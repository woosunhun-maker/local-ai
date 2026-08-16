import { assertConversationModel, LOCAL_CONVERSATION_MODEL } from "./local-model-routing.mjs";

const OLLAMA = "http://127.0.0.1:11434/api/chat";

export function buildRoomSystemPrompt() {
  return [
    "너는 이 맥에서만 사는 로컬 AI다. 창은 여러 개여도 기억은 하나다.",
    "한국어로 짧게 답한다. 추측하지 말고, 모르면 모른다고 한다.",
    "어느 모델을 썼는지, 다른 AI 이름을 말하지 않는다. 결과만 말한다.",
    "링크를 지어내지 않는다. 직접 열지 않은 주소는 주지 않는다. 후보면 추측이라고 적는다.",
    "보내지 않았고, 결제하지 않았고, 파일을 고치지 않았으면 했다고 말하지 않는다.",
    "결제·남에게 보내기는 혼자 하지 않고, 해도 되는지 한 줄로 묻는다.",
  ].join("\n");
}

export async function askRoomModelStream(messages, { fetchImpl = fetch, model = LOCAL_CONVERSATION_MODEL, signal } = {}) {
  assertConversationModel(model);
  if (!Array.isArray(messages) || messages.length < 1) throw new Error("invalid_room_messages");
  const recent = messages
    .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
    .slice(-24)
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 4_000) }));
  const response = await fetchImpl(OLLAMA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "system", content: buildRoomSystemPrompt() }, ...recent],
    }),
    signal,
  });
  if (!response.ok || !response.body) throw Object.assign(new Error("room_model_failed"), { statusCode: 502 });
  return response.body;
}

export async function* askRoomModelTokens(messages, options) {
  const source = await askRoomModelStream(messages, options);
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      const payload = JSON.parse(trimmed);
      const content = payload?.message?.content;
      if (typeof content === "string" && content) yield content;
    }
  }
}

export async function askRoomModel(messages, { fetchImpl = fetch, model = LOCAL_CONVERSATION_MODEL } = {}) {
  assertConversationModel(model);
  if (!Array.isArray(messages) || messages.length < 1) throw new Error("invalid_room_messages");
  const recent = messages
    .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
    .slice(-12)
    .map((item) => ({ role: item.role, content: item.content.trim().slice(0, 4_000) }));
  const response = await fetchImpl(OLLAMA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "system", content: buildRoomSystemPrompt() }, ...recent],
    }),
  });
  if (!response.ok) throw Object.assign(new Error("room_model_failed"), { statusCode: 502 });
  const body = await response.json();
  const text = body?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("empty_room_model_response");
  return text.trim();
}
