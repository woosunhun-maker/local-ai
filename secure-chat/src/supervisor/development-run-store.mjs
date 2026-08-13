/**
 * DevelopmentRun store — Supervisor 상위 실행 단위 + 예산/종료조건.
 * leaf Task Manager를 대체하지 않는다.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEVELOPMENT_RUN_SCHEMA = "local-ai.development-run.v1";
export const DEVELOPMENT_RUN_STORE_SCHEMA = "local-ai.development-run-store.v1";

export const DEVELOPMENT_RUN_STATUSES = Object.freeze([
  "DISCUSSING",
  "INSPECTING",
  "ANALYZING",
  "PROPOSING",
  "WAITING_ENVELOPE_APPROVAL",
  "RUNNING_TASKS",
  "WAITING_OWNER",
  "REPORTING",
  "DONE",
  "BLOCKED",
  "FAILED",
]);

const STATUS_SET = new Set(DEVELOPMENT_RUN_STATUSES);
const MAX_RUNS = 100;

export const DEVELOPMENT_RUN_TRANSITIONS = Object.freeze({
  DISCUSSING: Object.freeze(["INSPECTING", "FAILED", "BLOCKED"]),
  INSPECTING: Object.freeze(["ANALYZING", "FAILED", "BLOCKED"]),
  ANALYZING: Object.freeze(["PROPOSING", "FAILED", "BLOCKED"]),
  PROPOSING: Object.freeze(["WAITING_ENVELOPE_APPROVAL", "WAITING_OWNER", "FAILED", "BLOCKED"]),
  WAITING_ENVELOPE_APPROVAL: Object.freeze(["RUNNING_TASKS", "FAILED", "BLOCKED"]),
  RUNNING_TASKS: Object.freeze(["WAITING_OWNER", "REPORTING", "BLOCKED", "FAILED", "DONE"]),
  WAITING_OWNER: Object.freeze(["RUNNING_TASKS", "PROPOSING", "WAITING_ENVELOPE_APPROVAL", "REPORTING", "BLOCKED", "FAILED"]),
  REPORTING: Object.freeze(["DONE", "BLOCKED", "FAILED"]),
  DONE: Object.freeze([]),
  BLOCKED: Object.freeze(["WAITING_OWNER", "FAILED"]),
  FAILED: Object.freeze([]),
});

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function defaultBudget(overrides = {}) {
  return Object.freeze({
    max_leaf_tasks: Number.isInteger(overrides.max_leaf_tasks) ? overrides.max_leaf_tasks : 3,
    max_replans_per_task: Number.isInteger(overrides.max_replans_per_task) ? overrides.max_replans_per_task : 2,
    max_total_attempts: Number.isInteger(overrides.max_total_attempts) ? overrides.max_total_attempts : 6,
    max_runtime_ms: Number.isInteger(overrides.max_runtime_ms) ? overrides.max_runtime_ms : 60 * 60_000,
  });
}

function publicRun(run) {
  return Object.freeze({
    schema: run.schema,
    run_id: run.run_id,
    goal: run.goal,
    status: run.status,
    channel: run.channel,
    discussion_id: run.discussion_id,
    proposal: run.proposal,
    envelope: run.envelope,
    envelope_approval_id: run.envelope_approval_id,
    worktree: run.worktree,
    leaf_task_ids: Object.freeze([...(run.leaf_task_ids ?? [])]),
    budget: run.budget,
    counters: run.counters,
    inspection: run.inspection,
    report: run.report,
    blocked_reason: run.blocked_reason,
    error: run.error,
    created_at: run.created_at,
    updated_at: run.updated_at,
    expires_at: run.expires_at,
  });
}

export class DevelopmentRunStore {
  constructor(path, { now = () => Date.now(), idFactory = () => randomUUID() } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) fail("invalid_development_run_path");
    this.path = path;
    this.now = now;
    this.idFactory = idFactory;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await this.read();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.write({ version: 1, schema: DEVELOPMENT_RUN_STORE_SCHEMA, runs: [] });
    }
    return this;
  }

  async read() {
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== DEVELOPMENT_RUN_STORE_SCHEMA || !Array.isArray(raw.runs)) {
      fail("invalid_development_run_store", 500);
    }
    return raw;
  }

  async write(value) {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  serialized(work) {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async create({
    goal,
    channel = "local_owner_app",
    budget = {},
    discussionId = null,
    correlationId = null,
  } = {}) {
    if (channel === "telegram") fail("telegram_development_run_forbidden", 403);
    if (typeof goal !== "string" || goal.trim().length < 8) fail("invalid_run_goal");
    const budgetNorm = defaultBudget(budget);
    for (const [key, max] of [
      ["max_leaf_tasks", 20],
      ["max_replans_per_task", 10],
      ["max_total_attempts", 50],
    ]) {
      if (!Number.isInteger(budgetNorm[key]) || budgetNorm[key] < 0 || budgetNorm[key] > max) {
        fail(`invalid_budget_${key}`);
      }
    }
    if (!Number.isInteger(budgetNorm.max_runtime_ms) || budgetNorm.max_runtime_ms < 60_000) {
      fail("invalid_budget_max_runtime_ms");
    }

    return this.serialized(async () => {
      const store = await this.read();
      const atMs = this.now();
      const at = new Date(atMs).toISOString();
      const run = {
        schema: DEVELOPMENT_RUN_SCHEMA,
        run_id: this.idFactory(),
        goal: goal.trim().slice(0, 2_000),
        status: "DISCUSSING",
        channel,
        discussion_id: discussionId,
        correlation_id: correlationId,
        proposal: null,
        envelope: null,
        envelope_approval_id: null,
        worktree: null,
        leaf_task_ids: [],
        budget: budgetNorm,
        counters: Object.freeze({
          leaf_tasks_created: 0,
          total_attempts: 0,
          replans_by_task: {},
        }),
        inspection: null,
        report: null,
        blocked_reason: null,
        error: null,
        created_at: at,
        updated_at: at,
        expires_at: new Date(atMs + budgetNorm.max_runtime_ms).toISOString(),
      };
      store.runs = [run, ...store.runs].slice(0, MAX_RUNS);
      await this.write(store);
      return publicRun(run);
    });
  }

  async get(runId) {
    const store = await this.read();
    const run = store.runs.find((item) => item.run_id === runId);
    return run ? publicRun(run) : null;
  }

  async list({ status = null, limit = 50 } = {}) {
    const store = await this.read();
    let runs = store.runs;
    if (status) runs = runs.filter((item) => item.status === status);
    return runs.slice(0, Math.min(100, Math.max(1, limit))).map(publicRun);
  }

  async transition(runId, {
    toStatus,
    patch = {},
    error = undefined,
    blockedReason = undefined,
  } = {}) {
    if (!STATUS_SET.has(toStatus)) fail("invalid_run_status");
    return this.serialized(async () => {
      const store = await this.read();
      const index = store.runs.findIndex((item) => item.run_id === runId);
      if (index < 0) fail("development_run_not_found", 404);
      const run = store.runs[index];
      const allowed = DEVELOPMENT_RUN_TRANSITIONS[run.status] ?? [];
      if (!allowed.includes(toStatus)) fail("invalid_run_transition", 409);

      const at = new Date(this.now()).toISOString();
      const next = {
        ...run,
        ...patch,
        status: toStatus,
        updated_at: at,
        error: error === undefined ? (toStatus === "DONE" ? null : run.error) : error,
        blocked_reason: blockedReason === undefined
          ? (toStatus === "BLOCKED" ? run.blocked_reason : (toStatus === "DONE" ? null : run.blocked_reason))
          : blockedReason,
      };
      store.runs[index] = next;
      await this.write(store);
      return publicRun(next);
    });
  }

  async update(runId, patch = {}) {
    return this.serialized(async () => {
      const store = await this.read();
      const index = store.runs.findIndex((item) => item.run_id === runId);
      if (index < 0) fail("development_run_not_found", 404);
      const run = store.runs[index];
      const next = {
        ...run,
        ...patch,
        updated_at: new Date(this.now()).toISOString(),
      };
      store.runs[index] = next;
      await this.write(store);
      return publicRun(next);
    });
  }

  /**
   * 예산/만료 검사. 초과 시 BLOCKED 사유 반환 (상태 변경은 호출측).
   */
  evaluateBudget(run, { nowMs = this.now() } = {}) {
    if (!run) return Object.freeze({ ok: false, reason: "run_missing" });
    if (run.expires_at && Date.parse(run.expires_at) <= nowMs) {
      return Object.freeze({ ok: false, reason: "max_runtime_exceeded" });
    }
    const budget = run.budget ?? defaultBudget();
    const counters = run.counters ?? {};
    if ((counters.leaf_tasks_created ?? 0) > budget.max_leaf_tasks) {
      return Object.freeze({ ok: false, reason: "max_leaf_tasks_exceeded" });
    }
    if ((counters.total_attempts ?? 0) > budget.max_total_attempts) {
      return Object.freeze({ ok: false, reason: "max_total_attempts_exceeded" });
    }
    return Object.freeze({ ok: true, reason: "within_budget" });
  }

  canCreateLeafTask(run) {
    const budget = run.budget ?? defaultBudget();
    return (run.counters?.leaf_tasks_created ?? 0) < budget.max_leaf_tasks
      && (run.counters?.total_attempts ?? 0) < budget.max_total_attempts;
  }

  canReplanTask(run, taskId) {
    const budget = run.budget ?? defaultBudget();
    const count = run.counters?.replans_by_task?.[taskId] ?? 0;
    return count < budget.max_replans_per_task
      && (run.counters?.total_attempts ?? 0) < budget.max_total_attempts;
  }
}
