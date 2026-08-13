import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  normalizeTaskPrincipal,
  sameTelegramPrincipal,
  validateBotId as validatePrincipalBotId,
} from "../telegram/principal.mjs";
import {
  assertCodexTextSafe,
  assertAllowedIsolatedRelativePath,
  SYNTHETIC_OWNER_ID,
} from "./isolated-workspace.mjs";
import {
  restoreOwnerCodexPlan,
  validateCodexIdempotencyKey,
  validateOwnerDeviceHash,
} from "./owner-task-plan.mjs";
import { validateDraftPatch } from "./runner.mjs";
import { PrivateFileLock } from "../private-file-lock.mjs";

const STORE_VERSION = 3;
const MAX_ACTIVE_RESERVATIONS = 3;
const TEN_MINUTES_MS = 10 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;
const MAX_PER_TEN_MINUTES = 3;
const MAX_PER_DAY = 12;
const EXECUTION_TERMINAL_STATUSES = new Set(["succeeded", "failed", "interrupted_uncertain"]);
const APPROVAL_TERMINAL_STATUSES = new Set(["rejected", "expired"]);
const TERMINAL_STATUSES = new Set([...EXECUTION_TERMINAL_STATUSES, ...APPROVAL_TERMINAL_STATUSES]);
const STATUSES = new Set(["awaiting_approval", "queued", "running", ...TERMINAL_STATUSES]);
const INTENTS = new Set(["inspect", "draft"]);
const INGRESSES = new Set(["telegram", "owner_app"]);
const JOB_KEYS = new Set([
  "version",
  "id",
  "ingress",
  "botId",
  "ownerId",
  "chatId",
  "ownerGeneration",
  "updateId",
  "messageId",
  "ownerDeviceHash",
  "idempotencyKey",
  "approvalRequestId",
  "planCanonical",
  "planSha256",
  "intent",
  "request",
  "requestSha256",
  "status",
  "workerId",
  "workerPid",
  "workerLeaseNonce",
  "createdAt",
  "updatedAt",
  "startedAt",
  "finishedAt",
  "result",
  "deliveredAt",
  "quarantinedAt",
]);
const RESULT_KEYS = new Set([
  "code", "summary", "changedFileCount", "changedPaths", "patch", "patchSha256",
]);
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cf}/u;

function taskError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function plainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw taskError(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw taskError(code);
  return value;
}

function exactKeys(value, expected, code) {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw taskError(code);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw taskError(code);
  }
}

function normalizedText(value, maximum, code) {
  if (typeof value !== "string") throw taskError(code);
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum || UNSAFE_TEXT.test(normalized)) throw taskError(code);
  return normalized;
}

function validateBotId(value) {
  try {
    return validatePrincipalBotId(value, "invalid_codex_task_bot_id");
  } catch (error) {
    throw taskError(error.message);
  }
}

function validateTelegramInteger(value, { allowZero = false, code } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) throw taskError(code);
  return value;
}

function validateIntent(value) {
  if (!INTENTS.has(value)) throw taskError("invalid_codex_task_intent");
  return value;
}

function validateWorkerId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value)) throw taskError("invalid_codex_task_worker_id");
  return value;
}

function validateWorkerPid(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw taskError("invalid_codex_task_worker_pid");
  return value;
}

function validateWorkerLeaseNonce(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value)) throw taskError("invalid_codex_task_worker_lease_nonce");
  return value;
}

