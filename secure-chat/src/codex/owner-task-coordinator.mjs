import { createHash, randomUUID } from "node:crypto";
import { approvalDeviceKeyId } from "../approval-store.mjs";
import {
  assertCodexTextSafe,
  buildSanitizedSourceManifest,
  sanitizeCodexText,
  SYNTHETIC_OWNER_ID,
} from "./isolated-workspace.mjs";
import {
  createOwnerCodexPlan,
  normalizeOwnerCodexRequest,
  restoreOwnerCodexPlan,
  validateCodexIdempotencyKey,
  validateOwnerCodexIntent,
} from "./owner-task-plan.mjs";
import { publicCodexApproval, publicCodexTask } from "./public-task.mjs";

const INPUT_KEYS = new Set(["intent", "request", "idempotencyKey"]);
const LOCAL_ONLY_REQUEST_PATTERNS = Object.freeze([
  /(?:가게|매장|장부|매출|정산|직원|종업원|아가씨|웨이터|손님|고객|계좌|송금|이체|입금|출금|현금|카드\s*승인|카카오페이|재고|술병|영수증|포스|씨씨티비|카메라\s*영상|녹화\s*영상|메일|이메일|구매\s*내역|결제\s*내역|주문\s*내역|브라우저\s*(?:기록|내역)|홈\s*(?:제어|자동화)|연락처|전화번호|주소록|급여|출퇴근)/iu,
  /\b(?:employee|staff|customer|ledger|bookkeep(?:ing)?|sales records?|payroll|bank account|wire transfer|cash receipts?|inventory|cctv|camera footage|email|purchase history|browser history|home control|contacts?|phone number|point[ -]?of[ -]?sale)\b/iu,
]);

function coordinatorError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function exactInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw coordinatorError("invalid_codex_task_input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw coordinatorError("invalid_codex_task_input");
  const keys = Object.keys(value);
  if (keys.length !== INPUT_KEYS.size || keys.some((key) => !INPUT_KEYS.has(key))) {
    throw coordinatorError("invalid_codex_task_input");
  }
  return value;
}

function normalizeDeviceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(value)) {
    throw coordinatorError("invalid_owner_device", 403);
  }
  return value;
}

export function ownerCodexDeviceHash(deviceId) {
  return createHash("sha256")
    .update(`localai-codex-owner-device-v1:${normalizeDeviceId(deviceId)}`)
    .digest("hex");
}

export function ownerCodexApprovalDeviceId(deviceId) {
  return `codex-${ownerCodexDeviceHash(deviceId)}`;
}

function approvalDeviceIdFromOwnerHash(ownerDeviceHash) {
  if (typeof ownerDeviceHash !== "string" || !/^[a-f0-9]{64}$/u.test(ownerDeviceHash)) {
    throw coordinatorError("invalid_codex_owner_device_hash", 409);
  }
  return `codex-${ownerDeviceHash}`;
}

function sanitizeRequest(value) {
  const normalized = normalizeOwnerCodexRequest(value);
  const sanitized = sanitizeCodexText(normalized, { ownerId: SYNTHETIC_OWNER_ID }).text;
  try {
    assertCodexTextSafe(sanitized, { ownerId: SYNTHETIC_OWNER_ID, relativePath: "$owner-task" });
  } catch {
    throw coordinatorError("codex_task_request_blocked", 400);
  }
  if (LOCAL_ONLY_REQUEST_PATTERNS.some((pattern) => pattern.test(sanitized))) {
    throw coordinatorError("codex_task_local_only_intent", 400);
  }
  return sanitized;
}

function approvalPresentation(intent) {
  if (intent === "inspect") {
    return {
      title: "Codex 격리 점검 승인",
      summary: "표시된 요청과 허용 코드·알려진 식별자를 검사·치환한 스냅샷을 OpenAI Codex로 전송해 읽기 전용 점검에 한 번 사용",
    };
  }
  return {
    title: "Codex 격리 초안 승인",
    summary: "표시된 요청과 허용 코드·알려진 식별자를 검사·치환한 스냅샷을 OpenAI Codex로 전송해 격리 복제본에만 초안을 만들며 실제 소스에는 반영하지 않음",
  };
}

function assertTaskPlan(job) {
  const plan = restoreOwnerCodexPlan(job.planCanonical);
  if (
    plan.taskId !== job.id || plan.ownerDeviceHash !== job.ownerDeviceHash ||
    plan.idempotencyKey !== job.idempotencyKey || plan.intent !== job.intent ||
    plan.request !== job.request || plan.sha256 !== job.planSha256 ||
    job.approvalRequestId !== job.id
  ) throw coordinatorError("stored_codex_task_plan_mismatch", 409);
  return plan;
}

