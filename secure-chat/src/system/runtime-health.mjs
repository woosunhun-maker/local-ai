import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import {
  LOCAL_CONVERSATION_MODEL,
  LOCAL_EFFECT_PLANNING_MODEL,
} from "../local-model-routing.mjs";

const execFileAsync = promisify(execFile);

export const RUNTIME_HEALTH_SCHEMA = "local-ai.system-runtime-health.v1";
export const PACKAGE_VERSION = "1.2.0";

const DEFAULT_LABELS = Object.freeze([
  Object.freeze({ service: "ollama", label: "homebrew.mxcl.ollama", kind: "launchd" }),
  Object.freeze({ service: "secure-chat", label: "com.local.privateai.secure-chat", kind: "launchd" }),
  Object.freeze({ service: "telegram-general", label: "com.local.privateai.telegram-general", kind: "launchd" }),
  Object.freeze({ service: "codex-worker", label: "com.local.privateai.codex-worker", kind: "launchd" }),
  Object.freeze({ service: "openwebui", label: "com.local.privateai.openwebui", kind: "launchd" }),
  Object.freeze({ service: "openwebui-proxy", label: "com.local.privateai.openwebui-proxy", kind: "launchd" }),
  Object.freeze({ service: "ai-council-web", label: "com.local.ai-council.web", kind: "launchd" }),
  Object.freeze({ service: "health-monitor", label: "com.local.privateai.health-monitor", kind: "launchd_interval" }),
  Object.freeze({ service: "iphone-command", label: "com.local.privateai.iphone-command", kind: "launchd" }),
]);

function entry({
  service,
  status,
  model = null,
  pid = null,
  last_health_check = null,
  version = PACKAGE_VERSION,
  error = null,
  detail = null,
}) {
  return Object.freeze({
    service,
    status,
    model,
    pid,
    last_health_check,
    version,
    error,
    ...(detail ? { detail } : {}),
  });
}

async function launchctlSnapshot(label, { execFileImpl = execFileAsync, uid } = {}) {
  const domain = `gui/${uid ?? process.getuid?.() ?? 501}`;
  try {
    const { stdout } = await execFileImpl("/bin/launchctl", ["print", `${domain}/${label}`], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 64_000,
    });
    const stateMatch = stdout.match(/^\s*state = ([^\s]+)/m);
    const pidMatch = stdout.match(/^\s*pid = (\d+)/m);
    const lastExitMatch = stdout.match(/^\s*last exit code = (.+)$/m);
    const runsMatch = stdout.match(/^\s*runs = (\d+)/m);
    return {
      state: stateMatch?.[1] ?? "unknown",
      pid: pidMatch ? Number(pidMatch[1]) : null,
      lastExit: lastExitMatch?.[1]?.trim() ?? null,
      runs: runsMatch ? Number(runsMatch[1]) : null,
      error: null,
    };
  } catch (error) {
    return {
      state: "not_loaded",
      pid: null,
      lastExit: null,
      runs: null,
      error: error?.code === "ENOENT" ? "launchctl_missing" : "launchctl_unavailable",
    };
  }
}