function parseTimestamp(value, code = "invalid_codex_task_timestamp") {
  if (typeof value !== "string") throw new Error(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requestBindingSha256({ botId, ownerId, chatId, ownerGeneration, updateId, messageId, intent, request }) {
  return sha256(JSON.stringify([
    "codex-task-request-v2",
    botId,
    ownerId,
    chatId,
    ownerGeneration,
    updateId,
    messageId,
    intent,
    request,
  ]));
}

function ownerAppRequestBindingSha256({
  id,
  ownerDeviceHash,
  idempotencyKey,
  approvalRequestId,
  planSha256,
  intent,
  request,
}) {
  return sha256(JSON.stringify([
    "codex-task-request-v3-owner-app",
    id,
    ownerDeviceHash,
    idempotencyKey,
    approvalRequestId,
    planSha256,
    intent,
    request,
  ]));
}

function normalizeChangedPath(value) {
  const relativePath = normalizedText(value, 180, "invalid_codex_task_changed_path").normalize("NFC");
  if (!/^[A-Za-z0-9_./@+-]+$/u.test(relativePath)) throw taskError("invalid_codex_task_changed_path");
  try {
    assertAllowedIsolatedRelativePath(relativePath);
  } catch {
    throw taskError("invalid_codex_task_changed_path");
  }
  return relativePath;
}

function normalizeResult(value, { ingress, intent, status }) {
  const source = value === null || value === undefined ? {} : plainObject(value, "invalid_codex_task_result");
  const allowedInputKeys = new Set(RESULT_KEYS);
  for (const key of Object.keys(source)) {
    if (!allowedInputKeys.has(key)) throw taskError("invalid_codex_task_result");
  }

  const defaultCode = status === "succeeded"
    ? "codex_task_succeeded"
    : status === "failed"
      ? "codex_task_failed"
      : "codex_task_interrupted_uncertain";
  const defaultSummary = status === "succeeded"
    ? null
    : status === "failed"
      ? "작업이 실패했습니다. 원시 오류 내용은 저장하지 않았습니다."
      : "실행 중 중단되어 결과를 확정할 수 없습니다. 자동으로 재시도하지 않습니다.";
  const code = source.code === undefined ? defaultCode : source.code;
  if (typeof code !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(code)) throw taskError("invalid_codex_task_result_code");
  const summary = normalizedText(source.summary ?? defaultSummary, 1_500, "invalid_codex_task_result_summary");
  const changedPaths = source.changedPaths === undefined
    ? []
    : Array.isArray(source.changedPaths)
      ? source.changedPaths.map(normalizeChangedPath)
      : (() => { throw taskError("invalid_codex_task_changed_paths"); })();
  if (
    changedPaths.length > 20 ||
    new Set(changedPaths).size !== changedPaths.length ||
    [...changedPaths].sort().join("\0") !== changedPaths.join("\0")
  ) {
    throw taskError("invalid_codex_task_changed_paths");
  }
  const changedFileCount = source.changedFileCount ?? changedPaths.length;
  if (
    !Number.isSafeInteger(changedFileCount) || changedFileCount < 0 || changedFileCount > 20 ||
    (ingress === "owner_app" ? changedPaths.length !== changedFileCount : changedPaths.length > changedFileCount)
  ) {
    throw taskError("invalid_codex_task_changed_file_count");
  }
  if ((intent === "inspect" || status !== "succeeded") && changedFileCount !== 0) {
    throw taskError("codex_task_result_changes_not_allowed");
  }
  const patch = source.patch ?? null;
  const patchSha256 = source.patchSha256 ?? null;
  if (ingress === "owner_app" && intent === "draft" && status === "succeeded" && changedFileCount > 0) {
    if (typeof patch !== "string" || typeof patchSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(patchSha256)) {
      throw taskError("invalid_codex_task_patch");
    }
    let patchInfo;
    try {
      patchInfo = validateDraftPatch(patch);
      assertCodexTextSafe(patch, { ownerId: SYNTHETIC_OWNER_ID, relativePath: "$result.patch" });
    } catch {
      throw taskError("invalid_codex_task_patch");
    }
    if (
      createHash("sha256").update(patch, "utf8").digest("hex") !== patchSha256 ||
      patchInfo.changedFileCount !== changedFileCount ||
      [...patchInfo.paths].sort().join("\0") !== changedPaths.join("\0")
    ) throw taskError("invalid_codex_task_patch");
  } else if (patch !== null || patchSha256 !== null) {
    throw taskError("invalid_codex_task_patch");
  }
  return { code, summary, changedFileCount, changedPaths, patch, patchSha256 };
}

function validateStoredResult(value, context) {
  const result = plainObject(value, "invalid_codex_task_result");
  exactKeys(result, RESULT_KEYS, "invalid_codex_task_result");
  const normalized = normalizeResult(result, context);
  if (JSON.stringify(normalized) !== JSON.stringify(result)) throw new Error("invalid_codex_task_result");
  return result;
}

function validateJob(value) {
  const job = plainObject(value, "invalid_codex_task_job");
  exactKeys(job, JOB_KEYS, "invalid_codex_task_job");
  if (
    job.version !== STORE_VERSION ||
    typeof job.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(job.id) ||
    !INGRESSES.has(job.ingress)
  ) throw new Error("invalid_codex_task_job");
  validateIntent(job.intent);
  const request = normalizedText(job.request, 2_000, "invalid_codex_task_request");
  if (request !== job.request || !/^[a-f0-9]{64}$/.test(job.requestSha256)) {
    throw new Error("invalid_codex_task_request_binding");
  }

  if (job.ingress === "telegram") {
    const botId = validateBotId(job.botId);
    const principal = normalizeTaskPrincipal(job);
    validateTelegramInteger(job.updateId, { allowZero: true, code: "invalid_codex_task_update_id" });
    validateTelegramInteger(job.messageId, { code: "invalid_codex_task_message_id" });
    if (
      job.ownerDeviceHash !== null || job.idempotencyKey !== null ||
      job.approvalRequestId !== null || job.planCanonical !== null || job.planSha256 !== null ||
      requestBindingSha256({
        botId,
        ...principal,
        updateId: job.updateId,
        messageId: job.messageId,
        intent: job.intent,
        request: job.request,
      }) !== job.requestSha256
    ) throw new Error("invalid_codex_task_request_binding");
  } else {
    if (
      job.botId !== null || job.chatId !== null || job.ownerGeneration !== null ||
      job.updateId !== null || job.messageId !== null || job.ownerId !== SYNTHETIC_OWNER_ID
    ) throw new Error("invalid_codex_owner_app_principal");
    const ownerDeviceHash = validateOwnerDeviceHash(job.ownerDeviceHash);
    const idempotencyKey = validateCodexIdempotencyKey(job.idempotencyKey);
    if (job.approvalRequestId !== job.id || typeof job.planSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(job.planSha256)) {
      throw new Error("invalid_codex_task_approval_binding");
    }
    const plan = restoreOwnerCodexPlan(job.planCanonical);
    if (
      plan.taskId !== job.id || plan.ownerDeviceHash !== ownerDeviceHash ||
      plan.idempotencyKey !== idempotencyKey || plan.intent !== job.intent ||
      plan.request !== job.request || plan.sha256 !== job.planSha256 ||
      ownerAppRequestBindingSha256(job) !== job.requestSha256
    ) throw new Error("invalid_codex_task_request_binding");
  }
  if (!STATUSES.has(job.status)) throw new Error("invalid_codex_task_status");
  if (job.ingress === "telegram" && ["awaiting_approval", "rejected", "expired"].includes(job.status)) {
    throw new Error("invalid_telegram_codex_task_status");
  }

  const createdAt = parseTimestamp(job.createdAt);
  const updatedAt = parseTimestamp(job.updatedAt);
  if (updatedAt < createdAt) throw new Error("invalid_codex_task_timestamp");

  if (job.status === "awaiting_approval" || job.status === "queued") {
    if (
      job.workerId !== null || job.workerPid !== null || job.workerLeaseNonce !== null ||
      job.startedAt !== null || job.finishedAt !== null || job.result !== null ||
      job.deliveredAt !== null || job.quarantinedAt !== null
    ) {
      throw new Error("invalid_queued_codex_task");
    }
    return job;
  }

  if (APPROVAL_TERMINAL_STATUSES.has(job.status)) {
    if (
      job.ingress !== "owner_app" ||
      job.workerId !== null || job.workerPid !== null || job.workerLeaseNonce !== null ||
      job.startedAt !== null || job.result !== null ||
      job.deliveredAt !== null || job.quarantinedAt !== null
    ) throw new Error("invalid_terminal_codex_approval");
    const finishedAt = parseTimestamp(job.finishedAt);
    if (finishedAt < createdAt || updatedAt < finishedAt) throw new Error("invalid_codex_task_timestamp");
    return job;
  }

  validateWorkerId(job.workerId);
  validateWorkerPid(job.workerPid);
  validateWorkerLeaseNonce(job.workerLeaseNonce);
  const startedAt = parseTimestamp(job.startedAt);
  if (startedAt < createdAt || updatedAt < startedAt) throw new Error("invalid_codex_task_timestamp");
  if (job.status === "running") {
    if (job.finishedAt !== null || job.result !== null || job.deliveredAt !== null || job.quarantinedAt !== null) {
      throw new Error("invalid_running_codex_task");
    }
    return job;
  }

  const finishedAt = parseTimestamp(job.finishedAt);
  if (finishedAt < startedAt || updatedAt < finishedAt) throw new Error("invalid_codex_task_timestamp");
  validateStoredResult(job.result, { ingress: job.ingress, intent: job.intent, status: job.status });
  if (job.ingress === "owner_app" && (job.deliveredAt !== null || job.quarantinedAt !== null)) {
    throw new Error("invalid_owner_app_delivery_disposition");
  }
  if (job.deliveredAt !== null && parseTimestamp(job.deliveredAt) < finishedAt) throw new Error("invalid_codex_task_delivery_timestamp");
  if (job.quarantinedAt !== null && parseTimestamp(job.quarantinedAt) < finishedAt) throw new Error("invalid_codex_task_quarantine_timestamp");
  if (job.deliveredAt !== null && job.quarantinedAt !== null) throw new Error("invalid_codex_task_delivery_disposition");
  return job;
}

function validateStore(value) {
  const store = plainObject(value, "invalid_codex_task_store");
  exactKeys(store, new Set(["version", "jobs"]), "invalid_codex_task_store");
  if (store.version !== STORE_VERSION || !Array.isArray(store.jobs)) throw new Error("invalid_codex_task_store");
  const ids = new Set();
  const updateKeys = new Set();
  const messageKeys = new Set();
  const ownerIdempotencyKeys = new Set();
  const approvalRequestIds = new Set();
  for (const job of store.jobs) {
    validateJob(job);
    if (ids.has(job.id)) throw new Error("duplicate_codex_task_event");
    ids.add(job.id);
    if (job.ingress === "telegram") {
      const updateKey = `${job.botId}:${job.updateId}`;
      const messageKey = `${job.botId}:${job.messageId}`;
      if (updateKeys.has(updateKey) || messageKeys.has(messageKey)) throw new Error("duplicate_codex_task_event");
      updateKeys.add(updateKey);
      messageKeys.add(messageKey);
    } else {
      const idempotencyKey = `${job.ownerDeviceHash}:${job.idempotencyKey}`;
      if (ownerIdempotencyKeys.has(idempotencyKey) || approvalRequestIds.has(job.approvalRequestId)) {
        throw new Error("duplicate_codex_owner_task_binding");
      }
      ownerIdempotencyKeys.add(idempotencyKey);
      approvalRequestIds.add(job.approvalRequestId);
    }
  }
  return store;
}

function migrateV2Store(value) {
  if (value?.version !== 2 || !Array.isArray(value.jobs)) throw new Error("invalid_codex_task_store");
  const migrated = {
    version: STORE_VERSION,
    jobs: value.jobs.map((job) => {
      const migratedJob = {
        ...job,
        version: STORE_VERSION,
        ingress: "telegram",
        ownerDeviceHash: null,
        idempotencyKey: null,
        approvalRequestId: null,
        planCanonical: null,
        planSha256: null,
      };
      if (job.result !== null) {
        const { changedFiles: _legacyChangedFiles, ...legacyResult } = job.result;
        migratedJob.result = {
          ...legacyResult,
          changedPaths: [],
          patch: null,
          patchSha256: null,
        };
      }
      if (job.status === "queued" || job.status === "running") {
        const at = job.updatedAt;
        migratedJob.status = "interrupted_uncertain";
        migratedJob.workerId = job.status === "running" ? job.workerId : "owner-app-policy-migration";
        migratedJob.workerPid = job.status === "running" ? job.workerPid : 1;
        migratedJob.workerLeaseNonce = job.status === "running" ? job.workerLeaseNonce : "0".repeat(32);
        migratedJob.startedAt = job.status === "running" ? job.startedAt : job.createdAt;
        migratedJob.finishedAt = at;
        migratedJob.result = normalizeResult({
          code: "codex_owner_app_approval_required",
          summary: "Telegram 실행 접수가 종료되어 이 작업은 외부 모델로 보내지 않았습니다. Local AI 앱에서 새 계획을 확인하고 승인해 주세요.",
          changedFileCount: 0,
          changedPaths: [],
          patch: null,
          patchSha256: null,
        }, { ingress: "telegram", intent: job.intent, status: "interrupted_uncertain" });
        migratedJob.deliveredAt = null;
        migratedJob.quarantinedAt = at;
      }
      return migratedJob;
    }),
  };
  return validateStore(migrated);
}

function publicOutboxRecord(job) {
  return {
    id: job.id,
    botId: job.botId,
    ownerId: job.ownerId,
    chatId: job.chatId,
    ownerGeneration: job.ownerGeneration,
    updateId: job.updateId,
    messageId: job.messageId,
    intent: job.intent,
    status: job.status,
    finishedAt: job.finishedAt,
    result: structuredClone(job.result),
  };
}

function isoNow(now) {
  const value = now();
  if (!Number.isFinite(value)) throw taskError("invalid_codex_task_clock", 503);
  return new Date(value).toISOString();
}

function validWorkerLeaseMetadata(value) {
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    typeof value.workerId !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(value.workerId) ||
    typeof value.nonce !== "string" || !/^[a-f0-9]{32}$/.test(value.nonce) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.heartbeatAt)) ||
    Date.parse(value.heartbeatAt) < Date.parse(value.createdAt)
  ) return false;
  return true;
}

