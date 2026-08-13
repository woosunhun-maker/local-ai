import { containsCredential } from "../security/credential-patterns.mjs";

const PUBLIC_STATUSES = new Set([
  "awaiting_approval",
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted_uncertain",
  "rejected",
  "expired",
]);

export function safeCodexSummary(value) {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  if (!text || text.length > 1_500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cf}/u.test(text)) return null;
  if (/(?:\/Users\/|\/home\/|PrivateAI|\.codex|WINDOWS_CODEX_FULL_EXPORT|https?:\/\/|www\.)/iu.test(text)) return null;
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text)) return null;
  if (/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/u.test(text)) return null;
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(text)) return null;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text)) return null;
  if (containsCredential(text, { includeLooseAssignments: true })) return null;
  return text;
}

export function publicCodexTask(job) {
  if (!job || job.ingress !== "owner_app" || !PUBLIC_STATUSES.has(job.status)) {
    throw Object.assign(new Error("invalid_public_codex_task"), { statusCode: 500 });
  }
  let result = null;
  if (job.result !== null) {
    const summary = safeCodexSummary(job.result.summary) ?? "결과에 민감하거나 로컬 전용인 내용이 있어 상세 요약을 표시하지 않았습니다.";
    result = {
      code: job.result.code,
      summary,
      changedFileCount: job.result.changedFileCount,
      changedPaths: [...job.result.changedPaths],
      patch: job.result.patch,
      patchSha256: job.result.patchSha256,
    };
  }
  return {
    id: job.id,
    status: job.status,
    intent: job.intent,
    planSha256: job.planSha256,
    approvalRequestId: job.approvalRequestId,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result,
  };
}

export function publicCodexApproval(request) {
  if (!request || request.kind !== "codex.execute") {
    throw Object.assign(new Error("invalid_public_codex_approval"), { statusCode: 500 });
  }
  return {
    id: request.id,
    kind: request.kind,
    title: request.title,
    summary: request.summary,
    payload: request.payload,
    payloadSha256: request.payloadSha256,
    dataCategories: [...request.dataCategories],
    nonce: request.nonce,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    status: request.status,
  };
}
