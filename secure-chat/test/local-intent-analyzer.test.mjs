import assert from "node:assert/strict";
import test from "node:test";

import { canonicalSha256 } from "../src/growth/canonical.mjs";
import {
  analyzeLocalIntent,
  LOCAL_INTENT_ENDPOINT,
} from "../src/trust/local-intent-analyzer.mjs";

const MODEL_OUTPUT = {
  objective: {
    kind: "coupang.cart.add",
    summary: "생수 장바구니 추가 후보를 준비한다.",
    effect_class: "reversible_write",
  },
  confidence_bps: 8_400,
  slots: [
    { key: "product_url", state: "missing", source: "none", value: null },
    { key: "product_name", state: "missing", source: "none", value: null },
    { key: "option_decision", state: "missing", source: "none", value: null },
    { key: "quantity", state: "missing", source: "none", value: null },
    { key: "expected_unit_price", state: "missing", source: "none", value: null },
    { key: "max_total_price", state: "missing", source: "none", value: null },
    { key: "currency", state: "inferred", source: "session_context", value: "KRW" },
    { key: "query", state: "confirmed", source: "user", value: "물" },
  ],
  ambiguities: [{
    slot: "product_selection",
    material: true,
    blocks_effect: true,
    question: "상품, 용량, 묶음 수, 수량과 가격 한도를 확정해야 합니다.",
  }],
  preparations: [{ kind: "coupang.search", effect_class: "public_read" }],
};

test("calls only the fixed loopback Qwen route with structured output and no tools", async () => {
  const calls = [];
  const compiled = await analyzeLocalIntent({
    utterance: "쿠팡에서 물 좀 장바구니에 넣어놔",
    ingress: "local_owner_app",
  }, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ message: { content: JSON.stringify(MODEL_OUTPUT) } }) };
    },
    now: () => "2026-08-05T02:00:00.000Z",
    id: () => "intent-hypothesis.test",
  });

  assert.equal(calls[0].url, LOCAL_INTENT_ENDPOINT);
  assert.equal(calls[0].body.model, "qwen3.6:35b");
  assert.equal(calls[0].body.think, false);
  assert.equal(calls[0].body.tools, undefined);
  assert.equal(calls[0].body.format.additionalProperties, false);
  assert.deepEqual(calls[0].body.format.properties.objective.properties.kind.anyOf[0].enum, [
    "conversation.answer", "coupang.search", "coupang.cart.add", "mail.important.list", "mail.message.read",
  ]);
  assert.match(calls[0].body.messages[0].content, /Use conversation\.answer for greetings/u);
  assert.match(calls[0].body.messages[0].content, /Putting an item in a cart is coupang\.cart\.add/u);
  assert.match(calls[0].body.messages[0].content, /Never downgrade checkout, payment, purchase, or order/u);
  assert.equal(compiled.hypothesis.request_sha256.length, 64);
  assert.equal(JSON.stringify(compiled).includes("쿠팡에서 물 좀"), false);
});

test("model output cannot redefine a known action effect class", async () => {
  const downgraded = structuredClone(MODEL_OUTPUT);
  downgraded.objective.effect_class = "none";
  await assert.rejects(analyzeLocalIntent({ utterance: "물 넣어줘", ingress: "voice" }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(downgraded) } }) }),
  }), /invalid_local_intent_response/u);
});

test("explicit purchase language cannot be downgraded to a cart preparation", async () => {
  await assert.rejects(analyzeLocalIntent({ utterance: "생수를 바로 결제해서 주문해줘", ingress: "local_owner_app" }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(MODEL_OUTPUT) } }) }),
  }), (error) => error.message === "invalid_local_intent_response" && error.cause === "intent_contract_rejected");
});

test("a resolved product name supplies only the missing public-search query", async () => {
  const output = structuredClone(MODEL_OUTPUT);
  output.slots = output.slots.filter((entry) => entry.key !== "query");
  const productName = output.slots.find((entry) => entry.key === "product_name");
  Object.assign(productName, { state: "confirmed", source: "user", value: "생수" });
  const compiled = await analyzeLocalIntent({ utterance: "생수 좀 장바구니에 넣어줘", ingress: "local_owner_app" }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(output) } }) }),
  });
  const query = compiled.hypothesis.slots.find((entry) => entry.key === "query");
  assert.equal(query.state, "confirmed");
  assert.equal(query.source, "user");
  assert.equal(query.value_sha256, canonicalSha256("생수"));
});

test("external endpoints, transport details, and malformed output fail closed", async () => {
  await assert.rejects(analyzeLocalIntent({ utterance: "안녕", ingress: "telegram" }, {
    endpoint: "https://example.com/model",
  }), /non_local_intent_endpoint_rejected/u);

  await assert.rejects(analyzeLocalIntent({ utterance: "private-value", ingress: "telegram" }, {
    fetchImpl: async () => { throw new Error("private-value"); },
  }), (error) => error.message === "local_intent_model_unavailable" && !error.message.includes("private-value"));

  await assert.rejects(analyzeLocalIntent({ utterance: "안녕", ingress: "telegram" }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: "not-json" } }) }),
  }), /invalid_local_intent_response/u);
});
