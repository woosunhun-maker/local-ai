import assert from "node:assert/strict";
import test from "node:test";
import { EphemeralTelegramContext } from "../src/telegram/ephemeral-context.mjs";

test("Telegram context exists only in memory and expires at the configured TTL", () => {
  let now = 1_000_000;
  const context = new EphemeralTelegramContext({ now: () => now, ttlMs: 60_000 });
  context.append("owner", "user", "첫 질문");
  context.append("owner", "assistant", "첫 답변");
  assert.equal(context.get("owner").length, 2);
  now += 60_000;
  assert.deepEqual(context.get("owner"), []);
  assert.equal(context.entries.size, 0);
});

test("returned message objects cannot mutate retained context", () => {
  const context = new EphemeralTelegramContext();
  context.append("owner", "user", "원본");
  const copy = context.get("owner");
  copy[0].content = "변조";
  assert.equal(context.get("owner")[0].content, "원본");
});
