import assert from "node:assert/strict";
import test from "node:test";

import {
  APPROVAL_PREVIEW_SCHEMA,
  approvalPresentationForWebTask,
  compileApprovalPreview,
} from "../src/trust/approval-preview.mjs";

function cartTask(overrides = {}) {
  return {
    ingress: "local_owner_app",
    action: "coupang.cart.add",
    parameters: {
      productUrl: "https://www.coupang.com/vp/products/12345?itemId=67890",
      productName: "테스트 생수 2L 6개",
      option: null,
      quantity: 1,
      expectedUnitPrice: 40_000,
      maxTotalPrice: 50_000,
      currency: "KRW",
      ...overrides,
    },
  };
}

test("cart approval preview is deterministically derived from the normalized plan", () => {
  const compiled = compileApprovalPreview(cartTask());
  assert.equal(compiled.preview.schema, APPROVAL_PREVIEW_SCHEMA);
  assert.equal(compiled.preview.facts.option, "선택 없음");
  assert.equal(compiled.preview.facts.quantity, 1);
  assert.equal(compiled.preview.facts.maximum_total_price, 50_000);
  assert.deepEqual(compiled.preview.restrictions, {
    adds_to_cart_only: true,
    checkout: false,
    payment: false,
    order_submission: false,
  });
  assert.match(compiled.preview.presentation.consequences, /결제와 주문은 실행하지 않습니다/u);
  assert.match(compiled.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(approvalPresentationForWebTask(cartTask()), compiled.preview.presentation);
});

test("every material product, option, quantity, and price change produces a new preview digest", () => {
  const original = compileApprovalPreview(cartTask()).sha256;
  const changes = [
    { productName: "다른 생수" },
    { option: "12개 묶음" },
    { quantity: 2, maxTotalPrice: 100_000 },
    { expectedUnitPrice: 41_000 },
    { maxTotalPrice: 55_000 },
  ];
  for (const change of changes) assert.notEqual(compileApprovalPreview(cartTask(change)).sha256, original);
});

test("read-only work and unsupported approval actions cannot obtain a preview", () => {
  assert.throws(() => compileApprovalPreview({
    ingress: "local_owner_app",
    action: "mail.important.list",
    parameters: { provider: "gmail", maxResults: 5, unreadOnly: true },
  }), /approval_preview_not_required/u);
  assert.throws(() => compileApprovalPreview({
    ingress: "local_owner_app",
    action: "coupang.purchase",
    parameters: {},
  }), /invalid_web_task_for_approval_preview/u);
});
