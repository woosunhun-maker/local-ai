import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { redactCredentials } from "./security/credential-patterns.mjs";

const execFileAsync = promisify(execFile);

/** 맥에 이미 띄운 OpenClaw 채팅 프록시. 클라우드 API 키는 쓰지 않는다. */
export const OPENAI_CHAT_URL = "http://127.0.0.1:18790/v1/chat/completions";
export const OPENAI_LOCAL_MODEL = "openclaw/default";
export const OPENAI_ASK_PREFIX = "맥에 띄운 오픈에게 물은 답입니다.\n\n";
export const OPENAI_QUESTION_LIMIT = 4_000;
export const PROXY_KEYCHAIN_SERVICE = "local.privateai.openwebui.proxy.token";
export const PROXY_KEYCHAIN_ACCOUNT = "local-ai";

const TRIGGER = /^(?:맥에서\s*)?(?:오픈(?:\s*ai|\s*AI|에이아이)?|챗\s*지피티|chatgpt|gpt)에게(?:도)?(?:\s*(?:물어(?:봐(?:요|줘|주)?|라)?|질문(?:해)?(?:줘)?|물어봐\s*줘))?[.:：\s]+(.+)$/iu;
const BARE_TRIGGER = /^(?:맥에서\s*)?(?:오픈(?:\s*ai|\s*AI|에이아이)?|챗\s*지피티|chatgpt|gpt)에게(?:도)?(?:\s*(?:물어(?:봐(?:요|줘|주)?|라)?|질문(?:해)?(?:줘)?|물어봐\s*줘))?[.:：\s]*$/iu;

export const OPENAI_SYSTEM_PROMPT = [
  "너는 맥에 이미 떠 있는 오픈이다. 방금 받은 질문 한 줄에만 답한다.",
  "방 기록, 개인 기억, 파일, 도구는 없다.",
  "한국어로 짧게 답한다. 모르면 모른다고 한다.",
  "결제·전송·해킹·우회는 하지 않는다.",
].join("\n");

export const OPENAI_EMPTY_QUESTION = "무엇을 오픈에게 물을지 한 줄로 적어 주세요. 예: 오픈에게 물어봐 파이썬으로 리스트 정렬하는 법";
export const OPENAI_LOCAL_UNAVAILABLE = "맥에 띄운 오픈(127.0.0.1:18790)에 닿지 못했습니다. 프록시가 켜져 있는지 보면 됩니다. API 키는 필요 없습니다.";

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
    enabled: true,
    via: OPENAI_CHAT_URL,
    model: OPENAI_LOCAL_MODEL,
    apiKey: false,
    history: false,
    memory: false,
    tools: false,
    telegram: false,
  });
}

export function assertLocalOpenAIUrl(url) {
  if (url !== OPENAI_CHAT_URL) throw new Error("openai_url_must_be_loopback");
  return url;
}

async function defaultProxyToken() {
  try {
    const result = await execFileAsync("/usr/bin/security", [
      "find-generic-password",
      "-s",
      PROXY_KEYCHAIN_SERVICE,
      "-a",
      PROXY_KEYCHAIN_ACCOUNT,
      "-w",
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    return String(result.stdout ?? "").trim();
  } catch {
    return "";
  }
}

export async function resolveLocalOpenAIToken(options = {}) {
  if (Object.hasOwn(options, "token")) return String(options.token ?? "").trim();
  if (typeof options.readToken === "function") return String(await options.readToken() ?? "").trim();
  return defaultProxyToken();
}

function requestHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-OpenWebUI-Chat-Id": "secure-chat-openai-ask",
  };
}

export async function askOpenAIFromMac(question, {
  fetchImpl = fetch,
  token,
  readToken,
  signal,
} = {}) {
  const proxyToken = await resolveLocalOpenAIToken({ token, readToken });
  if (!proxyToken) {
    throw Object.assign(new Error("openai_local_unavailable"), {
      statusCode: 503,
      userMessage: OPENAI_LOCAL_UNAVAILABLE,
    });
  }
  const messages = buildOpenAIAskMessages(question);
  const response = await fetchImpl(OPENAI_CHAT_URL, {
    method: "POST",
    headers: requestHeaders(proxyToken),
    body: JSON.stringify({
      model: OPENAI_LOCAL_MODEL,
      stream: false,
      messages,
    }),
    signal,
  });
  if (!response.ok) {
    throw Object.assign(new Error("openai_ask_failed"), { statusCode: 502, userMessage: OPENAI_LOCAL_UNAVAILABLE });
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
  token,
  readToken,
  signal,
} = {}) {
  const proxyToken = await resolveLocalOpenAIToken({ token, readToken });
  if (!proxyToken) {
    yield OPENAI_LOCAL_UNAVAILABLE;
    return;
  }
  const messages = buildOpenAIAskMessages(question);
  const response = await fetchImpl(OPENAI_CHAT_URL, {
    method: "POST",
    headers: requestHeaders(proxyToken),
    body: JSON.stringify({
      model: OPENAI_LOCAL_MODEL,
      stream: true,
      messages,
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    yield OPENAI_LOCAL_UNAVAILABLE;
    return;
  }
  yield OPENAI_ASK_PREFIX;
  for await (const fragment of parseOpenAIChatSSE(response.body)) {
    yield fragment;
  }
}
