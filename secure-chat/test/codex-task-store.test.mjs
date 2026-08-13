import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexTaskStore } from "../src/codex/task-store.mjs";

const BOT_ID = "1234567890";
const OWNER_ID = "100000001";
const OWNER_GENERATION = "a".repeat(32);
const PRINCIPAL = Object.freeze({
  botId: BOT_ID,
  ownerId: OWNER_ID,
  chatId: OWNER_ID,
  ownerGeneration: OWNER_GENERATION,
});
const START = Date.parse("2026-08-05T00:00:00.000Z");
const ENQUEUE_FIXTURE = join(import.meta.dirname, "fixtures", "codex-task-enqueue.mjs");
const WORKER_FIXTURE = join(import.meta.dirname, "fixtures", "codex-worker-lock-holder.mjs");

function runJsonChild(script, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || signal) {
        reject(new Error("fixture child failed"));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error("fixture child output invalid")); }
    });
  });
}

async function waitForJsonLine(child) {
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk;
    const newline = output.indexOf("\n");
    if (newline >= 0) return JSON.parse(output.slice(0, newline));
  }
  throw new Error("worker fixture exited before readiness");
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "local-ai-codex-tasks-"));
  const path = join(root, "tasks.json");
  const clock = { value: START };
  const store = new CodexTaskStore(path, { now: () => clock.value, ...options });
  await store.initialize();
  return { root, path, clock, store };
}

function request(index, overrides = {}) {
  return {
    botId: BOT_ID,
    ownerId: OWNER_ID,
    chatId: OWNER_ID,
    ownerGeneration: OWNER_GENERATION,
    updateId: index,
    messageId: index + 1,
    intent: "inspect",
    request: `정책을 통과한 합성 요청 ${index}`,
    ...overrides,
  };
}

async function failNext(store, workerId) {
  const workerLease = await store.acquireWorkerLease({ workerId });
  try {
    const job = await store.claimNext(workerLease);
    assert.ok(job);
    return await store.transition(job.id, "running", "failed", null, { workerLease });
  } finally {
    await store.releaseWorkerLease(workerLease);
  }
}

test("stores only the bounded policy-passed request in a private atomic JSON file and deduplicates per bot", async () => {
  const { path, store } = await fixture();
  const original = request(10, { request: "  정책 통과 요청  " });
  const first = await store.enqueue(original);
  assert.equal(first.created, true);
  assert.equal(first.job.request, "정책 통과 요청");
  assert.match(first.job.requestSha256, /^[a-f0-9]{64}$/);

  const duplicate = await store.enqueue(original);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.id, first.job.id);
  await assert.rejects(
    store.enqueue({ ...original, request: "재생 중 바뀐 요청" }),
    /codex_task_replay_mismatch/,
  );
  await assert.rejects(
    store.enqueue({ ...original, ownerGeneration: "b".repeat(32) }),
    /codex_task_replay_mismatch/,
    "the same bot update can never be rebound to a new owner generation",
  );

  const anotherBot = await store.enqueue({ ...original, botId: "2234567890" });
  assert.equal(anotherBot.created, true, "update/message ids are scoped to the pinned bot id");
  await assert.rejects(
    store.enqueue({ ...request(11), request: "가".repeat(2_001) }),
    /invalid_codex_task_request/,
  );
  await assert.rejects(
    store.enqueue({ ...request(11), rawMessage: { private: true } }),
    /invalid_codex_task_input/,
  );

  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes("rawMessage"), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const tampered = JSON.parse(raw);
  tampered.jobs[0].ownerGeneration = "b".repeat(32);
  await writeFile(path, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  await assert.rejects(store.read(), /invalid_codex_task_request_binding/);
  await writeFile(path, raw, { mode: 0o600 });
});

test("legacy unbound v1 queues are archived instead of being attributed to the current owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-codex-tasks-v1-"));
  const path = join(root, "tasks.json");
  await writeFile(path, `${JSON.stringify({ version: 1, jobs: [{ request: "legacy-unbound" }] })}\n`, { mode: 0o600 });
  const store = new CodexTaskStore(path);
  await store.initialize();
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 3, jobs: [] });
  const archived = (await readdir(root)).filter((name) => name.startsWith("tasks.json.principal-unbound-v1."));
  assert.equal(archived.length, 1);
  assert.match(await readFile(join(root, archived[0]), "utf8"), /legacy-unbound/);
});

