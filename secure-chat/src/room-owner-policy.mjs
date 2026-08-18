/**
 * 아이폰에서 시킨 일은 맥이 한다.
 * 결제·문자·전화와 집 밖 유출은 주인이 허용하기 전에는 하지 않는다.
 * 공유기 밖(클라우드·텔레그램·외부 API)으로 개인정보·결제 정보를 보내지 않는다.
 */

export const ROOM_DENY_REPLY = "그건 아직 허용하지 않았습니다. 결제·문자·전화·집 밖 전송은 공유기를 넘기지 않고, 시켜도 하지 않습니다.";

export const ROOM_POLICY_REPLY = [
  "금지인 것만 안 합니다.",
  "결제·송금·구매 확정, 문자·전화, 개인정보·결제 정보를 공유기 밖·클라우드·텔레그램으로 보내는 것.",
  "질문은 승인 없이 바로 답합니다.",
  "집 일(방화벽·포트·계정·백업·감시 같은 실행)만 아이폰 Face ID 한 번 뒤에 맥이 합니다.",
].join(" ");

export function isPolicyQuestion(text) {
  const value = String(text ?? "");
  const about = /금지|할수있|할\s*수\s*있|안되는|안 되는|허용/iu.test(value);
  const asking = /[?？]|뭔지|뭐야|뭐가|얘기|말해|알려|있나|있어/iu.test(value);
  return about && asking;
}

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
