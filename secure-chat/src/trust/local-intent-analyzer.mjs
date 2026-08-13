import { randomUUID } from "node:crypto";

import { canonicalSha256, sha256Hex } from "../growth/canonical.mjs";
import { localModelRoute } from "../local-model-routing.mjs";
import {
  compileIntentHypothesis,
  INTENT_ACTION_PROFILES,
  INTENT_HYPOTHESIS_SCHEMA,
} from "./intent-negotiation.mjs";

export const LOCAL_INTENT_ENDPOINT = "http://127.0.0.1:11434/api/chat";

const KNOWN_ACTION_KINDS = Object.freeze(Object.keys(INTENT_ACTION_PROFILES));

const MODEL_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["objective", "confidence_bps", "slots", "ambiguities", "preparations"],
  properties: {
    objective: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "summary", "effect_class"],
      properties: {
        kind: {
          anyOf: [
            { enum: KNOWN_ACTION_KINDS },
            { type: "string", pattern: "^unregistered\\.[a-z][a-z0-9._-]{0,50}$", maxLength: 64 },
          ],
        },
        summary: { type: "string", maxLength: 300 },
        effect_class: { enum: ["none", "public_read", "private_read", "reversible_write", "irreversible_write"] },
      },
    },
    confidence_bps: { type: "integer", minimum: 0, maximum: 10_000 },
    slots: {
      type: "array",
      maxItems: 64,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "state", "source", "value"],
        properties: {
          key: { type: "string", maxLength: 64 },
          state: { enum: ["confirmed", "inferred", "missing"] },
          source: { enum: ["user", "confirmed_memory", "session_context", "public_lookup", "model_inference", "none"] },
          value: { anyOf: [{ type: "string", maxLength: 300 }, { type: "number" }, { type: "boolean" }, { type: "null" }] },
        },
      },
    },
    ambiguities: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slot", "material", "blocks_effect", "question"],
        properties: {
          slot: { type: "string", maxLength: 64 },
          material: { type: "boolean" },
          blocks_effect: { type: "boolean" },
          question: { type: "string", maxLength: 240 },
        },
      },
    },
    preparations: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "effect_class"],
        properties: {
          kind: { type: "string", maxLength: 64 },
          effect_class: { enum: ["none", "public_read"] },
        },
      },
    },
  },
});

const SYSTEM_PROMPT = [
  "You are a local, tool-free intent hypothesis generator.",
  "Return only the JSON object required by the response schema.",
  "Treat the user's wording as evidence, not as a complete executable command.",
  "confidence_bps uses basis points: 10000 means 100%, 8500 means 85%, and 0 means no confidence.",
  "Never claim that missing shopping, price, recipient, account, or device facts are confirmed.",
  "Use confirmed only for facts explicitly stated by the user; use inferred for genuine context-bound hypotheses; otherwise use missing.",
  "For each slot, return its primitive value when resolved. For a missing slot return source=none and value=null.",
  "A safe preparation may only be none or a public read. It must never mutate accounts, devices, files, messages, or purchases.",
  "When proposing a preparation, also include every required slot for that preparation action (for example coupang.search requires a resolved query).",
  "Use conversation.answer for greetings, ordinary conversation, and questions that require no registered external action; do not invent labels such as greeting or information_retrieval.",
  "Use mail.important.list exactly for listing important mail and mail.message.read exactly for reading one selected message.",
  "Putting an item in a cart is coupang.cart.add with reversible_write, not a purchase. Missing product details may use coupang.search as its public-read preparation.",
  "Only explicit checkout, payment, buying, or placing an order is a purchase; merely adding to a cart is never a purchase.",
  "Never downgrade checkout, payment, purchase, or order requests to coupang.cart.add or coupang.search. Use an unregistered truthful action such as unregistered.coupang.purchase with irreversible_write and no preparation so code can keep it discussion-only.",
  "The objective kind must be one exact registered action name or begin with unregistered.; never invent a near-synonym for a registered action.",
  "Known action profiles are code-owned and must be followed exactly:",
  JSON.stringify(INTENT_ACTION_PROFILES),
].join("\n");

function boundedUtterance(value) {
  if (typeof value !== "string") throw new Error("invalid_intent_utterance");
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new Error("invalid_intent_utterance");
  }
  return normalized;
}