async function ollamaModels({ fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl("http://127.0.0.1:11434/api/tags", {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response?.ok) return { ok: false, names: [], error: `http_${response?.status ?? "error"}` };
    const body = await response.json();
    const names = Array.isArray(body?.models)
      ? body.models.map((item) => item?.name).filter((name) => typeof name === "string")
      : [];
    return { ok: true, names, error: null };
  } catch {
    return { ok: false, names: [], error: "ollama_unreachable" };
  }
}

async function readHealthFile(path, readFileImpl) {
  try {
    const parsed = JSON.parse(await readFileImpl(path, "utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.services)) {
      return { ok: false, checkedAt: null, services: [], error: "health_file_invalid" };
    }
    return {
      ok: parsed.healthy === true,
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : null,
      services: parsed.services,
      error: null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, checkedAt: null, services: [], error: "health_file_missing" };
    return { ok: false, checkedAt: null, services: [], error: "health_file_unreadable" };
  }
}

async function memoryProbe(path, readFileImpl) {
  try {
    const parsed = JSON.parse(await readFileImpl(path, "utf8"));
    const count = Array.isArray(parsed?.items)
      ? parsed.items.filter((item) => item?.status === "active").length
      : null;
    return { ok: true, count, error: null };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: false, count: null, error: "memory_file_missing" };
    return { ok: false, count: null, error: "memory_unreadable" };
  }
}

/**
 * 추측 없이 조회 가능한 런타임 상태만 모은다.
 * Tool Registry / Task Manager / Planner 프로세스 등은 아직 없으면 not_implemented로 표기한다.
 */
export async function collectSystemRuntimeHealth({
  privateRoot = "/Users/hun/PrivateAI",
  fetchImpl = fetch,
  execFileImpl = execFileAsync,
  readFileImpl = readFile,
  ttsCatalog = null,
  taskManagerReady = false,
  packageVersion = PACKAGE_VERSION,
  now = () => new Date(),
} = {}) {
  const checkedAt = now().toISOString();
  const healthPath = `${privateRoot}/data/health/current.json`;
  const memoryPath = process.env.CONFIRMED_MEMORY_PATH ?? `${privateRoot}/data/confirmed-memory/memory.json`;

  const [models, healthFile, memory, ...launchdRowsRaw] = await Promise.all([
    ollamaModels({ fetchImpl }),
    readHealthFile(healthPath, readFileImpl).catch(() => ({ ok: false, checkedAt: null, services: [], error: "health_file_unreadable" })),
    memoryProbe(memoryPath, readFileImpl),
    ...DEFAULT_LABELS.map(async (item) => {
      const snap = await launchctlSnapshot(item.label, { execFileImpl });
      let status = "unknown";
      if (snap.error) status = "error";
      else if (item.kind === "launchd_interval") {
        // StartInterval 에이전트는 주기 실행 후 exit가 정상이다.
        status = snap.lastExit === "0" || snap.runs > 0 ? "ok" : "degraded";
        if (snap.state === "running") status = "ok";
      } else if (snap.state === "running") status = "ok";
      else if (snap.state === "not_loaded") status = "stopped";
      else status = "degraded";
      return entry({
        service: item.service,
        status,
        model: null,
        pid: snap.pid,
        last_health_check: checkedAt,
        version: packageVersion,
        error: snap.error,
        detail: Object.freeze({
          launchd_label: item.label,
          launchd_state: snap.state,
          last_exit: snap.lastExit,
          runs: snap.runs,
        }),
      });
    }),
  ]);

  const conversationReady = models.ok && models.names.includes(LOCAL_CONVERSATION_MODEL);
  const plannerReady = models.ok && models.names.includes(LOCAL_EFFECT_PLANNING_MODEL);
  const launchdRows = launchdRowsRaw.map((row) => {
    if (row.service !== "ollama") return row;
    return entry({
      ...row,
      model: conversationReady ? LOCAL_CONVERSATION_MODEL : null,
    });
  });

  const services = [
    ...launchdRows,
    entry({
      service: "llm_conversation",
      status: conversationReady ? "ok" : "degraded",
      model: LOCAL_CONVERSATION_MODEL,
      pid: null,
      last_health_check: checkedAt,
      version: packageVersion,
      error: conversationReady ? null : (models.error ?? "model_missing"),
    }),
    entry({
      service: "llm_planner_route",
      status: plannerReady ? "ok" : "degraded",
      model: LOCAL_EFFECT_PLANNING_MODEL,
      pid: null,
      last_health_check: checkedAt,
      version: packageVersion,
      error: plannerReady ? null : (models.error ?? "model_missing"),
      detail: Object.freeze({ note: "별도 OS 프로세스가 아니라 모델 라우트다" }),
    }),
    entry({
      service: "memory_confirmed",
      status: memory.ok ? "ok" : "degraded",
      model: null,
      pid: null,
      last_health_check: checkedAt,
      version: packageVersion,
      error: memory.error,
      detail: memory.count == null ? null : Object.freeze({ active_count: memory.count }),
    }),
    entry({
      service: "tts",
      status: ttsCatalog?.providers?.length ? "ok" : (ttsCatalog == null ? "unknown" : "degraded"),
      model: ttsCatalog?.providers?.[0]?.id ?? null,
      pid: null,
      last_health_check: checkedAt,
      version: packageVersion,
      error: ttsCatalog == null ? "tts_probe_not_injected" : (ttsCatalog.providers?.length ? null : "tts_unavailable"),
    }),
    entry({
      service: "tool_registry",
      status: "not_implemented",
      model: null,
      pid: null,
      last_health_check: checkedAt,
      version: packageVersion,
      error: "phase3_pending",
    }),
    entry({
      service: "task_manager",
      status: taskManagerReady ? "ok" : "not_implemented",
      model: null,
      pid: null,
      last_health_check: checkedAt,
      version: packageVersion,
      error: taskManagerReady ? null : "phase2_pending",
      detail: Object.freeze({
        note: taskManagerReady
          ? "상태 기계·저장소만 구현. Executor/Verifier 본문은 PHASE 4"
          : "not_ready",
      }),
    }),
    entry({
      service: "evidence_layer",
      status: "ok",
      model: null,
      pid: null,
      last_health_check: checkedAt,
      version: packageVersion,
      error: null,
      detail: Object.freeze({
        epistemics: "VERIFIED,RETRIEVED,INFERRED,UNKNOWN",
      }),
    }),
    entry({
      service: "health_snapshot_file",
      status: healthFile.error ? "degraded" : (healthFile.ok ? "ok" : "degraded"),
      model: null,
      pid: null,
      last_health_check: healthFile.checkedAt ?? checkedAt,
      version: packageVersion,
      error: healthFile.error,
      detail: Object.freeze({
        path: "data/health/current.json",
        service_count: healthFile.services.length,
      }),
    }),
  ];

  const criticalOk = ["secure-chat", "telegram-general", "llm_conversation"]
    .every((name) => services.find((row) => row.service === name)?.status === "ok");

  return Object.freeze({
    schema: RUNTIME_HEALTH_SCHEMA,
    checked_at: checkedAt,
    overall: criticalOk ? "ok" : "degraded",
    version: packageVersion,
    conversation_model: LOCAL_CONVERSATION_MODEL,
    planner_model: LOCAL_EFFECT_PLANNING_MODEL,
    services: Object.freeze(services),
  });
}
