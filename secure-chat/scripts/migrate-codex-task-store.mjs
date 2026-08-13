#!/opt/homebrew/bin/node

import { readFile, stat } from "node:fs/promises";
import { CodexTaskStore } from "../src/codex/task-store.mjs";

const TASK_PATH = "/Users/hun/PrivateAI/data/codex-bridge/tasks.json";

const store = new CodexTaskStore(TASK_PATH);
await store.initialize();
const persisted = JSON.parse(await readFile(TASK_PATH, "utf8"));
const mode = (await stat(TASK_PATH)).mode & 0o777;
if (
  persisted?.version !== 3 || !Array.isArray(persisted.jobs) || mode !== 0o600 ||
  persisted.jobs.some((job) => ["awaiting_approval", "queued", "running"].includes(job?.status))
) {
  throw new Error("codex_task_store_offline_migration_failed");
}
process.stdout.write(`${JSON.stringify({ outcome: "migrated", version: 3, jobCount: persisted.jobs.length })}\n`);
