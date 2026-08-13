import { createHash } from "node:crypto";
import { deviceActionBinding, inspectDeviceAction, inspectDeviceApp, sameDeviceApp, sanitizeOcrText } from "./device-privacy-policy.mjs";

function gatewayError(code, statusCode = 400) {
  return Object.assign(new Error(code), { name: "DeviceSafetyGatewayError", code, statusCode });
}

function requireDriver(driver) {
  if (!driver || typeof driver.getForegroundApp !== "function" || typeof driver.captureMaskedOcr !== "function" || typeof driver.perform !== "function") throw gatewayError("invalid_device_driver");
  return driver;
}

function safeAuditAppHash(app) {
  return createHash("sha256").update(`device-app-v1:${app.id}`).digest("hex");
}

export class DeviceSafetyGateway {
  constructor({ policy, approvalStore, driver, auditSink = () => {} }) {
    if (!policy || !approvalStore || typeof approvalStore.createRequest !== "function" || typeof approvalStore.consumeApproved !== "function") throw gatewayError("invalid_device_gateway_dependencies");
    if (typeof auditSink !== "function") throw gatewayError("invalid_device_audit_sink");
    this.policy = policy;
    this.approvalStore = approvalStore;
    this.driver = requireDriver(driver);
    this.auditSink = auditSink;
  }

  audit(event, details = {}) { this.auditSink(Object.freeze({ event, ...details })); }

  async foregroundApp() {
    const inspection = inspectDeviceApp(await this.driver.getForegroundApp(), this.policy);
    if (!inspection.allowed) {
      this.audit("device_access_denied", { reason: inspection.reason, appHash: safeAuditAppHash(inspection.app) });
      throw gatewayError(inspection.reason, 403);
    }
    return inspection;
  }

  async observe() {
    const foreground = await this.foregroundApp();
    const sanitized = sanitizeOcrText(await this.driver.captureMaskedOcr({ maskRegions: structuredClone(foreground.privateRegions) }));
    this.audit("device_screen_observed", { appHash: safeAuditAppHash(foreground.app), redactionCategories: sanitized.findings, maskedRegionCount: foreground.privateRegions.length });
    return Object.freeze({ app: foreground.app, text: sanitized.text, redactionCategories: sanitized.findings });
  }

  async prepare(actionValue, { ttlMs = 2 * 60_000 } = {}) {
    const inspection = inspectDeviceAction(actionValue, this.policy);
    if (!inspection.allowed) {
      this.audit("device_action_denied", { reason: inspection.reason });
      throw gatewayError(inspection.reason, 403);
    }
    const foreground = await this.foregroundApp();
    if (!sameDeviceApp(foreground.app, inspection.action.app)) throw gatewayError("foreground_app_changed", 409);
    const binding = deviceActionBinding(inspection.action);
    if (!inspection.approvalRequired) return Object.freeze({ status: "ready", action: binding.action, payloadSha256: binding.payloadSha256 });
    const approval = await this.approvalStore.createRequest({
      kind: "device.execute",
      title: "iPhone 자동화 승인",
      summary: `${binding.action.app.name}에서 '${binding.action.target}' 작업을 1회 실행합니다.`,
      payload: binding.payload,
      dataCategories: ["device_control", inspection.effect],
    }, ttlMs);
    this.audit("device_approval_requested", { appHash: safeAuditAppHash(binding.action.app), payloadSha256: binding.payloadSha256, effect: inspection.effect });
    return Object.freeze({ status: "approval_required", approvalId: approval.id, expiresAt: approval.expiresAt, action: binding.action, payloadSha256: binding.payloadSha256 });
  }

  async execute(actionValue, { approvalId = null } = {}) {
    const inspection = inspectDeviceAction(actionValue, this.policy);
    if (!inspection.allowed) throw gatewayError(inspection.reason, 403);
    const binding = deviceActionBinding(inspection.action);
    const foreground = await this.foregroundApp();
    if (!sameDeviceApp(foreground.app, binding.action.app)) throw gatewayError("foreground_app_changed", 409);
    if (inspection.approvalRequired) {
      if (typeof approvalId !== "string") throw gatewayError("device_approval_required", 403);
      const consumed = await this.approvalStore.consumeApproved(approvalId, binding.payloadSha256);
      if (!consumed || consumed.kind !== "device.execute" || consumed.payload !== binding.payload) throw gatewayError("device_approval_invalid_or_expired", 403);
    } else if (approvalId !== null) throw gatewayError("unexpected_device_approval", 409);
    const result = await this.driver.perform(structuredClone(binding.action));
    this.audit("device_action_executed", { appHash: safeAuditAppHash(binding.action.app), payloadSha256: binding.payloadSha256, effect: inspection.effect });
    return result;
  }
}
