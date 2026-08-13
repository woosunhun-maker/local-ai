import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalizeJson, isSha256, sha256Hex } from "./canonical.mjs";
import { createFrozenOutboundRequest, validateFrozenOutboundRequest } from "./outbound-request.mjs";
import { createUntrustedProposal } from "./proposal.mjs";

const DISPATCH_STATUSES = new Set(["prepared", "dispatching", "completed", "quarantined"]);
const DISPATCH_KEYS = new Set([
  "version",
  "requestId",
  "requestSha256",
  "payloadSha256",
  "nonce",
  "expiresAt",
  "correlationId",
  "status",
  "preparedAt",
  "dispatchStartedAt",
  "completedAt",
  "providerRequestId",
  "responseText",
  "responseSha256",
  "quarantinedAt",
  "proposalId",
  "stateSha256",
]);

function validRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) throw new Error(`${label}_schema_invalid`);
}

function isoOrNull(value, label) {
  if (value === null) return;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label}_invalid`);
}

function stateDigestMaterial(state) {
  const { stateSha256: _stateSha256, ...material } = state;
  return material;
}

function sealDispatchState(state) {
  const material = JSON.parse(canonicalizeJson(stateDigestMaterial(state)));
  return Object.freeze({
    ...material,
    stateSha256: sha256Hex(canonicalizeJson(material)),
  });
}

function validateDispatchState(state) {
  exactKeys(state, DISPATCH_KEYS, "growth_dispatch_state");
  if (state.version !== 1 || !validRequestId(state.requestId) || !validRequestId(state.correlationId)) {
    throw new Error("growth_dispatch_identity_invalid");
  }
  if (!isSha256(state.requestSha256) || !isSha256(state.payloadSha256)) throw new Error("growth_dispatch_binding_invalid");
  if (typeof state.nonce !== "string" || state.nonce.length < 32 || !/^[A-Za-z0-9_-]+$/.test(state.nonce)) {
    throw new Error("growth_dispatch_nonce_invalid");
  }
  isoOrNull(state.expiresAt, "growth_dispatch_expiry");
  isoOrNull(state.preparedAt, "growth_dispatch_prepared_at");
  isoOrNull(state.dispatchStartedAt, "growth_dispatch_started_at");
  isoOrNull(state.completedAt, "growth_dispatch_completed_at");
  isoOrNull(state.quarantinedAt, "growth_dispatch_quarantined_at");
  if (!DISPATCH_STATUSES.has(state.status)) throw new Error("growth_dispatch_status_invalid");
  if (state.status !== "prepared" && state.dispatchStartedAt === null) throw new Error("growth_dispatch_start_missing");
  if (["completed", "quarantined"].includes(state.status)) {
    if (state.completedAt === null || typeof state.responseText !== "string" || state.responseText.length < 1 || state.responseText.length > 20_000) {
      throw new Error("growth_dispatch_response_missing");
    }
    if (!isSha256(state.responseSha256) || sha256Hex(state.responseText) !== state.responseSha256) {
      throw new Error("growth_dispatch_response_hash_mismatch");
    }
  } else if (state.responseText !== null || state.responseSha256 !== null || state.completedAt !== null) {
    throw new Error("growth_dispatch_response_before_completion");
  }
  if (state.providerRequestId !== null && (typeof state.providerRequestId !== "string" || state.providerRequestId.length > 200)) {
    throw new Error("growth_dispatch_provider_id_invalid");
  }
  if (state.status === "quarantined") {
    if (!validRequestId(state.proposalId) || state.quarantinedAt === null) throw new Error("growth_dispatch_proposal_missing");
  } else if (state.proposalId !== null || state.quarantinedAt !== null) {
    throw new Error("growth_dispatch_proposal_state_invalid");
  }
  if (!isSha256(state.stateSha256) || sha256Hex(canonicalizeJson(stateDigestMaterial(state))) !== state.stateSha256) {
    throw new Error("growth_dispatch_state_hash_mismatch");
  }
  return state;
}

function receipt(state) {
  return Object.freeze({
    requestId: state.requestId,
    requestSha256: state.requestSha256,
    payloadSha256: state.payloadSha256,
    correlationId: state.correlationId,
    status: state.status,
    dispatchStartedAt: state.dispatchStartedAt,
    completedAt: state.completedAt,
    providerRequestId: state.providerRequestId,
    responseSha256: state.responseSha256,
    stateSha256: state.stateSha256,
  });
}

export class GrowthCoordinator {
  constructor({ rootPath, approvalStore, proposalStore, dispatchAdapter = null, now = () => Date.now() }) {
    this.rootPath = rootPath;
    this.outboundPath = join(rootPath, "outbound");
    this.dispatchPath = join(rootPath, "dispatch");
    this.approvalStore = approvalStore;
    this.proposalStore = proposalStore;
    this.dispatchAdapter = dispatchAdapter;
    this.now = now;
  }

  async initialize() {
    await mkdir(this.outboundPath, { recursive: true, mode: 0o700 });
    await mkdir(this.dispatchPath, { recursive: true, mode: 0o700 });
    await this.proposalStore.initialize();
  }

  async prepareConsultation(draft, { title = "외부 AI 기술 자문", summary = "비식별 기술 정보만 전송", ttlMs } = {}) {
    const frozen = createFrozenOutboundRequest(draft, { now: this.now(), ttlMs });
    const path = join(this.outboundPath, `${frozen.requestId}.json`);
    await writeFile(path, `${JSON.stringify(frozen, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      await this.approvalStore.createFrozenRequest(frozen, { title, summary });
    } catch (error) {
      await unlink(path).catch(() => {});
      throw error;
    }
    return {
      requestId: frozen.requestId,
      requestSha256: frozen.requestSha256,
      payloadSha256: frozen.payloadSha256,
      expiresAt: frozen.expiresAt,
    };
  }

  async dispatchApprovedRequest(requestId) {
    if (typeof this.dispatchAdapter !== "function") throw new Error("growth_external_transport_disabled");
    return this.withDispatchLock(requestId, async () => {
      const frozen = await this.readFrozenRequest(requestId);
      let state = await this.readDispatchState(requestId);
      if (!state) {
        state = sealDispatchState({
          version: 1,
          requestId,
          requestSha256: frozen.requestSha256,
          payloadSha256: frozen.payloadSha256,
          nonce: frozen.nonce,
          expiresAt: frozen.expiresAt,
          correlationId: randomBytes(18).toString("base64url"),
          status: "prepared",
          preparedAt: new Date(this.now()).toISOString(),
          dispatchStartedAt: null,
          completedAt: null,
          providerRequestId: null,
          responseText: null,
          responseSha256: null,
          quarantinedAt: null,
          proposalId: null,
        });
        await this.writeDispatchState(state, { initial: true });
      }
      this.assertDispatchBinding(state, frozen);
      if (["completed", "quarantined"].includes(state.status)) {
        return { receipt: receipt(state), externalResponse: state.responseText, reused: true };
      }
      if (state.status === "dispatching") throw new Error("growth_dispatch_in_doubt_no_retry");

      const approval = await this.approvalStore.consumeApproved(requestId, {
        payloadSha256: frozen.payloadSha256,
        frozenRequestSha256: frozen.requestSha256,
        nonce: frozen.nonce,
        expiresAt: frozen.expiresAt,
      });
      if (!approval) return null;

      state = sealDispatchState({
        ...state,
        status: "dispatching",
        dispatchStartedAt: new Date(this.now()).toISOString(),
      });
      await this.writeDispatchState(state);

      const result = await this.dispatchAdapter(Object.freeze({
        correlationId: state.correlationId,
        requestId: frozen.requestId,
        requestSha256: frozen.requestSha256,
        payloadSha256: frozen.payloadSha256,
        payloadCanonical: frozen.payloadCanonical,
      }));
      const responseText = typeof result === "string" ? result : result?.responseText;
      const providerRequestId = typeof result === "object" && result !== null ? (result.providerRequestId ?? null) : null;
      if (typeof responseText !== "string" || responseText.length < 1 || responseText.length > 20_000) {
        throw new Error("growth_dispatch_response_invalid");
      }
      if (providerRequestId !== null && (typeof providerRequestId !== "string" || providerRequestId.length > 200)) {
        throw new Error("growth_dispatch_provider_id_invalid");
      }
      state = sealDispatchState({
        ...state,
        status: "completed",
        completedAt: new Date(this.now()).toISOString(),
        providerRequestId,
        responseText,
        responseSha256: sha256Hex(responseText),
      });
      await this.writeDispatchState(state);
      return { receipt: receipt(state), externalResponse: responseText, reused: false };
    });
  }

  async quarantineAdvice({ requestId, correlationId, proposalContent }) {
    return this.withDispatchLock(requestId, async () => {
      const state = await this.readDispatchState(requestId);
      if (!state || !["completed", "quarantined"].includes(state.status)) throw new Error("growth_dispatch_not_completed");
      if (state.correlationId !== correlationId) throw new Error("growth_dispatch_correlation_mismatch");
      if (state.status === "quarantined") return this.proposalStore.readLatest(state.proposalId);
      const frozen = await this.readFrozenRequest(requestId, { allowExpired: true });
      this.assertDispatchBinding(state, frozen);
      const proposal = createUntrustedProposal({
        outboundRequestSha256: frozen.requestSha256,
        provider: frozen.payload.destination.provider,
        model: frozen.payload.destination.model,
        externalResponse: state.responseText,
        content: proposalContent,
      }, { now: Date.parse(state.completedAt), id: state.correlationId });
      const existing = await this.proposalStore.readLatest(proposal.id);
      if (existing) {
        if (existing.integrity.recordSha256 !== proposal.integrity.recordSha256) {
          throw new Error("growth_dispatch_proposal_correlation_conflict");
        }
      } else {
        await this.proposalStore.append(proposal);
      }
      const next = sealDispatchState({
        ...state,
        status: "quarantined",
        quarantinedAt: new Date(this.now()).toISOString(),
        proposalId: proposal.id,
      });
      await this.writeDispatchState(next);
      return existing ?? proposal;
    });
  }

  async status() {
    const [approvals, proposals] = await Promise.all([
      this.approvalStore.listPending(),
      this.proposalStore.listLatest(),
    ]);
    return {
      mode: "proposal_only",
      externalTransfer: "exact_payload_iphone_approval",
      autoApply: false,
      transportEnabled: typeof this.dispatchAdapter === "function",
      pendingConsultations: approvals.filter((entry) => entry.kind === "gpt.consult").length,
      pendingProposals: proposals.filter((entry) => entry.lifecycle.status === "pending").length,
      proposals: proposals.length,
    };
  }

  async withDispatchLock(requestId, operation) {
    if (!validRequestId(requestId)) throw new Error("invalid_growth_request_id");
    const lockPath = join(this.dispatchPath, `${requestId}.lock`);
    let handle;
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("growth_dispatch_already_in_progress");
      throw error;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async readDispatchState(requestId) {
    if (!validRequestId(requestId)) throw new Error("invalid_growth_request_id");
    const path = join(this.dispatchPath, `${requestId}.json`);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) throw new Error("unsafe_growth_dispatch_file");
      return validateDispatchState(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async writeDispatchState(state, { initial = false } = {}) {
    validateDispatchState(state);
    const path = join(this.dispatchPath, `${state.requestId}.json`);
    const content = `${canonicalizeJson(state)}\n`;
    if (initial) {
      await writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return;
    }
    const temporary = join(this.dispatchPath, `.${state.requestId}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  }

  assertDispatchBinding(state, frozen) {
    const exact =
      state.requestId === frozen.requestId &&
      state.requestSha256 === frozen.requestSha256 &&
      state.payloadSha256 === frozen.payloadSha256 &&
      state.nonce === frozen.nonce &&
      state.expiresAt === frozen.expiresAt;
    if (!exact) throw new Error("growth_dispatch_frozen_binding_mismatch");
  }

  async readFrozenRequest(requestId, { allowExpired = false } = {}) {
    if (!validRequestId(requestId)) throw new Error("invalid_growth_request_id");
    const root = await realpath(this.outboundPath);
    const path = join(root, `${requestId}.json`);
    const [resolved, metadata] = await Promise.all([realpath(path), lstat(path)]);
    if (!metadata.isFile() || metadata.isSymbolicLink() || !resolved.startsWith(`${root}/`) || metadata.size > 32 * 1024) {
      throw new Error("unsafe_growth_request_file");
    }
    const frozen = JSON.parse(await readFile(resolved, "utf8"));
    validateFrozenOutboundRequest(frozen, { at: this.now(), allowExpired });
    if (frozen.requestId !== requestId) throw new Error("growth_request_id_mismatch");
    return frozen;
  }
}
