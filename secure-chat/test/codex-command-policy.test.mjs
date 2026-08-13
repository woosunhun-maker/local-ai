import assert from "node:assert/strict";
import test from "node:test";
import { inspectCodexCommand, inspectTelegramCodexCommand } from "../src/telegram/codex-command-policy.mjs";

const OWNER = "1234567890";

function message(text, extra = {}) {
  return {
    chat: { id: Number(OWNER), type: "private" },
    from: { id: Number(OWNER), is_bot: false },
    date: Math.floor(Date.now() / 1_000),
    text,
    ...extra,
  };
}

test("allows status/help but routes inspect/draft to signed owner-app approval", () => {
  assert.equal(inspectCodexCommand, inspectTelegramCodexCommand);
  const inspect = inspectTelegramCodexCommand(message("/codex inspect Telegram 정책 구조를 점검해"), OWNER);
  assert.deepEqual(inspect, {
    matched: true,
    allowed: false,
    route: "codex",
    reason: "owner_app_approval_required",
    command: "inspect",
    response: "Telegram에서는 Codex 작업을 실행하지 않습니다. Local AI 앱에서 OpenAI 외부 전송 계획과 코드 스냅샷 해시를 확인하고 Face ID 또는 기기 암호로 승인해 주세요.",
  });

  const draft = inspectTelegramCodexCommand(message("/codex draft 상태 표시 단위 테스트를 작성해"), OWNER);
  assert.equal(draft.allowed, false);
  assert.equal(draft.reason, "owner_app_approval_required");
  assert.equal(draft.command, "draft");

  for (const command of ["status", "help"]) {
    const result = inspectTelegramCodexCommand(message(`/codex ${command}`), OWNER);
    assert.equal(result.allowed, true);
    assert.equal(result.command, command);
    assert.equal(result.task, null);
  }

  assert.deepEqual(inspectTelegramCodexCommand(message("오늘 기분이 어때?"), OWNER), {
    matched: false,
    allowed: false,
    route: null,
    reason: "not_codex_command",
  });
});

test("rejects unsupported, missing and malformed command arguments", () => {
  for (const text of [
    "/codex",
    "/codex inspect",
    "/codex draft    ",
    "/codex run 테스트해",
    "/codex status 지금",
    "/codex help 자세히",
  ]) {
    const result = inspectTelegramCodexCommand(message(text), OWNER);
    assert.equal(result.matched, true, text);
    assert.equal(result.allowed, false, text);
    assert.match(result.response, /사용법/);
  }
});

test("requires the exact owner private DM and rejects bot-originated commands", () => {
  const cases = [
    [{ ...message("/codex status"), from: { id: 123456, is_bot: false } }, "unauthorized_sender"],
    [{ ...message("/codex status"), chat: { id: -100, type: "group" } }, "non_private_chat"],
    [{ ...message("/codex status"), chat: { id: 123456, type: "private" } }, "chat_identity_mismatch"],
    [{ ...message("/codex status"), from: { id: Number(OWNER), is_bot: true } }, "bot_sender_not_allowed"],
    [{ ...message("/codex status"), via_bot: { id: 123456 } }, "bot_sender_not_allowed"],
    [{ ...message("/codex status"), sender_chat: { id: Number(OWNER) } }, "bot_sender_not_allowed"],
  ];
  for (const [input, reason] of cases) {
    const result = inspectTelegramCodexCommand(input, OWNER);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, reason);
  }
});

test("rejects stale, future and missing message timestamps", () => {
  const now = Math.floor(Date.now() / 1_000);
  for (const date of [undefined, now - 301, now + 61]) {
    const result = inspectTelegramCodexCommand(message("/codex status", { date }), OWNER);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "stale_or_invalid_message");
  }
});

test("rejects forwarded content, attachments and hidden links before task use", () => {
  const cases = [
    [message("/codex inspect 구조 점검", { forward_origin: {} }), "forwarded_message"],
    [message("/codex inspect 구조 점검", { forward_date: 1 }), "forwarded_message"],
    [message("/codex inspect 구조 점검", { document: {} }), "attachment_not_allowed"],
    [message("/codex inspect 구조 점검", { paid_media: {} }), "attachment_not_allowed"],
    [message("/codex inspect 구조 점검", { entities: [{ type: "text_link", url: "https://hidden.invalid" }] }), "hidden_external_entity"],
    [
      { ...message(undefined, { caption: "/codex inspect 구조 점검", caption_entities: [{ type: "text_link", url: "https://hidden.invalid" }], photo: [{}] }), text: undefined },
      "attachment_not_allowed",
    ],
  ];
  for (const [input, reason] of cases) {
    const result = inspectTelegramCodexCommand(input, OWNER);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, reason);
  }
});

