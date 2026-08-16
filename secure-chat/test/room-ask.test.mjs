import assert from "node:assert/strict";
import test from "node:test";

import { askRoomModel, askRoomModelTokens, buildRoomSystemPrompt, isRoomNoise, selectRoomContext } from "../src/room-ask.mjs";

test("방 시스템 프롬프트는 결제·전송을 혼자 하지 말라고 못 박는다", () => {
  const prompt = buildRoomSystemPrompt();
  assert.match(prompt, /결제/);
  assert.match(prompt, /보내지 않았고/);
  assert.match(prompt, /방금 한 말/);
  assert.match(prompt, /Cursor 창/);
  assert.doesNotMatch(prompt, /telegram/i);
});

test("끊긴 오타와 짧은 자모는 방 맥락에서 빼고 마지막 말은 남긴다", () => {
  assert.equal(isRoomNoise("ㅇ"), true);
  assert.equal(isRoomNoise("ㅇ아어어어ㅓㄹ"), true);
  const context = selectRoomContext([
    { role: "user", content: "키보드가 계속내려가노" },
    { role: "assistant", content: "어떤 기기인지 알려주세요" },
    { role: "user", content: "ㅇ아어어어ㅓㄹ" },
    { role: "assistant", content: "내용이 전달되지 않았습니다" },
    { role: "user", content: "미러링연결확인" },
  ]);
  assert.deepEqual(context.map((item) => item.content), [
    "키보드가 계속내려가노",
    "어떤 기기인지 알려주세요",
    "내용이 전달되지 않았습니다",
    "미러링연결확인",
  ]);
});

test("askRoomModel은 로컬 Ollama 응답 본문만 돌려준다", async () => {
  let body;
  const text = await askRoomModel(
    [{ role: "user", content: "안녕" }],
    {
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({ message: { content: " 집에 있다 " } }),
        };
      },
    },
  );
  assert.equal(text, "집에 있다");
  assert.equal(body.think, false);
  assert.equal(body.keep_alive, "10m");
  assert.equal(body.options.num_predict, 1_024);
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
