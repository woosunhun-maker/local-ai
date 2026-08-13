/**
 * 실행 전 고정된 success_criteria만으로 PASS 판정.
 * 모델이 실행 후 조건을 바꾸거나 완화할 수 없다.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical-json.mjs";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

export function successCriteriaDigest(criteria) {
  return createHash("sha256").update(canonicalJson(criteria ?? [])).digest("hex");
}

/**
 * criteria 항목을 host/task evidence 관측과 대조.
 * @returns {{ id: string, status: "verified"|"fail"|"unknown", required: boolean, security?: boolean, detail?: string }}
 */
function evaluateOneCriterion(criterion, { host, task, envelope } = {}) {
  const raw = typeof criterion === "string"
    ? { type: "claim_includes", claim_includes: criterion }
    : criterion;
  if (!raw || typeof raw.type !== "string") {
    return { id: "invalid", status: "fail", required: true, detail: "invalid_criterion" };
  }

  const id = raw.id ?? raw.type;
  switch (raw.type) {
    case "session_present":
      return {
        id,
        required: true,
        security: true,
        status: host?.session_id ? "verified" : "unknown",
      };
    case "sandbox_clean":
      return {
        id,
        required: true,
        security: true,
        status: (host?.blocked_files?.length ?? 0) === 0 ? "verified" : "fail",
      };
    case "test_exit_zero":
      return {
        id,
        required: true,
        security: false,
        status: host?.test_exit_code === 0 ? "verified" : "fail",
        detail: `exit=${host?.test_exit_code}`,
      };
    case "diff_hash_present":
      return {
        id,
        required: true,
        security: true,
        status: host?.diff_hash && host.diff_hash_kind !== "unresolved" ? "verified" : "unknown",
      };
    case "write_path_observed_if_changed":
      return {
        id,
        required: Boolean(host?.has_content_changes),
        security: true,
        status: !host?.has_content_changes || host.write_path_observed ? "verified" : "unknown",
      };
    case "changed_files_within_allowed_paths": {
      const allowed = envelope?.allowed_paths ?? [];
      const changed = host?.changed_files ?? [];
      const ok = changed.every((file) => allowed.some((prefix) =>
        file === prefix || file.startsWith(prefix.replace(/\/?$/u, "/")) || file.startsWith(prefix)));
      return {
        id,
        required: true,
        security: true,
        status: ok ? "verified" : "fail",
        detail: ok ? null : "path_outside_envelope",
      };
    }
    case "no_main_repo_writes":
      return {
        id,
        required: true,
        security: true,
        status: (host?.main_repo_writes?.length ?? 0) === 0 ? "verified" : "fail",
      };
    case "claim_includes": {
      const needle = raw.claim_includes ?? raw.claim;
      const evidence = Array.isArray(task?.evidence) ? task.evidence : (host?.evidence ?? []);
      const hit = evidence.some((item) =>
        item?.epistemic === "VERIFIED" && String(item.claim).includes(String(needle)));
      return {
        id,
        required: raw.required !== false,
        security: raw.security === true,
        status: hit ? "verified" : "unknown",
      };
    }
    case "out_of_scope_not_touched": {
      const patterns = (envelope?.out_of_scope ?? [])
        .map((item) => (typeof item === "string" ? item : item?.path))
        .filter(Boolean);
      const changed = host?.changed_files ?? [];
      const hit = changed.some((file) => patterns.some((p) => file.includes(p)));
      return {
        id,
        required: true,
        security: true,
        status: hit ? "fail" : "verified",
      };
    }
    default:
      return {
        id,
        required: true,
        security: true,
        status: "unknown",
        detail: `unsupported_criterion:${raw.type}`,
      };
  }
}

/**
 * 동결된 success_criteria로 checks 배열 생성.
 * host 기본 보안 체크와 병합 가능.
 */
export function buildSuccessCriteriaChecks({
  successCriteria,
  envelope,
  host,
  task,
  expectedDigest = null,
} = {}) {
  if (!Array.isArray(successCriteria) || successCriteria.length < 1) {
    fail("success_criteria_required");
  }
  const digest = successCriteriaDigest(successCriteria);
  if (expectedDigest && digest !== expectedDigest) {
    return Object.freeze([
      Object.freeze({
        id: "success_criteria_frozen",
        required: true,
        security: true,
        status: "fail",
        detail: "success_criteria_digest_mismatch",
      }),
    ]);
  }
  if (envelope?.success_criteria) {
    const envelopeDigest = successCriteriaDigest(envelope.success_criteria);
    if (envelopeDigest !== digest) {
      return Object.freeze([
        Object.freeze({
          id: "success_criteria_frozen",
          required: true,
          security: true,
          status: "fail",
          detail: "criteria_diverged_from_envelope",
        }),
      ]);
    }
  }

  return Object.freeze(successCriteria.map((criterion) =>
    Object.freeze(evaluateOneCriterion(criterion, { host, task, envelope }))));
}
