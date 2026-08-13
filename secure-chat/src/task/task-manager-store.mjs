import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { EVIDENCE_RECORD_SCHEMA, createEvidenceRecord } from "../evidence/evidence.mjs";

export const TASK_STATUSES = Object.freeze([
  "CREATED",
  "ANALYZING",
  "PLANNED",
  "WAITING_APPROVAL",
  "EXECUTING",
  "VERIFYING",
  "SUCCESS",
  "FAILED",
  "NEEDS_REPLAN",
]);

const STATUS_SET = new Set(TASK_STATUSES);
const MAX_TASKS = 200;
const MAX_EVIDENCE_PER_TASK = 50;

export const TASK_STORE_SCHEMA = "local-ai.task-manager.v1";

/** 허용된 상태 전이. Executor/Verifier는 task-orchestrator가 사용한다. */
export const TASK_TRANSITIONS = Object.freeze({
  CREATED: Object.freeze(["ANALYZING", "FAILED"]),
  ANALYZING: Object.freeze(["PLANNED", "FAILED", "NEEDS_REPLAN"]),
  PLANNED: Object.freeze(["WAITING_APPROVAL", "EXECUTING", "FAILED"]),
  WAITING_APPROVAL: Object.freeze(["EXECUTING", "FAILED", "NEEDS_REPLAN"]),
  EXECUTING: Object.freeze(["VERIFYING", "FAILED", "NEEDS_REPLAN"]),
  VERIFYING: Object.freeze(["SUCCESS", "FAILED", "NEEDS_REPLAN"]),
  SUCCESS: Object.freeze([]),
  FAILED: Object.freeze(["NEEDS_REPLAN"]),
  NEEDS_REPLAN: Object.freeze(["ANALYZING", "PLANNED", "FAILED"]),
});

function taskError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function boundedGoal(value) {
  if (typeof value !== "string") throw taskError("invalid_task_goal");
  const goal = value.trim();
  if (goal.length < 1 || goal.length > 2_000) throw taskError("invalid_task_goal");
  return goal;
}

function optionalStep(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw taskError(`invalid_task_${field}`);
  const step = value.trim();
  if (step.length < 1 || step.length > 500) throw taskError(`invalid_task_${field}`);
  return step;
}

function optionalError(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw taskError("invalid_task_error");
  return value.trim().slice(0, 500);
}

function normalizeEvidenceList(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw taskError("invalid_task_evidence");
  if (value.length > MAX_EVIDENCE_PER_TASK) throw taskError("task_evidence_limit");
  return value.map((entry) => {
    if (entry?.schema === EVIDENCE_RECORD_SCHEMA) {
      return createEvidenceRecord({
        epistemic: entry.epistemic,
        claim: entry.claim,
        source: entry.source,
        observedAt: entry.observed_at,
        evidenceId: entry.evidence_id,
        taskId: entry.task_id,
        correlationId: entry.correlation_id,
        detail: entry.detail,
      });
    }
    return createEvidenceRecord(entry);
  });
}

function validateTask(task) {
  if (!task || task.schema !== "local-ai.task.v1") throw taskError("invalid_task_schema");
  if (typeof task.task_id !== "string" || task.task_id.length < 8) throw taskError("invalid_task_id");
  if (!STATUS_SET.has(task.status)) throw taskError("invalid_task_status");
  if (typeof task.goal !== "string") throw taskError("invalid_task_goal");
  if (!Number.isFinite(Date.parse(task.created_at)) || !Number.isFinite(Date.parse(task.updated_at))) {
    throw taskError("invalid_task_timestamps");
  }
  if (typeof task.approval_required !== "boolean") throw taskError("invalid_task_approval_required");
  normalizeEvidenceList(task.evidence);
  return task;
}

function validateStore(value) {
  if (!value || value.version !== 1 || value.schema !== TASK_STORE_SCHEMA || !Array.isArray(value.tasks)) {
    throw taskError("invalid_task_store");
  }
  const ids = new Set();
  for (const task of value.tasks) {
    validateTask(task);
    if (ids.has(task.task_id)) throw taskError("duplicate_task_id");
    ids.add(task.task_id);
  }
  return value;
}

function publicTask(task) {
  return Object.freeze({
    task_id: task.task_id,
    goal: task.goal,
    status: task.status,
    created_at: task.created_at,
    updated_at: task.updated_at,
    current_step: task.current_step,
    next_step: task.next_step,
    evidence: Object.freeze((task.evidence ?? []).map((item) => Object.freeze({ ...item }))),
    error: task.error,
    approval_required: task.approval_required,
    correlation_id: task.correlation_id ?? null,
  });
}

