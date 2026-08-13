#!/opt/homebrew/bin/node

// This smoke check is deliberately local-only. A direct runner invocation
// would bypass the owner-app plan display and signed biometric approval that
// are required before any source snapshot may be sent to OpenAI.
import { CodexTaskStore } from "../src/codex/task-store.mjs";
import { codexWorkerReady } from "../src/telegram/codex-runtime-readiness.mjs";

const TASK_STORE_PATH = "/Users/hun/PrivateAI/data/codex-bridge/tasks.json";

async function main() {
  const configurationReady = await codexWorkerReady();
  const durableWorkerReady = configurationReady
    ? await new CodexTaskStore(TASK_STORE_PATH).workerReady()
    : false;
  const ready = configurationReady && durableWorkerReady;
  process.stdout.write(`${JSON.stringify({
    outcome: ready ? "ready" : "unavailable",
    ownerAppApprovalRequired: true,
    externalTransferPerformed: false,
    configurationReady,
    durableWorkerReady,
  })}\n`);
  if (!ready) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    outcome: "failed",
    ownerAppApprovalRequired: true,
    externalTransferPerformed: false,
    errorClass: error?.name ?? "Error",
  })}\n`);
  process.exitCode = 1;
});
