import assert from "node:assert/strict";
import test from "node:test";
import { TTSProviderRegistry, createDefaultTtsRegistry } from "../src/tts/providers.mjs";
import { SpeechSession } from "../src/tts/speech-session.mjs";
import { abortError } from "../src/tts/contracts.mjs";

test("session emits explicit fallback and completion states without auditing content", async () => {
  const audit = [];
  const session = new SpeechSession({
    registry: createDefaultTtsRegistry(),
    auditSink: async (record) => audit.push(record),
  });
  const events = [];
  for await (const event of session.stream(["비밀번호는 1234", "입니다. 다음 문장입니다!"])) events.push(event);

  assert.deepEqual(events.filter((event) => event.type === "state").map((event) => event.state), [
    "preparing",
    "client_fallback",
    "synthesizing",
    "synthesizing",
    "completed",
  ]);
  assert.deepEqual(events.filter((event) => event.type === "client_synthesis").map((event) => event.text), [
    "비밀번호는 1234입니다.",
    "다음 문장입니다!",
  ]);
  assert.doesNotMatch(JSON.stringify(audit), /비밀번호|1234|다음 문장/);
});

test("session cancellation reaches the active provider and reports cancelled", async () => {
  let providerObservedAbort = false;
  const provider = {
    id: "slow-local-provider",
    describe: () => ({ id: "slow-local-provider", availability: { state: "available" } }),
    async *synthesize({ signal }) {
      await new Promise((resolve, reject) => {
        const onAbort = () => {
          providerObservedAbort = true;
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
      yield { type: "audio", bytes: Buffer.from([1]) };
    },
  };
  const registry = new TTSProviderRegistry({
    providers: [provider],
    primaryProviderId: provider.id,
    fallbackProviderId: provider.id,
  });
  const session = new SpeechSession({ registry });
  const iterator = session.stream("취소 시험입니다.");

  assert.equal((await iterator.next()).value.state, "preparing");
  assert.equal((await iterator.next()).value.state, "synthesizing");
  const pendingAudio = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  session.cancel("user_cancelled");
  const cancelled = await pendingAudio;
  assert.equal(cancelled.value.state, "cancelled");
  assert.equal(providerObservedAbort, true);
});

test("async event consumption naturally backpressures a fast audio provider", async () => {
  let produced = 0;
  const provider = {
    id: "burst-local-provider",
    describe: () => ({ id: "burst-local-provider", availability: { state: "available" } }),
    async *synthesize() {
      for (let index = 0; index < 5; index += 1) {
        produced += 1;
        yield { type: "audio", bytes: Buffer.from([index]) };
      }
    },
  };
  const registry = new TTSProviderRegistry({
    providers: [provider],
    primaryProviderId: provider.id,
    fallbackProviderId: provider.id,
  });
  const session = new SpeechSession({ registry });
  const iterator = session.stream("백프레셔 시험입니다.");

  await iterator.next(); // preparing
  await iterator.next(); // synthesizing
  const firstAudio = await iterator.next();
  assert.equal(firstAudio.value.type, "audio");
  assert.equal(produced, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(produced, 1);
  await iterator.next();
  assert.equal(produced, 2);
  await iterator.return();
});
