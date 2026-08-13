/**
 * Task Orchestrator — Executor와 Verifier를 연결하고 실패 시 NEEDS_REPLAN으로 보낸다.
 */
import { createTaskExecutor } from "./task-executor.mjs";
import { verifyTaskOutcome, verificationEvidence } from "../verifier/task-verifier.mjs";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

export function createTaskOrchestrator({
  taskStore,
  executor = createTaskExecutor(),
  structuredLog = null,
} = {}) {
  if (!taskStore || typeof taskStore.transition !== "function") fail("invalid_task_store");

  async function emit(event, fields) {
    if (!structuredLog?.emit) return;
    await structuredLog.emit(event, fields).catch(() => {});
  }

  /**
   * 승인·채널 정책을 지키며 한 작업을 실행→검증한다.
   * toolName이 고위험 deferred면 SUCCESS로 올리지 않는다.
   */
  async function run({
    taskId,
    toolName,
    channel = "local_owner_app",
    hasApproval = false,
    expectations = [],
  } = {}) {
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
      return run({ taskId, toolName, channel, hasApproval, expectations });
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
