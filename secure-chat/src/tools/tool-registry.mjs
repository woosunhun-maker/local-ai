/**
 * Tool Registry — 기존 실행 모듈을 플러그인으로 재작성하지 않고 메타데이터만 등록한다.
 */

export const TOOL_CHANNELS = Object.freeze([
  "telegram",
  "local_owner_app",
  "mac_web",
  "system_cli",
]);

export const TOOL_RISK_LEVELS = Object.freeze(["LOW", "MEDIUM", "HIGH"]);

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function freezeTool(raw) {
  if (!raw || typeof raw.tool_name !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/i.test(raw.tool_name)) {
    fail("invalid_tool_name");
  }
  if (typeof raw.capability !== "string" || raw.capability.length < 1 || raw.capability.length > 120) {
    fail("invalid_tool_capability");
  }
  if (typeof raw.enabled !== "boolean") fail("invalid_tool_enabled");
  if (typeof raw.available !== "boolean") fail("invalid_tool_available");
  if (!TOOL_RISK_LEVELS.includes(raw.risk_level)) fail("invalid_tool_risk_level");
  if (!Array.isArray(raw.allowed_channels) || raw.allowed_channels.length < 1) fail("invalid_tool_channels");
  for (const channel of raw.allowed_channels) {
    if (!TOOL_CHANNELS.includes(channel)) fail("invalid_tool_channel");
  }
  if (typeof raw.approval_requirement !== "string") fail("invalid_tool_approval_requirement");
  if (!raw.input_contract || typeof raw.input_contract !== "object") fail("invalid_tool_input_contract");
  if (!raw.output_contract || typeof raw.output_contract !== "object") fail("invalid_tool_output_contract");

  return Object.freeze({
    tool_name: raw.tool_name,
    capability: raw.capability,
    description: typeof raw.description === "string" ? raw.description.slice(0, 300) : "",
    enabled: raw.enabled,
    available: raw.available,
    risk_level: raw.risk_level,
    allowed_channels: Object.freeze([...raw.allowed_channels]),
    approval_requirement: raw.approval_requirement,
    input_contract: Object.freeze({ ...raw.input_contract }),
    output_contract: Object.freeze({ ...raw.output_contract }),
    implementation: typeof raw.implementation === "string" ? raw.implementation : "existing_module",
    executes_effects: raw.executes_effects === true,
  });
}

export class ToolRegistry {
  constructor(tools = []) {
    this.tools = new Map();
    for (const tool of tools) this.register(tool);
  }

  register(tool) {
    const frozen = freezeTool(tool);
    if (this.tools.has(frozen.tool_name)) fail("duplicate_tool_name");
    this.tools.set(frozen.tool_name, frozen);
    return frozen;
  }

  get(toolName) {
    return this.tools.get(toolName) ?? null;
  }

  list() {
    return Object.freeze([...this.tools.values()]);
  }

  /**
   * enabled(정책 등록)와 available(런타임 가용)을 구분한다.
   */
  describe(toolName) {
    const tool = this.get(toolName);
    if (!tool) return null;
    return Object.freeze({
      ...tool,
      policy_state: tool.enabled ? "enabled" : "disabled",
      runtime_state: tool.available ? "available" : "unavailable",
      usable_now: tool.enabled && tool.available,
    });
  }
}

