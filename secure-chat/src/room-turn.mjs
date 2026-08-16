import { askOpenAITokens, isOpenGatewayUp, OPENAI_EMPTY_QUESTION, OPENAI_LOCAL_UNAVAILABLE } from "./openai-ask.mjs";
import { askRoomModelTokens } from "./room-ask.mjs";
import { planSelfConsult } from "./self-consult.mjs";

export function lastUserText(messages, fallback = "") {
  if (!Array.isArray(messages)) return String(fallback ?? "");
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item?.role === "user" && typeof item.content === "string") return item.content;
  }
  return String(fallback ?? "");
}

export async function planRoomTurn(messages, { ask, text, lessonStore } = {}) {
  const snapshot = lessonStore && typeof lessonStore.snapshot === "function"
    ? await lessonStore.snapshot()
    : { lastConsultAt: 0, consultCountToday: 0, lessons: [] };
  return {
    ...planSelfConsult(lastUserText(messages, text), {
      ask,
      lastConsultAt: snapshot.lastConsultAt,
      consultCountToday: snapshot.consultCountToday,
    }),
    lessons: snapshot.lessons ?? [],
  };
}

async function rememberConsult(lessonStore, question, answer) {
  if (!lessonStore || typeof lessonStore.remember !== "function") return;
  if (!answer || answer.includes(OPENAI_LOCAL_UNAVAILABLE)) return;
  await lessonStore.remember(question, answer);
}

export async function* roomTurnTokens(messages, {
  ask,
  text,
  signal,
  fetchImpl,
  token,
  readToken,
  lessonStore,
} = {}) {
  const plan = await planRoomTurn(messages, { ask, text, lessonStore });
  if (plan.mode === "openai_only") {
    if (!plan.question) {
      yield OPENAI_EMPTY_QUESTION;
      return;
    }
    yield* consultOpenAI(plan.question, { signal, fetchImpl, token, readToken, lessonStore });
    return;
  }

  const gatewayReady = plan.mode === "self" && plan.question
    ? isOpenGatewayUp({ fetchImpl })
    : Promise.resolve(false);

  for await (const fragment of askRoomModelTokens(messages, { signal, fetchImpl, lessons: plan.lessons })) {
    yield fragment;
  }

  if (plan.mode !== "self" || !plan.question || !(await gatewayReady)) return;
  yield "\n\n";
  yield* consultOpenAI(plan.question, { signal, fetchImpl, token, readToken, lessonStore });
}

async function* consultOpenAI(question, { signal, fetchImpl, token, readToken, lessonStore }) {
  let consult = "";
  try {
    for await (const fragment of askOpenAITokens(question, { signal, fetchImpl, token, readToken })) {
      consult += fragment;
      yield fragment;
    }
  } catch {
    if (!consult.includes(OPENAI_LOCAL_UNAVAILABLE)) {
      yield OPENAI_LOCAL_UNAVAILABLE;
      consult += OPENAI_LOCAL_UNAVAILABLE;
    }
  }
  await rememberConsult(lessonStore, question, consult);
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
