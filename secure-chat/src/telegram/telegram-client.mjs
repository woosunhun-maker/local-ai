function apiUrl(token, method) {
  if (!/^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("telegram_token_invalid");
  if (!/^[A-Za-z][A-Za-z0-9]{1,40}$/.test(method)) throw new Error("telegram_method_invalid");
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegramRequest(token, method, payload, { fetchImpl = fetch, timeoutMs = 40_000 } = {}) {
  let response;
  try {
    response = await fetchImpl(apiUrl(token, method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("telegram_transport_error");
  }
  if (!response.ok) throw new Error("telegram_http_error");
  let parsed;
  try {
    parsed = await response.json();
  } catch {
    throw new Error("telegram_response_invalid");
  }
  if (parsed?.ok !== true) throw new Error("telegram_api_error");
  return parsed.result;
}

export function telegramClient(token, options = {}) {
  return Object.freeze({
    verify: () => telegramRequest(token, "getMe", {}, options),
    discardPendingUpdates: () => telegramRequest(token, "deleteWebhook", { drop_pending_updates: true }, options),
    getUpdates: (offset) => {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("telegram_offset_invalid");
      return telegramRequest(token, "getUpdates", {
        offset,
        limit: 20,
        timeout: 30,
        allowed_updates: ["message"],
      }, { ...options, timeoutMs: 40_000 });
    },
    sendText: (chatId, text) => {
      const normalizedText = String(text ?? "").trim();
      if (!/^-?[1-9][0-9]{5,19}$/.test(String(chatId ?? "")) || !normalizedText) throw new Error("telegram_outbound_invalid");
      return telegramRequest(token, "sendMessage", {
        chat_id: chatId,
        text: normalizedText.slice(0, 4_000),
        disable_web_page_preview: true,
        protect_content: true,
      }, options);
    },
  });
}
