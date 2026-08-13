import assert from "node:assert/strict";
import test from "node:test";

import { LOCAL_CONVERSATION_MODEL, LOCAL_EFFECT_PLANNING_MODEL } from "../src/local-model-routing.mjs";
import { runSystemCommand, formatSystemStatusText } from "../src/system/introspection.mjs";

test("system.status returns VERIFIED evidence from runtime probes", async () => {
  const result = await runSystemCommand("system.status", {
    collectHealth: async () => ({
      schema: "local-ai.system-runtime-health.v1",
      checked_at: "2026-08-14T02:10:00.000Z",
      overall: "ok",
      version: "1.2.0",
      conversation_model: LOCAL_CONVERSATION_MODEL,
      planner_model: LOCAL_EFFECT_PLANNING_MODEL,
      services: [
        {
          service: "secure-chat",
          status: "ok",
          model: null,
          pid: 99,
          last_health_check: "2026-08-14T02:10:00.000Z",
          version: "1.2.0",
          error: null,
        },
      ],
    }),
    taskSummary: { schema: "local-ai.task-manager-summary.v1", total: 0, counts: {} },
  });
  assert.equal(result.command, "system.status");
  assert.equal(result.evidence[0].epistemic, "VERIFIED");
  assert.equal(result.tasks.epistemic, "VERIFIED");
  assert.match(formatSystemStatusText(result), /secure-chat: ok/);
});

test("unknown system commands fail closed", async () => {
  await assert.rejects(() => runSystemCommand("system.reboot"), /unsupported_system_command/);
});
