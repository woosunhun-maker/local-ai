import {
  canonicalSha256,
  canonicalizeJson,
  deepFreeze,
} from "../growth/canonical.mjs";
import { validateWebTask } from "../web-task-policy.mjs";
import {
  bindIntentToWebTask,
  validateIntentPlanBinding,
} from "./intent-plan-binding.mjs";
import { validateCompiledMoment } from "./moment-contract.mjs";

export const INTENT_MOMENT_BINDING_SCHEMA = "local-ai.intent-moment-binding.v1";

export class IntentMomentBindingError extends Error {
  constructor(code) {
    super(code);
    this.name = "IntentMomentBindingError";
    this.code = code;
  }
}

function fail(code) {
  throw new IntentMomentBindingError(code);
}

export function intentPlanProvenanceId(binding) {
  let validated;
  try {
    validated = validateIntentPlanBinding(binding);
  } catch {
    fail("invalid_intent_plan_binding_for_moment");
  }
  return `intent-binding.${validated.binding_sha256}`;
}

function expectedEffect(next) {
  if (next === "prepare") return new Set(["public_read"]);
  if (next === "execute_read") return new Set(["public_read", "private_read"]);
  if (next === "request_approval") return new Set(["reversible_write", "irreversible_write"]);
  return new Set();
}

export function bindIntentPlanToMoment(compiledIntent, bindingValue, task, compiledMoment) {
  let binding;
  let plan;
  let moment;
  try {
    binding = validateIntentPlanBinding(bindingValue);
  } catch {
    fail("invalid_intent_plan_binding_for_moment");
  }
  try {
    plan = validateWebTask(task);
  } catch {
    fail("invalid_web_task_for_moment");
  }
  try {
    moment = validateCompiledMoment(compiledMoment);
  } catch {
    fail("invalid_moment_for_intent_plan");
  }

  let replayedBinding;
  try {
    replayedBinding = bindIntentToWebTask(compiledIntent, task);
  } catch {
    fail("intent_plan_replay_rejected");
  }
  if (canonicalizeJson(replayedBinding) !== canonicalizeJson(binding)) fail("intent_plan_replay_mismatch");

  const contract = moment.contract;
  if (plan.sha256 !== binding.action_plan_sha256) fail("moment_plan_binding_mismatch");
  if (contract.plan.plan_sha256 !== plan.sha256) fail("moment_plan_digest_mismatch");
  if (contract.action.kind !== binding.action || contract.action.kind !== plan.action) fail("moment_action_mismatch");
  if (!expectedEffect(binding.next).has(contract.action.effect_class)) fail("moment_effect_class_mismatch");
  if (canonicalizeJson(contract.action.parameters) !== canonicalizeJson(plan.parameters)) fail("moment_parameters_mismatch");

  const provenanceId = intentPlanProvenanceId(binding);
  if (!contract.intent.source_provenance.includes(provenanceId)) fail("moment_intent_provenance_missing");
  if (binding.requires_approval) {
    if (contract.authorization.mode !== "user_approval" || contract.policy.decision !== "require_approval") {
      fail("moment_user_approval_missing");
    }
  } else if (contract.authorization.mode === "user_approval") {
    fail("moment_unexpected_user_approval");
  }

  const base = {
    schema: INTENT_MOMENT_BINDING_SCHEMA,
    intent_plan_binding_sha256: binding.binding_sha256,
    action_plan_sha256: plan.sha256,
    moment_contract_sha256: moment.sha256,
    action: contract.action.kind,
    effect_class: contract.action.effect_class,
    authorization_mode: contract.authorization.mode,
  };
  return deepFreeze({ ...base, linkage_sha256: canonicalSha256(base) });
}
