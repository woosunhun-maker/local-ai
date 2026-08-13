/**
 * Task Executor — Tool Registry + Approval Policy를 통과한 단계만 실행한다.
 * web-task/codex/owner-action 본체를 재작성하지 않는다.
 * 해당 고위험 도구는 기존 모듈 경로로 위임(deferred)하거나 거부한다.
 */
import { createEvidenceRecord, evidenceFromRuntimeService } from "../evidence/evidence.mjs";
import { assertToolExecutionAllowed } from "../approval/approval-policy.mjs";
import { runSystemCommand } from "../system/introspection.mjs";
import { createBuiltinToolRegistry } from "../tools/tool-registry.mjs";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

const DEFERRED_TOOLS = new Set([
  "web_task.execute",
  "web_task.plan",
  "owner.action.execute",
  "codex.enqueue",
  "growth.dispatch",
  "cursor.develop",
]);

export function createTaskExecutor({
  toolRegistry = createBuiltinToolRegistry(),
  runStatus = runSystemCommand,
  structuredLog = null,
} = {}) {
  async function emit(event, fields) {
    if (!structuredLog?.emit) return;
    await structuredLog.emit(event, fields).catch(() => {});
  }

  async function executeStep({
    toolName,
    channel = "local_owner_app",
    hasApproval = false,
    trustState = "owner_device",
    taskId = null,
    correlationId = null,
    expectations = [],
  } = {}) {
    if (typeof toolName !== "string" || !toolName) fail("invalid_executor_tool");
    assertToolExecutionAllowed({
      registry: toolRegistry,
      toolName,
      channel,
      hasApproval,
      trustState,
    });

    await emit("tool_invoked", {
      correlationId: correlationId ?? taskId ?? "executor",
      tool_name: toolName,
      channel,
    });

    if (DEFERRED_TOOLS.has(toolName)) {
      return Object.freeze({
        ok: false,
        deferred: true,
        tool_name: toolName,
        reason: "existing_module_path_required",
        evidence: Object.freeze([
          createEvidenceRecord({
            epistemic: "VERIFIED",
            claim: `${toolName} is not auto-executed by TaskExecutor; use existing approved module path`,
            source: "task.executor",
            taskId,
            correlationId,
            detail: { tool_name: toolName, deferred: true },
          }),
        ]),
        expectations,
      });
    }

    if (toolName === "system.status") {
      const status = await runStatus("system.status");
      const evidence = (status.runtime?.services ?? []).map((row) => evidenceFromRuntimeService(row, {
        correlationId,
        observedAt: status.checked_at,
      })).map((item) => ({ ...item, task_id: taskId }));
      const overallOk = status.runtime?.overall === "ok";
      return Object.freeze({
        ok: overallOk,
        deferred: false,
        tool_name: toolName,
        reason: overallOk ? "system_status_ok" : "system_status_degraded",
        evidence: Object.freeze(evidence),
        expectations: expectations.length > 0 ? expectations : Object.freeze([
          { service: "secure-chat", status: "ok" },
          { service: "llm_conversation", status: "ok" },
        ]),
        result: status,
      });
    }

    if (toolName === "memory.confirmed.read") {
      return Object.freeze({
        ok: true,
        deferred: false,
        tool_name: toolName,
        reason: "read_only_marker",
        evidence: Object.freeze([
          createEvidenceRecord({
            epistemic: "VERIFIED",
            claim: "memory.confirmed.read policy gate passed; use ConfirmedMemoryStore for data",
            source: "task.executor",
            taskId,
            correlationId,
            detail: { tool_name: toolName },
          }),
          createEvidenceRecord({
            epistemic: "RETRIEVED",
            claim: "caller should read ConfirmedMemoryStore separately",
            source: "task.executor",
            taskId,
            correlationId,
            detail: { tool_name: toolName },
          }),
        ]),
        expectations: Object.freeze([{ claim_includes: "policy gate passed" }]),
      });
    }

    fail("executor_handler_not_implemented", 501);
  }

  return Object.freeze({ executeStep, toolRegistry });
}
