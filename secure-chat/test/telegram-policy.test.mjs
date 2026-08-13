import assert from "node:assert/strict";
import test from "node:test";
import { inspectTelegramMessage } from "../src/telegram/policy.mjs";

const OWNER = "100000001";

function message(text, extra = {}) {
  return { chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER) }, text, ...extra };
}

test("ordinary conversation is accepted", () => {
  const result = inspectTelegramMessage(message("오늘 기분이 좀 답답한데 이야기하자"), OWNER);
  assert.equal(result.allowed, true);
  assert.equal(result.text, "오늘 기분이 좀 답답한데 이야기하자");
});

test("capability explanations and Korean words containing 맥 are not mistaken for privileged actions", () => {
  for (const text of [
    "구체적 사용법과 언어 모델 말고 실제 실행하는 모델은 어떤 것들이 있는지 설명해줘",
    "텔레그램에서 어떤 기능과 모델을 쓰는지 알려줘",
    "쿠팡 장바구니 자동화는 어떤 승인 구조인지 설명해줘",
    "파일 삭제 기능의 보안 설계를 설명해줘",
    "대화맥락을 못 이어가는구나",
    "실행 모델과 언어 모델의 차이가 뭐야?",
  ]) {
    const result = inspectTelegramMessage(message(text), OWNER);
    assert.equal(result.allowed, true, text);
  }
});

test("owner can request deterministic local status without reaching the model", () => {
  const result = inspectTelegramMessage(message("/status"), OWNER);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "status_command");
  assert.equal(result.statusCommand, true);
});

test("owner can request deterministic installed model inventory", () => {
  const result = inspectTelegramMessage(message("/models"), OWNER);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "models_command");
  assert.equal(result.modelsCommand, true);
});

test("owner can request deterministic evidence-gated project progress", () => {
  for (const text of ["/progress", "진행 상황", "현재 구축 진행률 알려줘", "현재 진행 상황 어떻게 된 거야, 그러면?"]) {
    const result = inspectTelegramMessage(message(text), OWNER);
    assert.equal(result.allowed, false, text);
    assert.equal(result.reason, "progress_command", text);
    assert.equal(result.progressCommand, true, text);
  }
});

test("shopping, email and authenticated browser actions are redirected to the local app", () => {
  for (const text of [
    "쿠팡 장바구니에 생수 넣어놔",
    "중요 메일 확인해",
    "크롬에 로그인해 둔 사이트에서 주문해",
    "Home Assistant로 조명 꺼",
    "내 파일을 삭제해줘",
    "맥 재시작해줘",
    "텔레그램으로 메시지 보내줘",
    "내 계좌 잔액 알려줘",
  ]) {
    const result = inspectTelegramMessage(message(text), OWNER);
    assert.equal(result.allowed, false, text);
    assert.equal(result.reason, "private_or_action_intent");
    assert.match(result.response, /Local AI 앱/);
  }
});

test("other users, groups, forwarded messages, attachments and secrets are blocked before model use", () => {
  assert.equal(inspectTelegramMessage({ ...message("안녕"), from: { id: 1 } }, OWNER).reason, "unauthorized_sender");
  assert.equal(inspectTelegramMessage({ ...message("안녕"), chat: { id: -1, type: "group" } }, OWNER).reason, "non_private_chat");
  assert.equal(inspectTelegramMessage({ ...message("안녕"), chat: { id: 123456, type: "private" } }, OWNER).reason, "chat_identity_mismatch");
  assert.equal(inspectTelegramMessage(message("봐줘", { forward_origin: {} }), OWNER).reason, "forwarded_message");
  assert.equal(inspectTelegramMessage(message("봐줘", { forward_date: 1 }), OWNER).reason, "forwarded_message");
  assert.equal(inspectTelegramMessage(message("봐줘", { document: {} }), OWNER).reason, "attachment_not_allowed");
  assert.match(inspectTelegramMessage(message("봐줘", { photo: [{}] }), OWNER).response, /사진·파일 첨부/);
  assert.equal(inspectTelegramMessage(message("봐줘", { paid_media: {} }), OWNER).reason, "attachment_not_allowed");
  assert.equal(inspectTelegramMessage(message("이것 좀 설명해", { entities: [{ type: "text_link", url: "https://private.invalid" }] }), OWNER).reason, "hidden_external_entity");
  assert.equal(inspectTelegramMessage(message("https://example.com 확인해"), OWNER).reason, "private_or_action_intent");
  assert.equal(inspectTelegramMessage(message("password=hunter2"), OWNER).reason, "private_or_action_intent");
  assert.equal(inspectTelegramMessage(message("내 주민번호는 900101-1234567"), OWNER).reason, "private_or_action_intent");
  assert.equal(inspectTelegramMessage(message("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue"), OWNER).reason, "private_or_action_intent");
});

test("provider credentials are blocked before ordinary Telegram model routing", () => {
  const syntheticCredentials = [
    ["thin", "qpat_", "a".repeat(56)].join(""),
    ["A", "KIA", "B".repeat(16)].join(""),
    ["AI", "za", "C".repeat(35)].join(""),
    ["123456789", ":", "D".repeat(35)].join(""),
  ];
  for (const credential of syntheticCredentials) {
    const result = inspectTelegramMessage(message(`이 값을 설명해 ${credential}`), OWNER);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "private_or_action_intent");
  }
});
