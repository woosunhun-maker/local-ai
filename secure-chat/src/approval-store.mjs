import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  buildApprovalSigningMessageFromBinding,
  validateFrozenOutboundRequest,
} from "./growth/outbound-request.mjs";
import { restoreOwnerCodexPlan } from "./codex/owner-task-plan.mjs";
import { PrivateFileLock } from "./private-file-lock.mjs";

const EMPTY_STORE = Object.freeze({ version: 1, deviceKeys: {}, requests: [] });
const DECISIONS = new Set(["approved", "rejected"]);
const REQUEST_STATUSES = new Set(["pending", "approved", "rejected", "expired", "consumed"]);
const NEW_REQUEST_KEYS = new Set(["kind", "title", "summary", "payload", "dataCategories"]);

function approvalError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isStrictOwnerCodexPlanV3(value) {
  try {
    return restoreOwnerCodexPlan(value).schema === "local-ai.codex-task-plan.v3";
  } catch {
    return false;
  }
}

export function approvalDeviceKeyId(deviceId) {
  return sha256(`localai-device-key-v1:${deviceId}`);
}

export function approvalSigningPayload(request, decision) {
  if (!DECISIONS.has(decision)) throw approvalError("invalid_approval_decision");
  return Buffer.from(buildApprovalSigningMessageFromBinding({
    requestId: request.id,
    payloadSha256: request.payloadSha256,
    nonce: request.nonce,
    expiresAt: request.expiresAt,
  }, decision), "utf8");
}

function validatePublicKey(encoded) {
  if (typeof encoded !== "string" || encoded.length < 80 || encoded.length > 512) {
    throw approvalError("invalid_approval_public_key");
  }
  let key;
  try {
    key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
  } catch {
    throw approvalError("invalid_approval_public_key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw approvalError("approval_key_must_be_p256");
  }
  return key;
}

function validateRequestContent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw approvalError("invalid_approval_request");
  if (typeof value.kind !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(value.kind)) throw approvalError("invalid_approval_kind");
  if (typeof value.title !== "string" || value.title.length < 1 || value.title.length > 80) throw approvalError("invalid_approval_title");
  if (typeof value.summary !== "string" || value.summary.length < 1 || value.summary.length > 500) throw approvalError("invalid_approval_summary");
  if (typeof value.payload !== "string" || value.payload.length < 1 || value.payload.length > 16_000) throw approvalError("invalid_approval_payload");
  const categories = value.dataCategories ?? [];
  if (!Array.isArray(categories) || categories.length > 12 || categories.some((item) => typeof item !== "string" || !/^[a-z0-9_-]{1,40}$/i.test(item))) {
    throw approvalError("invalid_data_categories");
  }
  return {
    kind: value.kind,
    title: value.title,
    summary: value.summary,
    payload: value.payload,
    dataCategories: [...new Set(categories)].sort(),
  };
}

function validateNewRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw approvalError("invalid_approval_request");
  const keys = Object.keys(value);
  if (keys.some((key) => !NEW_REQUEST_KEYS.has(key))) throw approvalError("invalid_approval_request");
  for (const required of ["kind", "title", "summary", "payload"]) {
    if (!Object.hasOwn(value, required)) throw approvalError("invalid_approval_request");
  }
  return validateRequestContent(value);
}

