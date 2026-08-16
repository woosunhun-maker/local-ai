import { assertConversationModel, LOCAL_CONVERSATION_MODEL } from "./local-model-routing.mjs";

const OLLAMA = "http://127.0.0.1:11434/api/chat";

export function buildRoomSystemPrompt(lessons = []) {
  const lines = [
    "너는 이 맥에서만 사는 로컬 AI다. 창은 여러 개여도 기억은 하나다.",
    "한국어로 짧게 답한다. 추측하지 말고, 모르면 모른다고 한다.",
    "지금 사용자가 방금 한 말에만 답한다. 예전에 끊긴 오타나 키보드 불평을 다시 꺼내지 않는다.",
    "어느 모델을 썼는지, 다른 AI 이름을 말하지 않는다. 결과만 말한다.",
    "링크를 지어내지 않는다. 직접 열지 않은 주소는 주지 않는다. 후보면 추측이라고 적는다.",
    "보내지 않았고, 결제하지 않았고, 파일을 고치지 않았으면 했다고 말하지 않는다.",
    "결제·남에게 보내기는 혼자 하지 않고, 해도 되는지 한 줄로 묻는다.",
  ];
  const usable = (Array.isArray(lessons) ? lessons : [])
    .map((item) => String(item?.lesson ?? "").trim())
    .filter((lesson) => lesson.length >= 12)
    .slice(-8);
  if (usable.length > 0) {
    lines.push("집에서 스스로 모은 일반 교훈이다. 개인 이야기는 아니다.");
    for (const lesson of usable) lines.push(`- ${lesson.slice(0, 240)}`);
  }
  return lines.join("\n");
}

const NOISE = /^(?:[\s.·…ㅇ어ㅏㅓㅜㅠㅡㅣㄱ-ㅎㅏ-ㅣ]{1,12})$/u;

export function isRoomNoise(text) {
  const value = String(text ?? "").trim();
  if (value.length < 2) return true;
  if (NOISE.test(value)) return true;
  if (/(.)\1{5,}/u.test(value)) return true;
  const letters = [...value].filter((ch) => /\S/u.test(ch));
  const jamo = letters.filter((ch) => /[ㄱ-ㅎㅏ-ㅣ]/u.test(ch)).length;
  if (letters.length <= 12 && jamo >= 2 && jamo / letters.length >= 0.25) return true;
  return false;
}

export function selectRoomContext(messages, { limit = 8 } = {}) {
  if (!Array.isArray(messages) || messages.length < 1) return [];
  const usable = messages.filter(
    (item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string" && item.content.trim(),
  );
  const latest = usable.at(-1);
  const kept = usable.filter((item, index) => {
    if (item === latest || index === usable.length - 1) return true;
    return !isRoomNoise(item.content);
  });
  return kept.slice(-limit).map((item) => ({
    role: item.role,
    content: item.content.trim().slice(0, 4_000),
  }));
}

export async function askRoomModelStream(messages, { fetchImpl = fetch, model = LOCAL_CONVERSATION_MODEL, signal, lessons } = {}) {
  assertConversationModel(model);
  if (!Array.isArray(messages) || messages.length < 1) throw new Error("invalid_room_messages");
  const recent = selectRoomContext(messages, { limit: 8 });
  if (recent.length < 1) throw new Error("invalid_room_messages");
  const response = await fetchImpl(OLLAMA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [{ role: "system", content: buildRoomSystemPrompt(lessons) }, ...recent],
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

export async function askRoomModel(messages, { fetchImpl = fetch, model = LOCAL_CONVERSATION_MODEL, lessons } = {}) {
  assertConversationModel(model);
  if (!Array.isArray(messages) || messages.length < 1) throw new Error("invalid_room_messages");
  const recent = selectRoomContext(messages, { limit: 8 });
  if (recent.length < 1) throw new Error("invalid_room_messages");
  const response = await fetchImpl(OLLAMA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: "system", content: buildRoomSystemPrompt(lessons) }, ...recent],
    }),
  });
  if (!response.ok) throw Object.assign(new Error("room_model_failed"), { statusCode: 502 });
  const body = await response.json();
  const text = body?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("empty_room_model_response");
  return text.trim();
}