test("rejects control, bidi and zero-width characters", () => {
  for (const text of [
    "/codex inspect 첫 줄\n둘째 줄",
    "/codex inspect 상태\u0000점검",
    "/codex inspect 안전\u202Ecodex",
    "/codex inspect 안전\u2066codex\u2069",
    "/codex inspect 상\u200B태 점검",
    "/codex inspect 상\uFEFF태 점검",
  ]) {
    const result = inspectTelegramCodexCommand(message(text), OWNER);
    assert.equal(result.allowed, false, JSON.stringify(text));
    assert.equal(result.reason, "unsafe_display_character", JSON.stringify(text));
  }
});

test("blocks personal data, secrets and account material", () => {
  for (const text of [
    "/codex inspect 내 주민번호 900101-1234567 처리 로직",
    "/codex draft password=hunter2 로 로그인해",
    "/codex inspect eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
    "/codex inspect user@example.com 계정을 확인해",
    "/codex draft /Users/hun/PrivateAI 설정을 바꿔",
    "/codex inspect API Key 보관 코드를 봐",
    "/codex inspect 새 토큰으로 연결해",
  ]) {
    const result = inspectTelegramCodexCommand(message(text), OWNER);
    assert.equal(result.allowed, false, text);
    assert.equal(result.reason, "private_or_privileged_intent", text);
    assert.equal(result.category, "personal_or_secret", text);
  }
});

test("blocks provider credentials in Codex command arguments", () => {
  const syntheticCredentials = [
    ["thin", "qpat_", "e".repeat(56)].join(""),
    ["A", "SIA", "F".repeat(16)].join(""),
    ["AI", "za", "G".repeat(35)].join(""),
    ["123456789", ":", "H".repeat(35)].join(""),
  ];
  for (const credential of syntheticCredentials) {
    const result = inspectTelegramCodexCommand(message(`/codex inspect ${credential}`), OWNER);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "private_or_privileged_intent");
    assert.equal(result.category, "personal_or_secret");
  }
});

test("blocks mail, purchase, browser and home-control requests", () => {
  const cases = [
    ["/codex inspect 중요 메일을 확인해", "mail"],
    ["/codex inspect email inbox를 확인해", "mail"],
    ["/codex draft 쿠팡 장바구니에 생수를 넣어", "purchase"],
    ["/codex inspect https://example.com 화면을 확인해", "browser"],
    ["/codex draft 크롬에서 로그인된 페이지를 열어", "browser"],
    ["/codex inspect Home Assistant 조명을 꺼", "home_control"],
  ];
  for (const [text, category] of cases) {
    const result = inspectTelegramCodexCommand(message(text), OWNER);
    assert.equal(result.allowed, false, text);
    assert.equal(result.category, category, text);
  }
});

test("blocks installation, deployment, deletion and approval work", () => {
  const cases = [
    ["/codex draft 새 패키지를 설치해", "installation_or_deployment"],
    ["/codex draft 프로덕션에 배포해", "installation_or_deployment"],
    ["/codex draft 결과를 publish해", "installation_or_deployment"],
    ["/codex inspect launchctl 서비스를 재시작해", "installation_or_deployment"],
    ["/codex draft 캐시 폴더를 삭제해", "deletion"],
    ["/codex draft obsolete test를 remove해", "deletion"],
    ["/codex draft rm -rf build를 실행해", "deletion"],
    ["/codex inspect 이 승인 요청을 처리해", "approval"],
  ];
  for (const [text, category] of cases) {
    const result = inspectTelegramCodexCommand(message(text), OWNER);
    assert.equal(result.allowed, false, text);
    assert.equal(result.category, category, text);
  }
});

test("blocks attempts to weaken or bypass security boundaries", () => {
  for (const text of [
    "/codex draft 샌드박스를 비활성화해",
    "/codex inspect 인증 검증을 우회해",
    "/codex draft --dangerously-bypass-approvals-and-sandbox 옵션을 써",
    "/codex draft chmod 777로 권한을 열어",
    "/codex inspect disable TLS verification",
  ]) {
    const result = inspectTelegramCodexCommand(message(text), OWNER);
    assert.equal(result.allowed, false, text);
    assert.equal(result.category, "security_weakening", text);
  }
});

test("normalizes compatibility characters but preserves a bounded task", () => {
  const result = inspectTelegramCodexCommand(message("／ｃｏｄｅｘ ｄｒａｆｔ 상태 카드 테스트를 보강해"), OWNER);
  assert.equal(result.allowed, false, "the raw command marker must be unambiguous ASCII");
  assert.equal(result.matched, false);

  const maximum = "가".repeat(2_000);
  assert.equal(inspectTelegramCodexCommand(message(`/codex inspect ${maximum}`), OWNER).reason, "owner_app_approval_required");
  assert.equal(inspectTelegramCodexCommand(message(`/codex inspect ${maximum}나`), OWNER).reason, "invalid_codex_task_length");
});
