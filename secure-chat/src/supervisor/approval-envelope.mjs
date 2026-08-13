/**
 * Immutable Approval Envelope — 최초 사용자 승인 범위를 digest로 고정.
 * Auto-replan은 digest 범위 안에서만 허용. 깨지면 재승인.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.mjs";

export const APPROVAL_ENVELOPE_SCHEMA = "local-ai.approval-envelope.v1";
export const APPROVAL_ENVELOPE_KIND = "development.envelope";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function positiveInt(value, field, { min = 1, max = 100 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) fail(`invalid_envelope_${field}`);
  return value;
}

/**
 * Envelope 본문(불변 필드) 생성 + digest.
 * no_merge / no_push / no_deploy / auto_commit=false 는 강제.
 */
export function createApprovalEnvelope({
  runId,
  goal,
  proposalDigest,
  successCriteria,
  outOfScope,
  worktreePath,
  branch,
  allowedPaths,
  allowedCommands,
  riskClass = "HIGH",
  maxLeafTasks = 3,
  maxReplansPerTask = 2,
  maxTotalAttempts = 6,
  maxRuntimeMs = 60 * 60_000,
  expiresAt = null,
  now = () => Date.now(),
} = {}) {
  if (typeof runId !== "string" || runId.length < 8) fail("invalid_envelope_run_id");
  if (typeof goal !== "string" || goal.trim().length < 8) fail("invalid_envelope_goal");
  if (typeof proposalDigest !== "string" || !/^[a-f0-9]{64}$/u.test(proposalDigest)) {
    fail("invalid_envelope_proposal_digest");
  }
  if (!Array.isArray(successCriteria) || successCriteria.length < 1) fail("invalid_envelope_success_criteria");
  if (!Array.isArray(outOfScope)) fail("invalid_envelope_out_of_scope");
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("/")) fail("invalid_envelope_worktree");
  if (typeof branch !== "string" || branch.trim().length < 3) fail("invalid_envelope_branch");

  const createdAtMs = now();
  const expiry = expiresAt
    ?? new Date(createdAtMs + positiveInt(maxRuntimeMs, "max_runtime_ms", { min: 60_000, max: 24 * 60 * 60_000 })).toISOString();

  const body = Object.freeze({
    schema: APPROVAL_ENVELOPE_SCHEMA,
    run_id: runId,
    goal: goal.trim().slice(0, 2_000),
    proposal_digest: proposalDigest,
    success_criteria: Object.freeze([...successCriteria]),
    out_of_scope: Object.freeze([...outOfScope]),
    worktree_path: worktreePath,
    branch: branch.trim(),
    allowed_paths: Object.freeze([...(allowedPaths ?? [])].map(String)),
    allowed_commands: Object.freeze([...(allowedCommands ?? [])].map(String)),
    risk_class: ["LOW", "MEDIUM", "HIGH"].includes(riskClass) ? riskClass : "HIGH",
    max_leaf_tasks: positiveInt(maxLeafTasks, "max_leaf_tasks", { min: 1, max: 20 }),
    max_replans_per_task: positiveInt(maxReplansPerTask, "max_replans_per_task", { min: 0, max: 10 }),
    max_total_attempts: positiveInt(maxTotalAttempts, "max_total_attempts", { min: 1, max: 50 }),
    max_runtime_ms: positiveInt(maxRuntimeMs, "max_runtime_ms", { min: 60_000, max: 24 * 60 * 60_000 }),
    expires_at: expiry,
    no_merge: true,
    no_push: true,
    no_deploy: true,
    auto_commit: false,
  });

  const digest = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return Object.freeze({
    ...body,
    envelope_digest: digest,
    created_at: new Date(createdAtMs).toISOString(),
  });
}

/** 저장된 envelope가 digest와 일치하는지 (변조/범위 확장 탐지) */
export function verifyEnvelopeIntegrity(envelope) {
  if (!envelope || envelope.schema !== APPROVAL_ENVELOPE_SCHEMA) {
    return Object.freeze({ ok: false, reason: "invalid_envelope_schema" });
  }
  const { envelope_digest: claimed, created_at: _created, ...body } = envelope;
  const expected = createHash("sha256").update(canonicalJson(body)).digest("hex");
  if (claimed !== expected) {
    return Object.freeze({ ok: false, reason: "envelope_digest_mismatch" });
  }
  return Object.freeze({ ok: true, reason: "ok", digest: expected });
}

export function isEnvelopeExpired(envelope, nowMs = Date.now()) {
  if (!envelope?.expires_at) return true;
  return Date.parse(envelope.expires_at) <= nowMs;
}

/**
 * 재실행 시도가 최초 envelope 범위 안인지.
 * 새 path/command/risk/criteria 변경이면 false → 재승인.
 */
export function isAttemptWithinEnvelope(envelope, attempt = {}) {
  const integrity = verifyEnvelopeIntegrity(envelope);
  if (!integrity.ok) return Object.freeze({ allowed: false, reason: integrity.reason });
  if (isEnvelopeExpired(envelope, attempt.nowMs ?? Date.now())) {
    return Object.freeze({ allowed: false, reason: "envelope_expired" });
  }
  if (attempt.proposal_digest && attempt.proposal_digest !== envelope.proposal_digest) {
    return Object.freeze({ allowed: false, reason: "proposal_digest_changed" });
  }
  if (attempt.worktree_path && attempt.worktree_path !== envelope.worktree_path) {
    return Object.freeze({ allowed: false, reason: "worktree_changed" });
  }
  if (attempt.risk_class && attempt.risk_class !== envelope.risk_class) {
    return Object.freeze({ allowed: false, reason: "risk_increased" });
  }
  if (Array.isArray(attempt.allowed_paths)) {
    const allowed = new Set(envelope.allowed_paths);
    if (attempt.allowed_paths.some((p) => !allowed.has(p))) {
      return Object.freeze({ allowed: false, reason: "allowed_paths_expanded" });
    }
  }
  if (Array.isArray(attempt.allowed_commands)) {
    const allowed = new Set(envelope.allowed_commands);
    if (attempt.allowed_commands.some((c) => !allowed.has(c))) {
      return Object.freeze({ allowed: false, reason: "allowed_commands_expanded" });
    }
  }
  if (attempt.success_criteria_digest) {
    const frozen = createHash("sha256")
      .update(canonicalJson(envelope.success_criteria))
      .digest("hex");
    if (attempt.success_criteria_digest !== frozen) {
      return Object.freeze({ allowed: false, reason: "success_criteria_changed" });
    }
  }
  if (attempt.no_merge === false || attempt.no_push === false || attempt.no_deploy === false) {
    return Object.freeze({ allowed: false, reason: "safety_flags_weakened" });
  }
  return Object.freeze({ allowed: true, reason: "within_envelope" });
}

export function envelopeApprovalPayload(envelope) {
  return JSON.stringify({
    schema: APPROVAL_ENVELOPE_SCHEMA,
    envelope_digest: envelope.envelope_digest,
    envelope,
  });
}
