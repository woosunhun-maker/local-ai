#!/opt/homebrew/bin/node
/**
 * 로컬에서 system.status를 직접 조회한다. 비밀값을 출력하지 않는다.
 * Usage: node scripts/system-status.mjs [--text]
 */

import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { runSystemCommand, formatSystemStatusText } = await import(
  pathToFileURL(join(root, "src/system/introspection.mjs")).href
);
const { TaskManagerStore } = await import(
  pathToFileURL(join(root, "src/task/task-manager-store.mjs")).href
);

const textMode = process.argv.includes("--text");
const store = new TaskManagerStore("/Users/hun/PrivateAI/data/task-manager/tasks.json");
let taskSummary = null;
try {
  await store.initialize();
  taskSummary = await store.summary();
} catch {
  taskSummary = null;
}

const result = await runSystemCommand("system.status", { taskSummary });
if (textMode) {
  process.stdout.write(`${formatSystemStatusText(result)}\n`);
} else {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