test("filesystem lock makes concurrent duplicate enqueue and worker claim atomic", async () => {
  const { path, clock, store } = await fixture();
  const peer = new CodexTaskStore(path, { now: () => clock.value });
  await peer.initialize();

  const attempts = await Promise.all([store.enqueue(request(20)), peer.enqueue(request(20))]);
  assert.deepEqual(attempts.map((entry) => entry.created).sort(), [false, true]);

  const workerLease = await store.acquireWorkerLease({ workerId: "worker-a" });
  await assert.rejects(peer.claimNext(workerLease), /codex_worker_lease_lost/);
  const claimed = await store.claimNext(workerLease);
  assert.equal(claimed.workerId, "worker-a");
  await assert.rejects(
    peer.acquireWorkerLease({ workerId: "worker-b" }),
    /codex_worker_already_running/,
  );
  await store.transition(claimed.id, "running", "failed", null, { workerLease });
  await store.releaseWorkerLease(workerLease);
  assert.equal((await store.get(claimed.id)).status, "failed");
  JSON.parse(await readFile(path, "utf8"));
});

test("task-store kernel lock persists empty and serializes duplicate enqueue across processes", async () => {
  const { path, store } = await fixture();
  const lockPath = `${path}.lock`;
  const details = await stat(lockPath);
  assert.equal(details.isFile(), true);
  assert.equal(details.mode & 0o777, 0o600);
  assert.equal(details.size, 0);
  const results = await Promise.all([
    runJsonChild(ENQUEUE_FIXTURE, [path, "30"]),
    runJsonChild(ENQUEUE_FIXTURE, [path, "30"]),
  ]);
  assert.deepEqual(results.map((entry) => entry.created).sort(), [false, true]);
  assert.equal(results[0].id, results[1].id);
  assert.equal((await store.read()).jobs.length, 1);
});

test("worker readiness requires a live process and a recent durable heartbeat", async () => {
  const { clock, store } = await fixture();
  assert.equal(await store.workerReady(), false);
  let lease = await store.acquireWorkerLease({ workerId: "readiness-worker" });
  assert.equal(await store.workerReady(), true);
  clock.value += 16_000;
  assert.equal(await store.workerReady(), false);
  lease = await store.heartbeatWorkerLease(lease);
  assert.equal(await store.workerReady(), true);
  await store.releaseWorkerLease(lease);
  assert.equal(await store.workerReady(), false);
});

test("queue and persistent rolling rate limits are enforced after deduplication", async () => {
  const { clock, store } = await fixture();
  for (let index = 0; index < 3; index += 1) await store.enqueue(request(100 + index));
  await assert.rejects(store.enqueue(request(103)), /codex_task_queue_full/);

  for (let index = 0; index < 3; index += 1) await failNext(store, `queue-worker-${index}`);
  await assert.rejects(store.enqueue(request(103)), /codex_task_rate_limit_10m/);
  clock.value += 10 * 60_000;
  assert.equal((await store.enqueue(request(103))).created, true);

  const daily = await fixture();
  for (let index = 0; index < 12; index += 1) {
    if (index > 0 && index % 3 === 0) daily.clock.value += 10 * 60_000;
    await daily.store.enqueue(request(200 + index));
    await failNext(daily.store, `daily-worker-${index}`);
  }
  daily.clock.value += 10 * 60_000;
  await assert.rejects(daily.store.enqueue(request(212)), /codex_task_rate_limit_daily/);

  const restarted = new CodexTaskStore(daily.path, { now: () => daily.clock.value });
  await restarted.initialize();
  await assert.rejects(restarted.enqueue(request(212)), /codex_task_rate_limit_daily/);
});

