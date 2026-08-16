import { askOpenAITokens, parseOpenAIAsk, OPENAI_EMPTY_QUESTION } from "./openai-ask.mjs";
import { askRoomModelTokens } from "./room-ask.mjs";

export function lastUserText(messages, fallback = "") {
  if (!Array.isArray(messages)) return String(fallback ?? "");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item?.role === "user" && typeof item.content === "string") return item.content;
  }
  return String(fallback ?? "");
}

export function planRoomTurn(messages, { ask, text } = {}) {
  return parseOpenAIAsk(lastUserText(messages, text), { ask });
}

export async function* roomTurnTokens(messages, {
  ask,
  text,
  signal,
  fetchImpl,
  apiKey,
  model,
} = {}) {
  const plan = planRoomTurn(messages, { ask, text });
  if (plan.target === "openai") {
    if (!plan.question) {
      yield OPENAI_EMPTY_QUESTION;
      return;
    }
    yield* askOpenAITokens(plan.question, { signal, fetchImpl, apiKey, model });
    return;
  }
  yield* askRoomModelTokens(messages, { signal, fetchImpl });
}

export async function roomTurnAnswer(messages, options) {
  let text = "";
  for await (const fragment of roomTurnTokens(messages, options)) {
    text += fragment;
  }
  const trimmed = text.trim();
  if (!trimmed) throw new Error("empty_room_model_response");
  return trimmed;
}
