import assert from "node:assert/strict";
import test from "node:test";
import { notifyOwnerOfGrowthApproval } from "../src/growth/owner-notification.mjs";

test("growth notification contains no frozen payload or personal content and opens the signed approval UI", async () => {
  let captured;
  await notifyOwnerOfGrowthApproval({
    tokenReader: async () => "synthetic-home-assistant-token",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true };
    },
  });
  const body = JSON.parse(captured.options.body);
  assert.equal(body.data.url, "localai://growth");
  assert.match(body.message, /정확한 내용/);
  assert.ok(!/payload|sha-?256|conversation|대화 내용|메모리/i.test(captured.options.body));
  assert.match(captured.options.headers.Authorization, /^Bearer synthetic-/);
});
