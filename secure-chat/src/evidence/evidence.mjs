/**
 * Evidence Layer — 사실과 추론을 구분한다.
 * VERIFIED: 실제 시스템 조회로 확인
 * RETRIEVED: 저장소/문서에서 읽어옴 (아직 재검증하지 않음)
 * INFERRED: 모델·휴리스틱 추론
 * UNKNOWN: 확인 불가
 */

export const EVIDENCE_EPISTEMICS = Object.freeze([
  "VERIFIED",
  "RETRIEVED",
  "INFERRED",
  "UNKNOWN",
]);

const EPISTEMIC_SET = new Set(EVIDENCE_EPISTEMICS);

export const EVIDENCE_RECORD_SCHEMA = "local-ai.evidence-record.v1";

function evidenceError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function boundedText(value, field, max) {
  if (typeof value !== "string") throw evidenceError(`invalid_evidence_${field}`);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) throw evidenceError(`invalid_evidence_${field}`);
  return trimmed;
}

/**
 * @returns {Readonly<{
 *   schema: string,
 *   evidence_id: string,
 *   epistemic: string,
 *   claim: string,
 *   source: string,
 *   observed_at: string,
 *   task_id: string|null,
 *   correlation_id: string|null,
 *   detail: object|null,
 * }>}
 */
export function createEvidenceRecord({
  epistemic,
  claim,
  source,
  observedAt = new Date().toISOString(),
  evidenceId = null,
  taskId = null,
  correlationId = null,
  detail = null,
  idFactory = () => cryptoRandomId(),
} = {}) {
  if (!EPISTEMIC_SET.has(epistemic)) throw evidenceError("invalid_evidence_epistemic");
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) {
    throw evidenceError("invalid_evidence_observed_at");
  }
  if (taskId != null && (typeof taskId !== "string" || taskId.length < 8 || taskId.length > 128)) {
    throw evidenceError("invalid_evidence_task_id");
  }
  if (correlationId != null && (typeof correlationId !== "string" || correlationId.length < 8 || correlationId.length > 128)) {
    throw evidenceError("invalid_evidence_correlation_id");
  }
  if (detail != null && (typeof detail !== "object" || Array.isArray(detail))) {
    throw evidenceError("invalid_evidence_detail");
  }
  // detail은 민감 원문을 넣지 않는다. 키·짧은 코드만 허용.
  let safeDetail = null;
  if (detail) {
    safeDetail = {};
    for (const [key, value] of Object.entries(detail)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
      if (typeof value === "string" && value.length <= 200) safeDetail[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") safeDetail[key] = value;
    }
    if (Object.keys(safeDetail).length < 1) safeDetail = null;
  }

  return Object.freeze({
    schema: EVIDENCE_RECORD_SCHEMA,
    evidence_id: typeof evidenceId === "string" && evidenceId.length >= 8
      ? evidenceId
      : idFactory(),
    epistemic,
    claim: boundedText(claim, "claim", 500),
    source: boundedText(source, "source", 120),
    observed_at: new Date(observedAt).toISOString(),
    task_id: taskId ?? null,
    correlation_id: correlationId ?? null,
    detail: safeDetail ? Object.freeze(safeDetail) : null,
  });
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() ?? `ev_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/** 런타임 health 서비스 행 → VERIFIED evidence */
export function evidenceFromRuntimeService(serviceRow, { correlationId = null, observedAt = null } = {}) {
  if (!serviceRow || typeof serviceRow.service !== "string") throw evidenceError("invalid_runtime_service_row");
  return createEvidenceRecord({
    epistemic: "VERIFIED",
    claim: `${serviceRow.service} status=${serviceRow.status}`,
    source: "system.runtime_health",
    observedAt: observedAt ?? serviceRow.last_health_check ?? new Date().toISOString(),
    correlationId,
    detail: {
      service: serviceRow.service,
      status: String(serviceRow.status),
      ...(serviceRow.model ? { model: String(serviceRow.model) } : {}),
      ...(serviceRow.error ? { error: String(serviceRow.error).slice(0, 120) } : {}),
      ...(serviceRow.pid != null ? { pid: serviceRow.pid } : {}),
    },
  });
}

export function assertNotInferredAsFact(record) {
  if (record?.epistemic === "INFERRED" || record?.epistemic === "UNKNOWN") {
    throw evidenceError("inferred_or_unknown_cannot_be_treated_as_fact", 409);
  }
  return true;
}
