/**
 * ReplanPolicy — Approval Envelope digest 범위 안에서만 자동 replan.
 */
import { isAttemptWithinEnvelope, isEnvelopeExpired } from "./approval-envelope.mjs";

/**
 * @returns {{ action: "auto_replan"|"require_reapproval"|"block"|"stop_success"|"stop_fail", reason: string }}
 */
export function decideReplan({
  run,
  envelope,
  verification,
  taskId,
  attempt = {},
  nowMs = Date.now(),
} = {}) {
  if (!run) return Object.freeze({ action: "block", reason: "run_missing" });
  if (!envelope) return Object.freeze({ action: "require_reapproval", reason: "envelope_missing" });

  if (isEnvelopeExpired(envelope, nowMs)) {
    return Object.freeze({ action: "block", reason: "envelope_expired" });
  }

  const within = isAttemptWithinEnvelope(envelope, { ...attempt, nowMs });
  if (!within.allowed) {
    return Object.freeze({ action: "require_reapproval", reason: within.reason });
  }

  const result = verification?.result;
  if (result === "PASS" || result === "PASS_WITH_WARNINGS") {
    return Object.freeze({ action: "stop_success", reason: result });
  }

  // 보안 UNKNOWN / 범위 문제 → 자동 replan 금지
  if (result === "UNKNOWN" && /security_expectation_unknown|envelope/u.test(String(verification?.reason ?? ""))) {
    return Object.freeze({ action: "require_reapproval", reason: verification.reason });
  }

  if (result === "FAIL" || result === "UNKNOWN") {
    const storeLike = {
      canReplanTask: (r, id) => {
        const budget = r.budget ?? {};
        const count = r.counters?.replans_by_task?.[id] ?? 0;
        return count < (budget.max_replans_per_task ?? 0)
          && (r.counters?.total_attempts ?? 0) < (budget.max_total_attempts ?? 0);
      },
    };
    // run store helper가 있으면 사용
    if (typeof run.canReplanTask === "function") {
      if (!run.canReplanTask(taskId)) {
        return Object.freeze({ action: "block", reason: "max_replans_per_task_exceeded" });
      }
    } else if (!storeLike.canReplanTask(run, taskId)) {
      return Object.freeze({ action: "block", reason: "max_replans_per_task_exceeded" });
    }

    const budgetCheck = run.budget && (run.counters?.total_attempts ?? 0) >= run.budget.max_total_attempts;
    if (budgetCheck) {
      return Object.freeze({ action: "block", reason: "max_total_attempts_exceeded" });
    }

    // 저위험 실패만 자동 — HIGH envelope여도 "동일 digest 내 재시도"는 허용하되
    // sandbox/forbidden은 재승인
    if (/forbidden|sandbox|telegram/iu.test(String(verification?.reason ?? ""))) {
      return Object.freeze({ action: "require_reapproval", reason: "security_boundary_hit" });
    }

    return Object.freeze({ action: "auto_replan", reason: "within_envelope_retry" });
  }

  return Object.freeze({ action: "stop_fail", reason: verification?.reason ?? "unverified" });
}
