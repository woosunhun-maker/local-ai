export const LOCAL_CONVERSATION_MODEL = "qwen3.6:35b";
export const LOCAL_EFFECT_PLANNING_MODEL = "qwen3-128k:latest";

const ROUTES = Object.freeze({
  general_chat: Object.freeze({
    model: LOCAL_CONVERSATION_MODEL,
    tools: false,
    durable_private_memory: false,
  }),
  intent_hypothesis: Object.freeze({
    model: LOCAL_CONVERSATION_MODEL,
    tools: false,
    durable_private_memory: false,
  }),
  effect_planning: Object.freeze({
    model: LOCAL_EFFECT_PLANNING_MODEL,
    tools: true,
    durable_private_memory: false,
  }),
});

export function localModelRoute(route) {
  const profile = ROUTES[route];
  if (!profile) throw new Error("unsupported_local_model_route");
  return profile;
}

export function assertConversationModel(model) {
  if (model !== LOCAL_CONVERSATION_MODEL) throw new Error("unapproved_local_conversation_model");
  return model;
}

export const LOCAL_MODEL_ROUTES = ROUTES;