test("only atomic claim starts work and terminal results are bounded, filename-only outbox records", async () => {
  const { store } = await fixture();
  const queued = await store.enqueue(request(300, { intent: "draft", request: "안전한 패치 초안 작성" }));
  const workerLease = await store.acquireWorkerLease({ workerId: "worker-draft" });
  await assert.rejects(
    store.transition(queued.job.id, "queued", "running", null, { workerLease }),
    /invalid_codex_task_transition/,
  );
  const running = await store.claimNext(workerLease);

  await assert.rejects(
    store.transition(running.id, "running", "succeeded", {
      summary: "경로가 포함된 결과",
      changedFileCount: 1,
      changedPaths: ["../secret.txt"],
      patch: null,
      patchSha256: null,
    }, { workerLease }),
    /invalid_codex_task_changed_path/,
  );
  await assert.rejects(
    store.transition(running.id, "running", "succeeded", {
      summary: "가".repeat(1_501),
      changedFileCount: 0,
      changedPaths: [],
      patch: null,
      patchSha256: null,
    }, { workerLease }),
    /invalid_codex_task_result_summary/,
  );

  const completed = await store.transition(running.id, "running", "succeeded", {
    summary: "검증 가능한 합성 패치 초안을 만들었습니다.",
    changedFileCount: 2,
    changedPaths: [],
    patch: null,
    patchSha256: null,
  }, { workerLease });
  await store.releaseWorkerLease(workerLease);
  assert.equal(completed.status, "succeeded");

  const outbox = await store.listUndelivered();
  assert.equal(outbox.length, 1);
  assert.deepEqual({
    botId: outbox[0].botId,
    ownerId: outbox[0].ownerId,
    chatId: outbox[0].chatId,
    ownerGeneration: outbox[0].ownerGeneration,
  }, PRINCIPAL);
  assert.equal(Object.hasOwn(outbox[0], "request"), false);
  assert.deepEqual(outbox[0].result.changedPaths, []);
  assert.equal(outbox[0].result.patch, null);
  assert.equal(outbox[0].result.changedFileCount, 2);
  assert.doesNotMatch(JSON.stringify(outbox), /안전한 패치 초안 작성/);

  const status = await store.summary();
  assert.deepEqual(status, {
    queued: 0,
    running: 0,
    undelivered: 1,
    recent: { id: completed.id, status: "succeeded" },
  });
  assert.doesNotMatch(JSON.stringify(status), /합성 패치/);

  const delivered = await store.markDelivered(completed.id, PRINCIPAL);
  assert.ok(delivered.deliveredAt);
  assert.deepEqual(await store.listUndelivered(), []);
  assert.equal((await store.summary()).undelivered, 0);
  assert.equal((await store.markDelivered(completed.id, PRINCIPAL)).deliveredAt, delivered.deliveredAt, "delivery acknowledgement is idempotent");
});

test("worker lifetime lock rejects peers and SIGKILL permits one replacement to recover running work", async (t) => {
  const { path, store } = await fixture();
  const queued = await store.enqueue(request(400));
  const holder = spawn(process.execPath, [WORKER_FIXTURE, path, "claim"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL"); });
  const ready = await waitForJsonLine(holder);
  assert.equal(ready.outcome, "ready");
  assert.equal(ready.runningId, queued.job.id);

  const relay = new CodexTaskStore(path);
  await relay.initialize();
  assert.equal(await relay.workerReady(), true);
  assert.equal((await relay.get(ready.runningId)).status, "running", "relay initialization must not recover another live worker");
  await assert.rejects(
    relay.acquireWorkerLease({ workerId: "overlapping-worker" }),
    /codex_worker_already_running/,
  );
  const forgedLease = await relay.readWorkerLease();
  await assert.rejects(relay.claimNext(forgedLease), /codex_worker_lease_lost/);
  await assert.rejects(relay.recoverRunning(forgedLease), /codex_worker_lease_lost/);
  assert.equal((await relay.get(ready.runningId)).status, "running", "overlapping worker must not mutate running state");

  holder.kill("SIGKILL");
  await once(holder, "exit");
  assert.equal(await relay.workerReady(), false);
  const replacementLease = await relay.acquireWorkerLease({ workerId: "replacement-worker" });
  const recovered = await relay.recoverRunning(replacementLease);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].status, "interrupted_uncertain");
  assert.equal(Object.hasOwn(recovered[0], "request"), false);
  assert.deepEqual(await relay.recoverRunning(replacementLease), []);

  const persisted = await relay.get(ready.runningId);
  assert.equal(persisted.status, "interrupted_uncertain");
  assert.equal(persisted.result.code, "codex_task_interrupted_uncertain");
  assert.equal((await relay.summary()).undelivered, 1);
  await relay.markDelivered(ready.runningId, PRINCIPAL);
  assert.equal((await relay.summary()).undelivered, 0);
  await relay.releaseWorkerLease(replacementLease);
  const workerLock = await stat(`${path}.worker-lock`);
  assert.equal(workerLock.mode & 0o777, 0o600);
  assert.equal(workerLock.size, 0);
});

