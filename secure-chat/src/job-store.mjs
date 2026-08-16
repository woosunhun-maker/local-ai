/**
 * 말은 대화에 두고, 하는 일은 jobId로 따로 둔다. 앱이 꺼져도 맥에 남는다.
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const JOB_SCHEMA = "local-ai.jobs.v1";
export const JOB_STATUSES = Object.freeze({
  running: { status: "running", label: "하는 중" },
  needs_review: { status: "needs_review", label: "확인 필요" },
  done: { status: "done", label: "끝남" },
  failed: { status: "failed", label: "못 함" },
  cancelled: { status: "cancelled", label: "중단" },
});

const MAX_JOBS = 200;
const MAX_EVENTS = 400;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function nowIso() {
  return new Date().toISOString();
}

function emptyState() {
  return { schema: JOB_SCHEMA, jobs: [], events: [], requestIndex: {}, updatedAt: nowIso() };
}

function publicJob(job) {
  return {
    id: job.id,
    conversationId: job.conversationId,
    userMessageId: job.userMessageId ?? null,
    title: job.title,
    status: job.status,
    label: job.label,
    detail: job.detail,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    endedAt: job.endedAt ?? null,
  };
}

export class JobStore {
  constructor(filePath) {
    if (typeof filePath !== "string" || !resolve(filePath).startsWith("/")) fail("invalid_job_path");
    this.path = resolve(filePath);
    this.initialized = false;
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#write(emptyState());
    }
    this.initialized = true;
    await this.recoverInterrupted();
    return this;
  }

  async recoverInterrupted() {
    const state = await this.#read();
    let changed = false;
    for (const job of state.jobs) {
      if (job.status !== "running") continue;
      job.status = "needs_review";
      job.label = JOB_STATUSES.needs_review.label;
      job.detail = "다시 이어야 하는지 확인이 필요합니다.";
      job.updatedAt = nowIso();
      this.#event(state, job, "needs_review");
      changed = true;
    }
    if (changed) await this.#write(state);
  }

  async start({ conversationId, clientRequestId, title, userMessageId, detail }) {
    const requestKey = String(clientRequestId ?? "").trim();
    if (requestKey && !/^[0-9a-f-]{16,36}$/i.test(requestKey)) fail("invalid_client_request_id");
    const state = await this.#read();
    if (requestKey && state.requestIndex[requestKey]) {
      const existing = state.jobs.find((item) => item.id === state.requestIndex[requestKey]);
      if (existing) return { job: publicJob(existing), replay: true };
    }
    const job = {
      id: randomUUID(),
      clientRequestId: requestKey || null,
      conversationId,
      userMessageId: userMessageId ?? null,
      title: String(title ?? "일").replace(/\s+/g, " ").trim().slice(0, 48) || "일",
      ...JOB_STATUSES.running,
      detail: String(detail ?? "확인하고 있습니다.").slice(0, 120),
      startedAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
    };
    state.jobs.unshift(job);
    if (requestKey) state.requestIndex[requestKey] = job.id;
    this.#event(state, job, "running");
    this.#trim(state);
    await this.#write(state);
    return { job: publicJob(job), replay: false };
  }

  async get(id) {
    const job = (await this.#read()).jobs.find((item) => item.id === id);
    if (!job) fail("job_not_found", 404);
    return publicJob(job);
  }

  async list({ conversationId, status } = {}) {
    return (await this.#read()).jobs
      .filter((item) => !conversationId || item.conversationId === conversationId)
      .filter((item) => !status || item.status === status)
      .slice(0, 80)
      .map(publicJob);
  }

  async update(id, { status, detail, userMessageId }) {
    const next = JOB_STATUSES[status];
    if (status && !next) fail("invalid_job_status");
    const state = await this.#read();
    const job = state.jobs.find((item) => item.id === id);
    if (!job) fail("job_not_found", 404);
    if (next) {
      job.status = next.status;
      job.label = next.label;
      if (next.status !== "running") job.endedAt = nowIso();
    }
    if (typeof detail === "string") job.detail = detail.slice(0, 120);
    if (userMessageId) job.userMessageId = userMessageId;
    job.updatedAt = nowIso();
    this.#event(state, job, job.status);
    await this.#write(state);
    return publicJob(job);
  }

  async cancel(id) {
    const current = await this.get(id);
    if (current.status !== "running") return current;
    return this.update(id, { status: "cancelled", detail: "중단했습니다." });
  }

  async events({ since } = {}) {
    const events = (await this.#read()).events;
    if (!since) return events.slice(-80);
    const index = events.findIndex((item) => item.id === since);
    return index >= 0 ? events.slice(index + 1) : events.slice(-80);
  }

  #event(state, job, type) {
    state.events.push({
      id: randomUUID(),
      at: nowIso(),
      jobId: job.id,
      conversationId: job.conversationId,
      type,
      status: job.status,
      label: job.label,
    });
  }

  #trim(state) {
    if (state.jobs.length > MAX_JOBS) state.jobs = state.jobs.slice(0, MAX_JOBS);
    if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
  }

  async #read() {
    if (!this.initialized) fail("jobs_not_initialized", 500);
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== JOB_SCHEMA || !Array.isArray(raw.jobs)) fail("invalid_job_file", 500);
    raw.events = Array.isArray(raw.events) ? raw.events : [];
    raw.requestIndex = raw.requestIndex && typeof raw.requestIndex === "object" ? raw.requestIndex : {};
    return raw;
  }

  async #write(data) {
    data.updatedAt = nowIso();
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }
}

export const CAPABILITIES = Object.freeze({
  apiVersion: "1.1",
  appName: "로컬 AI",
  features: {
    conversations: true,
    jobs: true,
    clientRequestId: true,
    events: true,
    join: true,
    photos: true,
    push: false,
    approvals: false,
    search: false,
    memoryManagement: false,
    liveActivities: false,
  },
});