function assertApprovalBinding(job, approval, derivedApprovalDeviceId) {
  if (!approval || approval.id !== job.approvalRequestId || approval.kind !== "codex.execute") {
    throw coordinatorError("codex_task_approval_missing", 409);
  }
  if (approval.payload !== job.planCanonical || approval.payloadSha256 !== job.planSha256) {
    throw coordinatorError("codex_task_approval_payload_mismatch", 409);
  }
  assertTaskPlan(job);
  if (["approved", "consumed", "rejected"].includes(approval.status)) {
    const expectedKeyId = approvalDeviceKeyId(derivedApprovalDeviceId);
    const expectedDecision = approval.status === "rejected" ? "rejected" : "approved";
    if (approval.decidedBy !== expectedKeyId || approval.decision !== expectedDecision) {
      throw coordinatorError("codex_task_approval_device_mismatch", 409);
    }
  }
  return approval;
}

export class OwnerCodexTaskCoordinator {
  constructor({ taskStore, approvalStore, sourceRoot, now = () => Date.now() } = {}) {
    if (!taskStore || !approvalStore || typeof sourceRoot !== "string" || !sourceRoot || typeof now !== "function") {
      throw new TypeError("owner codex coordinator dependencies are required");
    }
    this.taskStore = taskStore;
    this.approvalStore = approvalStore;
    this.sourceRoot = sourceRoot;
    this.now = now;
  }

  async registerApprovalKey(deviceId, publicKeyDER) {
    return this.approvalStore.registerDeviceKey(ownerCodexApprovalDeviceId(deviceId), publicKeyDER);
  }

  async replay(deviceId, value) {
    const input = exactInput(value);
    const ownerDeviceHash = ownerCodexDeviceHash(deviceId);
    const intent = validateOwnerCodexIntent(input.intent);
    const request = sanitizeRequest(input.request);
    const idempotencyKey = validateCodexIdempotencyKey(input.idempotencyKey);
    let job = await this.taskStore.findOwnerAppByIdempotency(ownerDeviceHash, idempotencyKey);
    if (!job) return null;
    assertTaskPlan(job);
    if (job.intent !== intent || job.request !== request) throw coordinatorError("codex_task_replay_mismatch", 409);
    job = await this.reconcileJob(deviceId, job);
    const approval = await this.approvalStore.get(job.approvalRequestId);
    if (!approval) throw coordinatorError("codex_task_approval_missing", 409);
    assertApprovalBinding(job, approval, ownerCodexApprovalDeviceId(deviceId));
    return {
      task: publicCodexTask(job),
      approval: job.status === "awaiting_approval" && approval.status === "pending"
        ? publicCodexApproval(approval)
        : null,
      created: false,
    };
  }

  async prepare(deviceId, value) {
    const replayed = await this.replay(deviceId, value);
    if (replayed) return replayed;
    const input = exactInput(value);
    const ownerDeviceHash = ownerCodexDeviceHash(deviceId);
    const intent = validateOwnerCodexIntent(input.intent);
    const request = sanitizeRequest(input.request);
    const idempotencyKey = validateCodexIdempotencyKey(input.idempotencyKey);
    await this.reconcileAll();
    const sourceManifest = await buildSanitizedSourceManifest(this.sourceRoot, { ownerId: SYNTHETIC_OWNER_ID });
    const taskId = randomUUID();
    const candidatePlan = createOwnerCodexPlan({
      taskId,
      ownerDeviceHash,
      idempotencyKey,
      intent,
      request,
      sourceManifestSha256: sourceManifest.sha256,
      sourceFileCount: sourceManifest.fileCount,
      sourceTotalBytes: sourceManifest.totalBytes,
    });
    const created = await this.taskStore.createOwnerAppTask({
      id: taskId,
      ownerDeviceHash,
      idempotencyKey,
      approvalRequestId: taskId,
      planCanonical: candidatePlan.canonical,
      planSha256: candidatePlan.sha256,
      intent,
      request,
    });
    let job = created.job;
    assertTaskPlan(job);
    if (job.intent !== intent || job.request !== request) throw coordinatorError("codex_task_replay_mismatch", 409);
    let approval = await this.ensureApproval(job);
    assertApprovalBinding(job, approval, ownerCodexApprovalDeviceId(deviceId));
    job = await this.reconcileJob(deviceId, job, approval);
    approval = await this.approvalStore.get(job.approvalRequestId) ?? approval;
    assertApprovalBinding(job, approval, ownerCodexApprovalDeviceId(deviceId));
    return { task: publicCodexTask(job), approval: publicCodexApproval(approval), created: created.created };
  }

