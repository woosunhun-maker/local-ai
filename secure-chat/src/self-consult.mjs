import { containsCredential } from "./security/credential-patterns.mjs";
import { parseOpenAIAsk, sanitizeOpenAIQuestion } from "./openai-ask.mjs";
import { isRoomNoise } from "./room-ask.mjs";
import { isMacDoCommand } from "./room-mac-do.mjs";
import { isFaceIdGateCommand } from "./room-faceid-gate.mjs";
import { isMacWorkCommand } from "./room-mac-work.mjs";
import { inspectRoomOwnerCommand } from "./room-owner-policy.mjs";

export const SELF_CONSULT_COOLDOWN_MS = 8_000;
export const SELF_CONSULT_DAILY_CAP = 40;

const PRIVATE = /비밀번호|패스워드|password|otp|인증번호|주민등록|계좌|카드번호|복구\s*코드|내 주소|우리 집|전화번호|휴대폰번호|여권|운전면허/iu;
const SMALLTALK = /^(?:안녕(?:하세요)?|하이|ㅎㅇ|헬로|hello|hi|고마워|감사합니다?|ㅇㅋ|응|그래|좋아|ㅋㅋ+|ㅎㅎ+|네|아니)$/iu;
const KNOWLEDGE = /[?？]|어떻게|왜\s|왜요|무엇|뭐가|최신|비교|차이|고치|고쳐|에러|오류|구현|설명|방법|원리|설계|추천|뜻|이유/u;
export function isOutsideRoomTask(text) {
  return isMacWorkCommand(text);
}

export function isPrivateForConsult(text) {
  const value = String(text ?? "");
  return containsCredential(value) || PRIVATE.test(value);
}

export function isSmallTalk(text) {
  const value = String(text ?? "").trim();
  if (!value || isRoomNoise(value)) return true;
  if (SMALLTALK.test(value)) return true;
  return value.length < 6 && !KNOWLEDGE.test(value);
}

export function isKnowledgeSeeking(text) {
  const value = String(text ?? "").trim();
  if (!value || isSmallTalk(value) || isPrivateForConsult(value) || isMacWorkCommand(value)) return false;
  if (KNOWLEDGE.test(value)) return true;
  return value.length >= 18;
}

export function buildSelfQuestion(text) {
  const cleaned = sanitizeOpenAIQuestion(text);
  return `개인·계정·파일 없이 일반 지식만 짧게: ${cleaned.slice(0, 360)}`;
}

export function planSelfConsult(text, {
  ask,
  now = Date.now(),
  lastConsultAt = 0,
  consultCountToday = 0,
} = {}) {
  const gate = inspectRoomOwnerCommand(text);
  if (!gate.allow) {
    return Object.freeze({
      mode: "deny",
      target: "deny",
      consult: false,
      question: "",
      reason: gate.reason,
      reply: gate.reply,
    });
  }
  const parsed = parseOpenAIAsk(text, { ask });
  if (parsed.target === "openai") {
    return Object.freeze({
      mode: "openai_only",
      target: "openai",
      consult: true,
      question: parsed.question,
      reason: parsed.question ? "explicit" : "explicit_empty",
    });
  }
  if (isPrivateForConsult(text)) {
    return Object.freeze({ mode: "local", target: "local", consult: false, question: "", reason: "private" });
  }
  if (isFaceIdGateCommand(text) && !isMacDoCommand(text)) {
    return Object.freeze({
      mode: "faceid_gate",
      target: "iphone",
      consult: false,
      question: "",
      reason: "faceid_gate",
      reply: "",
    });
  }
  if (isMacWorkCommand(text)) {
    return Object.freeze({ mode: "mac_work", target: "mac", consult: false, question: "", reason: "mac_work" });
  }
  if (isSmallTalk(text)) {
    return Object.freeze({ mode: "local", target: "local", consult: false, question: "", reason: "smalltalk" });
  }
  if (!isKnowledgeSeeking(text)) {
    return Object.freeze({ mode: "local", target: "local", consult: false, question: "", reason: "local_enough" });
  }
  if (lastConsultAt && now - lastConsultAt < SELF_CONSULT_COOLDOWN_MS) {
    return Object.freeze({ mode: "local", target: "local", consult: false, question: "", reason: "cooldown" });
  }
  if (consultCountToday >= SELF_CONSULT_DAILY_CAP) {
    return Object.freeze({ mode: "local", target: "local", consult: false, question: "", reason: "daily_cap" });
  }
  return Object.freeze({
    mode: "self",
    target: "self",
    consult: true,
    question: buildSelfQuestion(text),
    reason: "self",
  });
}

export function draftLesson(question, answer) {
  const topic = sanitizeOpenAIQuestion(question).slice(0, 80);
  const lesson = sanitizeOpenAIQuestion(String(answer ?? "").replace(/^맥에 띄운 오픈에게 물은 답입니다\.\s*/u, "")).slice(0, 240);
  if (topic.length < 4 || lesson.length < 12) return null;
  if (isPrivateForConsult(topic) || isPrivateForConsult(lesson)) return null;
  return Object.freeze({ topic, lesson });
}
