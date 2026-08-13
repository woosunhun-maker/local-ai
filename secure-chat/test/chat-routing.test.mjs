import assert from "node:assert/strict";
import test from "node:test";
import { assertChatModeAccess, resolveChatMode, trimChatContext } from "../src/chat-routing.mjs";

test("automatic mode keeps ordinary conversation fast", () => {
  assert.equal(resolveChatMode("auto", [{ role: "user", content: "오늘 기분 어때?" }]), "fast");
});

test("automatic mode never auto-escalates to deep anymore", () => {
  assert.equal(resolveChatMode("auto", [{ role: "user", content: "홈어시스턴트 조명 꺼줘" }]), "fast");
  assert.equal(resolveChatMode("auto", [{ role: "user", content: "이 오류 로그 점검해봐" }]), "fast");
});

test("explicit mode always wins", () => {
  assert.equal(resolveChatMode("fast", [{ role: "user", content: "서버를 재시작해줘" }]), "fast");
  assert.equal(resolveChatMode("deep", [{ role: "user", content: "안녕" }]), "deep");
});

test("only the owner app can reach the privileged deep-task path", () => {
  assert.equal(assertChatModeAccess("deep", { role: "owner" }), true);
  assert.equal(assertChatModeAccess("fast", { role: "member" }), true);
  assert.throws(
    () => assertChatModeAccess("deep", { role: "member" }),
    (error) => error?.statusCode === 403 && /owner_device/.test(error.message),
  );
});

test("fast context is bounded and preserves newest messages", () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `${index}:` + "가".repeat(1_500) }));
  const trimmed = trimChatContext(messages, "fast");
  assert.ok(trimmed.length <= 16);
  assert.ok(trimmed.reduce((sum, message) => sum + message.content.length, 0) <= 12_000);
  assert.match(trimmed.at(-1).content, /^29:/);
});
