import assert from "node:assert/strict";
import test from "node:test";

import { askRoomModel, askRoomModelTokens, buildRoomSystemPrompt } from "../src/room-ask.mjs";

test("방 시스템 프롬프트는 결제·전송을 혼자 하지 말라고 못 박는다", () => {
  const prompt = buildRoomSystemPrompt();
  assert.match(prompt, /결제/);
  assert.match(prompt, /보내지 않았고/);
  assert.doesNotMatch(prompt, /telegram/i);
});

test("askRoomModel은 로컬 Ollama 응답 본문만 돌려준다", async () => {
  const text = await askRoomModel(
    [{ role: "user", content: "안녕" }],
    {
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ message: { content: " 집에 있다 " } }),
      }),
    },
  );
  assert.equal(text, "집에 있다");
});

test("토큰 스트림은 줄 단위 Ollama JSON만 이어 붙인다", async () => {
  const chunks = [
    '{"message":{"content":"안"}}\n',
    '{"message":{"content":"녕"}}\n',
  ];
  async function* body() {
    for (const chunk of chunks) yield Buffer.from(chunk);
  }
  const parts = [];
  for await (const part of askRoomModelTokens(
    [{ role: "user", content: "hi" }],
    {
      fetchImpl: async () => ({
        ok: true,
        body: body(),
      }),
    },
  )) {
    parts.push(part);
  }
  assert.deepEqual(parts, ["안", "녕"]);
});
