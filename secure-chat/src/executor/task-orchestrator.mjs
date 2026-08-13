/**
 * Task Orchestrator — Executor·Verifier·CursorDevelopmentAdapter 연결.
 * cursor.develop은 has_approval boolean이 아니라 ApprovalStore 재조회로만 진행한다.
 */
import { createTaskExecutor } from "./task-executor.mjs";
import { verifyTaskOutcome, verificationEvidence } from "../verifier/task-verifier.mjs";
import { verifyCursorHostOutcome } from "../adapters/cursor/cursor-development-adapter.mjs";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

export function createTaskOrchestrator({
  taskStore,
  executor = createTaskExecutor(),
  cursorAdapter = null,
  structuredLog = null,
} = {}) {
  if (!taskStore || typeof taskStore.transition !== "function") fail("invalid_task_store");

  async function emit(event, fields) {
    if (!structuredLog?.emit) return;
    await structuredLog.emit(event, fields).catch(() => {});
  }

  async function advanceToPlanned(taskId, current) {
    let next = current;
    if (next.status === "CREATED") {
      next = await taskStore.transition(taskId, {
        toStatus: "ANALYZING",
        currentStep: "analyze",
        nextStep: "plan",
      });
    }
    if (next.status === "ANALYZING") {
      next = await taskStore.transition(taskId, {
        toStatus: "PLANNED",
        currentStep: "plan",
        nextStep: next.approval_required ? "await_approval" : "execute",
      });
    }
    return next;
  }

  async function runCursorDevelop({
    taskId,
    channel = "local_owner_app",
    prompt,
    testCommand = null,
  }) {
    if (!cursorAdapter) fail("cursor_adapter_unavailable", 503);
    if (channel === "telegram") {
      let current = await taskStore.get(taskId);
      if (!current) fail("task_not_found", 404);
      current = await advanceToPlanned(taskId, current);
      if (current.status === "PLANNED" && current.approval_required) {
        current = await taskStore.transition(taskId, {
          toStatus: "WAITING_APPROVAL",
          currentStep: "await_approval",
          nextStep: "execute",
        });
      }
      if (["WAITING_APPROVAL", "EXECUTING", "PLANNED"].includes(current.status)) {
        const toFailed = current.status === "PLANNED" && !current.approval_required
          ? "FAILED"
          : (current.status === "PLANNED" ? null : "FAILED");
        if (current.status === "PLANNED" && !current.approval_required) {
          current = await taskStore.transition(taskId, {
            toStatus: "FAILED",
            currentStep: "telegram_denied",
            error: "telegram_cursor_develop_forbidden",
          });
        } else if (toFailed === "FAILED" || current.status === "WAITING_APPROVAL" || current.status === "EXECUTING") {
          if (current.status === "PLANNED") {
            current = await taskStore.transition(taskId, {
              toStatus: "WAITING_APPROVAL",
              currentStep: "await_approval",
              nextStep: "execute",
            });
          }
          current = await taskStore.transition(taskId, {
            toStatus: "FAILED",
            currentStep: "telegram_denied",
            error: "telegram_cursor_develop_forbidden",
          });
        }
      }
      return Object.freeze({
        task: current,
        phase: "FAILED",
        verification: Object.freeze({ result: "FAIL", reason: "telegram_cursor_develop_forbidden" }),
        message: "Telegram에서 cursor.develop 실행 금지",
      });
    }

    let current = await taskStore.get(taskId);
    if (!current) fail("task_not_found", 404);
    if (current.approval_required !== true) fail("cursor_develop_requires_approval_flag", 409);

    current = await advanceToPlanned(taskId, current);
    if (current.status === "NEEDS_REPLAN") {
      current = await taskStore.transition(taskId, {
        toStatus: "ANALYZING",
        currentStep: "replan",
        nextStep: "plan",
        error: null,
      });
      return runCursorDevelop({ taskId, channel, prompt, testCommand });
    }
    if (current.status === "PLANNED") {
      current = await taskStore.transition(taskId, {
        toStatus: "WAITING_APPROVAL",
        currentStep: "await_approval",
        nextStep: "execute",
      });
    }

    const result = await cursorAdapter.runDevelop({
      task: current,
      prompt,
      testCommand,
      channel,
    });

    if (result.binding) {
      current = await taskStore.setBindings(taskId, {
        cursor: {
          ...result.binding,
          session_id: result.session_id ?? null,
        },
      });
    }
    if (result.evidence?.length) {
      current = await taskStore.appendEvidence(taskId, result.evidence);
    }

    if (result.phase === "WAITING_APPROVAL") {
      return Object.freeze({
        task: current,
        phase: "WAITING_APPROVAL",
        verification: null,
        approval_id: result.approval_id,
        message: result.message,
      });
    }

    if (result.phase === "FAILED") {
      if (current.status === "WAITING_APPROVAL" || current.status === "EXECUTING") {
        current = await taskStore.transition(taskId, {
          toStatus: "FAILED",
          currentStep: "cursor_failed",
          error: result.message ?? "cursor_failed",
          evidence: result.evidence ?? [],
        });
      }
      return Object.freeze({
        task: current,
        phase: "FAILED",
        verification: Object.freeze({ result: "FAIL", reason: result.message ?? "cursor_failed" }),
        host: result.host,
        session_id: result.session_id,
      });
    }

    // EXECUTING → VERIFYING
    if (current.status === "WAITING_APPROVAL") {
      current = await taskStore.transition(taskId, {
        toStatus: "EXECUTING",
        currentStep: "cursor_acp",
        nextStep: "verify",
      });
    }
    if (current.status === "EXECUTING") {
      current = await taskStore.transition(taskId, {
        toStatus: "VERIFYING",
        currentStep: "verify",
        nextStep: "complete",
        evidence: result.evidence ?? [],
      });
    }

    const outcome = verifyCursorHostOutcome(result.host);
    const verification = outcome.result === "PASS"
      ? verifyTaskOutcome({
        task: current,
        expectations: outcome.expectations,
        requireVerified: true,
      })
      : Object.freeze({
        result: outcome.result === "FAIL" ? "FAIL" : "UNKNOWN",
        reason: outcome.reason,
        checked_at: new Date().toISOString(),
        matched: Object.freeze([]),
        missing: Object.freeze([]),
      });

    const evidence = [verificationEvidence(verification, { taskId })];
    if (verification.result === "PASS") {
      current = await taskStore.transition(taskId, {
        toStatus: "SUCCESS",
        currentStep: "done",
        nextStep: null,
        evidence,
      });
    } else if (verification.result === "FAIL") {
      current = await taskStore.transition(taskId, {
        toStatus: "NEEDS_REPLAN",
        currentStep: "verify_failed",
        nextStep: "replan",
        error: verification.reason,
        evidence,
      });
    } else {
      current = await taskStore.transition(taskId, {
        toStatus: "NEEDS_REPLAN",
        currentStep: "verify_unknown",
        nextStep: "replan",
        error: verification.reason,
        evidence,
      });
    }

    await emit("verification_completed", {
      correlationId: current.correlation_id ?? taskId,
      task_id: taskId,
      result: verification.result,
    });

    return Object.freeze({
      task: current,
      phase: current.status,
      verification,
      host: result.host,
      session_id: result.session_id,
      approval_id: result.approval_id,
    });
  }

  async function run({
    taskId,
    toolName,
    channel = "local_owner_app",
    hasApproval = false,
    prompt = null,
    testCommand = null,
    expectations = [],
  } = {}) {
    if (toolName === "cursor.develop") {
      return runCursorDevelop({
        taskId,
        channel,
        prompt: prompt ?? (await taskStore.get(taskId))?.goal,
        testCommand,
      });
    }

    const task = await taskStore.get(taskId);
    if (!task) fail("task_not_found", 404);

    let current = task;
    if (current.status === "CREATED") {
      current = await taskStore.transition(taskId, {
        toStatus: "ANALYZING",
        currentStep: "analyze",
        nextStep: "plan",
      });
    }
    if (current.status === "ANALYZING") {
      current = await taskStore.transition(taskId, {
        toStatus: "PLANNED",
        currentStep: "plan",
        nextStep: current.approval_required ? "await_approval" : "execute",
      });
    }
    if (current.status === "PLANNED" && current.approval_required) {
      current = await taskStore.transition(taskId, {
        toStatus: "WAITING_APPROVAL",
        currentStep: "await_approval",
        nextStep: "execute",
      });
      return Object.freeze({
        task: current,
        phase: "WAITING_APPROVAL",
        verification: null,
        message: "승인 대기. Face ID/기존 ApprovalStore 경로로 승인한 뒤 hasApproval=true로 재실행.",
      });
    }
    if (current.status === "WAITING_APPROVAL") {
      if (!hasApproval) {
        return Object.freeze({
          task: current,
          phase: "WAITING_APPROVAL",
          verification: null,
          message: "승인 없음. 실행하지 않음.",
        });
      }
      current = await taskStore.transition(taskId, {
        toStatus: "EXECUTING",
        currentStep: "execute",
        nextStep: "verify",
      });
    } else if (current.status === "PLANNED" && !current.approval_required) {
      current = await taskStore.transition(taskId, {
        toStatus: "EXECUTING",
        currentStep: "execute",
        nextStep: "verify",
      });
    } else if (current.status === "NEEDS_REPLAN") {
      current = await taskStore.transition(taskId, {
        toStatus: "ANALYZING",
        currentStep: "replan",
        nextStep: "plan",
        error: null,
      });
      return run({ taskId, toolName, channel, hasApproval, prompt, testCommand, expectations });
    }

    if (current.status !== "EXECUTING") {
      fail("task_not_runnable", 409);
    }

    let execution;
    try {
      execution = await executor.executeStep({
        toolName,
        channel,
        hasApproval,
        taskId,
        correlationId: current.correlation_id,
        expectations,
      });
    } catch (error) {
      current = await taskStore.transition(taskId, {
        toStatus: "FAILED",
        currentStep: "execute_failed",
        error: error?.message ?? "executor_failed",
        evidence: [],
      });
      return Object.freeze({
        task: current,
        phase: "FAILED",
        verification: Object.freeze({ result: "FAIL", reason: error?.message ?? "executor_failed" }),
        execution: null,
      });
    }

    current = await taskStore.transition(taskId, {
      toStatus: "VERIFYING",
      currentStep: "verify",
      nextStep: "complete",
      evidence: execution.evidence ?? [],
    });

    await emit("verification_started", {
      correlationId: current.correlation_id ?? taskId,
      task_id: taskId,
    });

    const verification = verifyTaskOutcome({
      task: current,
      expectations: execution.expectations?.length ? execution.expectations : expectations,
      requireVerified: true,
    });

    const evidence = [verificationEvidence(verification, { taskId })];

    if (execution.deferred) {
      current = await taskStore.transition(taskId, {
        toStatus: "NEEDS_REPLAN",
        currentStep: "deferred_existing_module",
        nextStep: "use_existing_path",
        error: "existing_module_path_required",
        evidence,
      });
      await emit("verification_completed", {
        correlationId: current.correlation_id ?? taskId,
        task_id: taskId,
        result: "UNKNOWN",
      });
      return Object.freeze({
        task: current,
        phase: "NEEDS_REPLAN",
        verification: Object.freeze({ ...verification, result: "UNKNOWN", reason: "deferred_existing_module" }),
        execution,
      });
    }

    if (verification.result === "PASS") {
      current = await taskStore.transition(taskId, {
        toStatus: "SUCCESS",
        currentStep: "done",
        nextStep: null,
        evidence,
      });
    } else if (verification.result === "FAIL") {
      current = await taskStore.transition(taskId, {
        toStatus: "NEEDS_REPLAN",
        currentStep: "verify_failed",
        nextStep: "replan",
        error: verification.reason,
        evidence,
      });
    } else {
      current = await taskStore.transition(taskId, {
        toStatus: "NEEDS_REPLAN",
        currentStep: "verify_unknown",
        nextStep: "replan",
        error: verification.reason,
        evidence,
      });
    }

    await emit("verification_completed", {
      correlationId: current.correlation_id ?? taskId,
      task_id: taskId,
      result: verification.result,
    });

    return Object.freeze({
      task: current,
      phase: current.status,
      verification,
      execution: Object.freeze({
        ok: execution.ok,
        deferred: execution.deferred,
        tool_name: execution.tool_name,
        reason: execution.reason,
      }),
    });
  }

  async function replan(taskId) {
    const task = await taskStore.get(taskId);
    if (!task) fail("task_not_found", 404);
    if (task.status !== "NEEDS_REPLAN" && task.status !== "FAILED") {
      fail("task_not_replanable", 409);
    }
    return taskStore.transition(taskId, {
      toStatus: "ANALYZING",
      currentStep: "replan",
      nextStep: "plan",
      error: null,
    });
  }

  return Object.freeze({ run, replan });
}
