import {
  TTSError,
  TTS_PRIVACY_CONTRACT,
  TTS_PROVIDER_STATE,
  createCatalog,
  throwIfAborted,
  validateSynthesisText,
} from "./contracts.mjs";

export const QWEN_PROVIDER_ID = "qwen3-tts-local";
export const APPLE_PROVIDER_ID = "apple-avspeech-device";
export const QWEN_SOHEE_VOICE_ID = "qwen3-sohee";
export const APPLE_AUTO_VOICE_ID = "apple-ko-auto";

export const RECOMMENDED_QWEN_MODEL_SLOT = Object.freeze({
  family: "Qwen3-TTS",
  variant: "12Hz-1.7B-CustomVoice-6bit",
  repository: "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit",
  revision: null,
  sha256: null,
  installed: false,
});

function voiceDescription() {
  return {
    id: QWEN_SOHEE_VOICE_ID,
    displayName: "Sohee",
    locale: "ko-KR",
    styles: ["natural", "calm", "concise"],
  };
}

export class UnavailableQwenProvider {
  id = QWEN_PROVIDER_ID;

  constructor(reason = "model_not_installed") {
    this.reason = reason;
  }

  describe() {
    return {
      id: this.id,
      displayName: "Qwen3-TTS Sohee",
      execution: "mac_local",
      availability: { state: TTS_PROVIDER_STATE.unavailable, reason: this.reason },
      privacy: TTS_PRIVACY_CONTRACT,
      capabilities: { streaming: true, preview: true, instructionStyles: true },
      model: RECOMMENDED_QWEN_MODEL_SLOT,
      voices: [{ ...voiceDescription(), selectable: false }],
    };
  }

  async *synthesize() {
    throw new TTSError("provider_unavailable", "Qwen3-TTS model is not installed");
  }
}

export class AppleClientFallbackProvider {
  id = APPLE_PROVIDER_ID;

  describe() {
    return {
      id: this.id,
      displayName: "Apple 기기 음성",
      execution: "iphone_local",
      availability: { state: TTS_PROVIDER_STATE.clientManaged, reason: "device_voice_inventory_required" },
      privacy: TTS_PRIVACY_CONTRACT,
      capabilities: { streaming: false, preview: true, clientSynthesis: true },
      voicesSource: "AVSpeechSynthesisVoice.speechVoices",
      preferredQualityOrder: ["premium", "enhanced", "default"],
      voices: [{ id: APPLE_AUTO_VOICE_ID, displayName: "가장 좋은 설치 음성", locale: "ko-KR", selectable: true }],
    };
  }

  async *synthesize({ text, voiceId = APPLE_AUTO_VOICE_ID, signal } = {}) {
    throwIfAborted(signal);
    const normalized = validateSynthesisText(text);
    yield {
      type: "client_synthesis",
      providerId: this.id,
      voiceId,
      locale: "ko-KR",
      preferredQualityOrder: ["premium", "enhanced", "default"],
      text: normalized,
    };
  }
}

function validatePinnedModel(model) {
  if (!model || typeof model !== "object") throw new TTSError("invalid_pinned_model");
  if (typeof model.repository !== "string" || !model.repository) throw new TTSError("invalid_model_repository");
  if (!/^[a-f0-9]{40}$/u.test(model.revision ?? "")) throw new TTSError("unpinned_model_revision");
  if (!/^[a-f0-9]{64}$/u.test(model.sha256 ?? "")) throw new TTSError("unverified_model_hash");
  if (typeof model.localPath !== "string" || !model.localPath.startsWith("/")) throw new TTSError("invalid_model_path");
  return model;
}

// Adapter for the later, separately approved MLX runtime. Constructing it requires
// a commit-pinned, hash-verified local model and an injected offline engine. This
// module itself never downloads a model or performs network I/O.
export class PinnedLocalQwenProvider {
  id = QWEN_PROVIDER_ID;

  constructor({ model, engine }) {
    this.model = validatePinnedModel(model);
    if (!engine || typeof engine.synthesize !== "function") throw new TTSError("invalid_local_tts_engine");
    this.engine = engine;
  }