function validateStoredRequest(request, deviceKeys) {
  if (!request || typeof request !== "object" || Array.isArray(request) || request.version !== 1) {
    throw new Error("invalid_stored_approval_request");
  }
  if (typeof request.id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(request.id)) throw new Error("invalid_stored_approval_id");
  if (!Array.isArray(request.dataCategories)) throw new Error("invalid_stored_approval_categories");
  validateRequestContent(request);
  if (sha256(request.payload) !== request.payloadSha256) throw new Error("stored_approval_payload_hash_mismatch");
  const createdAt = Date.parse(request.createdAt);
  const expiresAt = Date.parse(request.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt || expiresAt - createdAt > 24 * 60 * 60_000) {
    throw new Error("invalid_stored_approval_expiry");
  }
  if (typeof request.nonce !== "string" || request.nonce.length < 32 || request.nonce.length > 128 || !/^[A-Za-z0-9_-]+$/.test(request.nonce)) {
    throw new Error("invalid_stored_approval_nonce");
  }
  if (!REQUEST_STATUSES.has(request.status)) throw new Error("invalid_stored_approval_status");

  const requiredDecision = ["approved", "consumed"].includes(request.status)
    ? "approved"
    : request.status === "rejected"
      ? "rejected"
      : null;
  const hasDecisionProof = request.decision !== undefined || request.decisionSignatureDER !== undefined || request.decidedBy !== undefined;
  if (request.status === "pending" && hasDecisionProof) throw new Error("pending_approval_contains_decision_proof");
  if (request.status === "expired" && hasDecisionProof && request.decision !== "approved") {
    throw new Error("expired_approval_has_invalid_prior_decision");
  }
  if (requiredDecision && request.decision !== requiredDecision) throw new Error("stored_approval_decision_missing");
  if (hasDecisionProof) {
    if (!DECISIONS.has(request.decision) || typeof request.decidedBy !== "string" || !/^[a-f0-9]{64}$/.test(request.decidedBy)) {
      throw new Error("invalid_stored_approval_decision_proof");
    }
    if (typeof request.decisionSignatureDER !== "string" || request.decisionSignatureDER.length < 64 || request.decisionSignatureDER.length > 256) {
      throw new Error("invalid_stored_approval_decision_signature");
    }
    const decidedAt = Date.parse(request.decidedAt);
    const keyEntry = deviceKeys[request.decidedBy];
    if (!Number.isFinite(decidedAt) || decidedAt >= expiresAt || !keyEntry) throw new Error("invalid_stored_approval_decision_metadata");
    const verified = verifySignature(
      "sha256",
      approvalSigningPayload(request, request.decision),
      validatePublicKey(keyEntry.publicKeyDER),
      Buffer.from(request.decisionSignatureDER, "base64"),
    );
    if (!verified) throw new Error("stored_approval_signature_verification_failed");
  } else if (requiredDecision) {
    throw new Error("stored_approval_decision_proof_missing");
  }
  if (request.status === "consumed" && !Number.isFinite(Date.parse(request.consumedAt))) {
    throw new Error("stored_approval_consumption_metadata_missing");
  }

  if (request.frozenRequestSha256 !== undefined) {
    if (request.kind !== "gpt.consult" || !/^[a-f0-9]{64}$/.test(request.frozenRequestSha256)) {
      throw new Error("invalid_stored_frozen_approval");
    }
    const frozen = {
      schema: "local-ai.growth.frozen-request.v1",
      requestId: request.id,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      nonce: request.nonce,
      payload: JSON.parse(request.payload),
      payloadCanonical: request.payload,
      payloadSha256: request.payloadSha256,
      requestSha256: request.frozenRequestSha256,
    };
    validateFrozenOutboundRequest(frozen, { allowExpired: true, at: createdAt });
  } else if (request.kind === "gpt.consult") {
    throw new Error("gpt_consult_must_be_frozen");
  }
  return true;
}

function validateStore(store) {
  if (store?.version !== 1 || !store.deviceKeys || typeof store.deviceKeys !== "object" || Array.isArray(store.deviceKeys) || !Array.isArray(store.requests)) {
    throw new Error("invalid_approval_store");
  }
  for (const [id, entry] of Object.entries(store.deviceKeys)) {
    if (!/^[a-f0-9]{64}$/.test(id) || !entry || typeof entry !== "object") throw new Error("invalid_stored_approval_key");
    validatePublicKey(entry.publicKeyDER);
    if (!Number.isFinite(Date.parse(entry.registeredAt))) throw new Error("invalid_stored_approval_key_timestamp");
  }
  const ids = new Set();
  for (const request of store.requests) {
    validateStoredRequest(request, store.deviceKeys);
    if (ids.has(request.id)) throw new Error("duplicate_stored_approval_id");
    ids.add(request.id);
  }
  return store;
}

export class ApprovalStore {
  constructor(path, { now = () => Date.now() } = {}) {
    this.path = path;
    this.directory = path.slice(0, path.lastIndexOf("/"));
    this.lockPath = `${path}.lock`;
    this.now = now;
    this.fileLock = new PrivateFileLock(this.lockPath, { errorPrefix: "approval_store_lock" });
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.withLock(async () => {
      try {
        await this.read();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await this.write(EMPTY_STORE);
      }
    });
  }

  async read() {
    const parsed = JSON.parse(await readFile(this.path, "utf8"));
    return validateStore(parsed);
  }

