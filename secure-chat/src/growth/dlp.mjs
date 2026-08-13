import { canonicalizeJson, deepFreeze } from "./canonical.mjs";

export const DLP_POLICY_VERSION = "local-ai-growth-dlp-v2-structured";
export const OUTBOUND_DRAFT_SCHEMA = "local-ai.growth.structured-draft.v1";
export const PERFORMANCE_TEMPLATE_ID = "performance_diagnostics_v1";

export const SEMANTIC_CATEGORIES = Object.freeze({
  public_technical: Object.freeze({ outbound: "allow" }),
  synthetic_test: Object.freeze({ outbound: "allow" }),
  dependency_version: Object.freeze({ outbound: "allow" }),
  generic_error_code: Object.freeze({ outbound: "allow" }),
  performance_metric: Object.freeze({ outbound: "allow" }),
  sanitized_architecture: Object.freeze({ outbound: "allow" }),
  credential: Object.freeze({ outbound: "deny" }),
  authentication_material: Object.freeze({ outbound: "deny" }),
  account_identifier: Object.freeze({ outbound: "deny" }),
  device_identifier: Object.freeze({ outbound: "deny" }),
  raw_conversation: Object.freeze({ outbound: "deny" }),
  personal_memory: Object.freeze({ outbound: "deny" }),
  contact: Object.freeze({ outbound: "deny" }),
  message: Object.freeze({ outbound: "deny" }),
  calendar: Object.freeze({ outbound: "deny" }),
  location: Object.freeze({ outbound: "deny" }),
  home_security: Object.freeze({ outbound: "deny" }),
  health: Object.freeze({ outbound: "deny" }),
  financial: Object.freeze({ outbound: "deny" }),
  legal: Object.freeze({ outbound: "deny" }),
  biometric: Object.freeze({ outbound: "deny" }),
  photo: Object.freeze({ outbound: "deny" }),
  audio: Object.freeze({ outbound: "deny" }),
  private_source: Object.freeze({ outbound: "deny" }),
  unclassified: Object.freeze({ outbound: "deny" }),
});

const DRAFT_KEYS = new Set(["schema", "templateId", "facts"]);
const PERFORMANCE_FACT_KEYS = new Set([
  "sampleCount",
  "medianLatencyMs",
  "p95LatencyMs",
  "failureCount",
]);
const COMPILED_REQUEST_KEYS = new Set([
  "templateId",
  "facts",
  "purpose",
  "question",
  "dataCategories",
  "evidence",
]);

function finding(code, category, path) {
  return Object.freeze({ code, category, path, action: "block" });
}

function exactKeys(value, allowed, path, findings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    findings.push(finding("schema.object_required", "unclassified", path));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) findings.push(finding("schema.unknown_field", "unclassified", `${path}.${key}`));
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) findings.push(finding("schema.missing_field", "unclassified", `${path}.${key}`));
  }
  return true;
}

function safeInteger(value, minimum, maximum, path, findings) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    findings.push(finding("schema.invalid_integer", "unclassified", path));
    return false;
  }
  return true;
}

function inspectPerformanceFacts(facts, findings) {
  if (!exactKeys(facts, PERFORMANCE_FACT_KEYS, "$.facts", findings)) return;
  const sampleValid = safeInteger(facts.sampleCount, 10, 1_000_000, "$.facts.sampleCount", findings);
  const medianValid = safeInteger(facts.medianLatencyMs, 0, 3_600_000, "$.facts.medianLatencyMs", findings);
  const p95Valid = safeInteger(facts.p95LatencyMs, 0, 3_600_000, "$.facts.p95LatencyMs", findings);
  const failureValid = safeInteger(facts.failureCount, 0, 1_000_000, "$.facts.failureCount", findings);
  if (sampleValid && failureValid && facts.failureCount > facts.sampleCount) {
    findings.push(finding("schema.failure_count_exceeds_samples", "unclassified", "$.facts.failureCount"));
  }
  if (medianValid && p95Valid && facts.p95LatencyMs < facts.medianLatencyMs) {
    findings.push(finding("schema.percentile_order_invalid", "unclassified", "$.facts.p95LatencyMs"));
  }
}

