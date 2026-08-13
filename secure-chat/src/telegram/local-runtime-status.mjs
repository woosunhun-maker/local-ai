export const SECURE_CHAT_HEALTH_URL = "http://127.0.0.1:18791/health";
export const OLLAMA_HEALTH_URL = "http://127.0.0.1:11434/api/tags";

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0;
}

async function endpointReady(fetchImpl, url, { validate } = {}) {
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response?.ok) return false;
    if (!validate) return true;
    return validate(await response.json()) === true;
  } catch {
    return false;
  }
}

export async function collectLocalRuntimeStatus({ fetchImpl = fetch, codexTasks = null } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("invalid_status_fetch");
  const [secureChatReady, localModelReady, codex] = await Promise.all([
    endpointReady(fetchImpl, SECURE_CHAT_HEALTH_URL, {
      validate: (value) => value?.ok === true && value?.exposure === "loopback_only",
    }),
    endpointReady(fetchImpl, OLLAMA_HEALTH_URL),
    codexTasks?.summary?.().catch(() => null) ?? null,
  ]);

  return Object.freeze({
    schema: "local-ai.telegram-runtime-status.v1",
    secureChatReady,
    localModelReady,
    codex: codex ? Object.freeze({
      queued: boundedCount(codex.queued),
      running: boundedCount(codex.running),
      undelivered: boundedCount(codex.undelivered),
    }) : null,
    telegramMode: codexTasks ? "general_chat_and_codex_status" : "general_chat_only",
    privilegedIngress: "local_owner_app_only",
  });
}

export function formatLocalRuntimeStatus(status) {
  if (status?.schema !== "local-ai.telegram-runtime-status.v1") throw new Error("invalid_runtime_status");
  const ready = (value) => value === true ? "정상" : "확인 필요";
  const lines = [
    "나의 Local AI 상태",
    `• Mac 보안 서버: ${ready(status.secureChatReady)}`,
    `• 로컬 대화 모델: ${ready(status.localModelReady)}`,
    `• Telegram: 연결됨 · ${status.telegramMode === "general_chat_and_codex_status" ? "일반 대화 + Codex 상태 조회" : "일반 대화 전용"}`,
  ];
  if (status.codex) {
    lines.push(`• Codex 작업: 대기 ${boundedCount(status.codex.queued)} · 실행 ${boundedCount(status.codex.running)} · 결과 대기 ${boundedCount(status.codex.undelivered)}`);
  } else {
    lines.push("• 격리 Codex: 비활성 또는 사전점검 실패");
  }
  lines.push("• 구매·메일·파일·홈 제어와 승인은 나의 Local AI 앱에서만 처리");
  return lines.join("\n");
}
