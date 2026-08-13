/**
 * Approval Policy Manager
 * 기존 ApprovalStore / Face ID 서명 흐름을 대체하지 않는다.
 * Tool·Channel·위험도·신뢰 상태를 보고 승인 필요 여부만 판단한다.
 */

import { TOOL_CHANNELS, TOOL_RISK_LEVELS } from "../tools/tool-registry.mjs";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

/**
 * @returns {Readonly<{
 *   decision: "allow"|"require_approval"|"deny",
 *   reason: string,
 *   risk_level: string,
 *   channel: string,
 *   tool_name: string,
 *   approval_requirement: string,
 * }>}
 */
export function evaluateApprovalPolicy({
  tool,
  channel,
  hasApproval = false,
  trustState = "owner_device",
} = {}) {
  if (!tool || typeof tool.tool_name !== "string") fail("invalid_policy_tool");
  if (!TOOL_CHANNELS.includes(channel)) fail("invalid_policy_channel");
  if (!TOOL_RISK_LEVELS.includes(tool.risk_level)) fail("invalid_policy_risk");

  if (tool.enabled !== true) {
    return Object.freeze({
      decision: "deny",
      reason: "tool_disabled",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  if (!tool.allowed_channels.includes(channel)) {
    return Object.freeze({
      decision: "deny",
      reason: "channel_not_allowed",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  // Telegram에서는 효과 실행 도구를 절대 허용하지 않는다.
  if (channel === "telegram" && tool.executes_effects === true) {
    return Object.freeze({
      decision: "deny",
      reason: "telegram_effect_execution_forbidden",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  if (tool.available !== true) {
    return Object.freeze({
      decision: "deny",
      reason: "tool_unavailable",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  if (trustState !== "owner_device" && tool.risk_level !== "LOW") {
    return Object.freeze({
      decision: "deny",
      reason: "insufficient_trust",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  const needsApproval = tool.approval_requirement !== "none"
    && tool.approval_requirement !== "creates_pending_approval"
    && tool.approval_requirement !== "owner_confirm_step";

  // creates_pending_approval / owner_confirm_step 은 "요청 생성/확인 단계" 자체
  if (tool.approval_requirement === "creates_pending_approval") {
    return Object.freeze({
      decision: "allow",
      reason: "creates_pending_approval_only",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  if (tool.approval_requirement === "owner_confirm_step") {
    return Object.freeze({
      decision: "require_approval",
      reason: "owner_confirm_step_required",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  if (tool.approval_requirement === "none" && tool.risk_level === "LOW") {
    return Object.freeze({
      decision: "allow",
      reason: "low_risk_no_approval",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  if (needsApproval && !hasApproval) {
    return Object.freeze({
      decision: "require_approval",
      reason: "approval_required_before_execute",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  if (needsApproval && hasApproval) {
    return Object.freeze({
      decision: "allow",
      reason: "prior_approval_present",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  if (tool.risk_level === "HIGH" && !hasApproval) {
    return Object.freeze({
      decision: "require_approval",
      reason: "high_risk_requires_approval",
      risk_level: tool.risk_level,
      channel,
      tool_name: tool.tool_name,
      approval_requirement: tool.approval_requirement,
    });
  }

  return Object.freeze({
    decision: "require_approval",
    reason: "default_require_approval",
    risk_level: tool.risk_level,
    channel,
    tool_name: tool.tool_name,
    approval_requirement: tool.approval_requirement,
  });
}

/**
 * 실행 게이트. require_approval 인데 승인 없으면 실행 불가.
 */
export function assertToolExecutionAllowed({
  registry,
  toolName,
  channel,
  hasApproval = false,
  trustState = "owner_device",
} = {}) {
  const tool = registry?.get?.(toolName);
  if (!tool) fail("unknown_tool", 404);
  const policy = evaluateApprovalPolicy({ tool, channel, hasApproval, trustState });
  if (policy.decision === "deny") {
    throw Object.assign(new Error(policy.reason), { statusCode: 403, policy });
  }
  if (policy.decision === "require_approval") {
    throw Object.assign(new Error(policy.reason), { statusCode: 403, policy });
  }
  return policy;
}