function normalizeWorkerLease(value) {
  if (!validWorkerLeaseMetadata(value)) throw taskError("codex_worker_lease_invalid", 503);
  return Object.freeze({
    version: 1,
    workerId: value.workerId,
    pid: value.pid,
    nonce: value.nonce,
    createdAt: value.createdAt,
    heartbeatAt: value.heartbeatAt,
  });
}

function normalizeDeliveryPrincipal(value) {
  const botId = validateBotId(value?.botId);
  return Object.freeze({ botId, ...normalizeTaskPrincipal(value) });
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export class CodexTaskStore {
  constructor(path, { now = () => Date.now(), isProcessAlive = processIsAlive } = {}) {
    if (typeof path !== "string" || !path.trim()) throw new TypeError("codex task store path is required");
    if (typeof now !== "function") throw new TypeError("codex task clock is required");
    if (typeof isProcessAlive !== "function") throw new TypeError("codex task process liveness probe is required");
    this.path = path;
    this.directory = dirname(path);
    this.lockPath = `${path}.lock`;
    this.workerLeasePath = `${path}.worker-lease`;
    this.workerLockPath = `${path}.worker-lock`;
    this.fileLock = new PrivateFileLock(this.lockPath, { errorPrefix: "codex_task_store_lock" });
    this.workerFileLock = new PrivateFileLock(this.workerLockPath, {
      retryAttempts: 1,
      errorPrefix: "codex_worker_kernel_lock",
    });
    this.workerKernelLease = null;
    this.now = now;
    this.isProcessAlive = isProcessAlive;
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.withLock(async () => {
      try {
        const raw = JSON.parse(await readFile(this.path, "utf8"));
        if (raw?.version === 1) {
          const quarantinePath = `${this.path}.principal-unbound-v1.${Date.now()}.${randomBytes(6).toString("hex")}`;
          await rename(this.path, quarantinePath);
          await chmod(quarantinePath, 0o600);
          await this.write({ version: STORE_VERSION, jobs: [] });
          return;
        }
        if (raw?.version === 2) {
          await this.write(migrateV2Store(raw));
          return;
        }
        validateStore(raw);
        await chmod(this.path, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await this.write({ version: STORE_VERSION, jobs: [] });
      }
    });
  }

  async read() {
    return validateStore(JSON.parse(await readFile(this.path, "utf8")));
  }

  async write(value) {
    validateStore(value);
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async withLock(operation) {
    return this.fileLock.withLock(operation);
  }

  async readWorkerLease() {
    return normalizeWorkerLease(JSON.parse(await readFile(this.workerLeasePath, "utf8")));
  }

  async workerReady({ maxHeartbeatAgeMs = 15_000 } = {}) {
    if (!Number.isSafeInteger(maxHeartbeatAgeMs) || maxHeartbeatAgeMs < 1 || maxHeartbeatAgeMs > 60_000) {
      throw taskError("invalid_codex_worker_readiness_window");
    }
    try {
      const lease = await this.readWorkerLease();
      const now = this.now();
      const heartbeatAt = Date.parse(lease.heartbeatAt);
      return Number.isFinite(now) && heartbeatAt <= now + 5_000 && now - heartbeatAt <= maxHeartbeatAgeMs && this.isProcessAlive(lease.pid);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.message === "codex_worker_lease_invalid") return false;
      throw error;
    }
  }

  async writeWorkerLease(value) {
    const lease = normalizeWorkerLease(value);
    const temporary = `${this.workerLeasePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.workerLeasePath);
      await chmod(this.workerLeasePath, 0o600);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    return lease;
  }

  async acquireWorkerLease({ workerId, pid = process.pid } = {}) {
    const normalizedWorkerId = validateWorkerId(workerId);
    const normalizedPid = validateWorkerPid(pid);
    if (normalizedPid !== process.pid) throw taskError("codex_worker_pid_mismatch", 409);
    if (this.workerKernelLease) throw taskError("codex_worker_already_running", 409);
    let kernelLease;
    try {
      kernelLease = await this.workerFileLock.acquire();
    } catch (error) {
      if (error?.message === "codex_worker_kernel_lock_locked") {
        throw taskError("codex_worker_already_running", 409);
      }
      throw taskError("codex_worker_lease_unavailable", 503);
    }
    const at = isoNow(this.now);
    const lease = normalizeWorkerLease({
      version: 1,
      workerId: normalizedWorkerId,
      pid: normalizedPid,
      nonce: randomBytes(16).toString("hex"),
      createdAt: at,
      heartbeatAt: at,
    });
    try {
      await this.writeWorkerLease(lease);
      this.workerKernelLease = { nonce: lease.nonce, release: kernelLease.release };
      return lease;
    } catch (error) {
      await kernelLease.release().catch(() => {});
      throw error;
    }
  }

  async assertWorkerLease(value) {
    const expected = normalizeWorkerLease(value);
    if (this.workerKernelLease?.nonce !== expected.nonce) {
      throw taskError("codex_worker_lease_lost", 409);
    }
    let actual;
    try {
      actual = await this.readWorkerLease();
    } catch (error) {
      if (error.code === "ENOENT") throw taskError("codex_worker_lease_lost", 409);
      throw error;
    }
    if (
      actual.workerId !== expected.workerId || actual.pid !== expected.pid || actual.nonce !== expected.nonce ||
      !this.isProcessAlive(actual.pid)
    ) throw taskError("codex_worker_lease_lost", 409);
    return actual;
  }

  async heartbeatWorkerLease(value) {
    const actual = await this.assertWorkerLease(value);
    const heartbeatAt = isoNow(this.now);
    if (Date.parse(heartbeatAt) < Date.parse(actual.heartbeatAt)) throw taskError("codex_worker_lease_clock_reversed", 503);
    return this.writeWorkerLease({ ...actual, heartbeatAt });
  }

  async releaseWorkerLease(value) {
    const expected = normalizeWorkerLease(value);
    const kernelLease = this.workerKernelLease;
    if (!kernelLease || kernelLease.nonce !== expected.nonce) throw taskError("codex_worker_lease_lost", 409);
    let actual;
    try {
      actual = await this.assertWorkerLease(expected);
      await unlink(this.workerLeasePath);
      return Object.freeze({ workerId: actual.workerId, released: true });
    } finally {
      this.workerKernelLease = null;
      await kernelLease.release();
    }
  }

  async enqueue(value) {
    const input = plainObject(value, "invalid_codex_task_input");
    exactKeys(input, new Set([
      "botId", "ownerId", "chatId", "ownerGeneration", "updateId", "messageId", "intent", "request",
    ]), "invalid_codex_task_input");
    const botId = validateBotId(input.botId);
    const principal = normalizeTaskPrincipal(input);
    const updateId = validateTelegramInteger(input.updateId, { allowZero: true, code: "invalid_codex_task_update_id" });
    const messageId = validateTelegramInteger(input.messageId, { code: "invalid_codex_task_message_id" });
    const intent = validateIntent(input.intent);
    const request = normalizedText(input.request, 2_000, "invalid_codex_task_request");
    const requestSha256 = requestBindingSha256({ botId, ...principal, updateId, messageId, intent, request });

    return this.withLock(async () => {
      const store = await this.read();
      const byUpdate = store.jobs.find((job) => job.botId === botId && job.updateId === updateId);
      const byMessage = store.jobs.find((job) => job.botId === botId && job.messageId === messageId);
      if (byUpdate || byMessage) {
        if (
          !byUpdate || !byMessage || byUpdate.id !== byMessage.id ||
          byUpdate.botId !== botId ||
          !sameTelegramPrincipal(byUpdate, { botId, ...principal }) ||
          byUpdate.intent !== intent || byUpdate.requestSha256 !== requestSha256
        ) {
          throw taskError("codex_task_replay_mismatch", 409);
        }
        return { created: false, job: structuredClone(byUpdate) };
      }

      if (store.jobs.filter((job) => ["awaiting_approval", "queued"].includes(job.status)).length >= MAX_ACTIVE_RESERVATIONS) {
        throw taskError("codex_task_queue_full", 429);
      }
      const now = this.now();
      if (!Number.isFinite(now)) throw taskError("invalid_codex_task_clock", 503);
      const recentTenMinutes = store.jobs.filter((job) => now - Date.parse(job.createdAt) < TEN_MINUTES_MS).length;
      if (recentTenMinutes >= MAX_PER_TEN_MINUTES) throw taskError("codex_task_rate_limit_10m", 429);
      const recentDay = store.jobs.filter((job) => now - Date.parse(job.createdAt) < ONE_DAY_MS).length;
      if (recentDay >= MAX_PER_DAY) throw taskError("codex_task_rate_limit_daily", 429);

      const at = new Date(now).toISOString();
      const job = {
        version: STORE_VERSION,
        id: randomUUID(),
        ingress: "telegram",
        botId,
        ...principal,
        updateId,
        messageId,
        ownerDeviceHash: null,
        idempotencyKey: null,
        approvalRequestId: null,
        planCanonical: null,
        planSha256: null,
        intent,
        request,
        requestSha256,
        status: "queued",
        workerId: null,
        workerPid: null,
        workerLeaseNonce: null,
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        finishedAt: null,
        result: null,
        deliveredAt: null,
        quarantinedAt: null,
      };
      store.jobs.push(job);
      await this.write(store);
      return { created: true, job: structuredClone(job) };
    });
  }

  async createOwnerAppTask(value) {
    const input = plainObject(value, "invalid_codex_owner_task_input");
    exactKeys(input, new Set([
      "id", "ownerDeviceHash", "idempotencyKey", "approvalRequestId",
      "planCanonical", "planSha256", "intent", "request",
    ]), "invalid_codex_owner_task_input");
    if (
      typeof input.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.id) ||
      input.approvalRequestId !== input.id
    ) throw taskError("invalid_codex_task_approval_binding");
    const ownerDeviceHash = validateOwnerDeviceHash(input.ownerDeviceHash);
    const idempotencyKey = validateCodexIdempotencyKey(input.idempotencyKey);
    const intent = validateIntent(input.intent);
    const request = normalizedText(input.request, 2_000, "invalid_codex_task_request");
    if (request !== input.request || typeof input.planSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(input.planSha256)) {
      throw taskError("invalid_codex_task_plan");
    }
    const plan = restoreOwnerCodexPlan(input.planCanonical);
    if (
      plan.taskId !== input.id || plan.ownerDeviceHash !== ownerDeviceHash ||
      plan.idempotencyKey !== idempotencyKey || plan.intent !== intent ||
      plan.request !== request || plan.sha256 !== input.planSha256
    ) throw taskError("invalid_codex_task_plan_binding");
    const requestSha256 = ownerAppRequestBindingSha256({
      id: input.id,
      ownerDeviceHash,
      idempotencyKey,
      approvalRequestId: input.approvalRequestId,
      planSha256: input.planSha256,
      intent,
      request,
    });

    return this.withLock(async () => {
      const store = await this.read();
      const byIdempotency = store.jobs.find((job) =>
        job.ingress === "owner_app" &&
        job.ownerDeviceHash === ownerDeviceHash &&
        job.idempotencyKey === idempotencyKey);
      const byId = store.jobs.find((job) => job.id === input.id || job.approvalRequestId === input.approvalRequestId);
      if (byIdempotency) {
        const existing = byIdempotency;
        if (
          existing.ingress !== "owner_app" || existing.ownerDeviceHash !== ownerDeviceHash ||
          existing.idempotencyKey !== idempotencyKey || existing.intent !== intent ||
          existing.request !== request
        ) throw taskError("codex_task_replay_mismatch", 409);
        return { created: false, job: structuredClone(existing) };
      }
      if (byId) throw taskError("codex_task_replay_mismatch", 409);

      if (store.jobs.filter((job) => ["awaiting_approval", "queued"].includes(job.status)).length >= MAX_ACTIVE_RESERVATIONS) {
        throw taskError("codex_task_queue_full", 429);
      }
      const now = this.now();
      if (!Number.isFinite(now)) throw taskError("invalid_codex_task_clock", 503);
      const recentTenMinutes = store.jobs.filter((job) => now - Date.parse(job.createdAt) < TEN_MINUTES_MS).length;
      if (recentTenMinutes >= MAX_PER_TEN_MINUTES) throw taskError("codex_task_rate_limit_10m", 429);
      const recentDay = store.jobs.filter((job) => now - Date.parse(job.createdAt) < ONE_DAY_MS).length;
      if (recentDay >= MAX_PER_DAY) throw taskError("codex_task_rate_limit_daily", 429);

      const at = new Date(now).toISOString();
      const job = {
        version: STORE_VERSION,
        id: input.id,
        ingress: "owner_app",
        botId: null,
        ownerId: SYNTHETIC_OWNER_ID,
        chatId: null,
        ownerGeneration: null,
        updateId: null,
        messageId: null,
        ownerDeviceHash,
        idempotencyKey,
        approvalRequestId: input.approvalRequestId,
        planCanonical: input.planCanonical,
        planSha256: input.planSha256,
        intent,
        request,
        requestSha256,
        status: "awaiting_approval",
        workerId: null,
        workerPid: null,
        workerLeaseNonce: null,
        createdAt: at,
        updatedAt: at,
        startedAt: null,
        finishedAt: null,
        result: null,
        deliveredAt: null,
        quarantinedAt: null,
      };
      store.jobs.push(job);
      await this.write(store);
      return { created: true, job: structuredClone(job) };
    });
  }

  async getOwnerApp(id, ownerDeviceHash) {
    validateOwnerDeviceHash(ownerDeviceHash);
    const job = await this.get(id);
    return job?.ingress === "owner_app" && job.ownerDeviceHash === ownerDeviceHash ? job : null;
  }

  async findOwnerAppByIdempotency(ownerDeviceHash, idempotencyKey) {
    validateOwnerDeviceHash(ownerDeviceHash);
    validateCodexIdempotencyKey(idempotencyKey);
    const store = await this.read();
    const job = store.jobs.find((entry) =>
      entry.ingress === "owner_app" &&
      entry.ownerDeviceHash === ownerDeviceHash &&
      entry.idempotencyKey === idempotencyKey);
    return job ? structuredClone(job) : null;
  }

  async listOwnerApp(ownerDeviceHash, { limit = 20 } = {}) {
    validateOwnerDeviceHash(ownerDeviceHash);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw taskError("invalid_codex_task_list_limit");
    const store = await this.read();
    return store.jobs
      .filter((job) => job.ingress === "owner_app" && job.ownerDeviceHash === ownerDeviceHash)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async listAwaitingOwnerApp({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw taskError("invalid_codex_task_list_limit");
    const store = await this.read();
    return store.jobs
      .filter((job) => job.ingress === "owner_app" && job.status === "awaiting_approval")
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  async promoteOwnerApp(id, ownerDeviceHash) {
    validateOwnerDeviceHash(ownerDeviceHash);
    return this.withLock(async () => {
      const store = await this.read();
      const job = store.jobs.find((entry) => entry.id === id);
      if (!job || job.ingress !== "owner_app" || job.ownerDeviceHash !== ownerDeviceHash) {
        throw taskError("codex_task_not_found", 404);
      }
      if (["queued", "running", ...EXECUTION_TERMINAL_STATUSES].includes(job.status)) return structuredClone(job);
      if (job.status !== "awaiting_approval") throw taskError("codex_task_state_conflict", 409);
      job.status = "queued";
      job.updatedAt = isoNow(this.now);
      await this.write(store);
      return structuredClone(job);
    });
  }

  async resolveOwnerApproval(id, ownerDeviceHash, status) {
    validateOwnerDeviceHash(ownerDeviceHash);
    if (!APPROVAL_TERMINAL_STATUSES.has(status)) throw taskError("invalid_codex_task_approval_status");
    return this.withLock(async () => {
      const store = await this.read();
      const job = store.jobs.find((entry) => entry.id === id);
      if (!job || job.ingress !== "owner_app" || job.ownerDeviceHash !== ownerDeviceHash) {
        throw taskError("codex_task_not_found", 404);
      }
      if (job.status === status) return structuredClone(job);
      if (job.status !== "awaiting_approval") throw taskError("codex_task_state_conflict", 409);
      const at = isoNow(this.now);
      job.status = status;
      job.finishedAt = at;
      job.updatedAt = at;
      await this.write(store);
      return structuredClone(job);
    });
  }

  async get(id) {
    const store = await this.read();
    const job = store.jobs.find((entry) => entry.id === id);
    return job ? structuredClone(job) : null;
  }

  async listTerminalJobIds({ limit = 5_000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw taskError("invalid_codex_task_list_limit");
    const store = await this.read();
    return store.jobs
      .filter((job) => TERMINAL_STATUSES.has(job.status))
      .sort((left, right) => Date.parse(left.finishedAt) - Date.parse(right.finishedAt))
      .slice(0, limit)
      .map((job) => job.id);
  }

  async listOwnerAppApprovalRequestIds({ limit = 10_000 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw taskError("invalid_codex_task_list_limit");
    const store = await this.read();
    return store.jobs
      .filter((job) => job.ingress === "owner_app")
      .slice(0, limit)
      .map((job) => job.approvalRequestId);
  }

  async pruneOwnerAppTerminal({ maxAgeMs = 7 * ONE_DAY_MS, maxCount = 100 } = {}) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < ONE_DAY_MS || maxAgeMs > 30 * ONE_DAY_MS) {
      throw taskError("invalid_codex_task_retention");
    }
    if (!Number.isSafeInteger(maxCount) || maxCount < 1 || maxCount > 100) {
      throw taskError("invalid_codex_task_retention");
    }
    return this.withLock(async () => {
      const store = await this.read();
      const now = this.now();
      if (!Number.isFinite(now)) throw taskError("invalid_codex_task_clock", 503);
      const terminal = store.jobs
        .filter((job) => job.ingress === "owner_app" && TERMINAL_STATUSES.has(job.status))
        .sort((left, right) => Date.parse(right.finishedAt) - Date.parse(left.finishedAt));
      const removeIds = new Set(terminal
        .filter((job, index) => index >= maxCount || now - Date.parse(job.finishedAt) >= maxAgeMs)
        .map((job) => job.id));
      if (removeIds.size === 0) return [];
      const removed = store.jobs
        .filter((job) => removeIds.has(job.id))
        .map((job) => ({ id: job.id, approvalRequestId: job.approvalRequestId }));
      store.jobs = store.jobs.filter((job) => !removeIds.has(job.id));
      await this.write(store);
      return removed;
    });
  }

  async claimNext(workerLease) {
    const lease = await this.assertWorkerLease(workerLease);
    return this.withLock(async () => {
      await this.assertWorkerLease(lease);
      const store = await this.read();
      const job = store.jobs.find((entry) => entry.status === "queued");
      if (!job) return null;
      const at = isoNow(this.now);
      job.status = "running";
      job.workerId = lease.workerId;
      job.workerPid = lease.pid;
      job.workerLeaseNonce = lease.nonce;
      job.startedAt = at;
      job.updatedAt = at;
      await this.write(store);
      return structuredClone(job);
    });
  }

  async transition(id, from, to, result = null, { workerLease } = {}) {
    if (from !== "running" || !EXECUTION_TERMINAL_STATUSES.has(to)) throw taskError("invalid_codex_task_transition", 409);
    const lease = await this.assertWorkerLease(workerLease);
    return this.withLock(async () => {
      await this.assertWorkerLease(lease);
      const store = await this.read();
      const job = store.jobs.find((entry) => entry.id === id);
      if (!job) throw taskError("codex_task_not_found", 404);
      if (job.status !== from) throw taskError("codex_task_state_conflict", 409);
      if (
        job.workerId !== lease.workerId || job.workerPid !== lease.pid || job.workerLeaseNonce !== lease.nonce
      ) throw taskError("codex_task_worker_mismatch", 409);
      const normalizedResult = normalizeResult(result, { ingress: job.ingress, intent: job.intent, status: to });
      const at = isoNow(this.now);
      job.status = to;
      job.result = normalizedResult;
      job.finishedAt = at;
      job.updatedAt = at;
      await this.write(store);
      return structuredClone(job);
    });
  }

  async recoverRunning(workerLease) {
    const lease = await this.assertWorkerLease(workerLease);
    return this.withLock(async () => {
      await this.assertWorkerLease(lease);
      const store = await this.read();
      const running = store.jobs.filter((job) =>
        job.status === "running" &&
        job.workerLeaseNonce !== lease.nonce);
      if (running.length === 0) return [];
      const at = isoNow(this.now);
      for (const job of running) {
        job.status = "interrupted_uncertain";
        job.result = normalizeResult(null, { ingress: job.ingress, intent: job.intent, status: "interrupted_uncertain" });
        job.finishedAt = at;
        job.updatedAt = at;
      }
      await this.write(store);
      return running.map(publicOutboxRecord);
    });
  }

  async listUndelivered({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw taskError("invalid_codex_task_outbox_limit");
    const store = await this.read();
    return store.jobs
      .filter((job) =>
        job.ingress === "telegram" &&
        EXECUTION_TERMINAL_STATUSES.has(job.status) &&
        job.deliveredAt === null && job.quarantinedAt === null)
      .sort((left, right) => Date.parse(left.finishedAt) - Date.parse(right.finishedAt))
      .slice(0, limit)
      .map(publicOutboxRecord);
  }

  async markDelivered(id, principalValue) {
    const principal = normalizeDeliveryPrincipal(principalValue);
    return this.withLock(async () => {
      const store = await this.read();
      const job = store.jobs.find((entry) => entry.id === id);
      if (!job) throw taskError("codex_task_not_found", 404);
      if (job.ingress !== "telegram" || !EXECUTION_TERMINAL_STATUSES.has(job.status)) throw taskError("codex_task_not_deliverable", 409);
      if (!sameTelegramPrincipal(job, principal)) throw taskError("codex_task_delivery_principal_mismatch", 409);
      if (job.quarantinedAt !== null) throw taskError("codex_task_delivery_quarantined", 409);
      if (job.deliveredAt === null) {
        job.deliveredAt = isoNow(this.now);
        job.updatedAt = job.deliveredAt;
        await this.write(store);
      }
      return { id: job.id, status: job.status, deliveredAt: job.deliveredAt };
    });
  }

  async quarantineDelivery(id, currentPrincipalValue) {
    const currentPrincipal = normalizeDeliveryPrincipal(currentPrincipalValue);
    return this.withLock(async () => {
      const store = await this.read();
      const job = store.jobs.find((entry) => entry.id === id);
      if (!job) throw taskError("codex_task_not_found", 404);
      if (job.ingress !== "telegram" || !EXECUTION_TERMINAL_STATUSES.has(job.status)) throw taskError("codex_task_not_deliverable", 409);
      if (sameTelegramPrincipal(job, currentPrincipal)) throw taskError("codex_task_quarantine_principal_matches", 409);
      if (job.deliveredAt !== null) throw taskError("codex_task_already_delivered", 409);
      if (job.quarantinedAt === null) {
        job.quarantinedAt = isoNow(this.now);
        job.updatedAt = job.quarantinedAt;
        await this.write(store);
      }
      return { id: job.id, status: job.status, quarantinedAt: job.quarantinedAt };
    });
  }

  async summary(principalValue = null) {
    const store = await this.read();
    const principal = principalValue === null ? null : normalizeDeliveryPrincipal(principalValue);
    const telegramJobs = store.jobs.filter((job) => job.ingress === "telegram");
    const jobs = principal === null ? telegramJobs : telegramJobs.filter((job) => sameTelegramPrincipal(job, principal));
    const recent = [...jobs].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null;
    return {
      queued: jobs.filter((job) => job.status === "queued").length,
      running: jobs.filter((job) => job.status === "running").length,
      undelivered: jobs.filter((job) => EXECUTION_TERMINAL_STATUSES.has(job.status) && job.deliveredAt === null && job.quarantinedAt === null).length,
      recent: recent ? { id: recent.id, status: recent.status } : null,
    };
  }
}