  async write(value) {
    const temporary = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  async withLock(operation) {
    return this.fileLock.withLock(operation);
  }

  async registerDeviceKey(deviceId, publicKeyDER) {
    const key = validatePublicKey(publicKeyDER);
    const normalized = key.export({ format: "der", type: "spki" }).toString("base64");
    return this.withLock(async () => {
      const store = await this.read();
      const id = approvalDeviceKeyId(deviceId);
      const current = store.deviceKeys[id];
      if (current && current.publicKeyDER !== normalized) throw approvalError("approval_key_already_registered", 409);
      if (current) return { created: false };
      store.deviceKeys[id] = { publicKeyDER: normalized, registeredAt: new Date(this.now()).toISOString() };
      await this.write(store);
      return { created: true };
    });
  }

  async createRequest(value, ttlMs = 5 * 60_000, { id = randomUUID() } = {}) {
    const request = validateNewRequest(value);
    if (request.kind === "gpt.consult") throw approvalError("gpt_consult_requires_frozen_request");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 30_000 || ttlMs > 24 * 60 * 60_000) throw approvalError("invalid_approval_ttl");
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw approvalError("invalid_approval_id");
    return this.withLock(async () => {
      const store = await this.read();
      const existing = store.requests.find((entry) => entry.id === id);
      if (existing) {
        const exact = existing.kind === request.kind && existing.title === request.title &&
          existing.summary === request.summary && existing.payload === request.payload &&
          existing.dataCategories.length === request.dataCategories.length &&
          existing.dataCategories.every((entry, index) => entry === request.dataCategories[index]);
        if (!exact) throw approvalError("approval_request_replay_mismatch", 409);
        return structuredClone(existing);
      }
      const now = this.now();
      const created = {
        version: 1,
        id,
        kind: request.kind,
        title: request.title,
        summary: request.summary,
        payload: request.payload,
        payloadSha256: sha256(request.payload),
        dataCategories: request.dataCategories,
        nonce: randomBytes(24).toString("base64url"),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
        status: "pending",
      };
      store.requests.push(created);
      await this.write(store);
      return structuredClone(created);
    });
  }

  async createFrozenRequest(frozenRequest, { title, summary } = {}) {
    validateFrozenOutboundRequest(frozenRequest, { at: this.now() });
    if (typeof title !== "string" || title.length < 1 || title.length > 80) throw approvalError("invalid_approval_title");
    if (typeof summary !== "string" || summary.length < 1 || summary.length > 500) throw approvalError("invalid_approval_summary");
    return this.withLock(async () => {
      const store = await this.read();
      if (store.requests.some((entry) => entry.id === frozenRequest.requestId)) {
        throw approvalError("approval_request_already_exists", 409);
      }
      const created = {
        version: 1,
        id: frozenRequest.requestId,
        kind: "gpt.consult",
        title,
        summary,
        payload: frozenRequest.payloadCanonical,
        payloadSha256: frozenRequest.payloadSha256,
        frozenRequestSha256: frozenRequest.requestSha256,
        dataCategories: [...frozenRequest.payload.request.dataCategories],
        nonce: frozenRequest.nonce,
        createdAt: frozenRequest.createdAt,
        expiresAt: frozenRequest.expiresAt,
        status: "pending",
      };
      if (sha256(created.payload) !== created.payloadSha256) throw approvalError("frozen_payload_hash_mismatch", 409);
      store.requests.push(created);
      await this.write(store);
      return structuredClone(created);
    });
  }

  async listPending() {
    return this.withLock(async () => {
      const store = await this.read();
      const changed = this.expireRequests(store);
      if (changed) await this.write(store);
      return store.requests.filter((entry) => entry.status === "pending").map((entry) => structuredClone(entry));
    });
  }

