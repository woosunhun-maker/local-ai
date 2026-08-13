import assert from "node:assert/strict";
import test from "node:test";

import {
  collectLocalRuntimeStatus,
  formatLocalRuntimeStatus,
  OLLAMA_HEALTH_URL,
  SECURE_CHAT_HEALTH_URL,
} from "../src/telegram/local-runtime-status.mjs";

test("checks only the two fixed loopback health endpoints and exposes bounded state", async () => {
  const calls = [];
  const status = await collectLocalRuntimeStatus({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url === SECURE_CHAT_HEALTH_URL) {
        return { ok: true, json: async () => ({ ok: true, exposure: "loopback_only" }) };
      }
      return { ok: true };
    },
    codexTasks: {
      summary: async () => ({ queued: 3, running: 1, undelivered: 2, recent: { id: "private-job-id" } }),
    },
  });
  assert.deepEqual(calls.map((entry) => entry.url).sort(), [OLLAMA_HEALTH_URL, SECURE_CHAT_HEALTH_URL].sort());
  assert.ok(calls.every((entry) => entry.options.method === "GET"));
  assert.deepEqual(status.codex, { queued: 3, running: 1, undelivered: 2 });
  assert.equal(JSON.stringify(status).includes("private-job-id"), false);
});

test("fails closed to check-needed labels without leaking transport errors", async () => {
  const status = await collectLocalRuntimeStatus({
    fetchImpl: async () => { throw new Error("private endpoint detail"); },
    codexTasks: { summary: async () => { throw new Error("private queue detail"); } },
  });
  assert.equal(status.secureChatReady, false);
  assert.equal(status.localModelReady, false);
  assert.equal(status.codex, null);
  const message = formatLocalRuntimeStatus(status);
  assert.match(message, /확인 필요/);
  assert.match(message, /격리 Codex: 비활성 또는 사전점검 실패/);
  assert.doesNotMatch(message, /private|endpoint|queue/iu);
});
