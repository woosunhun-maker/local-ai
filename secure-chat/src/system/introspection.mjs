import { collectSystemRuntimeHealth, RUNTIME_HEALTH_SCHEMA } from "./runtime-health.mjs";
import { evidenceFromRuntimeService } from "../evidence/evidence.mjs";

export const SYSTEM_COMMANDS = Object.freeze(["system.status"]);

/**
 * AI가 추측하지 않고 실제 상태를 조회하는 내부 명령.
 * 아직 없는 기능은 not_implemented로만 표기한다.
 */
export async function runSystemCommand(command, {
  collectHealth = collectSystemRuntimeHealth,
  healthOptions = {},
  taskSummary = null,
} = {}) {
  if (command !== "system.status") {
    throw Object.assign(new Error("unsupported_system_command"), { statusCode: 400 });
  }

  const runtime = await collectHealth(healthOptions);
  if (runtime?.schema !== RUNTIME_HEALTH_SCHEMA) {
    throw Object.assign(new Error("invalid_runtime_health"), { statusCode: 500 });
  }

  const evidence = (runtime.services ?? []).map((row) => evidenceFromRuntimeService(row, {
    observedAt: runtime.checked_at,
  }));

  const tasks = taskSummary
    ? {
      epistemic: "VERIFIED",
      summary: taskSummary,
    }
    : {
      epistemic: "UNKNOWN",
      summary: null,
      note: "task_manager_probe_not_injected",
    };

  return Object.freeze({
    schema: "local-ai.system-command-result.v1",
    command: "system.status",
    checked_at: runtime.checked_at,
    runtime,
    tasks,
    evidence: Object.freeze(evidence),
    guidance: Object.freeze([
      "이 결과는 실제 프로브/파일 조회에 기반한다 (evidence.epistemic=VERIFIED).",
      "INFERRED 문장으로 프로세스 실행 여부를 단정하지 않는다.",
      "tool_registry·Verifier 본문은 아직 구현되지 않았다.",
    ]),
  });
}

export function formatSystemStatusText(result) {
  if (result?.schema !== "local-ai.system-command-result.v1") {
    throw new Error("invalid_system_command_result");
  }
  const lines = [
    "system.status (실측)",
    `overall: ${result.runtime.overall}`,
    `conversation: ${result.runtime.conversation_model}`,
    `planner_route: ${result.runtime.planner_model}`,
  ];
  for (const row of result.runtime.services) {
    const pid = row.pid != null ? ` pid=${row.pid}` : "";
    const err = row.error ? ` error=${row.error}` : "";
    lines.push(`• ${row.service}: ${row.status}${pid}${err}`);
  }
  if (result.tasks?.summary) {
    lines.push(`tasks total: ${result.tasks.summary.total}`);
  }
  return lines.join("\n");
}