  async decide(deviceId, id, decision, signatureDER) {
    const ownerDeviceHash = ownerCodexDeviceHash(deviceId);
    let job = await this.taskStore.getOwnerApp(id, ownerDeviceHash);
    if (!job) throw coordinatorError("codex_task_not_found", 404);
    const derivedDeviceId = ownerCodexApprovalDeviceId(deviceId);
    const approval = await this.approvalStore.get(job.approvalRequestId);
    assertApprovalBinding(job, approval, derivedDeviceId);
    const decided = await this.approvalStore.decide({
      id: job.approvalRequestId,
      deviceId: derivedDeviceId,
      decision,
      signatureDER,
    });
    const decidedApproval = await this.approvalStore.get(job.approvalRequestId);
    assertApprovalBinding(job, decidedApproval, derivedDeviceId);
    job = await this.reconcileJob(deviceId, job, decidedApproval);
    return {
      id: decided.id,
      status: decided.status,
      payloadSha256: decided.payloadSha256,
      task: publicCodexTask(job),
    };
  }

  async list(deviceId, { limit = 20 } = {}) {
    const ownerDeviceHash = ownerCodexDeviceHash(deviceId);
    const jobs = await this.taskStore.listOwnerApp(ownerDeviceHash, { limit });
    const reconciled = [];
    for (const job of jobs) reconciled.push(await this.reconcileJob(deviceId, job));
    return reconciled.map(publicCodexTask);
  }

  async get(deviceId, id) {
    const ownerDeviceHash = ownerCodexDeviceHash(deviceId);
    let job = await this.taskStore.getOwnerApp(id, ownerDeviceHash);
    if (!job) return null;
    job = await this.reconcileJob(deviceId, job);
    if (job.status !== "awaiting_approval") {
      return { task: publicCodexTask(job), approval: null };
    }
    const approval = await this.approvalStore.get(job.approvalRequestId);
    if (!approval) throw coordinatorError("codex_task_approval_missing", 409);
    assertApprovalBinding(job, approval, ownerCodexApprovalDeviceId(deviceId));
    if (approval.status !== "pending") {
      job = await this.reconcileJob(deviceId, job, approval);
      return { task: publicCodexTask(job), approval: null };
    }
    return { task: publicCodexTask(job), approval: publicCodexApproval(approval) };
  }

  async approvalKind(id) {
    return (await this.approvalStore.get(id))?.kind ?? null;
  }

  async reconcileAll() {
    const jobs = await this.taskStore.listAwaitingOwnerApp({ limit: 500 });
    const reconciled = [];
    for (const job of jobs) {
      const approval = await this.approvalStore.get(job.approvalRequestId) ?? await this.ensureApproval(job);
      reconciled.push(await this.reconcileStoredJob(job, approval, approvalDeviceIdFromOwnerHash(job.ownerDeviceHash)));
    }
    return reconciled;
  }

  async pruneRetention() {
    const removedTasks = await this.taskStore.pruneOwnerAppTerminal({
      maxAgeMs: 7 * 24 * 60 * 60_000,
      maxCount: 100,
    });
    const removedApprovals = await this.approvalStore.deleteCodexRequests(
      removedTasks.map((entry) => entry.approvalRequestId),
    );
    const retainedIds = await this.taskStore.listOwnerAppApprovalRequestIds();
    const removedOrphans = await this.approvalStore.pruneOrphanedCodexRequests(retainedIds);
    return Object.freeze({
      removedTaskCount: removedTasks.length,
      removedApprovalCount: new Set([
        ...removedApprovals,
        ...removedOrphans,
      ]).size,
    });
  }

  async ensureApproval(job) {
    const plan = assertTaskPlan(job);
    const presentation = approvalPresentation(job.intent);
    return this.approvalStore.createRequest({
      kind: "codex.execute",
      ...presentation,
      payload: plan.canonical,
      dataCategories: ["task_instruction", "known_identifier_scrubbed_code_snapshot"],
    }, 10 * 60_000, { id: job.approvalRequestId });
  }

  async reconcileJob(deviceId, value, knownApproval = null) {
    return this.reconcileStoredJob(value, knownApproval, ownerCodexApprovalDeviceId(deviceId));
  }

  async reconcileStoredJob(value, knownApproval, derivedDeviceId) {
    let job = value;
    if (job.ingress !== "owner_app") throw coordinatorError("invalid_owner_codex_task", 409);
    if (job.status !== "awaiting_approval") return job;
    let approval = knownApproval ?? await this.ensureApproval(job);
    assertApprovalBinding(job, approval, derivedDeviceId);
    if (approval.status === "pending") return job;
    if (approval.status === "rejected" || approval.status === "expired") {
      return this.taskStore.resolveOwnerApproval(job.id, job.ownerDeviceHash, approval.status);
    }
    if (approval.status === "approved") {
      await this.approvalStore.consumeApproved(job.approvalRequestId, job.planSha256);
      approval = await this.approvalStore.get(job.approvalRequestId);
      assertApprovalBinding(job, approval, derivedDeviceId);
    }
    if (approval.status === "consumed") {
      return this.taskStore.promoteOwnerApp(job.id, job.ownerDeviceHash);
    }
    if (approval.status === "expired") {
      return this.taskStore.resolveOwnerApproval(job.id, job.ownerDeviceHash, "expired");
    }
    throw coordinatorError("codex_task_approval_state_invalid", 409);
  }
}
