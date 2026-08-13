import { createHash } from "node:crypto";
import {
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  EXPECTED_CODEX_VERSION,
} from "./runner.mjs";

export const OWNER_CODEX_PLAN_SCHEMA = "local-ai.codex-task-plan.v3";
export const OWNER_CODEX_EXECUTION_MODE = "isolated_inspect_and_draft";

const INTENTS = new Set(["inspect", "draft"]);
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DEVICE_HASH = /^[a-f0-9]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}$/u;
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cf}/u;
const PLAN_KEYS = new Set([
  "schema",
  "taskId",
  "ownerDeviceHash",
  "idempotencyKey",
  "intent",
  "request",
  "sourceManifestSha256",
  "sourceFileCount",
  "sourceTotalBytes",
  "execution",
]);
const EXECUTION_KEYS = new Set([
  "mode",
  "codexVersion",
  "model",
  "reasoningEffort",
  "provider",
  "externalTransfer",
  "transferredData",
  "sourcePolicy",
  "ownerSourcePermission",
  "draftValidation",
  "toolNetwork",
  "modelHostFileTools",
  "osProcessSandbox",
  "clientAuthentication",
  "sourceApply",
]);

function planError(code) {
  return Object.assign(new Error(code), { statusCode: 400 });
}

function plainObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw planError(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw planError(code);
  return value;
}

function exactKeys(value, expected, code) {
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) throw planError(code);
}

export function normalizeOwnerCodexRequest(value) {
  if (typeof value !== "string") throw planError("invalid_codex_task_request");
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 2_000 || UNSAFE_TEXT.test(normalized)) {
    throw planError("invalid_codex_task_request");
  }
  return normalized;
}

export function validateOwnerCodexIntent(value) {
  if (!INTENTS.has(value)) throw planError("invalid_codex_task_intent");
  return value;
}

export function validateOwnerDeviceHash(value) {
  if (typeof value !== "string" || !DEVICE_HASH.test(value)) throw planError("invalid_codex_owner_device_hash");
  return value;
}

export function validateCodexIdempotencyKey(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) throw planError("invalid_codex_idempotency_key");
  return value;
}

export function validateOwnerCodexTaskId(value) {
  if (typeof value !== "string" || !TASK_ID.test(value)) throw planError("invalid_codex_task_id");
  return value;
}

export function validateSourceManifestSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw planError("invalid_codex_source_manifest");
  return value;
}

export function validateSourceFileCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 4_096) throw planError("invalid_codex_source_file_count");
  return value;
}

export function validateSourceTotalBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2 * 1024 * 1024) {
    throw planError("invalid_codex_source_total_bytes");
  }
  return value;
}

function executionContract() {
  return {
    mode: OWNER_CODEX_EXECUTION_MODE,
    codexVersion: EXPECTED_CODEX_VERSION,
    model: CODEX_MODEL,
    reasoningEffort: CODEX_REASONING_EFFORT,
    provider: "openai_codex",
    externalTransfer: true,
    transferredData: ["task_instruction", "known_identifier_scrubbed_code_snapshot"],
    sourcePolicy: "allowlisted_known_identifier_scrubbed_code_v2",
    ownerSourcePermission: "read_only",
    draftValidation: "trusted_apply_isolated_copy_only",
    toolNetwork: false,
    modelHostFileTools: false,
    osProcessSandbox: false,
    clientAuthentication: "codex_auth_used",
    sourceApply: false,
  };
}

function canonicalPlan({
  taskId,
  ownerDeviceHash,
  idempotencyKey,
  intent,
  request,
  sourceManifestSha256,
  sourceFileCount,
  sourceTotalBytes,
}) {
  return {
    schema: OWNER_CODEX_PLAN_SCHEMA,
    taskId,
    ownerDeviceHash,
    idempotencyKey,
    intent,
    request,
    sourceManifestSha256,
    sourceFileCount,
    sourceTotalBytes,
    execution: executionContract(),
  };
}

export function createOwnerCodexPlan(value) {
  const source = plainObject(value, "invalid_codex_task_plan_input");
  exactKeys(source, new Set([
    "taskId", "ownerDeviceHash", "idempotencyKey", "intent", "request", "sourceManifestSha256",
    "sourceFileCount", "sourceTotalBytes",
  ]), "invalid_codex_task_plan_input");
  const plan = canonicalPlan({
    taskId: validateOwnerCodexTaskId(source.taskId),
    ownerDeviceHash: validateOwnerDeviceHash(source.ownerDeviceHash),
    idempotencyKey: validateCodexIdempotencyKey(source.idempotencyKey),
    intent: validateOwnerCodexIntent(source.intent),
    request: normalizeOwnerCodexRequest(source.request),
    sourceManifestSha256: validateSourceManifestSha256(source.sourceManifestSha256),
    sourceFileCount: validateSourceFileCount(source.sourceFileCount),
    sourceTotalBytes: validateSourceTotalBytes(source.sourceTotalBytes),
  });
  const canonical = JSON.stringify(plan);
  return Object.freeze({
    ...plan,
    execution: Object.freeze({
      ...plan.execution,
      transferredData: Object.freeze([...plan.execution.transferredData]),
    }),
    canonical,
    sha256: createHash("sha256").update(canonical).digest("hex"),
  });
}

export function restoreOwnerCodexPlan(canonical) {
  if (typeof canonical !== "string" || canonical.length < 1 || canonical.length > 16_000) {
    throw planError("invalid_codex_task_plan");
  }
  let parsed;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    throw planError("invalid_codex_task_plan");
  }
  plainObject(parsed, "invalid_codex_task_plan");
  exactKeys(parsed, PLAN_KEYS, "invalid_codex_task_plan");
  plainObject(parsed.execution, "invalid_codex_task_plan");
  exactKeys(parsed.execution, EXECUTION_KEYS, "invalid_codex_task_plan");
  const restored = createOwnerCodexPlan({
    taskId: parsed.taskId,
    ownerDeviceHash: parsed.ownerDeviceHash,
    idempotencyKey: parsed.idempotencyKey,
    intent: parsed.intent,
    request: parsed.request,
    sourceManifestSha256: parsed.sourceManifestSha256,
    sourceFileCount: parsed.sourceFileCount,
    sourceTotalBytes: parsed.sourceTotalBytes,
  });
  if (parsed.schema !== OWNER_CODEX_PLAN_SCHEMA || restored.canonical !== canonical) {
    throw planError("invalid_codex_task_plan");
  }
  return restored;
}
