import {
  canonicalSha256,
  deepFreeze,
  isSha256,
} from "../growth/canonical.mjs";
import { validateWebTask } from "../web-task-policy.mjs";
import {
  decideIntentNextStep,
  INTENT_ACTION_PROFILES,
  validateCompiledIntentHypothesis,
} from "./intent-negotiation.mjs";

export const INTENT_PLAN_BINDING_SCHEMA = "local-ai.intent-plan-binding.v1";

const PARAMETER_BINDINGS = Object.freeze({
  "coupang.search": Object.freeze({
    query: Object.freeze({ parameter: "query" }),
  }),
  "coupang.cart.add": Object.freeze({
    product_url: Object.freeze({ parameter: "productUrl" }),
    product_name: Object.freeze({ parameter: "productName" }),
    option_decision: Object.freeze({ parameter: "option", nullAs: "none" }),
    quantity: Object.freeze({ parameter: "quantity" }),
    expected_unit_price: Object.freeze({ parameter: "expectedUnitPrice" }),
    max_total_price: Object.freeze({ parameter: "maxTotalPrice" }),
    currency: Object.freeze({ parameter: "currency" }),
  }),
  "mail.important.list": Object.freeze({
    provider: Object.freeze({ parameter: "provider" }),
    max_results: Object.freeze({ parameter: "maxResults" }),
    unread_only: Object.freeze({ parameter: "unreadOnly" }),
  }),
  "mail.message.read": Object.freeze({
    provider: Object.freeze({ parameter: "provider" }),
    selection_id: Object.freeze({ parameter: "selectionId" }),
  }),
});

export class IntentPlanBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = "IntentPlanBindingError";
    this.code = code;
  }
}

function fail(code) {
  throw new IntentPlanBindingError(code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(code);
}

function allowedAction(decision, hypothesis, action) {
  if (decision.next === "prepare") return decision.preparation_kinds.includes(action);
  if (["execute_read", "request_approval"].includes(decision.next)) return hypothesis.objective.kind === action;
  return false;
}

function bindSlots(hypothesis, plan) {
  const profile = INTENT_ACTION_PROFILES[plan.action];
  const mappings = PARAMETER_BINDINGS[plan.action];
  if (!profile || !mappings) fail("unregistered_intent_plan_profile");
  const slots = new Map(hypothesis.slots.map((slot) => [slot.key, slot]));
  const bindings = [];

  for (const key of profile.requiredSlots) {
    const slot = slots.get(key);
    const mapping = mappings[key];
    if (!slot || slot.state === "missing" || !mapping) fail("intent_plan_slot_missing");
    const rawValue = plan.parameters[mapping.parameter];
    const value = rawValue === null && Object.hasOwn(mapping, "nullAs") ? mapping.nullAs : rawValue;
    const valueSha256 = canonicalSha256(value);
    if (valueSha256 !== slot.value_sha256) fail("intent_plan_slot_mismatch");
    bindings.push({ key, value_sha256: valueSha256 });
  }
  return bindings.sort((left, right) => left.key.localeCompare(right.key));
}

export function bindIntentToWebTask(compiledIntent, task) {
  let intent;
  try {
    intent = validateCompiledIntentHypothesis(compiledIntent);
  } catch {
    fail("invalid_compiled_intent_for_plan");
  }
  if (intent.hypothesis.ingress !== "local_owner_app") fail("intent_plan_owner_app_required");

  const decision = decideIntentNextStep(intent);
  let plan;
  try {
    plan = validateWebTask(task);
  } catch {
    fail("invalid_web_task_for_intent");
  }
  if (!allowedAction(decision, intent.hypothesis, plan.action)) fail("intent_plan_action_not_authorized");
  if (decision.next === "prepare" && (plan.risk !== "read_public_catalog" || plan.requiresApproval)) {
    fail("unsafe_intent_preparation_plan");
  }
  if (decision.next === "execute_read" && plan.requiresApproval) fail("unexpected_intent_read_approval");
  if (decision.next === "request_approval" && !plan.requiresApproval) fail("intent_effect_approval_missing");

  const slotBindings = bindSlots(intent.hypothesis, plan);
  const base = {
    schema: INTENT_PLAN_BINDING_SCHEMA,
    hypothesis_sha256: intent.sha256,
    request_sha256: intent.hypothesis.request_sha256,
    action_plan_sha256: plan.sha256,
    action: plan.action,
    next: decision.next,
    requires_approval: plan.requiresApproval,
    slot_bindings_sha256: canonicalSha256(slotBindings),
  };
  return deepFreeze({ ...base, binding_sha256: canonicalSha256(base) });
}

export function validateIntentPlanBinding(value) {
  const input = plain(value, "invalid_intent_plan_binding");
  exactKeys(input, [
    "schema", "hypothesis_sha256", "request_sha256", "action_plan_sha256", "action",
    "next", "requires_approval", "slot_bindings_sha256", "binding_sha256",
  ], "invalid_intent_plan_binding_fields");
  if (input.schema !== INTENT_PLAN_BINDING_SCHEMA) fail("unsupported_intent_plan_binding_schema");
  if (![input.hypothesis_sha256, input.request_sha256, input.action_plan_sha256, input.slot_bindings_sha256, input.binding_sha256].every(isSha256)) {
    fail("invalid_intent_plan_binding_digest");
  }
  if (!Object.hasOwn(PARAMETER_BINDINGS, input.action)) fail("unregistered_intent_plan_profile");
  if (!["prepare", "execute_read", "request_approval"].includes(input.next)) fail("invalid_intent_plan_next_step");
  if (typeof input.requires_approval !== "boolean") fail("invalid_intent_plan_approval_flag");
  if ((input.next === "request_approval") !== input.requires_approval) fail("intent_plan_approval_flag_mismatch");
  const base = {
    schema: input.schema,
    hypothesis_sha256: input.hypothesis_sha256,
    request_sha256: input.request_sha256,
    action_plan_sha256: input.action_plan_sha256,
    action: input.action,
    next: input.next,
    requires_approval: input.requires_approval,
    slot_bindings_sha256: input.slot_bindings_sha256,
  };
  if (canonicalSha256(base) !== input.binding_sha256) fail("intent_plan_binding_tampered");
  return deepFreeze({ ...base, binding_sha256: input.binding_sha256 });
}

export const INTENT_PLAN_PARAMETER_BINDINGS = deepFreeze(PARAMETER_BINDINGS);
