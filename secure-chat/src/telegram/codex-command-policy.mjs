import { containsCredential } from "../security/credential-patterns.mjs";

const ATTACHMENT_FIELDS = Object.freeze([
  "photo",
  "document",
  "audio",
  "voice",
  "video",
  "video_note",
  "animation",
  "sticker",
  "contact",
  "location",
  "venue",
  "poll",
  "passport_data",
  "web_app_data",
  "story",
  "dice",
  "game",
  "invoice",
  "successful_payment",
  "users_shared",
  "chat_shared",
  "paid_media",
  "giveaway",
  "giveaway_created",
  "giveaway_winners",
  "giveaway_completed",
]);

const FORWARD_FIELDS = Object.freeze([
  "forward_origin",
  "forward_from",
  "forward_from_chat",
  "forward_date",
  "forward_sender_name",
  "is_automatic_forward",
]);

const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0]/u;

const BLOCKED_CATEGORIES = Object.freeze([
  Object.freeze({
    category: "personal_or_secret",
    patterns: Object.freeze([
      /(?:개인\s*정보|민감\s*정보|주민(?:등록)?번호|여권번호|운전면허번호|생년월일|집\s*주소|전화번호|휴대폰번호|연락처)/iu,
      /(?:비밀번호|패스워드|암호|인증번호|복구\s*코드|보안\s*코드|일회용\s*비밀번호|토큰|otp|2fa|api\s*key|secret|credential|access\s*token|refresh\s*token|authorization|bearer)/iu,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
      /(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[-. ]?\d{4}/u,
      /\b\d{6}[- ]?[1-4]\d{6}\b/u,
      /\b(?:\d[ -]*?){13,19}\b/u,
      /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/u,
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
      /\b(?:password|passwd|secret|access[_ -]?token|refresh[_ -]?token|authorization|bearer)\s*[:=]/iu,
      /(?:\/Users\/[A-Za-z0-9._-]+|\/Users\/hun|\/Users\/[^/\s]+\/PrivateAI|\$HOME|~\/)/u,
    ]),
  }),
  Object.freeze({
    category: "mail",
    patterns: Object.freeze([
      /(?:메일|이메일|e-?mail|gmail|지메일|받은\s*편지|수신함|회신|답장|보낸\s*편지|inbox|mailbox|\bmail\b)/iu,
    ]),
  }),
  Object.freeze({
    category: "purchase",
    patterns: Object.freeze([
      /(?:쿠팡|coupang|장바구니|주문|구매|결제|배송지|배송주소|반품|환불|checkout|purchase|payment|shopping\s*cart|\border\b|\bcart\b|\brefund\b)/iu,
      /(?:카드|계좌|은행|송금|이체|주식|증권|보험|세금|금융)/iu,
    ]),
  }),
  Object.freeze({
    category: "browser",
    patterns: Object.freeze([
      /(?:chrome|크롬|safari|사파리|browser|브라우저|웹사이트|로그인된\s*웹|사이트에서|웹에서)/iu,
      /(?:https?:\/\/|www\.)/iu,
    ]),
  }),
  Object.freeze({
    category: "home_control",
    patterns: Object.freeze([
      /(?:home\s*assistant|홈\s*어시스턴트|아카라|aqara|matter|스마트\s*홈|조명|도어락|현관|cctv|에어컨|보일러)/iu,
    ]),
  }),
  Object.freeze({
    category: "installation_or_deployment",
    patterns: Object.freeze([
      /(?:설치|인스톨|install(?:ation)?|업그레이드|upgrade|패키지\s*추가|의존성\s*추가)/iu,
      /(?:배포|deploy(?:ment)?|릴리스|release|publish|프로덕션|production|실서버|운영\s*서버|git\s*push|앱\s*스토어|testflight)/iu,
      /(?:launchctl|daemon|launchagent|재시작|restart|reboot|종료|shutdown|kill\s+-)/iu,
    ]),
  }),
  Object.freeze({
    category: "deletion",
    patterns: Object.freeze([
      /(?:삭제|영구\s*삭제|초기화|포맷|휴지통\s*비우|delete|remove|wipe|erase|factory\s*reset)/iu,
      /(?:^|\s)(?:rm|rmdir|unlink)\s+(?:-[A-Za-z]*\s+)?/iu,
    ]),
  }),
  Object.freeze({
    category: "security_weakening",
    patterns: Object.freeze([
      /(?:보안|인증|검증|서명|샌드박스|방화벽|암호화).{0,16}(?:끄|해제|우회|무시|제거|약화|완화|비활성)/iu,
      /(?:끄|해제|우회|무시|제거|약화|완화|비활성).{0,16}(?:보안|인증|검증|서명|샌드박스|방화벽|암호화)/iu,
      /(?:bypass|disable|weaken|skip|ignore).{0,24}(?:security|authentication|authorization|verification|signature|sandbox|firewall|tls|ssl)/iu,
      /(?:security|authentication|authorization|verification|signature|sandbox|firewall|tls|ssl).{0,24}(?:bypass|disable|weaken|skip|ignore)/iu,
      /(?:--dangerously-bypass|sandbox\s*(?:=|:)\s*(?:off|none)|chmod\s+777|sudo\b|root\s+(?:권한|access)|allow\s+all|no\s*auth)/iu,
    ]),
  }),
  Object.freeze({
    category: "approval",
    patterns: Object.freeze([
      /(?:승인|거부|결재|허가|approve|approval|reject|authorize|authorise|consent)/iu,
    ]),
  }),
]);

const BLOCKED_RESPONSE = "이 Codex 요청은 Telegram에서 처리할 수 없습니다. 개인정보나 중요한 작업은 나의 Local AI 앱에서 지시해 주세요.";
const SYNTAX_RESPONSE = "사용법: /codex inspect <요청>, /codex draft <요청>, /codex status, /codex help";
const OWNER_APP_APPROVAL_RESPONSE = "Telegram에서는 Codex 작업을 실행하지 않습니다. Local AI 앱에서 OpenAI 외부 전송 계획과 코드 스냅샷 해시를 확인하고 Face ID 또는 기기 암호로 승인해 주세요.";

function frozen(value) {
  return Object.freeze(value);
}

function rejected(reason, response = BLOCKED_RESPONSE, extra = {}) {
  return frozen({ matched: true, allowed: false, route: "codex", reason, response, ...extra });
}

function hasHiddenExternalEntity(message) {
  const entities = [
    ...(Array.isArray(message.entities) ? message.entities : []),
    ...(Array.isArray(message.caption_entities) ? message.caption_entities : []),
  ];
  return entities.some((entity) => entity?.type === "text_link" || typeof entity?.url === "string");
}

function commandSource(message) {
  if (typeof message?.text === "string") return message.text;
  if (typeof message?.caption === "string") return message.caption;
  return "";
}

function blockedCategory(text) {
  if (containsCredential(text, { includeLooseAssignments: true })) return "personal_or_secret";
  const compact = text.replace(/\s+/gu, "");
  for (const entry of BLOCKED_CATEGORIES) {
    if (entry.patterns.some((pattern) => pattern.test(text) || pattern.test(compact))) return entry.category;
  }
  return null;
}

export function inspectTelegramCodexCommand(message, ownerId) {
  const expectedOwner = String(ownerId ?? "");
  if (!/^[1-9][0-9]{5,19}$/.test(expectedOwner)) throw new Error("invalid_telegram_owner_id");

  const rawSource = commandSource(message);
  const trimmedSource = rawSource.trim();
  if (!/^\/codex(?:\s|$)/iu.test(trimmedSource)) {
    return frozen({ matched: false, allowed: false, route: null, reason: "not_codex_command" });
  }

  if (!message || typeof message !== "object" || Array.isArray(message)) return rejected("invalid_message");
  if (message.chat?.type !== "private") return rejected("non_private_chat");
  if (message.from?.is_bot === true || message.via_bot !== undefined || message.sender_chat !== undefined) {
    return rejected("bot_sender_not_allowed");
  }
  if (String(message.from?.id ?? "") !== expectedOwner) return rejected("unauthorized_sender");
  if (String(message.chat?.id ?? "") !== expectedOwner) return rejected("chat_identity_mismatch");
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(message.date) || message.date < nowSeconds - 300 || message.date > nowSeconds + 60) {
    return rejected("stale_or_invalid_message");
  }
  if (FORWARD_FIELDS.some((field) => message[field] !== undefined && message[field] !== false)) {
    return rejected("forwarded_message");
  }
  if (ATTACHMENT_FIELDS.some((field) => message[field] !== undefined)) return rejected("attachment_not_allowed");
  if (hasHiddenExternalEntity(message)) return rejected("hidden_external_entity");
  if (typeof message.text !== "string") return rejected("text_required");
  if (rawSource.length < 1 || rawSource.length > 4_000) return rejected("invalid_text_length");
  if (UNSAFE_DISPLAY_CHARACTERS.test(rawSource)) return rejected("unsafe_display_character");

  const text = rawSource.normalize("NFKC").trim();
  const match = /^\/codex(?:\s+([a-z]+))?(?:\s+([\s\S]*))?$/iu.exec(text);
  if (!match) return rejected("invalid_command_syntax", SYNTAX_RESPONSE);
  const command = (match[1] ?? "").toLowerCase();
  const argument = (match[2] ?? "").trim();

  if (command === "help" || command === "status") {
    if (argument) return rejected("unexpected_command_argument", SYNTAX_RESPONSE);
    return frozen({
      matched: true,
      allowed: true,
      route: "codex",
      reason: `codex_${command}`,
      command,
      task: null,
    });
  }

  if (command !== "inspect" && command !== "draft") {
    return rejected("unsupported_codex_command", SYNTAX_RESPONSE);
  }
  if (!argument || argument.length > 2_000) return rejected("invalid_codex_task_length", SYNTAX_RESPONSE);
  if (UNSAFE_DISPLAY_CHARACTERS.test(argument)) return rejected("unsafe_display_character");
  const category = blockedCategory(argument);
  if (category) return rejected("private_or_privileged_intent", OWNER_APP_APPROVAL_RESPONSE, { command, category });
  return rejected("owner_app_approval_required", OWNER_APP_APPROVAL_RESPONSE, { command });
}

export const inspectCodexCommand = inspectTelegramCodexCommand;

export const CODEX_COMMAND_POLICY = Object.freeze({
  commands: Object.freeze(["inspect", "draft", "status", "help"]),
  maxTaskLength: 2_000,
  ownerPrivateDmOnly: true,
  maximumMessageAgeSeconds: 300,
  attachmentsAllowed: false,
  forwardedMessagesAllowed: false,
  hiddenLinksAllowed: false,
  privilegedActionsAllowed: false,
  executionCommandsAllowed: false,
});
