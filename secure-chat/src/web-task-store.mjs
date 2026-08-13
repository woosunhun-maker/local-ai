import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_JOBS = 100;
const STATUSES = new Set(["ready", "awaiting_approval", "running", "succeeded", "failed", "blocked", "cancelled"]);

function storeError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function validateJob(job) {
  if (!job || job.version !== 1 || typeof job.id !== "string" || typeof job.planSha256 !== "string") throw new Error("invalid_web_task_job");
  if (!STATUSES.has(job.status) || !Number.isFinite(Date.parse(job.createdAt)) || !Number.isFinite(Date.parse(job.updatedAt))) {
    throw new Error("invalid_web_task_job");
  }
  if (typeof job.action !== "string" || typeof job.requiresApproval !== "boolean") throw new Error("invalid_web_task_job");
  if (typeof job.planCanonical !== "string" || createHash("sha256").update(job.planCanonical).digest("hex") !== job.planSha256) {
    throw new Error("invalid_web_task_plan_binding");
  }
  if (job.approvalRequestId !== null && typeof job.approvalRequestId !== "string") throw new Error("invalid_web_task_job");
  if (job.result !== null) {
    if (!job.result || typeof job.result !== "object" || Array.isArray(job.result)) throw new Error("invalid_web_task_result");
    if (typeof job.result.code !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(job.result.code)) throw new Error("invalid_web_task_result");
    if (!Number.isSafeInteger(job.result.itemCount) || job.result.itemCount < 0 || job.result.itemCount > 100) throw new Error("invalid_web_task_result");
  }
  return job;
}

function validateStore(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.jobs)) throw new Error("invalid_web_task_store");
  const ids = new Set();
  for (const job of value.jobs) {
    validateJob(job);
    if (ids.has(job.id)) throw new Error("duplicate_web_task_job");
    ids.add(job.id);
  }
  return value;
}

export class WebTaskStore {
  constructor(path, { now = () => Date.now() } = {}) {
    this.path = path;
    this.now = now;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await this.read();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.write({ version: 1, jobs: [] });
    }
  }

  async read() {
    return validateStore(JSON.parse(await readFile(this.path, "utf8")));
  }

  async write(value) {
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  async create(plan, { approvalRequestId = null } = {}) {
    if (!plan || plan.schema !== "local-ai.web-task-plan.v1" || !/^[a-f0-9]{64}$/.test(plan.sha256)) {
      throw storeError("invalid_web_task_plan");
    }
    if (plan.requiresApproval !== (approvalRequestId !== null)) throw storeError("invalid_web_task_approval_binding");
    return this.serialized(async () => {
      const store = await this.read();
      const at = new Date(this.now()).toISOString();
      const job = {
        version: 1,
        id: randomUUID(),
        action: plan.action,
        planSha256: plan.sha256,
        planCanonical: plan.canonical,
        requiresApproval: plan.requiresApproval,
        approvalRequestId,
        status: plan.requiresApproval ? "awaiting_approval" : "ready",
        createdAt: at,
        updatedAt: at,
        result: null,
      };
      store.jobs.push(job);
      store.jobs = store.jobs.slice(-MAX_JOBS);
      await this.write(store);
      return structuredClone(job);
    });
  }

  async get(id) {
    const store = await this.read();
    const job = store.jobs.find((entry) => entry.id === id);
    return job ? structuredClone(job) : null;
  }

  async transition(id, from, to, result = null) {
    if (!STATUSES.has(from) || !STATUSES.has(to)) throw storeError("invalid_web_task_transition");
    const allowed = {
      ready: new Set(["running", "blocked", "cancelled"]),
      awaiting_approval: new Set(["ready", "blocked", "cancelled"]),
      running: new Set(["succeeded", "failed", "blocked"]),
    };
    if (!allowed[from]?.has(to)) throw storeError("invalid_web_task_transition", 409);
    return this.serialized(async () => {
      const store = await this.read();
      const job = store.jobs.find((entry) => entry.id === id);
      if (!job) throw storeError("web_task_not_found", 404);
      if (job.status !== from) throw storeError("web_task_state_conflict", 409);
      if (result !== null) validateJob({ ...job, status: to, result, updatedAt: new Date(this.now()).toISOString() });
      job.status = to;
      job.result = result;
      job.updatedAt = new Date(this.now()).toISOString();
      await this.write(store);
      return structuredClone(job);
    });
  }

  async serialized(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
