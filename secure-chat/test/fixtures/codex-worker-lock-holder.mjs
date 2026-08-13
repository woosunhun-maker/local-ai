import { CodexTaskStore } from "../../src/codex/task-store.mjs";

const path = process.argv[2];
if (!path) process.exit(0);
const shouldClaim = process.argv[3] === "claim";
const store = new CodexTaskStore(path);
await store.initialize();
const lease = await store.acquireWorkerLease({ workerId: `fixture-worker-${process.pid}` });
const running = shouldClaim ? await store.claimNext(lease) : null;
process.stdout.write(`${JSON.stringify({ outcome: "ready", runningId: running?.id ?? null })}\n`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await store.releaseWorkerLease(lease).catch(() => {});
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
setInterval(() => {}, 1_000);
