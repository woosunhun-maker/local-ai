import assert from "node:assert/strict";
import test from "node:test";
import { isBlockedWebTaskAction, validateWebTask } from "../src/web-task-policy.mjs";

test("only the owner app ingress can create an authenticated web task", () => {
  assert.throws(() => validateWebTask({
    ingress: "telegram",
    action: "mail.important.list",
    parameters: { provider: "gmail", maxResults: 5, unreadOnly: true },
  }), /local_owner_app_required/);
});

test("important mail is a local-app-only read plan without a second approval", () => {
  const plan = validateWebTask({
    ingress: "local_owner_app",
    action: "mail.important.list",
    parameters: { provider: "gmail", maxResults: 5, unreadOnly: true },
  });
  assert.equal(plan.risk, "private_read");
  assert.equal(plan.requiresApproval, false);
  assert.equal(plan.restrictions.returnChannel, "local_owner_app_only");
  assert.equal(plan.restrictions.rawBrowserToolsExposedToModel, false);
  assert.match(plan.sha256, /^[a-f0-9]{64}$/);
});

test("adding to a Coupang cart requires an exact price-bound approval plan", () => {
  const plan = validateWebTask({
    ingress: "local_owner_app",
    action: "coupang.cart.add",
    parameters: {
      productUrl: "https://m.coupang.com/vp/products/123?itemId=456&vendorItemId=789",
      productName: "생수 2L 6개",
      option: "2L × 6",
      quantity: 1,
      expectedUnitPrice: 7000,
      maxTotalPrice: 7500,
      currency: "KRW",
    },
  });
  assert.equal(plan.requiresApproval, true);
  assert.equal(plan.risk, "authenticated_account_mutation");
  assert.equal(plan.parameters.productUrl, "https://www.coupang.com/vp/products/123?itemId=456&vendorItemId=789");
  assert.equal(plan.parameters.maxTotalPrice, 7500);
});

test("checkout, payment, mail mutation, arbitrary URLs and unknown parameters fail closed", () => {
  for (const action of ["coupang.checkout", "coupang.purchase", "payment.submit", "mail.send", "mail.delete", "browser.evaluate"]) {
    assert.equal(isBlockedWebTaskAction(action), true);
    assert.throws(() => validateWebTask({ ingress: "local_owner_app", action, parameters: {} }), /web_task_action_blocked/);
  }
  assert.throws(() => validateWebTask({
    ingress: "local_owner_app",
    action: "coupang.cart.add",
    parameters: {
      productUrl: "https://evil.example/vp/products/123",
      productName: "상품",
      option: null,
      quantity: 1,
      expectedUnitPrice: 1000,
      maxTotalPrice: 1000,
      currency: "KRW",
    },
  }), /invalid_coupang_product_url/);
  assert.throws(() => validateWebTask({
    ingress: "local_owner_app",
    action: "coupang.search",
    parameters: { query: "생수", password: "never" },
  }), /unknown_web_task_parameter/);
});

test("credential-shaped values never become public shopping text", () => {
  const lgPat = ["thinq", "pat_", "A".repeat(48)].join("");
  assert.throws(() => validateWebTask({
    ingress: "local_owner_app",
    action: "coupang.search",
    parameters: { query: `공기청정기 ${lgPat}` },
  }), /credential_in_web_task/);
  assert.throws(() => validateWebTask({
    ingress: "local_owner_app",
    action: "coupang.cart.add",
    parameters: {
      productUrl: "https://www.coupang.com/vp/products/123",
      productName: `token=${"Z".repeat(32)}`,
      option: null,
      quantity: 1,
      expectedUnitPrice: 1000,
      maxTotalPrice: 1000,
      currency: "KRW",
    },
  }), /credential_in_web_task/);
});
