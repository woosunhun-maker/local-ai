import assert from "node:assert/strict";
import test from "node:test";
import { FixedWindowRateLimiter, ratePolicyFor } from "../src/rate-limiter.mjs";

test("chat, approval decisions, TTS, and reads use independent rate buckets", () => {
  const policies = [
    ratePolicyFor("POST", "/api/chat"),
    ratePolicyFor("POST", "/api/approvals/SYNTHETICREQUEST1/decision"),
    ratePolicyFor("POST", "/api/codex/approvals/SYNTHETICREQUEST1/decision"),
    ratePolicyFor("POST", "/api/codex/approval-key"),
    ratePolicyFor("POST", "/api/tts/stream"),
    ratePolicyFor("GET", "/api/growth/status"),
  ];
  assert.deepEqual(policies.map((entry) => entry.bucket), ["chat", "decision", "decision", "decision", "tts", "read"]);
  assert.equal(new Set(policies.map((entry) => entry.bucket)).size, 4);
});

test("a full chat bucket does not consume TTS or read capacity", () => {
  const clock = { value: 1_000 };
  const limiter = new FixedWindowRateLimiter({ now: () => clock.value });
  const chat = ratePolicyFor("POST", "/api/chat");
  const tts = ratePolicyFor("POST", "/api/tts/stream");
  const read = ratePolicyFor("GET", "/api/status");
  for (let index = 0; index < chat.limit; index += 1) assert.equal(limiter.allow("device", chat), true);
  assert.equal(limiter.allow("device", chat), false);
  assert.equal(limiter.allow("device", tts), true);
  assert.equal(limiter.allow("device", read), true);
  clock.value += 60_000;
  assert.equal(limiter.allow("device", chat), true);
});
