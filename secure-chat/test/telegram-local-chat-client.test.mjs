import assert from "node:assert/strict";
import test from "node:test";
import {
  askLocalModel,
  buildSystemPrompt,
  currentSeoulDate,
  LOCAL_OLLAMA_CHAT_URL,
  TELEGRAM_LOCAL_MODEL,
} from "../src/telegram/local-chat-client.mjs";

test("Telegram receives the current Seoul date without pretending its training data is live", () => {
  const now = new Date("2026-08-05T15:01:02.000Z");
  assert.equal(currentSeoulDate(now), "2026-08-06");
  const prompt = buildSystemPrompt(now);
  assert.match(prompt, /2026-08-06/u);
  assert.match(prompt, /학습지식/u);
  assert.match(prompt, /공개 웹 검색이 연결되지 않았/u);
  assert.match(prompt, /대명사나 생략 표현/u);
  assert.match(prompt, /qwen3\.6:35b/u);
  assert.match(prompt, /3~8개의 짧은 줄/u);
  assert.throws(() => currentSeoulDate(new Date("invalid")), /invalid_local_clock/u);
});

test("Telegram chat calls only the fixed loopback Ollama endpoint with no tool surface", async () => {
  const calls = [];
  const answer = await askLocalModel([{ role: "user", content: "안녕" }], {
    now: new Date("2026-08-05T15:01:02.000Z"),
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ message: { content: "반가워요" } }) };
    },
  });
  assert.equal(answer, "반가워요");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LOCAL_OLLAMA_CHAT_URL);
  assert.equal(new URL(calls[0].url).hostname, "127.0.0.1");
  assert.equal(calls[0].body.model, TELEGRAM_LOCAL_MODEL);
  assert.equal(calls[0].body.messages[0].role, "system");
  assert.match(calls[0].body.messages[0].content, /2026-08-06/u);
  assert.equal(calls[0].body.messages.at(-1).content, "안녕");
  for (const forbidden of ["tools", "tool_choice", "functions", "response_format"]) {
    assert.equal(Object.hasOwn(calls[0].body, forbidden), false, forbidden);
  }
});

test("non-loopback endpoints and unapproved model overrides fail before fetch", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error("unexpected"); };
  await assert.rejects(
    askLocalModel([{ role: "user", content: "안녕" }], { fetchImpl, url: "https://example.com/v1/chat" }),
    /non_local_model_endpoint_rejected/,
  );
  await assert.rejects(
    askLocalModel([{ role: "user", content: "안녕" }], { fetchImpl, model: "openai/gpt" }),
    /unapproved_local_model_rejected/,
  );
  assert.equal(calls, 0);
});

test("transport exceptions are replaced with a content-free local error", async () => {
  const privateText = "PRIVATE-MESSAGE-SHOULD-NOT-ESCAPE";
  await assert.rejects(
    askLocalModel([{ role: "user", content: privateText }], {
      fetchImpl: async () => { throw new Error(`failed body=${privateText}`); },
    }),
    (error) => error.message === "local_model_unavailable" && !error.message.includes(privateText),
  );
});
