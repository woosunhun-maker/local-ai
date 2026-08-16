import assert from "node:assert/strict";
import test from "node:test";
import { inspectOwnerAppImage, readOwnerAppPhoto } from "../src/vision/app-photo-read.mjs";
import { inspectTelegramMessage } from "../src/telegram/policy.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(64, 1)]).toString("base64");

test("owner app image accepts jpeg and rejects junk", () => {
  const ok = inspectOwnerAppImage(JPEG);
  assert.equal(ok.ext, "jpg");
  assert.throws(() => inspectOwnerAppImage("not-image"), /invalid_app_image|unsupported_app_image/);
});

test("owner app OCR uses injected runner and never needs telegram", async () => {
  const text = await readOwnerAppPhoto(JPEG, {
    runner: async () => "OpenClaw: access not configured\nWD6QTSZJ",
  });
  assert.match(text, /OpenClaw/);
});

test("telegram still rejects photos", () => {
  const result = inspectTelegramMessage({
    from: { id: 1234567 },
    chat: { id: 1234567, type: "private" },
    text: "봐봐",
    photo: [{ file_id: "x" }],
  }, "1234567");
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "attachment_not_allowed");
});