export class DlpViolationError extends Error {
  constructor(findings) {
    super(`Outbound draft blocked by ${DLP_POLICY_VERSION}`);
    this.name = "DlpViolationError";
    this.findings = findings;
  }
}

export function inspectOutboundDraft(draft) {
  const findings = [];
  if (!exactKeys(draft, DRAFT_KEYS, "$", findings)) {
    return Object.freeze({ ok: false, policyVersion: DLP_POLICY_VERSION, findings: Object.freeze(findings) });
  }
  if (draft.schema !== OUTBOUND_DRAFT_SCHEMA) {
    findings.push(finding("schema.version_denied", "unclassified", "$.schema"));
  }
  if (draft.templateId !== PERFORMANCE_TEMPLATE_ID) {
    findings.push(finding("schema.template_denied", "unclassified", "$.templateId"));
  } else {
    inspectPerformanceFacts(draft.facts, findings);
  }
  return Object.freeze({
    ok: findings.length === 0,
    policyVersion: DLP_POLICY_VERSION,
    findings: Object.freeze(findings),
  });
}

export function assertOutboundSafe(draft) {
  const inspection = inspectOutboundDraft(draft);
  if (!inspection.ok) throw new DlpViolationError(inspection.findings);
  return inspection;
}

function compilePerformanceDraft(draft) {
  const facts = {
    sampleCount: draft.facts.sampleCount,
    medianLatencyMs: draft.facts.medianLatencyMs,
    p95LatencyMs: draft.facts.p95LatencyMs,
    failureCount: draft.facts.failureCount,
  };
  const failureRate = ((facts.failureCount / facts.sampleCount) * 100).toFixed(1);
  const dataCategories = ["performance_metric"];
  const evidence = [{
    id: "aggregate_latency",
    type: "benchmark",
    category: "performance_metric",
    sourceKind: "local_aggregate",
    summary: `합성·일반 작업 메타데이터 ${facts.sampleCount}건의 중앙값 ${facts.medianLatencyMs}ms, p95 ${facts.p95LatencyMs}ms, 실패율 ${failureRate}%입니다. 본문·기기 식별자·파일은 포함하지 않았습니다.`,
  }];
  if (facts.failureCount > 0) {
    dataCategories.push("generic_error_code");
    evidence.push({
      id: "generic_failures",
      type: "generic_error",
      category: "generic_error_code",
      sourceKind: "local_aggregate",
      summary: `일반화된 request_failed 이벤트가 ${facts.failureCount}건 발생했습니다. 오류 원문은 포함하지 않았습니다.`,
    });
  }
  return {
    templateId: draft.templateId,
    facts,
    purpose: "performance_review",
    question: "개인정보 없는 집계 지연과 일반 오류 코드만으로 로컬 대화 경로의 병목 가설, 합성 재현 시험, 안전한 개선 순서를 제안해줘.",
    dataCategories,
    evidence,
  };
}

export function compileOutboundDraft(draft) {
  assertOutboundSafe(draft);
  return deepFreeze(compilePerformanceDraft(draft));
}

export function validateCompiledOutboundRequest(value) {
  const findings = [];
  if (!exactKeys(value, COMPILED_REQUEST_KEYS, "request", findings)) {
    throw new DlpViolationError(findings);
  }
  const reconstructedDraft = {
    schema: OUTBOUND_DRAFT_SCHEMA,
    templateId: value.templateId,
    facts: value.facts,
  };
  const expected = compileOutboundDraft(reconstructedDraft);
  if (canonicalizeJson(value) !== canonicalizeJson(expected)) {
    throw new DlpViolationError([finding("compiled_request_mismatch", "unclassified", "request")]);
  }
  return true;
}
