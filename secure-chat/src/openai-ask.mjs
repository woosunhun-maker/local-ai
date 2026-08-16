import { redactCredentials } from "./security/credential-patterns.mjs";

export const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_ASK_PREFIX = "맥이 오픈에게 물은 답입니다.\n\n";
export const OPENAI_DEFAULT_MODEL = "gpt-4.1-mini";
export const OPENAI_QUESTION_LIMIT = 4_000;

const TRIGGER = /^(?:맥에서\s*)?(?:오픈(?:\s*ai|\s*AI|에이아이)?|챗\s*지피티|chatgpt|gpt)에게(?:도)?(?:\s*(?:물어(?:봐(?:요|줘|주)?|라)?|질문(?:해)?(?:줘)?|물어봐\s*줘))?[.:：\s]+(.+)$/iu;
const BARE_TRIGGER = /^(?:맥에서\s*)?(?:오픈(?:\s*ai|\s*AI|에이아이)?|챗\s*지피티|chatgpt|gpt)에게(?:도)?(?:\s*(?:물어(?:봐(?:요|줘|주)?|라)?|질문(?:해)?(?:줘)?|물어봐\s*줘))?[.:：\s]*$/iu;

export const OPENAI_SYSTEM_PROMPT = [
  "너는 맥 로컬 AI가 방금 보낸 질문 한 줄에만 답한다.",
  "방 기록, 개인 기억, 파일, 도구는 없다.",
  "한국어로 짧게 답한다. 모르면 모른다고 한다.",
  "결제·전송·해킹·우회는 하지 않는다.",
].join("\n");

export const OPENAI_EMPTY_QUESTION = "무엇을 오픈에게 물을지 한 줄로 적어 주세요. 예: 오픈에게 물어봐 파이썬으로 리스트 정렬하는 법";
export const OPENAI_KEY_MISSING = "맥 .env에 OPENAI_API_KEY가 없습니다. 키를 넣으면 오픈에게 물을 수 있습니다. 대화 원문과 기억은 보내지 않습니다.";

export function stripOpenAIAskTrigger(text) {
  const raw = String(text ?? "").trim();
  const matched = TRIGGER.exec(raw);
  if (matched?.[1]) return matched[1].trim();
  if (BARE_TRIGGER.test(raw)) return "";
  return raw;
}

export function parseOpenAIAsk(text, { ask } = {}) {
  const raw = String(text ?? "").trim();
  if (ask === "openai") {
    return { target: "openai", question: stripOpenAIAskTrigger(raw) };
  }
  if (TRIGGER.test(raw)) {
    return { target: "openai", question: stripOpenAIAskTrigger(raw) };
  }
  if (BARE_TRIGGER.test(raw)) {
    return { target: "openai", question: "" };
  }
  return { target: "local", question: raw };
}

export function sanitizeOpenAIQuestion(question) {
  return redactCredentials(String(question ?? "").trim()).slice(0, OPENAI_QUESTION_LIMIT);
}

export function buildOpenAIAskMessages(question) {
  const cleaned = sanitizeOpenAIQuestion(question);
  if (!cleaned) throw new Error("openai_question_empty");
  return Object.freeze([
    Object.freeze({ role: "system", content: OPENAI_SYSTEM_PROMPT }),
    Object.freeze({ role: "user", content: cleaned }),
  ]);
}

export function openaiAskStatus() {
  return Object.freeze({
    enabled: Boolean(String(process.env.OPENAI_API_KEY ?? "").trim()),
    model: process.env.OPENAI_MODEL || OPENAI_DEFAULT_MODEL,
    history: false,
    memory: false,
    tools: false,
    telegram: false,
  });
}

function readApiKey(options = {}) {
  return String(options.apiKey ?? process.env.OPENAI_API_KEY ?? "").trim();
}

function readModel(options = {}) {
  return String(options.model ?? process.env.OPENAI_MODEL ?? OPENAI_DEFAULT_MODEL).trim() || OPENAI_DEFAULT_MODEL;
}

export async function askOpenAIFromMac(question, {
  fetchImpl = fetch,
  apiKey,
  model,
  signal,
} = {}) {
  const key = readApiKey({ apiKey });
  if (!key) {
    throw Object.assign(new Error("openai_key_missing"), {
      statusCode: 503,
      userMessage: OPENAI_KEY_MISSING,
    });
  }
  const messages = buildOpenAIAskMessages(question);
  const response = await fetchImpl(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: readModel({ model }),
      stream: false,
      messages,
    }),
    signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error("openai_ask_failed"), { statusCode: 502 });
  }
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("empty_openai_response");
  return `${OPENAI_ASK_PREFIX}${text.trim()}`;
}

export async function* parseOpenAIChatSSE(source) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of source) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      const payload = JSON.parse(data);
      const content = payload?.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content) yield content;
    }
  }
}

export async function* askOpenAITokens(question, {
  fetchImpl = fetch,
  apiKey,
  model,
  signal,
} = {}) {
  const key = readApiKey({ apiKey });
  if (!key) {
    yield OPENAI_KEY_MISSING;
    return;
  }
  const messages = buildOpenAIAskMessages(question);
  const response = await fetchImpl(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: readModel({ model }),
      stream: true,
      messages,
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    throw Object.assign(new Error("openai_ask_failed"), { statusCode: 502 });
  }
  yield OPENAI_ASK_PREFIX;
  for await (const fragment of parseOpenAIChatSSE(response.body)) {
    yield fragment;
  }
}
