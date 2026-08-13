/**
 * Task Verifier — 모델이 "성공했다"고 말한 것만으로 PASS하지 않는다.
 * 결과: PASS | PASS_WITH_WARNINGS | FAIL | UNKNOWN
 *
 * 필수(required) expectation이 빠지거나 security 필수 항목이 UNKNOWN이면
 * all_expectations_verified(PASS)를 반환하지 않는다.
 */
import { createEvidenceRecord } from "../evidence/evidence.mjs";

export const VERIFY_RESULTS = Object.freeze([
  "PASS",
  "PASS_WITH_WARNINGS",
  "FAIL",
  "UNKNOWN",
]);

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

/**
 * @param {{
 *   task: object,
 *   expectations?: Array<{
 *     service?: string,
 *     status?: string,
 *     claim_includes?: string,
 *     epistemic?: string,
 *     required?: boolean,
 *     security?: boolean,
 *     allow_unknown?: boolean,
 *   }>,
 *   requireVerified?: boolean,
 *   checks?: Array<{
 *     id: string,
 *     status: "verified"|"partial"|"unknown"|"fail",
 *     required?: boolean,
 *     security?: boolean,
 *     warning?: boolean,
 *     detail?: string,
 *   }>,
 * }} input
 */
export function verifyTaskOutcome({
  task,
  expectations = [],
  requireVerified = true,
  checks = null,
} = {}) {
  if (!task || typeof task.task_id !== "string") fail("invalid_verify_task");
  const evidence = Array.isArray(task.evidence) ? task.evidence : [];
  const verified = evidence.filter((item) => item?.epistemic === "VERIFIED");
  const unknownEvidence = evidence.filter((item) => item?.epistemic === "UNKNOWN");
  const inferredOnly = evidence.length > 0 && verified.length < 1
    && evidence.every((item) => item?.epistemic === "INFERRED" || item?.epistemic === "UNKNOWN");

  if (inferredOnly) {
    return Object.freeze({
      result: "FAIL",
      reason: "inferred_evidence_cannot_prove_success",
      checked_at: new Date().toISOString(),
      matched: Object.freeze([]),
      missing: Object.freeze(["verified_evidence"]),
      warnings: Object.freeze([]),
    });
  }

  if (requireVerified && verified.length < 1) {
    return Object.freeze({
      result: "UNKNOWN",
      reason: "no_verified_evidence",
      checked_at: new Date().toISOString(),
      matched: Object.freeze([]),
      missing: Object.freeze(["verified_evidence"]),
      warnings: Object.freeze([]),
    });
  }

  // 구조화 checks가 있으면 expectation 문자열 매칭보다 우선
  if (Array.isArray(checks) && checks.length > 0) {
    const failed = checks.filter((c) => c.status === "fail");
    const requiredUnknown = checks.filter(
      (c) => c.required !== false && (c.status === "unknown" || c.status === "partial"),
    );
    const securityUnknown = checks.filter(
      (c) => c.security === true && (c.status === "unknown" || c.status === "partial"),
    );
    const warnings = checks.filter((c) => c.warning === true || (c.required === false && c.status !== "verified"));

    if (failed.length > 0) {
      return Object.freeze({
        result: "FAIL",
        reason: `checks_failed:${failed.map((c) => c.id).join(",")}`,
        checked_at: new Date().toISOString(),
        matched: Object.freeze(checks.filter((c) => c.status === "verified").map((c) => c.id)),
        missing: Object.freeze(failed.map((c) => c.id)),
        warnings: Object.freeze([]),
      });
    }
    if (securityUnknown.length > 0) {
      return Object.freeze({
        result: "UNKNOWN",
        reason: `security_expectation_unknown:${securityUnknown.map((c) => c.id).join(",")}`,
        checked_at: new Date().toISOString(),
        matched: Object.freeze(checks.filter((c) => c.status === "verified").map((c) => c.id)),
        missing: Object.freeze(securityUnknown.map((c) => c.id)),
        warnings: Object.freeze([]),
      });
    }
    if (requiredUnknown.length > 0) {
      return Object.freeze({
        result: "UNKNOWN",
        reason: `required_expectation_incomplete:${requiredUnknown.map((c) => c.id).join(",")}`,
        checked_at: new Date().toISOString(),
        matched: Object.freeze(checks.filter((c) => c.status === "verified").map((c) => c.id)),
        missing: Object.freeze(requiredUnknown.map((c) => c.id)),
        warnings: Object.freeze([]),
      });
    }
    if (warnings.length > 0) {
      return Object.freeze({
        result: "PASS_WITH_WARNINGS",
        reason: "required_verified_with_warnings",
        checked_at: new Date().toISOString(),
        matched: Object.freeze(checks.filter((c) => c.status === "verified").map((c) => c.id)),
        missing: Object.freeze([]),
        warnings: Object.freeze(warnings.map((c) => c.id)),
      });
    }
    return Object.freeze({
      result: "PASS",
      reason: "all_expectations_verified",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(checks.map((c) => c.id)),
      missing: Object.freeze([]),
      warnings: Object.freeze([]),
    });
  }

  if (!Array.isArray(expectations) || expectations.length < 1) {
    return Object.freeze({
      result: verified.length > 0 ? "PASS" : "UNKNOWN",
      reason: verified.length > 0 ? "verified_evidence_present" : "no_expectations_or_evidence",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(verified.map((item) => item.evidence_id)),
      missing: Object.freeze([]),
      warnings: Object.freeze([]),
    });
  }

  const matched = [];
  const missing = [];
  const missingSecurity = [];
  const warnings = [];

  for (const expectation of expectations) {
    const found = verified.find((item) => {
      if (expectation.epistemic && item.epistemic !== expectation.epistemic) return false;
      if (expectation.claim_includes && !String(item.claim).includes(expectation.claim_includes)) return false;
      if (expectation.service && item.detail?.service !== expectation.service) return false;
      if (expectation.status && String(item.detail?.status) !== String(expectation.status)) return false;
      return true;
    });
    const label = expectation.claim_includes ?? expectation.service ?? "expectation";
    const isRequired = expectation.required !== false;
    if (found) {
      matched.push(found.evidence_id);
      continue;
    }
    // UNKNOWN evidence that matches claim → partial for that expectation
    const unknownHit = unknownEvidence.find((item) =>
      expectation.claim_includes && String(item.claim).includes(expectation.claim_includes));
    if (unknownHit && isRequired) {
      if (expectation.security) missingSecurity.push(label);
      else missing.push(label);
      continue;
    }
    if (!isRequired) {
      warnings.push(label);
      continue;
    }
    if (expectation.security) missingSecurity.push(label);
    else missing.push(label);
  }

  if (missingSecurity.length > 0) {
    return Object.freeze({
      result: "UNKNOWN",
      reason: "security_expectation_unknown",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(matched),
      missing: Object.freeze(missingSecurity),
      warnings: Object.freeze(warnings),
    });
  }

  if (missing.length > 0 && matched.length < 1) {
    return Object.freeze({
      result: "FAIL",
      reason: "expectations_unmet",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(matched),
      missing: Object.freeze(missing),
      warnings: Object.freeze(warnings),
    });
  }
  if (missing.length > 0) {
    // 필수 누락이 있으면 PASS/all_expectations_verified 금지
    return Object.freeze({
      result: "UNKNOWN",
      reason: "partial_expectations",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(matched),
      missing: Object.freeze(missing),
      warnings: Object.freeze(warnings),
    });
  }
  if (warnings.length > 0) {
    return Object.freeze({
      result: "PASS_WITH_WARNINGS",
      reason: "required_verified_with_warnings",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(matched),
      missing: Object.freeze([]),
      warnings: Object.freeze(warnings),
    });
  }
  return Object.freeze({
    result: "PASS",
    reason: "all_expectations_verified",
    checked_at: new Date().toISOString(),
    matched: Object.freeze(matched),
    missing: Object.freeze([]),
    warnings: Object.freeze([]),
  });
}

export function verificationEvidence(result, { taskId = null } = {}) {
  const epistemic = result.result === "PASS" || result.result === "PASS_WITH_WARNINGS" || result.result === "FAIL"
    ? "VERIFIED"
    : "UNKNOWN";
  return createEvidenceRecord({
    epistemic,
    claim: `verification ${result.result}: ${result.reason}`,
    source: "task.verifier",
    taskId,
    detail: {
      result: result.result,
      reason: result.reason,
      warnings: result.warnings ?? [],
    },
  });
}
