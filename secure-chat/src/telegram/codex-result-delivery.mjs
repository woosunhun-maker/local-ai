import { normalizeTaskPrincipal, sameTelegramPrincipal, validateBotId } from "./principal.mjs";
import { safeCodexSummary } from "../codex/public-task.mjs";

function normalizeCurrentPrincipal(value) {
  return Object.freeze({
    botId: validateBotId(value?.botId),
    ...normalizeTaskPrincipal(value),
  });
}

export function formatCodexResult(job) {
  const id = String(job.id).slice(0, 8);
  if (job.status === "succeeded") {
    const summary = safeCodexSummary(job.result?.summary) ?? "결과에 민감할 수 있는 내용이 있어 Telegram에는 상세 내용을 표시하지 않았습니다.";
    const draft = job.intent === "draft"
      ? `\n격리 초안 변경: ${job.result?.changedFileCount ?? 0}개 · 실제 소스에는 미반영`
      : "";
    return `Codex 작업 #${id} 완료\n${summary}${draft}`;
  }
  if (job.status === "interrupted_uncertain") {
    return `Codex 작업 #${id} 중단 · 결과를 확정할 수 없어 자동 재실행하지 않았습니다.`;
  }
  return `Codex 작업 #${id} 실패 · 원시 오류와 로컬 경로는 Telegram으로 보내지 않았습니다.`;
}

export async function deliverCodexResults({ store, client, principal: value, limit = 10 }) {
  const principal = normalizeCurrentPrincipal(value);
  for (const job of await store.listUndelivered({ limit })) {
    if (!sameTelegramPrincipal(job, principal)) {
      await store.quarantineDelivery(job.id, principal);
      continue;
    }
    await client.sendText(principal.chatId, formatCodexResult(job));
    await store.markDelivered(job.id, principal);
  }
}
