import {
  canonicalSha256,
  canonicalizeJson,
  deepFreeze,
} from "../growth/canonical.mjs";
import { validateWebTask } from "../web-task-policy.mjs";
import { bindIntentPlanToMoment } from "./intent-moment-binding.mjs";
import { validateCompiledMoment } from "./moment-contract.mjs";

export const APPROVAL_PREVIEW_SCHEMA = "local-ai.approval-preview.v1";
export const APPROVAL_MOMENT_BINDING_SCHEMA = "local-ai.approval-moment-binding.v1";

export class ApprovalPreviewError extends Error {
  constructor(code) {
    super(code);
    this.name = "ApprovalPreviewError";
    this.code = code;
  }
}

function fail(code) {
  throw new ApprovalPreviewError(code);
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

function cartPreview(plan) {
  const parameters = plan.parameters;
  const option = parameters.option ?? "선택 없음";
  return {
    schema: APPROVAL_PREVIEW_SCHEMA,
    action_plan_sha256: plan.sha256,
    action: plan.action,
    title: "장바구니 추가 승인",
    facts: {
      product_url: parameters.productUrl,
      product_name: parameters.productName,
      option,
      quantity: parameters.quantity,
      expected_unit_price: parameters.expectedUnitPrice,
      maximum_total_price: parameters.maxTotalPrice,
      currency: parameters.currency,
    },
    restrictions: {
      adds_to_cart_only: true,
      checkout: false,
      payment: false,
      order_submission: false,
    },
    presentation: {
      channel: "iphone_local_app",
      bystander_exposure: "none",
      plain_language: `${parameters.productName} / 옵션: ${option} / 수량: ${parameters.quantity}`,
      consequences: `예상 단가 ${parameters.expectedUnitPrice} ${parameters.currency}, 최대 합계 ${parameters.maxTotalPrice} ${parameters.currency}입니다. 결제와 주문은 실행하지 않습니다.`,
      no_action_result: "승인하지 않으면 장바구니는 바뀌지 않습니다.",
      rollback: "장바구니에서 다시 제거할 수 있습니다.",
      uncertainty: "실행 직전에 상품, 옵션, 가격과 재고를 다시 확인합니다.",
      choices: ["approve", "later", "reject", "stop_all"],
      comprehension_gate: "predict_effect",
    },
  };
}

export function compileApprovalPreview(task) {
  let plan;
  try {
    plan = validateWebTask(task);
  } catch {
    fail("invalid_web_task_for_approval_preview");
  }
  if (!plan.requiresApproval || plan.action !== "coupang.cart.add") fail("approval_preview_not_required");
  const preview = cartPreview(plan);
  const canonical = canonicalizeJson(preview);
  return deepFreeze({ preview: deepFreeze(preview), canonical, sha256: canonicalSha256(preview) });
}

export function approvalPresentationForWebTask(task) {
  return structuredClone(compileApprovalPreview(task).preview.presentation);
}

export function bindApprovalPreviewToMoment(value) {
  const input = plain(value, "invalid_approval_moment_binding_input");
  exactKeys(input, [
    "compiled_intent", "intent_plan_binding", "task", "compiled_moment", "compiled_preview",
  ], "invalid_approval_moment_binding_fields");

  const expectedPreview = compileApprovalPreview(input.task);
  const supplied = plain(input.compiled_preview, "invalid_compiled_approval_preview");
  exactKeys(supplied, ["preview", "canonical", "sha256"], "invalid_compiled_approval_preview_fields");
  if (canonicalizeJson(supplied) !== canonicalizeJson(expectedPreview)) fail("approval_preview_tampered");

  let intentMoment;
  let moment;
  try {
    intentMoment = bindIntentPlanToMoment(
      input.compiled_intent,
      input.intent_plan_binding,
      input.task,
      input.compiled_moment,
    );
    moment = validateCompiledMoment(input.compiled_moment);
  } catch {
    fail("approval_intent_moment_chain_rejected");
  }
  const contract = moment.contract;
  if (intentMoment.action_plan_sha256 !== expectedPreview.preview.action_plan_sha256) fail("approval_preview_plan_mismatch");
  if (canonicalizeJson(contract.presentation) !== canonicalizeJson(expectedPreview.preview.presentation)) {
    fail("approval_presentation_mismatch");
  }
  if (contract.authorization.mode !== "user_approval" || contract.authorization.payload_sha256 !== contract.bindings.approval_basis_sha256) {
    fail("approval_payload_not_bound");
  }

  const base = {
    schema: APPROVAL_MOMENT_BINDING_SCHEMA,
    preview_sha256: expectedPreview.sha256,
    intent_moment_linkage_sha256: intentMoment.linkage_sha256,
    action_plan_sha256: expectedPreview.preview.action_plan_sha256,
    moment_contract_sha256: moment.sha256,
    approval_payload_sha256: contract.authorization.payload_sha256,
  };
  return deepFreeze({ ...base, binding_sha256: canonicalSha256(base) });
}