/** 현재 코드베이스에 실제로 존재하는 모듈만 등록. 가짜 도구 없음. */
export function createBuiltinToolRegistry({
  webTaskAvailable = true,
  ownerActionAvailable = true,
  codexAvailable = true,
  growthAvailable = false,
  ttsAvailable = true,
} = {}) {
  const registry = new ToolRegistry();

  registry.register({
    tool_name: "system.status",
    capability: "read_runtime_status",
    description: "실측 시스템 상태 조회",
    enabled: true,
    available: true,
    risk_level: "LOW",
    allowed_channels: ["local_owner_app", "mac_web", "system_cli"],
    approval_requirement: "none",
    input_contract: { command: "system.status" },
    output_contract: { schema: "local-ai.system-command-result.v1" },
    implementation: "src/system/introspection.mjs",
    executes_effects: false,
  });

  registry.register({
    tool_name: "memory.confirmed.read",
    capability: "read_confirmed_user_memory",
    description: "확인형 사용자 기억 조회",
    enabled: true,
    available: true,
    risk_level: "LOW",
    allowed_channels: ["local_owner_app", "mac_web"],
    approval_requirement: "none",
    input_contract: { methods: ["listActive", "listCandidates"] },
    output_contract: { items: "confirmed_memory_items" },
    implementation: "src/confirmed-memory-store.mjs",
    executes_effects: false,
  });

  registry.register({
    tool_name: "memory.confirmed.write",
    capability: "propose_or_confirm_user_memory",
    description: "확인형 사용자 기억 제안/확정",
    enabled: true,
    available: true,
    risk_level: "MEDIUM",
    allowed_channels: ["local_owner_app", "mac_web"],
    approval_requirement: "owner_confirm_step",
    input_contract: { methods: ["propose", "confirm"] },
    output_contract: { item: "confirmed_memory_item" },
    implementation: "src/confirmed-memory-store.mjs",
    executes_effects: true,
  });

  registry.register({
    tool_name: "web_task.plan",
    capability: "plan_shared_chrome_web_task",
    description: "공유 Chrome 탭 대상 웹 작업 계획",
    enabled: true,
    available: webTaskAvailable,
    risk_level: "MEDIUM",
    allowed_channels: ["local_owner_app"],
    approval_requirement: "plan_bound_device_signature",
    input_contract: { schema: "local-ai.web-task-plan.v1" },
    output_contract: { job_status: ["ready", "awaiting_approval"] },
    implementation: "src/web-task-policy.mjs + web-task-coordinator.mjs",
    executes_effects: false,
  });

  registry.register({
    tool_name: "web_task.execute",
    capability: "execute_shared_chrome_web_task",
    description: "승인된 웹 작업 실행",
    enabled: true,
    available: webTaskAvailable,
    risk_level: "HIGH",
    allowed_channels: ["local_owner_app"],
    approval_requirement: "prior_approved_request",
    input_contract: { requires: ["approved_web_task_job"] },
    output_contract: { result_code: "string" },
    implementation: "src/web-task-coordinator.mjs",
    executes_effects: true,
  });

  registry.register({
    tool_name: "owner.action.request",
    capability: "create_owner_action_approval",
    description: "Telegram/앱에서 작업 승인 요청 생성(실행 아님)",
    enabled: true,
    available: ownerActionAvailable,
    risk_level: "MEDIUM",
    allowed_channels: ["telegram", "local_owner_app"],
    approval_requirement: "creates_pending_approval",
    input_contract: { schema: "local-ai.owner-action-plan.v1" },
    output_contract: { kind: "owner.action.v1", status: "pending" },
    implementation: "src/telegram/owner-action-bridge.mjs",
    executes_effects: false,
  });

  registry.register({
    tool_name: "owner.action.execute",
    capability: "execute_owner_action",
    description: "앱 승인 후 Mac에서 안전 실행",
    enabled: true,
    available: ownerActionAvailable,
    risk_level: "HIGH",
    allowed_channels: ["local_owner_app"],
    approval_requirement: "prior_approved_request",
    input_contract: { kind: "owner.action.v1", status: "approved" },
    output_contract: { execution_receipt: "object" },
    implementation: "src/telegram/owner-action-executor.mjs",
    executes_effects: true,
  });

  registry.register({
    tool_name: "codex.enqueue",
    capability: "enqueue_isolated_codex_task",
    description: "격리 Codex 점검/초안 큐 등록",
    enabled: true,
    available: codexAvailable,
    risk_level: "HIGH",
    allowed_channels: ["local_owner_app"],
    approval_requirement: "device_signature_codex_plan",
    input_contract: { schema: "local-ai.codex-task-plan.v3" },
    output_contract: { task_status: "queued" },
    implementation: "src/codex/owner-task-coordinator.mjs",
    executes_effects: true,
  });

  registry.register({
    tool_name: "growth.dispatch",
    capability: "dispatch_growth_advice_request",
    description: "집계 성능 문제만 외부 조언 요청",
    enabled: true,
    available: growthAvailable,
    risk_level: "MEDIUM",
    allowed_channels: ["local_owner_app"],
    approval_requirement: "frozen_outbound_request",
    input_contract: { kind: "gpt.consult" },
    output_contract: { advice: "quarantined" },
    implementation: "src/growth/coordinator.mjs",
    executes_effects: true,
  });

  registry.register({
    tool_name: "tts.stream",
    capability: "synthesize_speech",
    description: "로컬 TTS 스트림",
    enabled: true,
    available: ttsAvailable,
    risk_level: "LOW",
    allowed_channels: ["local_owner_app"],
    approval_requirement: "none",
    input_contract: { path: "/api/tts/stream" },
    output_contract: { audio_events: "stream" },
    implementation: "src/tts/*",
    executes_effects: false,
  });

  return registry;
}