export class TaskManagerStore {
  constructor(path, {
    now = () => Date.now(),
    idFactory = () => randomUUID(),
    structuredLog = null,
  } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError("task store path required");
    this.path = path;
    this.now = now;
    this.idFactory = idFactory;
    this.structuredLog = structuredLog;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await this.read();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.write({ version: 1, schema: TASK_STORE_SCHEMA, tasks: [] });
    }
  }

  async read() {
    return validateStore(JSON.parse(await readFile(this.path, "utf8")));
  }

  async write(value) {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validateStore(value), null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  serialized(work) {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #emit(event, fields) {
    if (!this.structuredLog?.emit) return;
    await this.structuredLog.emit(event, fields).catch(() => {});
  }

  async create({
    goal,
    approvalRequired = true,
    currentStep = null,
    nextStep = "analyze",
    correlationId = null,
    evidence = [],
  } = {}) {
    return this.serialized(async () => {
      const store = await this.read();
      const at = new Date(this.now()).toISOString();
      const taskId = this.idFactory();
      const records = normalizeEvidenceList(evidence).map((item) => ({
        ...item,
        task_id: taskId,
      }));
      const task = {
        schema: "local-ai.task.v1",
        task_id: taskId,
        goal: boundedGoal(goal),
        status: "CREATED",
        created_at: at,
        updated_at: at,
        current_step: optionalStep(currentStep, "current_step"),
        next_step: optionalStep(nextStep, "next_step"),
        evidence: records,
        error: null,
        approval_required: approvalRequired === true,
        correlation_id: typeof correlationId === "string" && correlationId.length >= 8
          ? correlationId
          : null,
      };
      store.tasks.push(task);
      store.tasks = store.tasks.slice(-MAX_TASKS);
      await this.write(store);
      await this.#emit("task_started", {
        correlationId: task.correlation_id ?? task.task_id,
        task_id: task.task_id,
        status: task.status,
      });
      return publicTask(task);
    });
  }

  async get(taskId) {
    const store = await this.read();
    const task = store.tasks.find((entry) => entry.task_id === taskId);
    return task ? publicTask(task) : null;
  }

  async list({ limit = 50, status = null } = {}) {
    const store = await this.read();
    let tasks = [...store.tasks].reverse();
    if (status != null) {
      if (!STATUS_SET.has(status)) throw taskError("invalid_task_status_filter");
      tasks = tasks.filter((task) => task.status === status);
    }
    const capped = Math.min(Math.max(1, Number(limit) || 50), 100);
    return Object.freeze(tasks.slice(0, capped).map(publicTask));
  }

  async transition(taskId, {
    toStatus,
    currentStep = undefined,
    nextStep = undefined,
    error = undefined,
    evidence = [],
    correlationId = null,
  } = {}) {
    if (!STATUS_SET.has(toStatus)) throw taskError("invalid_task_status");
    return this.serialized(async () => {
      const store = await this.read();
      const index = store.tasks.findIndex((entry) => entry.task_id === taskId);
      if (index < 0) throw taskError("task_not_found", 404);
      const task = store.tasks[index];
      const allowed = TASK_TRANSITIONS[task.status] ?? [];
      if (!allowed.includes(toStatus)) throw taskError("invalid_task_transition", 409);

      if (toStatus === "WAITING_APPROVAL" && task.approval_required !== true) {
        throw taskError("approval_not_required", 409);
      }
      if (toStatus === "EXECUTING" && task.status === "PLANNED" && task.approval_required === true) {
        throw taskError("approval_required_before_execute", 409);
      }

      const at = new Date(this.now()).toISOString();
      const added = normalizeEvidenceList(evidence).map((item) => ({
        ...item,
        task_id: task.task_id,
      }));
      const nextEvidence = [...task.evidence, ...added].slice(-MAX_EVIDENCE_PER_TASK);

      if (toStatus === "VERIFYING") {
        await this.#emit("verification_started", {
          correlationId: correlationId ?? task.correlation_id ?? task.task_id,
          task_id: task.task_id,
        });
      }

      const updated = {
        ...task,
        status: toStatus,
        updated_at: at,
        current_step: currentStep === undefined ? task.current_step : optionalStep(currentStep, "current_step"),
        next_step: nextStep === undefined ? task.next_step : optionalStep(nextStep, "next_step"),
        error: error === undefined ? (toStatus === "SUCCESS" ? null : task.error) : optionalError(error),
        evidence: nextEvidence,
      };
      if (toStatus === "FAILED" && !updated.error) updated.error = "task_failed";
      store.tasks[index] = updated;
      await this.write(store);

      if (toStatus === "SUCCESS") {
        await this.#emit("task_completed", {
          correlationId: correlationId ?? updated.correlation_id ?? updated.task_id,
          task_id: updated.task_id,
          status: updated.status,
        });
        await this.#emit("verification_completed", {
          correlationId: correlationId ?? updated.correlation_id ?? updated.task_id,
          task_id: updated.task_id,
          result: "PASS",
        });
      } else if (toStatus === "FAILED") {
        await this.#emit("task_failed", {
          correlationId: correlationId ?? updated.correlation_id ?? updated.task_id,
          task_id: updated.task_id,
          error_class: "TaskFailed",
        });
      } else if (toStatus === "NEEDS_REPLAN") {
        await this.#emit("verification_completed", {
          correlationId: correlationId ?? updated.correlation_id ?? updated.task_id,
          task_id: updated.task_id,
          result: "FAIL",
        });
      }

      return publicTask(updated);
    });
  }

  async appendEvidence(taskId, evidence) {
    return this.serialized(async () => {
      const store = await this.read();
      const index = store.tasks.findIndex((entry) => entry.task_id === taskId);
      if (index < 0) throw taskError("task_not_found", 404);
      const task = store.tasks[index];
      const added = normalizeEvidenceList(Array.isArray(evidence) ? evidence : [evidence])
        .map((item) => ({ ...item, task_id: task.task_id }));
      const updated = {
        ...task,
        updated_at: new Date(this.now()).toISOString(),
        evidence: [...task.evidence, ...added].slice(-MAX_EVIDENCE_PER_TASK),
      };
      store.tasks[index] = updated;
      await this.write(store);
      return publicTask(updated);
    });
  }

  async summary() {
    const store = await this.read();
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
    for (const task of store.tasks) counts[task.status] += 1;
    return Object.freeze({
      schema: "local-ai.task-manager-summary.v1",
      total: store.tasks.length,
      counts: Object.freeze(counts),
    });
  }
}
