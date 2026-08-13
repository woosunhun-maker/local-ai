import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexTaskStore } from "../src/codex/task-store.mjs";
import { deliverCodexResults } from "../src/telegram/codex-result-delivery.mjs";

const BOT_ID = "1234567890";
const PRINCIPAL_A = Object.freeze({
  botId: BOT_ID,
  ownerId: "100000001",
  chatId: "100000001",
  ownerGeneration: "a".repeat(32),
});
const PRINCIPAL_B = Object.freeze({
  botId: BOT_ID,
  ownerId: "100000002",
  chatId: "100000002",
  ownerGeneration: "b".repeat(32),
});

async function completedJob(store, principal, eventId) {
  const queued = await store.enqueue({
    ...principal,
    updateId: eventId,
    messageId: eventId + 1,
    intent: "inspect",
    request: `합성 점검 요청 ${eventId}`,
  });
  const workerLease = await store.acquireWorkerLease({ workerId: `delivery-worker-${eventId}` });
  const running = await store.claimNext(workerLease);
  assert.equal(running.id, queued.job.id);
  assert.equal(running.ownerId, principal.ownerId, "worker must consume the immutable job principal");
  const completed = await store.transition(running.id, "running", "succeeded", {
    summary: "민감정보 없는 합성 점검 결과입니다.",
    changedFileCount: 0,
    changedPaths: [],
    patch: null,
    patchSha256: null,
  }, { workerLease });
  await store.releaseWorkerLease(workerLease);
  return completed;
}

test("owner rotation quarantines old results and delivers only an exact principal match", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-codex-delivery-"));
  const store = new CodexTaskStore(join(root, "tasks.json"));
  await store.initialize();
  const oldJob = await completedJob(store, PRINCIPAL_A, 10);
  const sends = [];
  const client = { sendText: async (...value) => sends.push(value) };

  await deliverCodexResults({ store, client, principal: PRINCIPAL_B });
  assert.deepEqual(sends, []);
  assert.ok((await store.get(oldJob.id)).quarantinedAt);
  assert.deepEqual(await store.listUndelivered(), []);
  await assert.rejects(store.markDelivered(oldJob.id, PRINCIPAL_A), /codex_task_delivery_quarantined/);

  const currentJob = await completedJob(store, PRINCIPAL_B, 20);
  await deliverCodexResults({ store, client, principal: PRINCIPAL_B });
  assert.equal(sends.length, 1);
  assert.equal(String(sends[0][0]), PRINCIPAL_B.chatId);
  assert.ok((await store.get(currentJob.id)).deliveredAt);
  assert.equal((await store.summary(PRINCIPAL_A)).undelivered, 0);
  assert.equal((await store.summary(PRINCIPAL_B)).undelivered, 0);
});
