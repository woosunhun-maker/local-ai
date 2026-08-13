import assert from "node:assert/strict";
import test from "node:test";

import {
  assertConversationModel,
  LOCAL_CONVERSATION_MODEL,
  LOCAL_EFFECT_PLANNING_MODEL,
  localModelRoute,
} from "../src/local-model-routing.mjs";

test("Qwen 3.6 is limited to tool-free conversation and intent hypotheses", () => {
  assert.equal(LOCAL_CONVERSATION_MODEL, "qwen3.6:35b");
  assert.deepEqual(localModelRoute("general_chat"), {
    model: "qwen3.6:35b",
    tools: false,
    durable_private_memory: false,
  });
  assert.deepEqual(localModelRoute("intent_hypothesis"), {
    model: "qwen3.6:35b",
    tools: false,
    durable_private_memory: false,
  });
});

test("effect planning stays on the separately pinned model", () => {
  assert.equal(LOCAL_EFFECT_PLANNING_MODEL, "qwen3-128k:latest");
  assert.deepEqual(localModelRoute("effect_planning"), {
    model: "qwen3-128k:latest",
    tools: true,
    durable_private_memory: false,
  });
});

test("arbitrary model overrides fail closed", () => {
  assert.equal(assertConversationModel("qwen3.6:35b"), "qwen3.6:35b");
  assert.throws(() => assertConversationModel("openai/gpt"), /unapproved_local_conversation_model/u);
  assert.throws(() => assertConversationModel("qwen3-128k:latest"), /unapproved_local_conversation_model/u);
  assert.throws(() => localModelRoute("unknown"), /unsupported_local_model_route/u);
});
