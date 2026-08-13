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

const ALWAYS_PRIVATE_PATTERNS = Object.freeze([
  /https?:\/\//iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[-. ]?\d{4}/u,
  /\b(?:\d[ -]*?){13,19}\b/u,
  /\b\d{6}[- ]?[1-4]\d{6}\b/u,
  /\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:password|passwd|secret|access[_ -]?token|refresh[_ -]?token|authorization|bearer)\s*[:=]/iu,
]);

// These patterns describe an actual private read or state-changing request.
// Domain nouns alone are intentionally allowed so the owner can ask how a
// capability works without the explanation itself being mistaken for an
// instruction to use that capability.
const PRIVATE_ACTION_PATTERNS = Object.freeze([
  /(?:쿠팡|coupang|장바구니).{0,80}(?:넣어|담아|추가해|빼줘|삭제해|주문해|구매해|결제해|반품해|환불해)/iu,
  /(?:주문|구매|결제|반품|환불)(?:해|해줘|해라|해주세요|처리해|진행해)/iu,
  /(?:메일|이메일|e-mail|gmail|지메일|받은편지|수신함).{0,80}(?:확인해|읽어|열어|요약해|보내|회신해|답장해|삭제해|보관해|표시해)/iu,
  /(?:로그인)(?:해|해줘|해라|해주세요|시켜)|(?:계정|비밀번호|패스워드|암호|인증번호|otp|2fa|토큰|api\s*key).{0,60}(?:보여|알려|찾아|입력해|변경해|재설정해|삭제해)/iu,
  /(?:주민등록번호?|주민번호|여권번호?|운전면허번호?|생년월일|집\s*주소|전화번호|휴대폰번호|복구\s*코드).{0,60}(?:보여|알려|찾아|확인해|저장해|보내)/iu,
  /(?:카드|계좌|은행|주식|증권|보험|세금|금융).{0,80}(?:확인해|조회해|보여|알려|송금해|이체해|결제해|변경해|등록해|삭제해)/iu,
  /(?:파일|폴더|문서|사진|앨범|카메라|마이크|화면|클립보드).{0,80}(?:열어|읽어|보여|찾아|복사해|옮겨|수정해|삭제해|만들어|다운로드해|업로드해|켜줘|꺼줘)/iu,
  /(?:home\s*assistant|홈\s*어시스턴트|아카라|aqara|matter|조명|도어락|현관|cctv|에어컨|보일러).{0,80}(?:켜|꺼|열어|닫아|잠가|해제해|변경해|설정해|실행해|작동해)/iu,
  /(?:카카오톡|카톡|telegram|텔레그램|문자|메시지).{0,80}(?:읽어|보여|찾아|보내|전송해|삭제해)/iu,
  /(?:연락처|캘린더|일정).{0,80}(?:읽어|보여|알려|찾아|등록해|추가해|변경해|삭제해)/iu,
  /(?:chrome|크롬|safari|사파리|브라우저|웹사이트|사이트|아이폰|iphone|컴퓨터|(?:^|\s)mac(?:\s|$)|(?:^|\s)맥(?:\s|$)).{0,80}(?:열어|접속해|들어가|클릭해|입력해|실행해|설치해|삭제해|재시작해|종료해|업데이트해|설정해|변경해|연결해)/iu,
  /(?:설치|삭제|재시작|종료|실행|업데이트|업그레이드|연결|해제|배포)(?:해|해줘|해라|해봐|해주세요|시켜|하자|해놔)/iu,
]);

const FORWARD_FIELDS = Object.freeze([
  "forward_origin",
  "forward_from",
  "forward_from_chat",
  "forward_date",
  "forward_sender_name",
  "is_automatic_forward",
]);

function hasHiddenExternalEntity(message) {
  const entities = [...(Array.isArray(message.entities) ? message.entities : []), ...(Array.isArray(message.caption_entities) ? message.caption_entities : [])];
  return entities.some((entity) => entity?.type === "text_link" || typeof entity?.url === "string");
}

function rejection(reason) {
  const response = reason === "attachment_not_allowed"
    ? "사진·파일 첨부는 Telegram 일반 대화 AI가 읽지 않습니다. 민감한 자료는 나의 Local AI 앱에서 확인해 주세요."
    : "이 요청은 개인정보 조회나 실제 서비스 작업에 해당합니다. 나의 Local AI 앱에서 지시해 주세요.";
  return Object.freeze({ allowed: false, reason, response });
}

export function inspectTelegramMessage(message, ownerId) {
  const expectedOwner = String(ownerId ?? "");
  if (!/^[1-9][0-9]{5,19}$/.test(expectedOwner)) throw new Error("invalid_telegram_owner_id");
  if (!message || typeof message !== "object" || Array.isArray(message)) return rejection("invalid_message");
  if (message.chat?.type !== "private") return rejection("non_private_chat");
  if (String(message.from?.id ?? "") !== expectedOwner) return rejection("unauthorized_sender");
  if (String(message.chat?.id ?? "") !== expectedOwner) return rejection("chat_identity_mismatch");
  if (FORWARD_FIELDS.some((field) => message[field] !== undefined && message[field] !== false)) {
    return rejection("forwarded_message");
  }
  if (ATTACHMENT_FIELDS.some((field) => message[field] !== undefined)) return rejection("attachment_not_allowed");
  if (hasHiddenExternalEntity(message)) return rejection("hidden_external_entity");
  if (typeof message.text !== "string") return rejection("text_required");
  const text = message.text.normalize("NFKC").trim();
  if (text.length < 1 || text.length > 4_000) return rejection("invalid_text_length");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return rejection("control_character_not_allowed");
  if (text === "/start") {
    return Object.freeze({
      allowed: false,
      reason: "start_command",
      response: "이 대화는 일반 질문 전용이며 Telegram 서버를 거칩니다. /status는 시스템 상태, /models는 실제 모델을 표시합니다. 비밀번호·인증번호·개인정보·메일·구매·파일·집 제어는 보내지 말고 나의 Local AI 앱에서 지시해 주세요.",
    });
  }
  if (text === "/clear") return Object.freeze({ allowed: false, reason: "clear_command", clearContext: true, response: "일반 대화의 임시 문맥을 지웠습니다." });
  if (text === "/status") return Object.freeze({ allowed: false, reason: "status_command", statusCommand: true });
  if (text === "/models") return Object.freeze({ allowed: false, reason: "models_command", modelsCommand: true });
  if (text === "/progress" || /^(?:현재\s*)?(?:구축\s*)?(?:진행\s*상황|진행률)(?:은|이|을)?(?:\s*(?:알려줘|보여줘|어때|뭐야|몇\s*퍼센트(?:야)?|어떻게\s*(?:돼|됐어|됐냐|된\s*거야)))?(?:,?\s*그러면)?[?.!]?$/u.test(text)) {
    return Object.freeze({ allowed: false, reason: "progress_command", progressCommand: true });
  }
  if (text.startsWith("/")) return rejection("command_not_allowed");
  if (
    containsCredential(text, { includeLooseAssignments: true }) ||
    ALWAYS_PRIVATE_PATTERNS.some((pattern) => pattern.test(text)) ||
    PRIVATE_ACTION_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return rejection("private_or_action_intent");
  }
  return Object.freeze({ allowed: true, reason: "ordinary_conversation", text });
}

export const TELEGRAM_GENERAL_POLICY = Object.freeze({
  maxTextLength: 4_000,
  attachmentsAllowed: false,
  forwardedMessagesAllowed: false,
  groupsAllowed: false,
  toolsAllowed: false,
  privateActionsAllowed: false,
});
