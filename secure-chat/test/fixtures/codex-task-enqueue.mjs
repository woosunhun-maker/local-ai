import { CodexTaskStore } from "../../src/codex/task-store.mjs";

const path = process.argv[2];
if (!path) process.exit(0);
const index = Number(process.argv[3]);
const store = new CodexTaskStore(path);
await store.initialize();
const result = await store.enqueue({
  botId: "1234567890",
  ownerId: "100000001",
  chatId: "100000001",
  ownerGeneration: "a".repeat(32),
  updateId: index,
  messageId: index + 1,
  intent: "inspect",
  request: `다중 프로세스 합성 요청 ${index}`,
});
process.stdout.write(`${JSON.stringify({ outcome: "done", created: result.created, id: result.job.id })}\n`);