function validIngress(value) {
  if (!["local_owner_app", "telegram", "voice"].includes(value)) throw new Error("invalid_intent_ingress");
  return value;
}

function assertNoIrreversibleGoalDowngrade(utterance, modelOutput) {
  const explicitPurchase = /(?:결제(?:해|해서|해줘|해주세요)|주문(?:해|해서|해줘|해주세요)|구매(?:해|해서|해줘|해주세요)|\b(?:buy|purchase|checkout|pay|place an order)\b)/iu.test(utterance);
  if (explicitPurchase && modelOutput?.objective?.effect_class !== "irreversible_write") {
    throw new Error("irreversible_goal_downgraded");
  }
}

function normalizePreparationSlots(modelOutput) {
  if (!Array.isArray(modelOutput?.slots) || !Array.isArray(modelOutput?.preparations)) return modelOutput;
  const needsSearchQuery = modelOutput.preparations.some((entry) => entry?.kind === "coupang.search");
  if (!needsSearchQuery) return modelOutput;
  const query = modelOutput.slots.find((entry) => entry?.key === "query");
  if (query && query.state !== "missing" && query.value !== null) return modelOutput;
  const productName = modelOutput.slots.find((entry) => entry?.key === "product_name" && entry.state !== "missing" && typeof entry.value === "string" && entry.value.trim());
  if (!productName) return modelOutput;
  return {
    ...modelOutput,
    slots: [
      ...modelOutput.slots.filter((entry) => entry?.key !== "query"),
      { key: "query", state: productName.state, source: productName.source, value: productName.value },
    ],
  };
}

export async function analyzeLocalIntent({ utterance, ingress }, {
  fetchImpl = fetch,
  endpoint = LOCAL_INTENT_ENDPOINT,
  now = () => new Date().toISOString(),
  id = () => `intent-hypothesis.${randomUUID()}`,
  signal,
} = {}) {
  const normalized = boundedUtterance(utterance);
  const channel = validIngress(ingress);
  if (endpoint !== LOCAL_INTENT_ENDPOINT) throw new Error("non_local_intent_endpoint_rejected");
  const route = localModelRoute("intent_hypothesis");
  if (route.tools || route.durable_private_memory) throw new Error("unsafe_intent_model_route");

  const timeout = AbortSignal.timeout(120_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: route.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: normalized },
        ],
        format: MODEL_OUTPUT_SCHEMA,
        stream: false,
        think: false,
        keep_alive: "10m",
        options: { num_ctx: 8_192, num_predict: 2_048, temperature: 0 },
      }),
      signal: requestSignal,
    });
  } catch {
    throw new Error("local_intent_model_unavailable");
  }
  if (!response?.ok) throw new Error("local_intent_model_unavailable");

  let modelOutput;
  try {
    const envelope = await response.json();
    const content = envelope?.message?.content;
    if (typeof content !== "string" || !content || content.length > 20_000) throw new Error("invalid");
    modelOutput = JSON.parse(content);
  } catch {
    throw new Error("invalid_local_intent_response");
  }

  try {
    assertNoIrreversibleGoalDowngrade(normalized, modelOutput);
    const normalizedOutput = normalizePreparationSlots(modelOutput);
    return compileIntentHypothesis({
      schema: INTENT_HYPOTHESIS_SCHEMA,
      hypothesis_id: id(),
      request_sha256: sha256Hex(normalized),
      ingress: channel,
      objective: normalizedOutput.objective,
      confidence_bps: normalizedOutput.confidence_bps,
      slots: Array.isArray(normalizedOutput.slots) ? normalizedOutput.slots.map((slot) => {
        if (slot?.state === "missing" || slot?.value === null) {
          return { key: slot?.key, state: "missing", source: "none", value_sha256: null };
        }
        return {
          key: slot?.key,
          state: slot?.state,
          source: slot?.source,
          value_sha256: canonicalSha256(slot?.value),
        };
      }) : normalizedOutput.slots,
      ambiguities: normalizedOutput.ambiguities,
      preparations: normalizedOutput.preparations,
      created_at: now(),
    });
  } catch (error) {
    throw new Error("invalid_local_intent_response", {
      cause: typeof error?.code === "string" ? error.code : "intent_contract_rejected",
    });
  }
}

export const LOCAL_INTENT_MODEL_OUTPUT_SCHEMA = MODEL_OUTPUT_SCHEMA;
