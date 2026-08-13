import {
  TTSError,
  TTS_SESSION_STATE,
  abortError,
  throwIfAborted,
  toPrivacySafeAuditRecord,
} from "./contracts.mjs";
import { createDefaultTtsRegistry } from "./providers.mjs";
import { KoreanSentenceChunker } from "./sentence-chunker.mjs";

async function* fragmentsFrom(input) {
  if (typeof input === "string") {
    yield input;
    return;
  }
  if (input?.[Symbol.asyncIterator]) {
    yield* input;
    return;
  }
  if (input?.[Symbol.iterator]) {
    yield* input;
    return;
  }
  throw new TTSError("invalid_tts_input");
}

function errorCode(error) {
  return typeof error?.code === "string" ? error.code : "tts_failed";
}

function isRuntimeFailure(error) {
  const code = errorCode(error);
  return code.startsWith("tts_worker_") || [
    "model_load_failed", "sohee_voice_missing", "worker_busy", "synthesis_failed",
    "invalid_tts_worker_event",
  ].includes(code);
}

export class SpeechSession {
  #controller = new AbortController();
  #started = false;
  #finished = false;

  constructor({
    registry = createDefaultTtsRegistry(),
    chunkerFactory = () => new KoreanSentenceChunker(),
    auditSink = async () => {},
    maxSegments = 128,
    maxInputCharacters = 32_000,
  } = {}) {
    this.registry = registry;
    this.chunkerFactory = chunkerFactory;
    this.auditSink = auditSink;
    this.maxSegments = maxSegments;
    this.maxInputCharacters = maxInputCharacters;
  }

  cancel(reason = "tts_cancelled") {
    if (!this.#controller.signal.aborted && !this.#finished) this.#controller.abort(abortError(reason));
  }

  async *stream(input, {
    providerId,
    voiceId,
    style = "natural",
    allowClientFallback = true,
    signal: externalSignal,
  } = {}) {
    if (this.#started) throw new TTSError("tts_session_already_started");
    this.#started = true;
    const signal = this.#controller.signal;
    const onExternalAbort = () => this.cancel(externalSignal.reason);
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    let provider;
    let segmentCount = 0;
    let totalCharacters = 0;
    try {
      throwIfAborted(externalSignal);
      const resolved = this.registry.resolve(providerId, { allowClientFallback });
      provider = resolved.provider;
      yield await this.#state(TTS_SESSION_STATE.preparing, { providerId: provider.id });
      if (resolved.fallbackFrom) {
        yield await this.#state(TTS_SESSION_STATE.clientFallback, {
          providerId: provider.id,
          fallbackFrom: resolved.fallbackFrom,
          reason: resolved.fallbackReason,
        });
      }

      const chunker = this.chunkerFactory();
      for await (const fragment of fragmentsFrom(input)) {
        throwIfAborted(signal);
        if (typeof fragment !== "string") throw new TTSError("invalid_tts_fragment");
        totalCharacters += fragment.length;
        if (totalCharacters > this.maxInputCharacters) throw new TTSError("tts_input_too_large");
        for (const segment of chunker.push(fragment)) {
          if (segmentCount >= this.maxSegments) throw new TTSError("too_many_tts_segments");
          provider = yield* this.#synthesizeSegment(provider, segment, segmentCount++, {
            voiceId, style, signal, allowClientFallback,
          });
        }
      }
      for (const segment of chunker.flush()) {
        if (segmentCount >= this.maxSegments) throw new TTSError("too_many_tts_segments");
        provider = yield* this.#synthesizeSegment(provider, segment, segmentCount++, {
          voiceId, style, signal, allowClientFallback,
        });
      }
      throwIfAborted(signal);
      this.#finished = true;
      yield await this.#state(TTS_SESSION_STATE.completed, { providerId: provider.id });
    } catch (error) {
      if (signal.aborted || error?.code === "cancelled") {
        this.#finished = true;
        yield await this.#state(TTS_SESSION_STATE.cancelled, { providerId: provider?.id });
        return;
      }
      this.#finished = true;
      yield await this.#state(TTS_SESSION_STATE.error, {
        providerId: provider?.id,
        errorCode: errorCode(error),
      });
    } finally {
      externalSignal?.removeEventListener("abort", onExternalAbort);
      if (!this.#finished) this.cancel("tts_consumer_closed");
    }
  }

  async *#synthesizeSegment(provider, text, segmentIndex, { voiceId, style, signal, allowClientFallback }) {
    throwIfAborted(signal);
    yield await this.#state(TTS_SESSION_STATE.synthesizing, { providerId: provider.id, segmentIndex });
    let emittedAudio = false;
    try {
      for await (const event of provider.synthesize({ text, voiceId, style, signal })) {
        throwIfAborted(signal);
        if (event.type === "audio") emittedAudio = true;
        yield { ...event, segmentIndex };
      }
      return provider;
    } catch (error) {
      const fallback = !emittedAudio && allowClientFallback && isRuntimeFailure(error)
        ? this.registry.fallbackFor(provider.id)
        : undefined;
      if (!fallback) throw error;
      yield await this.#state(TTS_SESSION_STATE.clientFallback, {
        providerId: fallback.id,
        fallbackFrom: provider.id,
        reason: "provider_unavailable",
      });
      for await (const event of fallback.synthesize({ text, signal })) {
        throwIfAborted(signal);
        yield { ...event, segmentIndex };
      }
      return fallback;
    }
  }

  async #state(state, details = {}) {
    const event = { type: "state", state, ...details };
    await this.auditSink(toPrivacySafeAuditRecord(event));
    return event;
  }
}
