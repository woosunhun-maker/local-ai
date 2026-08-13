import assert from "node:assert/strict";
import test from "node:test";

import {
  createBuiltinToolRegistry,
} from "../src/tools/tool-registry.mjs";
import {
  assertToolExecutionAllowed,
  evaluateApprovalPolicy,
} from "../src/approval/approval-policy.mjs";

test("tool registry separates enabled policy from available runtime", () => {
  const registry = createBuiltinToolRegistry({ growthAvailable: false, webTaskAvailable: true });
  const growth = registry.describe("growth.dispatch");
  const web = registry.describe("web_task.execute");
  assert.equal(growth.enabled, true);
  assert.equal(growth.available, false);
  assert.equal(growth.usable_now, false);
  assert.equal(web.enabled, true);
  assert.equal(web.available, true);
  assert.equal(web.usable_now, true);
});

test("Telegram cannot execute effect tools even with approval flag", () => {
  const registry = createBuiltinToolRegistry();
  for (const toolName of ["web_task.execute", "owner.action.execute", "codex.enqueue"]) {
    assert.throws(
      () => assertToolExecutionAllowed({
        registry,
        toolName,
        channel: "telegram",
        hasApproval: true,
      }),
      /channel_not_allowed|telegram_effect_execution_forbidden/,
    );
  }
});

test("Telegram may create owner.action approval request but not execute", () => {
  const registry = createBuiltinToolRegistry();
  const request = evaluateApprovalPolicy({
    tool: registry.get("owner.action.request"),
    channel: "telegram",
    hasApproval: false,
  });
  assert.equal(request.decision, "allow");
  assert.throws(
    () => assertToolExecutionAllowed({
      registry,
      toolName: "owner.action.execute",
      channel: "telegram",
      hasApproval: true,
    }),
    /channel_not_allowed|telegram_effect_execution_forbidden/,
  );
});

test("approval-required tools cannot execute without approval", () => {
  const registry = createBuiltinToolRegistry();
  assert.throws(
    () => assertToolExecutionAllowed({
      registry,
      toolName: "web_task.execute",
      channel: "local_owner_app",
      hasApproval: false,
    }),
    /approval_required_before_execute/,
  );
  const allowed = assertToolExecutionAllowed({
    registry,
    toolName: "web_task.execute",
    channel: "local_owner_app",
    hasApproval: true,
  });
  assert.equal(allowed.decision, "allow");
});

test("low-risk system.status is allow on owner channels and denied on telegram", () => {
  const registry = createBuiltinToolRegistry();
  assert.equal(evaluateApprovalPolicy({
    tool: registry.get("system.status"),
    channel: "system_cli",
  }).decision, "allow");
  assert.equal(evaluateApprovalPolicy({
    tool: registry.get("system.status"),
    channel: "telegram",
  }).decision, "deny");
});
