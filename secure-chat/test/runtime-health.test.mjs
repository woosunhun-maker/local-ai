import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_CONVERSATION_MODEL,
  LOCAL_EFFECT_PLANNING_MODEL,
} from "../src/local-model-routing.mjs";
import {
  RUNTIME_HEALTH_SCHEMA,
  collectSystemRuntimeHealth,
} from "../src/system/runtime-health.mjs";

test("collectSystemRuntimeHealth marks unimplemented modules explicitly", async () => {
  const runtime = await collectSystemRuntimeHealth({
    privateRoot: "/tmp/local-ai-health-missing",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ models: [{ name: LOCAL_CONVERSATION_MODEL }, { name: LOCAL_EFFECT_PLANNING_MODEL }] }),
    }),
    execFileImpl: async () => ({
      stdout: "state = running\npid = 1234\nlast exit code = (never exited)\nruns = 1\n",
    }),
    readFileImpl: async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
    ttsCatalog: { providers: [{ id: "qwen3-tts", state: "ready" }] },
    now: () => new Date("2026-08-14T01:00:00.000Z"),
  });

  assert.equal(runtime.schema, RUNTIME_HEALTH_SCHEMA);
  assert.equal(runtime.conversation_model, LOCAL_CONVERSATION_MODEL);
  assert.equal(runtime.planner_model, LOCAL_EFFECT_PLANNING_MODEL);
  const byName = Object.fromEntries(runtime.services.map((row) => [row.service, row]));
  assert.equal(byName.tool_registry.status, "not_implemented");
  assert.equal(byName.task_manager.status, "not_implemented");
  assert.equal(byName.llm_conversation.status, "ok");
  assert.equal(byName.tts.status, "ok");
  assert.equal(byName.tts.model, "qwen3-tts");
  assert.ok(byName["secure-chat"].pid === 1234);
  assert.equal(byName.llm_planner_route.detail.note.includes("모델 라우트"), true);
});
