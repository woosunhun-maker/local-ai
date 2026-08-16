/**
 * 아이폰에서 시킨 일은 맥이 한다.
 * 결제·문자·전화와 집 밖 유출은 주인이 허용하기 전에는 하지 않는다.
 * 공유기 밖(클라우드·텔레그램·외부 API)으로 개인정보·결제 정보를 보내지 않는다.
 */

export const ROOM_DENY_REPLY = "그건 아직 허용하지 않았습니다. 결제·문자·전화·집 밖 전송은 공유기를 넘기지 않고, 시켜도 하지 않습니다.";

const DENIED = Object.freeze([
  Object.freeze({
    reason: "payment",
    pattern: /(?:결제|송금|이체)(?:해|해줘|해라|해주세요|시켜|진행해)|(?:구매해|주문해|돈\s*보내|이체해|송금해|checkout|purchase)/iu,
  }),
  Object.freeze({
    reason: "message",
    pattern: /(?:문자|sms|메시지).{0,20}(?:보내|전송|발송)|(?:전화|통화).{0,12}(?:걸어|걸어줘|걸어라|해줘|해라|연결)/iu,
  }),
  Object.freeze({
    reason: "leak",
    pattern: /(?:클라우드|텔레그램|telegram|카톡|카카오톡|외부|집\s*밖|인터넷으로).{0,24}(?:보내|전송|올려|공유|유출)|(?:개인정보|주민|계좌|카드번호|비밀번호).{0,24}(?:보내|전송|올려|공유)/iu,
  }),
]);

export function inspectRoomOwnerCommand(text) {
  const value = String(text ?? "").trim();
  for (const item of DENIED) {
    if (item.pattern.test(value)) {
      return Object.freeze({
        allow: false,
        mode: "deny",
        reason: item.reason,
        reply: ROOM_DENY_REPLY,
      });
    }
  }
  return Object.freeze({ allow: true, mode: "allow", reason: "owner_allowed", reply: "" });
}
