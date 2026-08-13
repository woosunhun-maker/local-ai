/**
 * DevelopmentRun 최종 보고 (사용자 대면 요약).
 */
export function buildDevelopmentReport({
  run,
  leafResults = [],
  verification = null,
} = {}) {
  const status = run?.status ?? "UNKNOWN";
  const lines = [
    `DevelopmentRun ${run?.run_id ?? "?"} — ${status}`,
    `목표: ${run?.goal ?? ""}`,
  ];
  if (run?.blocked_reason) lines.push(`차단 사유: ${run.blocked_reason}`);
  if (run?.envelope?.envelope_digest) {
    lines.push(`Approval Envelope: ${run.envelope.envelope_digest.slice(0, 16)}…`);
  }
  if (run?.worktree?.worktree_path) {
    lines.push(`Worktree(write root): ${run.worktree.worktree_path}`);
    lines.push("main repo: read-only (self-development)");
  }
  lines.push(`예산: leaf=${run?.counters?.leaf_tasks_created ?? 0}/${run?.budget?.max_leaf_tasks ?? "?"}`
    + ` attempts=${run?.counters?.total_attempts ?? 0}/${run?.budget?.max_total_attempts ?? "?"}`);
  if (run?.proposal?.success_criteria) {
    lines.push(`성공 조건(고정): ${run.proposal.success_criteria.length}개`);
  }
  if (run?.proposal?.out_of_scope) {
    lines.push(`범위 밖: ${run.proposal.out_of_scope.length}개`);
  }
  for (const leaf of leafResults) {
    lines.push(`- task ${leaf.task_id}: ${leaf.phase ?? leaf.status}`
      + (leaf.verification?.result ? ` (${leaf.verification.result})` : ""));
  }
  if (verification?.result) {
    lines.push(`종합 검증: ${verification.result} — ${verification.reason ?? ""}`);
  }
  lines.push("자동 merge/commit/push/deploy: 금지. main 반영은 별도 승인(schema only).");

  return Object.freeze({
    schema: "local-ai.development-report.v1",
    run_id: run?.run_id ?? null,
    status,
    summary_text: lines.join("\n"),
    merge_to_main: Object.freeze({
      available: status === "DONE" || status === "REPORTING",
      execution_enabled: false,
      kind: "dev.merge_to_main",
    }),
    leaf_results: Object.freeze(leafResults.map((item) => Object.freeze({ ...item }))),
    generated_at: new Date().toISOString(),
  });
}