test("concurrent v2 migration preserves terminal history and quarantines every executable legacy job", async () => {
  const { path, clock, store } = await fixture();
  const terminal = [];
  for (const [index, status] of [[500, "succeeded"], [510, "failed"], [520, "interrupted_uncertain"]]) {
    const queued = await store.enqueue(request(index));
    const lease = await store.acquireWorkerLease({ workerId: `migration-${status}` });
    const running = await store.claimNext(lease);
    terminal.push(await store.transition(running.id, "running", status, {
      code: status === "succeeded" ? "codex_task_succeeded" : `codex_task_${status}`,
      summary: `합성 ${status} 기록`,
      changedFileCount: 0,
      changedPaths: [],
      patch: null,
      patchSha256: null,
    }, { workerLease: lease }));
    await store.releaseWorkerLease(lease);
    assert.equal(running.id, queued.job.id);
  }
  await store.markDelivered(terminal[0].id, PRINCIPAL);
  await store.quarantineDelivery(terminal[1].id, {
    botId: BOT_ID,
    ownerId: "100000002",
    chatId: "100000002",
    ownerGeneration: "b".repeat(32),
  });
  clock.value += 10 * 60_000;
  const queued = await store.enqueue(request(530));
  const runningSource = await store.enqueue(request(540));
  const runningLease = await store.acquireWorkerLease({ workerId: "migration-running" });
  const running = await store.claimNext(runningLease);
  assert.equal(running.id, queued.job.id, "oldest queued job is claimed first");
  await store.releaseWorkerLease(runningLease);

  const v3 = JSON.parse(await readFile(path, "utf8"));
  const original = new Map(v3.jobs.map((job) => [job.id, structuredClone(job)]));
  const v2Jobs = v3.jobs.map((job) => {
    const legacy = structuredClone(job);
    for (const key of ["ingress", "ownerDeviceHash", "idempotencyKey", "approvalRequestId", "planCanonical", "planSha256"]) delete legacy[key];
    legacy.version = 2;
    if (legacy.result !== null) {
      const { changedPaths: _changedPaths, patch: _patch, patchSha256: _patchSha256, ...result } = legacy.result;
      legacy.result = { ...result, changedFiles: [] };
    }
    return legacy;
  });
  await writeFile(path, `${JSON.stringify({ version: 2, jobs: v2Jobs })}\n`, { mode: 0o600 });

  const first = new CodexTaskStore(path, { now: () => clock.value });
  const second = new CodexTaskStore(path, { now: () => clock.value });
  await Promise.all([first.initialize(), second.initialize()]);
  const migrated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  for (const job of migrated.jobs) {
    assert.equal(job.requestSha256, original.get(job.id).requestSha256);
    assert.equal(job.ingress, "telegram");
    if ([running.id, runningSource.job.id].includes(job.id)) {
      assert.equal(job.status, "interrupted_uncertain");
      assert.equal(job.result.code, "codex_owner_app_approval_required");
      assert.ok(job.quarantinedAt);
    }
  }
  assert.equal((await first.get(terminal[0].id)).deliveredAt, original.get(terminal[0].id).deliveredAt);
  assert.equal((await first.get(terminal[1].id)).quarantinedAt, original.get(terminal[1].id).quarantinedAt);
  assert.equal((await first.get(terminal[2].id)).status, "interrupted_uncertain");
  const noClaimLease = await first.acquireWorkerLease({ workerId: "migration-no-legacy-claim" });
  assert.equal(await first.claimNext(noClaimLease), null);
  await first.releaseWorkerLease(noClaimLease);
});
