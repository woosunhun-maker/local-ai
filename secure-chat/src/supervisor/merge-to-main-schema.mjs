/**
 * dev.merge_to_main — 승인 스키마만. 자동 merge/commit/push/deploy 실행 금지.
 */
export const MERGE_TO_MAIN_KIND = "dev.merge_to_main";
export const MERGE_TO_MAIN_SCHEMA = "local-ai.dev-merge-to-main.v1";

/**
 * owner가 main 반영을 승인할 때 쓸 payload 스키마 생성.
 * 실행기는 구현하지 않는다.
 */
export function createMergeToMainApprovalDraft({
  runId,
  envelopeDigest,
  worktreePath,
  branch,
  diffHash,
  leafTaskIds = [],
} = {}) {
  if (typeof runId !== "string" || runId.length < 8) {
    throw Object.assign(new Error("invalid_merge_run_id"), { statusCode: 400 });
  }
  return Object.freeze({
    schema: MERGE_TO_MAIN_SCHEMA,
    kind: MERGE_TO_MAIN_KIND,
    run_id: runId,
    envelope_digest: envelopeDigest ?? null,
    worktree_path: worktreePath ?? null,
    branch: branch ?? null,
    diff_hash: diffHash ?? null,
    leaf_task_ids: Object.freeze([...leafTaskIds]),
    auto_merge: false,
    auto_commit: false,
    auto_push: false,
    auto_deploy: false,
    execution_enabled: false,
    note: "스키마만 준비됨. 실제 merge/commit/push/deploy는 구현되지 않음.",
  });
}

export function assertMergeExecutionForbidden() {
  throw Object.assign(new Error("dev_merge_to_main_execution_forbidden"), { statusCode: 403 });
}
