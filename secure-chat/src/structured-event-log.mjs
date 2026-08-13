import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/** PHASE 1 구조화 이벤트. 아직 훅이 없는 이벤트도 스키마에 포함한다. */
export const STRUCTURED_EVENTS = Object.freeze([
  "request_received",
  "router_selected",
  "model_invoked",
  "planner_invoked",
  "tool_invoked",
  "task_started",
  "task_completed",
  "task_failed",
  "verification_started",
  "verification_completed",
]);

const EVENT_SET = new Set(STRUCTURED_EVENTS);

export function newCorrelationId() {
  return randomUUID();
}

function sanitizeFields(fields) {
  if (fields == null) return {};
  if (typeof fields !== "object" || Array.isArray(fields)) throw new Error("invalid_structured_log_fields");
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "timestamp" || key === "event") continue;
    if (typeof key !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    if (value == null) continue;
    if (typeof value === "string") {
      out[key] = value.length > 500 ? `${value.slice(0, 500)}…` : value;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
  }
  return out;
}

/**
 * 구조화 JSONL 로그. 본문·토큰·개인정보를 넣지 않는다.
 * @returns {{ emit: Function, correlationId: Function }}
 */
export function createStructuredEventLog({
  logDir,
  clock = () => new Date(),
  append = appendFile,
  ensureDir = mkdir,
} = {}) {
  if (typeof logDir !== "string" || !logDir.startsWith("/")) throw new Error("invalid_structured_log_dir");

  const emit = async (event, fields = {}) => {
    if (!EVENT_SET.has(event)) throw new Error("unsupported_structured_event");
    const timestamp = clock();
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) throw new Error("invalid_structured_log_clock");
    const safe = sanitizeFields(fields);
    const correlationId = typeof safe.correlationId === "string" && safe.correlationId.length >= 8
      ? safe.correlationId
      : newCorrelationId();
    const record = {
      timestamp: timestamp.toISOString(),
      event,
      correlationId,
      ...safe,
      correlationId,
    };
    await ensureDir(logDir, { recursive: true, mode: 0o700 });
    const path = `${logDir}/${timestamp.toISOString().slice(0, 10)}.jsonl`;
    await append(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return Object.freeze({ ...record });
  };

  return Object.freeze({
    emit,
    correlationId: newCorrelationId,
  });
}
