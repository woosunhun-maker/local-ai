import assert from "node:assert/strict";
import test from "node:test";
import { telegramClient } from "../src/telegram/telegram-client.mjs";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";

test("Telegram transport never propagates a token-bearing fetch error", async () => {
  const client = telegramClient(TOKEN, {
    fetchImpl: async (url) => { throw new Error(`network failure at ${url}`); },
  });
  await assert.rejects(
    client.verify(),
    (error) => error.message === "telegram_transport_error" && !error.message.includes(TOKEN),
  );
});

test("Telegram update and response payloads stay bounded and contain no local tool metadata", async () => {
  const calls = [];
  const client = telegramClient(TOKEN, {
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => ({ ok: true, result: [] }) };
    },
  });
  await client.getUpdates(7);
  await client.sendText(100000001, "안녕");
  assert.deepEqual(calls[0].body.allowed_updates, ["message"]);
  assert.equal(calls[0].body.offset, 7);
  assert.deepEqual(calls[1].body, {
    chat_id: 100000001,
    text: "안녕",
    disable_web_page_preview: true,
    protect_content: true,
  });
  assert.equal(JSON.stringify(calls.map((entry) => entry.body)).includes(TOKEN), false);
});

test("invalid offsets and outbound messages fail without a network call", async () => {
  let calls = 0;
  const client = telegramClient(TOKEN, { fetchImpl: async () => { calls += 1; } });
  assert.throws(() => client.getUpdates(-1), /telegram_offset_invalid/);
  assert.throws(() => client.sendText("bad", "hello"), /telegram_outbound_invalid/);
  assert.throws(() => client.sendText(100000001, ""), /telegram_outbound_invalid/);
  assert.equal(calls, 0);
});