  describe() {
    const runtimeHealth = typeof this.engine.health === "function"
      ? this.engine.health()
      : { state: "ready", available: true, restartRemaining: 0 };
    return {
      id: this.id,
      displayName: "Qwen3-TTS Sohee",
      execution: "mac_local",
      availability: runtimeHealth.state === "ready" && runtimeHealth.available
        ? { state: TTS_PROVIDER_STATE.available }
        : {
            state: TTS_PROVIDER_STATE.unavailable,
            reason: ["idle", "starting", "restarting"].includes(runtimeHealth.state)
              ? "runtime_warming"
              : "runtime_unavailable",
          },
      runtimeHealth: {
        state: runtimeHealth.state,
        restartRemaining: runtimeHealth.restartRemaining,
      },
      privacy: TTS_PRIVACY_CONTRACT,
      capabilities: { streaming: true, preview: true, instructionStyles: true },
      model: {
        family: "Qwen3-TTS",
        repository: this.model.repository,
        revision: this.model.revision,
        verified: true,
        networkPolicy: "offline_only",
      },
      voices: [{ ...voiceDescription(), selectable: true }],
    };
  }

  async *synthesize({ text, voiceId = QWEN_SOHEE_VOICE_ID, style = "natural", signal } = {}) {
    throwIfAborted(signal);
    const normalized = validateSynthesisText(text);
    if (voiceId !== QWEN_SOHEE_VOICE_ID) throw new TTSError("unsupported_voice");
    if (!voiceDescription().styles.includes(style)) throw new TTSError("unsupported_voice_style");
    let sequence = 0;
    for await (const chunk of this.engine.synthesize({
      text: normalized,
      speaker: "Sohee",
      language: "Korean",
      style,
      modelPath: this.model.localPath,
      signal,
    })) {
      throwIfAborted(signal);
      const bytes = Buffer.isBuffer(chunk?.bytes) ? chunk.bytes : Buffer.from(chunk?.bytes ?? []);
      if (!bytes.length) continue;
      yield {
        type: "audio",
        providerId: this.id,
        voiceId,
        sequence: sequence++,
        encoding: chunk.encoding ?? "pcm_s16le",
        sampleRate: chunk.sampleRate ?? 24_000,
        channels: chunk.channels ?? 1,
        bytes,
      };
    }
  }
}

export class TTSProviderRegistry {
  constructor({ providers, primaryProviderId = QWEN_PROVIDER_ID, fallbackProviderId = APPLE_PROVIDER_ID }) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
    this.primaryProviderId = primaryProviderId;
    this.fallbackProviderId = fallbackProviderId;
    if (!this.providers.has(primaryProviderId) || !this.providers.has(fallbackProviderId)) {
      throw new TTSError("invalid_provider_registry");
    }
  }

  catalog() {
    return createCatalog([...this.providers.values()], {
      primaryProviderId: this.primaryProviderId,
      fallbackProviderId: this.fallbackProviderId,
    });
  }

  resolve(requestedProviderId = this.primaryProviderId, { allowClientFallback = true } = {}) {
    const requested = this.providers.get(requestedProviderId);
    if (!requested) throw new TTSError("unknown_tts_provider");
    const description = requested.describe();
    if (description.availability.state !== TTS_PROVIDER_STATE.unavailable) {
      return { provider: requested };
    }
    if (!allowClientFallback) throw new TTSError("provider_unavailable");
    const fallback = this.providers.get(this.fallbackProviderId);
    if (!fallback) throw new TTSError("fallback_unavailable");
    return {
      provider: fallback,
      fallbackFrom: requested.id,
      fallbackReason: description.availability.reason,
    };
  }

  fallbackFor(failedProviderId) {
    if (failedProviderId === this.fallbackProviderId) return undefined;
    return this.providers.get(this.fallbackProviderId);
  }
}

export function createDefaultTtsRegistry() {
  return new TTSProviderRegistry({
    providers: [new UnavailableQwenProvider(), new AppleClientFallbackProvider()],
  });
}
