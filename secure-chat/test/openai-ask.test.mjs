import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENAI_ASK_PREFIX,
  OPENAI_CHAT_URL,
  OPENAI_LOCAL_MODEL,
  OPENAI_LOCAL_UNAVAILABLE,
  OPENAI_SYSTEM_PROMPT,
  askOpenAIFromMac,
  askOpenAITokens,
  assertLocalOpenAIUrl,
  buildOpenAIAskMessages,
  openaiAskStatus,
  parseOpenAIAsk,
  sanitizeOpenAIQuestion,
} from "../src/openai-ask.mjs";
import { lastUserText, planRoomTurn, roomTurnAnswer } from "../src/room-turn.mjs";

test("오픈에게라는 말만 있으면 맥이 오픈 경로로 보낸다", () => {
  assert.deepEqual(parseOpenAIAsk("오픈에게 물어봐 파이썬 정렬"), {
    target: "openai",
    question: "파이썬 정렬",
  });
  assert.equal(parseOpenAIAsk("안녕").target, "local");
  assert.equal(parseOpenAIAsk("그냥 질문", { ask: "openai" }).target, "openai");
  assert.equal(parseOpenAIAsk("오픈에게").question, "");
});

test("오픈에게 보내는 본문은 질문 한 줄뿐이고 방 기록은 없다", () => {
  const messages = buildOpenAIAskMessages("  오늘 비 와?  ");
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, OPENAI_SYSTEM_PROMPT);
  assert.equal(messages[1].content, "오늘 비 와?");
  assert.doesNotMatch(JSON.stringify(messages), /room|memory|telegram/i);
});

test("질문 속 비밀 모양은 지우고 보낸다", () => {
  const key = ["sk", "-", "proj-", "F".repeat(32)].join("");
  assert.match(sanitizeOpenAIQuestion(`키는 ${key} 이다`), /REDACTED_CREDENTIAL/);
});

test("상태에는 API 키가 없고 맥 루프백만 있다", () => {
  const status = openaiAskStatus();
  assert.equal(status.apiKey, false);
  assert.equal(status.via, OPENAI_CHAT_URL);
  assert.equal(status.model, OPENAI_LOCAL_MODEL);
  assert.equal(assertLocalOpenAIUrl(OPENAI_CHAT_URL), OPENAI_CHAT_URL);
  assert.throws(() => assertLocalOpenAIUrl("https://api.openai.com/v1/chat/completions"), /loopback/);
});

test("프록시 토큰이 없으면 바깥 네트워크를 열지 않는다", async () => {
  let called = 0;
  await assert.rejects(
    () => askOpenAIFromMac("날씨", {
      token: "",
      fetchImpl: async () => {
        called += 1;
        return { ok: true, json: async () => ({}) };
      },
    }),
    /openai_local_unavailable/,
  );
  assert.equal(called, 0);
});

test("맥 호출은 127.0.0.1:18790만 쓰고 답을 표시한다", async () => {
  const calls = [];
  const text = await askOpenAIFromMac("리스트 정렬", {
    token: "local-proxy",
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      assert.match(url, /^http:\/\/127\.0\.0\.1:18790\//u);
      assert.doesNotMatch(url, /openai\.com/u);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: " sorted() " } }] }),
      };
    },
  });
  assert.equal(calls[0].url, OPENAI_CHAT_URL);
  assert.equal(calls[0].body.model, OPENAI_LOCAL_MODEL);
  assert.equal(calls[0].body.messages.length, 2);
  assert.equal(calls[0].body.messages[1].content, "리스트 정렬");
  assert.equal(calls[0].body.stream, false);
  assert.equal(text, `${OPENAI_ASK_PREFIX}sorted()`);
});

test("스트림도 질문 한 줄만 맥 프록시로 보낸다", async () => {
  async function* body() {
    yield 'data: {"choices":[{"delta":{"content":"안녕"}}]}\n';
    yield "data: [DONE]\n";
  }
  const parts = [];
  for await (const part of askOpenAITokens("안녕이니", {
    token: "local-proxy",
    fetchImpl: async (url, init) => {
      assert.equal(url, OPENAI_CHAT_URL);
      assert.equal(JSON.parse(init.body).messages.length, 2);
      return { ok: true, body: body() };
    },
  })) {
    parts.push(part);
  }
  assert.deepEqual(parts, [OPENAI_ASK_PREFIX, "안녕"]);
});

test("방 턴은 오픈 경로에서 예전 말을 보내지 않는다", async () => {
  const room = [
    { role: "user", content: "내 비밀번호는 비밀이다" },
    { role: "assistant", content: "기억했다" },
    { role: "user", content: "오픈에게 물어봐 1+1" },
  ];
  assert.equal(lastUserText(room), "오픈에게 물어봐 1+1");
  assert.deepEqual(planRoomTurn(room), { target: "openai", question: "1+1" });
  const answer = await roomTurnAnswer(room, {
    token: "local-proxy",
    fetchImpl: async (url, init) => {
      assert.equal(url, OPENAI_CHAT_URL);
      const body = JSON.parse(init.body);
      assert.equal(body.messages.at(-1).content, "1+1");
      assert.doesNotMatch(JSON.stringify(body), /비밀번호|기억했다/);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: "2" } }] }),
        body: (async function* () {
          yield 'data: {"choices":[{"delta":{"content":"2"}}]}\n';
          yield "data: [DONE]\n";
        })(),
      };
    },
  });
  assert.equal(answer, `${OPENAI_ASK_PREFIX}2`);
});

test("프록시가 없으면 안내만 하고 로컬 모델도 안 부른다", async () => {
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "오픈에게 물어봐 안녕" }],
    {
      token: "",
      fetchImpl: async () => {
        throw new Error("should_not_fetch");
      },
    },
  );
  assert.equal(answer, OPENAI_LOCAL_UNAVAILABLE);
});
