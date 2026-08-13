/**
 * Task Verifier — 모델이 "성공했다"고 말한 것만으로 PASS하지 않는다.
 * 결과: PASS | FAIL | UNKNOWN
 */
import { createEvidenceRecord } from "../evidence/evidence.mjs";

export const VERIFY_RESULTS = Object.freeze(["PASS", "FAIL", "UNKNOWN"]);

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

/**
 * @param {{
 *   task: object,
 *   expectations?: Array<{ service?: string, status?: string, claim_includes?: string, epistemic?: string }>,
 *   requireVerified?: boolean,
 * }} input
 */
export function verifyTaskOutcome({
  task,
  expectations = [],
  requireVerified = true,
} = {}) {
  if (!task || typeof task.task_id !== "string") fail("invalid_verify_task");
  const evidence = Array.isArray(task.evidence) ? task.evidence : [];
  const verified = evidence.filter((item) => item?.epistemic === "VERIFIED");
  const inferredOnly = evidence.length > 0 && verified.length < 1
    && evidence.every((item) => item?.epistemic === "INFERRED" || item?.epistemic === "UNKNOWN");

  if (inferredOnly) {
    return Object.freeze({
      result: "FAIL",
      reason: "inferred_evidence_cannot_prove_success",
      checked_at: new Date().toISOString(),
      matched: Object.freeze([]),
      missing: Object.freeze(["verified_evidence"]),
    });
  }

  if (requireVerified && verified.length < 1) {
    return Object.freeze({
      result: "UNKNOWN",
      reason: "no_verified_evidence",
      checked_at: new Date().toISOString(),
      matched: Object.freeze([]),
      missing: Object.freeze(["verified_evidence"]),
    });
  }

  if (!Array.isArray(expectations) || expectations.length < 1) {
    return Object.freeze({
      result: verified.length > 0 ? "PASS" : "UNKNOWN",
      reason: verified.length > 0 ? "verified_evidence_present" : "no_expectations_or_evidence",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(verified.map((item) => item.evidence_id)),
      missing: Object.freeze([]),
    });
  }

  const matched = [];
  const missing = [];
  for (const expectation of expectations) {
    const found = verified.find((item) => {
      if (expectation.epistemic && item.epistemic !== expectation.epistemic) return false;
      if (expectation.claim_includes && !String(item.claim).includes(expectation.claim_includes)) return false;
      if (expectation.service && item.detail?.service !== expectation.service) return false;
      if (expectation.status && String(item.detail?.status) !== String(expectation.status)) return false;
      return true;
    });
    if (found) matched.push(found.evidence_id);
    else missing.push(expectation.claim_includes ?? expectation.service ?? "expectation");
  }

  if (missing.length > 0 && matched.length < 1) {
    return Object.freeze({
      result: "FAIL",
      reason: "expectations_unmet",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(matched),
      missing: Object.freeze(missing),
    });
  }
  if (missing.length > 0) {
    return Object.freeze({
      result: "UNKNOWN",
      reason: "partial_expectations",
      checked_at: new Date().toISOString(),
      matched: Object.freeze(matched),
      missing: Object.freeze(missing),
    });
  }
  return Object.freeze({
    result: "PASS",
    reason: "all_expectations_verified",
    checked_at: new Date().toISOString(),
    matched: Object.freeze(matched),
    missing: Object.freeze([]),
  });
}

export function verificationEvidence(result, { taskId = null } = {}) {
  return createEvidenceRecord({
    epistemic: result.result === "PASS" ? "VERIFIED" : (result.result === "FAIL" ? "VERIFIED" : "UNKNOWN"),
    claim: `verification ${result.result}: ${result.reason}`,
    source: "task.verifier",
    taskId,
    detail: {
      result: result.result,
      reason: result.reason,
    },
  });
}
