const PROVIDER_STATES = ["available", "unavailable", "client_managed"];

export const TTS_API_VERSION = 1;

export const TTS_PROVIDER_STATE = Object.freeze({
  available: "available",
  unavailable: "unavailable",
  clientManaged: "client_managed",
});

export const TTS_SESSION_STATE = Object.freeze({
  preparing: "preparing",
  synthesizing: "synthesizing",
  clientFallback: "client_fallback",
  completed: "completed",
  cancelled: "cancelled",
  error: "error",
});

export const TTS_HTTP_CONTRACT = Object.freeze({
  catalog: Object.freeze({ method: "GET", path: "/api/tts/catalog", responseType: "application/json" }),
  stream: Object.freeze({
    method: "POST",
    path: "/api/tts/stream",
    requestType: "application/json",
    responseType: "application/x-ndjson",
    request: Object.freeze({
      required: ["text"],
      optional: ["providerId", "voiceId", "style", "allowClientFallback"],
      maxTextCharacters: 8_000,
    }),
    events: Object.freeze(["state", "audio", "client_synthesis"]),
    audioPayload: "base64",
  }),
});

export const TTS_PRIVACY_CONTRACT = Object.freeze({
  processing: "local_only",
  contentLogging: false,
  cloudFallback: false,
  transport: "authenticated_tailnet",
});

export class TTSError extends Error {
  constructor(code, message = code, options = {}) {
    super(message, options);
    this.name = "TTSError";
    this.code = code;
  }
}

export function abortError(reason = "tts_cancelled") {
  return new TTSError("cancelled", typeof reason === "string" ? reason : "tts_cancelled");
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

export function validateProviderDescription(description) {
  if (!description || typeof description !== "object") throw new TTSError("invalid_provider_description");
  if (typeof description.id !== "string" || !description.id) throw new TTSError("invalid_provider_id");
  if (!PROVIDER_STATES.includes(description.availability?.state)) throw new TTSError("invalid_provider_state");
  return description;
}

export function validateSynthesisText(text, { maxCharacters = 8_000 } = {}) {
  if (typeof text !== "string") throw new TTSError("invalid_tts_text");
  const normalized = text.replaceAll("\u0000", "").trim();
  if (!normalized || normalized.length > maxCharacters) throw new TTSError("invalid_tts_text");
  return normalized;
}

export function createCatalog(providers, { primaryProviderId, fallbackProviderId } = {}) {
  const descriptions = providers.map((provider) => validateProviderDescription(provider.describe()));
  return {
    version: TTS_API_VERSION,
    privacy: TTS_PRIVACY_CONTRACT,
    endpoints: TTS_HTTP_CONTRACT,
    primaryProviderId,
    fallbackProviderId,
    providers: descriptions,
  };
}

// Only this allow-listed record may be sent to an audit sink. Text, audio bytes,
// voice identifiers, file paths, prompts, and device identifiers are deliberately omitted.
export function toPrivacySafeAuditRecord(event, now = () => new Date().toISOString()) {
  const record = {
    timestamp: now(),
    event: "tts_state",
    state: typeof event?.state === "string" ? event.state : "unknown",
  };
  if (typeof event?.providerId === "string") record.providerId = event.providerId;
  if (typeof event?.fallbackFrom === "string") record.fallbackFrom = event.fallbackFrom;
  if (["model_not_installed", "provider_unavailable", "device_voice_inventory_required"].includes(event?.reason)) {
    record.reason = event.reason;
  }
  if (typeof event?.errorCode === "string") {
    const safeErrorCodes = new Set([
      "cancelled", "invalid_tts_input", "invalid_tts_fragment", "invalid_tts_text",
      "provider_unavailable", "fallback_unavailable", "tts_input_too_large",
      "too_many_tts_segments", "unsupported_voice", "unsupported_voice_style", "tts_failed",
    ]);
    record.errorCode = safeErrorCodes.has(event.errorCode) ? event.errorCode : "tts_failed";
  }
  if (Number.isSafeInteger(event?.segmentIndex)) record.segmentIndex = event.segmentIndex;
  return record;
}

export function serializeTtsEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    throw new TTSError("invalid_tts_event");
  }
  if (event.type !== "audio") return JSON.stringify(event);
  const bytes = Buffer.isBuffer(event.bytes) ? event.bytes : Buffer.from(event.bytes ?? []);
  const { bytes: _bytes, ...metadata } = event;
  return JSON.stringify({ ...metadata, data: bytes.toString("base64") });
}
