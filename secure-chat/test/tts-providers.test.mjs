import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLE_PROVIDER_ID,
  PinnedLocalQwenProvider,
  QWEN_PROVIDER_ID,
  TTSProviderRegistry,
  createDefaultTtsRegistry,
} from "../src/tts/providers.mjs";
import { serializeTtsEvent, toPrivacySafeAuditRecord } from "../src/tts/contracts.mjs";

test("default catalog accurately reports Qwen unavailable and Apple as a client fallback", () => {
  const registry = createDefaultTtsRegistry();
  const catalog = registry.catalog();
  const qwen = catalog.providers.find((provider) => provider.id === QWEN_PROVIDER_ID);
  const apple = catalog.providers.find((provider) => provider.id === APPLE_PROVIDER_ID);

  assert.equal(qwen.availability.state, "unavailable");
  assert.equal(qwen.availability.reason, "model_not_installed");
  assert.equal(qwen.model.installed, false);
  assert.equal(qwen.model.revision, null);
  assert.equal(apple.availability.state, "client_managed");
  assert.equal(apple.execution, "iphone_local");
  assert.equal(catalog.privacy.contentLogging, false);
  assert.equal(catalog.privacy.cloudFallback, false);
});

test("unavailable Qwen resolves to an on-device Apple synthesis instruction", async () => {
  const registry = createDefaultTtsRegistry();
  const resolved = registry.resolve(QWEN_PROVIDER_ID);
  assert.equal(resolved.provider.id, APPLE_PROVIDER_ID);
  assert.equal(resolved.fallbackFrom, QWEN_PROVIDER_ID);

  const events = [];
  for await (const event of resolved.provider.synthesize({ text: "아이폰 안에서만 읽습니다." })) events.push(event);
  assert.equal(events[0].type, "client_synthesis");
  assert.equal(events[0].locale, "ko-KR");
  assert.equal(events[0].text, "아이폰 안에서만 읽습니다.");
});

test("future local Qwen adapter requires a pinned revision and verified hash", () => {
  const engine = { async *synthesize() {} };
  assert.throws(() => new PinnedLocalQwenProvider({
    model: { repository: "example/model", revision: "main", sha256: "b".repeat(64), localPath: "/private/model" },
    engine,
  }), /unpinned_model_revision/);
});

test("pinned local adapter streams binary audio without exposing its local path", async () => {
  const provider = new PinnedLocalQwenProvider({
    model: {
      repository: "example/model",
      revision: "a".repeat(40),
      sha256: "b".repeat(64),
      localPath: "/private/models/qwen",
    },
    engine: {
      async *synthesize() {
        yield { bytes: Buffer.from([1, 2]), sampleRate: 24_000 };
        yield { bytes: Buffer.from([3]), sampleRate: 24_000 };
      },
    },
  });
  assert.equal(provider.describe().availability.state, "available");
  assert.doesNotMatch(JSON.stringify(provider.describe()), /private\/models/);

  const events = [];
  for await (const event of provider.synthesize({ text: "로컬 음성입니다." })) events.push(event);
  assert.equal(events.length, 2);
  assert.equal(events[1].sequence, 1);
  assert.equal(JSON.parse(serializeTtsEvent(events[0])).data, "AQI=");
});

test("privacy-safe audit records discard text, audio, voice, and device data", () => {
  const record = toPrivacySafeAuditRecord({
    type: "state",
    state: "synthesizing",
    providerId: QWEN_PROVIDER_ID,
    text: "절대 기록하면 안 되는 개인정보",
    bytes: Buffer.from("secret"),
    voiceId: "private-voice",
    deviceId: "private-device",
  }, () => "2026-08-05T00:00:00.000Z");
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /개인정보|secret|private-voice|private-device/);
  assert.deepEqual(record, {
    timestamp: "2026-08-05T00:00:00.000Z",
    event: "tts_state",
    state: "synthesizing",
    providerId: QWEN_PROVIDER_ID,
  });
  assert.equal(toPrivacySafeAuditRecord({ state: "error", errorCode: "secret_password", reason: "private reason" }).errorCode, "tts_failed");
});

test("registry can host a verified local provider without changing the API contract", () => {
  const provider = new PinnedLocalQwenProvider({
    model: {
      repository: "example/model",
      revision: "a".repeat(40),
      sha256: "b".repeat(64),
      localPath: "/private/models/qwen",
    },
    engine: { async *synthesize() {} },
  });
  const registry = new TTSProviderRegistry({
    providers: [provider],
    primaryProviderId: provider.id,
    fallbackProviderId: provider.id,
  });
  assert.equal(registry.catalog().providers[0].availability.state, "available");
});