  async get(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) throw approvalError("invalid_approval_id");
    return this.withLock(async () => {
      const store = await this.read();
      if (this.expireRequests(store)) await this.write(store);
      const request = store.requests.find((entry) => entry.id === id);
      return request ? structuredClone(request) : null;
    });
  }

  async deleteCodexRequests(ids) {
    if (
      !Array.isArray(ids) || ids.length > 1_000 ||
      ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(id))
    ) throw approvalError("invalid_codex_approval_retention_ids");
    const requested = new Set(ids);
    if (requested.size === 0) return [];
    return this.withLock(async () => {
      const store = await this.read();
      const removed = store.requests
        .filter((request) => request.kind === "codex.execute" && requested.has(request.id))
        .map((request) => request.id);
      if (removed.length === 0) return [];
      const removedIds = new Set(removed);
      store.requests = store.requests.filter((request) => !removedIds.has(request.id));
      await this.write(store);
      return removed;
    });
  }

  async pruneOrphanedCodexRequests(retainedIds) {
    if (
      !Array.isArray(retainedIds) || retainedIds.length > 10_000 ||
      retainedIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(id))
    ) throw approvalError("invalid_codex_approval_retention_ids");
    const retained = new Set(retainedIds);
    return this.withLock(async () => {
      const store = await this.read();
      const removed = store.requests
        .filter((request) =>
          request.kind === "codex.execute" &&
          ["consumed", "rejected", "expired"].includes(request.status) &&
          isStrictOwnerCodexPlanV3(request.payload) &&
          !retained.has(request.id))
        .map((request) => request.id);
      if (removed.length === 0) return [];
      const removedIds = new Set(removed);
      store.requests = store.requests.filter((request) => !removedIds.has(request.id));
      await this.write(store);
      return removed;
    });
  }

  async decide({ id, deviceId, decision, signatureDER }) {
    if (!DECISIONS.has(decision)) throw approvalError("invalid_approval_decision");
    if (typeof signatureDER !== "string" || signatureDER.length < 64 || signatureDER.length > 256) throw approvalError("invalid_approval_signature", 403);
    return this.withLock(async () => {
      const store = await this.read();
      if (this.expireRequests(store)) await this.write(store);
      const request = store.requests.find((entry) => entry.id === id);
      if (!request) throw approvalError("approval_not_found", 404);
      const codexDerivedDevice = typeof deviceId === "string" && /^codex-[a-f0-9]{64}$/u.test(deviceId);
      if ((request.kind === "codex.execute") !== codexDerivedDevice) {
        throw approvalError("codex_dedicated_approval_required", 403);
      }
      const decidingKeyId = approvalDeviceKeyId(deviceId);
      const keyEntry = store.deviceKeys[decidingKeyId];
      if (!keyEntry) throw approvalError("approval_key_not_registered", 409);
      const key = validatePublicKey(keyEntry.publicKeyDER);
      const valid = verifySignature(
        "sha256",
        approvalSigningPayload(request, decision),
        key,
        Buffer.from(signatureDER, "base64"),
      );
      if (!valid) throw approvalError("invalid_approval_signature", 403);

      if (request.status !== "pending") {
        const idempotent =
          ((decision === "approved" && ["approved", "consumed"].includes(request.status)) ||
            (decision === "rejected" && request.status === "rejected")) &&
          request.decision === decision && request.decidedBy === decidingKeyId;
        if (!idempotent) throw approvalError("approval_not_pending", 409);
        return { id: request.id, kind: request.kind, status: decision, payloadSha256: request.payloadSha256 };
      }

      request.status = decision;
      request.decision = decision;
      request.decidedAt = new Date(this.now()).toISOString();
      request.decidedBy = decidingKeyId;
      request.decisionSignatureDER = signatureDER;
      await this.write(store);
      return { id: request.id, kind: request.kind, status: request.status, payloadSha256: request.payloadSha256 };
    });
  }

  async consumeApproved(id, expectedBinding) {
    return this.withLock(async () => {
      const store = await this.read();
      const changed = this.expireRequests(store);
      const request = store.requests.find((entry) => entry.id === id);
      if (!request || request.status !== "approved") {
        if (changed) await this.write(store);
        return null;
      }
      const expectedPayloadSha256 = typeof expectedBinding === "string" ? expectedBinding : expectedBinding?.payloadSha256;
      if (request.payloadSha256 !== expectedPayloadSha256) throw approvalError("approved_payload_hash_mismatch", 409);
      if (request.frozenRequestSha256 !== undefined) {
        if (!expectedBinding || typeof expectedBinding !== "object") throw approvalError("frozen_approval_binding_required", 409);
        const exact =
          expectedBinding.frozenRequestSha256 === request.frozenRequestSha256 &&
          expectedBinding.nonce === request.nonce &&
          expectedBinding.expiresAt === request.expiresAt;
        if (!exact) throw approvalError("approved_frozen_request_binding_mismatch", 409);
      }
      request.status = "consumed";
      request.consumedAt = new Date(this.now()).toISOString();
      await this.write(store);
      return structuredClone(request);
    });
  }

  expireRequests(store) {
    const now = this.now();
    let changed = false;
    for (const request of store.requests) {
      if (["pending", "approved"].includes(request.status) && Date.parse(request.expiresAt) <= now) {
        request.status = "expired";
        changed = true;
      }
    }
    return changed;
  }
}
