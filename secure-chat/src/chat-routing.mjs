// 자동으로 deep(도구/에이전트)로 올리지 않는다.
// deep은 사용자가 명시적으로 고르거나, 아이폰의 「다른 AI에게 대신 물어보기」 등 수동 경로만 사용한다.

export function resolveChatMode(requestedMode, messages) {
  if (requestedMode === "fast" || requestedMode === "deep") return requestedMode;
  // auto 및 기타 → 항상 로컬 빠른 대화
  return "fast";
}

export function assertChatModeAccess(mode, device) {
  if (!new Set(["fast", "deep"]).has(mode)) throw Object.assign(new Error("invalid_chat_mode"), { statusCode: 400 });
  if (mode === "deep" && device?.role !== "owner") {
    throw Object.assign(new Error("owner_device_required_for_deep_tasks"), { statusCode: 403 });
  }
  return true;
}

export function trimChatContext(messages, mode) {
  const characterLimit = mode === "deep" ? 60_000 : 12_000;
  const messageLimit = mode === "deep" ? 40 : 16;
  const selected = [];
  let characters = 0;

  for (let index = messages.length - 1; index >= 0 && selected.length < messageLimit; index -= 1) {
    const message = messages[index];
    if (characters + message.content.length > characterLimit && selected.length > 0) break;
    const remaining = Math.max(1, characterLimit - characters);
    selected.push({ ...message, content: message.content.slice(-remaining) });
    characters += Math.min(message.content.length, remaining);
  }
  return selected.reverse();
}
