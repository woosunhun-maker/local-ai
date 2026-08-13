import { redactCredentials } from "../security/credential-patterns.mjs";
import { canonicalizeJson, deepFreeze, sha256Hex } from "../growth/canonical.mjs";

export const DEVICE_POLICY_VERSION = "local-ai-device-privacy-v1";
export const DEVICE_ACTION_SCHEMA = "local-ai.device-action.v1";

const ACTION_EFFECTS = new Map([
  ["observe", "read"], ["launch_app", "navigation"], ["swipe", "navigation"],
  ["tap", "device_write"], ["type_text", "device_write"],
  ["send", "external_write"], ["upload", "external_write"],
  ["delete", "destructive"], ["install", "security"],
  ["uninstall", "security"], ["change_permission", "security"],
  ["purchase", "financial"], ["payment", "financial"], ["transfer", "financial"],
]);

const APPROVAL_EFFECTS = new Set(["device_write", "external_write", "destructive", "security"]);

const NEVER_AUTOMATE_PATTERNS = Object.freeze([
  /(?:authenticator|authentication|otp|2fa|one.?time|verification.?code|인증번호|인증앱)/iu,
  /(?:password|passwd|1password|bitwarden|lastpass|keychain|키체인|비밀번호|패스워드)/iu,
  /(?:bank|banking|card|wallet|finance|stock|securities|crypto|은행|카드|증권|주식|가상자산|지갑|페이)/iu,
  /(?:health|hospital|medical|patient|fitness|건강|병원|진료|의료)/iu,
  /(?:government|passport|resident|identity|정부|여권|주민등록|신분증)/iu,
  /(?:permissioncontroller|systemui|settings|preferences|설정|권한)/iu,
]);

const PRIVATE_TEXT_PATTERNS = Object.freeze([
  Object.freeze({ code: "resident_id", expression: /\b\d{6}[- ]?[1-4]\d{6}\b/gu }),
  Object.freeze({ code: "email", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu }),
  Object.freeze({ code: "phone", expression: /(?:\+?82[- .]?)?0?1[016789][-. ]?\d{3,4}[-. ]?\d{4}/gu }),
  Object.freeze({ code: "payment_card", expression: /\b(?:\d[ -]*?){13,19}\b/gu }),
  Object.freeze({ code: "otp", expression: /(?:otp|2fa|인증번호|인증코드|verification\s*code)\s*[:#-]?\s*\d{4,8}/giu }),
]);

const ACTION_KEYS = new Set(["schema", "action", "app", "target", "parameters"]);
const APP_KEYS = new Set(["id", "name"]);
const REGION_KEYS = new Set(["x", "y", "width", "height", "label"]);

function policyError(code, statusCode = 400) {
  return Object.assign(new Error(code), { name: "DevicePrivacyError", code, statusCode });
}

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw policyError(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) throw policyError(code);
}

function normalizedLabel(value, code, max = 160) {
  if (typeof value !== "string") throw policyError(code);
  const normalized = value.normalize("NFC").trim();
  if (normalized.length < 1 || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) throw policyError(code);
  return normalized;
}

function normalizeApp(app) {
  exactKeys(app, APP_KEYS, "invalid_device_app");
  return { id: normalizedLabel(app.id, "invalid_device_app_id", 200), name: normalizedLabel(app.name, "invalid_device_app_name", 120) };
}

function normalizeParameters(action, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw policyError("invalid_device_parameters");
  const parameters = structuredClone(value);
  if (canonicalizeJson(parameters).length > 8_000) throw policyError("device_parameters_too_large");
  const keys = Object.keys(parameters);
  const requireKeys = (...expected) => {
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) throw policyError("invalid_device_parameters");
  };
  const boundedCoordinate = (name) => {
    if (typeof parameters[name] !== "number" || !Number.isFinite(parameters[name]) || parameters[name] < 0 || parameters[name] > 1) throw policyError("invalid_device_coordinate");
  };
  if (["observe", "launch_app"].includes(action)) requireKeys();
  if (action === "swipe") {
    requireKeys("direction");
    if (!["up", "down", "left", "right"].includes(parameters.direction)) throw policyError("invalid_device_swipe_direction");
  }
  if (action === "tap") {
    requireKeys("x", "y");
    boundedCoordinate("x");
    boundedCoordinate("y");
  }
  if (["type_text", "send"].includes(action)) {
    requireKeys("text");
    parameters.text = normalizedLabel(parameters.text, "invalid_device_text", 2_000);
  }
  if (action === "upload") {
    requireKeys("artifactId");
    parameters.artifactId = normalizedLabel(parameters.artifactId, "invalid_device_artifact_id", 128);
  }
  if (action === "delete") {
    requireKeys("itemId");
    parameters.itemId = normalizedLabel(parameters.itemId, "invalid_device_item_id", 200);
  }
  if (["install", "uninstall"].includes(action)) {
    requireKeys("packageId");
    parameters.packageId = normalizedLabel(parameters.packageId, "invalid_device_package_id", 200);
  }
  if (action === "change_permission") {
    requireKeys("permission", "state");
    parameters.permission = normalizedLabel(parameters.permission, "invalid_device_permission", 120);
    if (!["grant", "revoke"].includes(parameters.state)) throw policyError("invalid_device_permission_state");
  }
  if (["purchase", "payment", "transfer"].includes(action)) {
    requireKeys("amount", "currency");
    if (typeof parameters.amount !== "number" || !Number.isFinite(parameters.amount) || parameters.amount <= 0) throw policyError("invalid_device_financial_amount");
    if (typeof parameters.currency !== "string" || !/^[A-Z]{3}$/u.test(parameters.currency)) throw policyError("invalid_device_currency");
  }
  return parameters;
}

export function normalizeDeviceAction(value) {
  exactKeys(value, ACTION_KEYS, "invalid_device_action");
  if (value.schema !== DEVICE_ACTION_SCHEMA) throw policyError("invalid_device_action_schema");
  if (!ACTION_EFFECTS.has(value.action)) throw policyError("unsupported_device_action");
  return deepFreeze({
    schema: DEVICE_ACTION_SCHEMA,
    action: value.action,
    app: normalizeApp(value.app),
    target: normalizedLabel(value.target, "invalid_device_target"),
    parameters: normalizeParameters(value.action, value.parameters),
  });
}

function normalizePrivateRegions(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw policyError("invalid_private_regions");
  const normalized = {};
  for (const [rawAppId, regions] of Object.entries(value)) {
    const appId = normalizedLabel(rawAppId, "invalid_private_region_app", 200).toLowerCase();
    if (!allowed.has(appId) || !Array.isArray(regions) || regions.length > 32) throw policyError("invalid_private_regions");
    normalized[appId] = regions.map((region) => {
      exactKeys(region, REGION_KEYS, "invalid_private_region");
      const result = {
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        label: normalizedLabel(region.label, "invalid_private_region_label", 80),
      };
      for (const key of ["x", "y", "width", "height"]) {
        if (typeof result[key] !== "number" || !Number.isFinite(result[key]) || result[key] < 0 || result[key] > 1) throw policyError("invalid_private_region_coordinate");
      }
      if (result.width <= 0 || result.height <= 0 || result.x + result.width > 1 || result.y + result.height > 1) throw policyError("invalid_private_region_bounds");
      return result;
    });
  }
  return normalized;
}

export function createDevicePrivacyPolicy({ allowedApps = [], blockedApps = [], privateRegions = {} } = {}) {
  if (!Array.isArray(allowedApps) || !Array.isArray(blockedApps)) throw policyError("invalid_device_app_policy");
  const allowed = new Set(allowedApps.map((value) => normalizedLabel(value, "invalid_allowed_app", 200).toLowerCase()));
  const blocked = new Set(blockedApps.map((value) => normalizedLabel(value, "invalid_blocked_app", 200).toLowerCase()));
  return deepFreeze({
    version: DEVICE_POLICY_VERSION,
    allowedApps: [...allowed].sort(),
    blockedApps: [...blocked].sort(),
    privateRegions: normalizePrivateRegions(privateRegions, allowed),
  });
}

export function inspectDeviceApp(appValue, policy) {
  const app = normalizeApp(appValue);
  if (!policy || policy.version !== DEVICE_POLICY_VERSION) throw policyError("invalid_device_policy");
  const id = app.id.toLowerCase();
  const name = app.name.toLowerCase();
  const identity = `${app.id}\n${app.name}`;
  if (NEVER_AUTOMATE_PATTERNS.some((pattern) => pattern.test(identity))) return Object.freeze({ allowed: false, reason: "sensitive_app_denied", app });
  if (policy.blockedApps.includes(id) || policy.blockedApps.includes(name)) return Object.freeze({ allowed: false, reason: "configured_app_denied", app });
  // Display names are attacker-controlled and non-unique. Only a stable bundle/package id grants access.
  if (!policy.allowedApps.includes(id)) return Object.freeze({ allowed: false, reason: "app_not_allowlisted", app });
  return Object.freeze({ allowed: true, reason: "app_allowlisted", app, privateRegions: policy.privateRegions[id] ?? Object.freeze([]) });
}

function pointInsideRegion(x, y, region) {
  return x >= region.x && x <= region.x + region.width && y >= region.y && y <= region.y + region.height;
}

export function inspectDeviceAction(value, policy) {
  let action;
  try { action = normalizeDeviceAction(value); } catch (error) {
    return Object.freeze({ allowed: false, approvalRequired: false, reason: error.code ?? "invalid_device_action" });
  }
  const appInspection = inspectDeviceApp(action.app, policy);
  if (!appInspection.allowed) return Object.freeze({ allowed: false, approvalRequired: false, reason: appInspection.reason, action });
  if (action.action === "tap" && appInspection.privateRegions.some((region) => pointInsideRegion(action.parameters.x, action.parameters.y, region))) {
    return Object.freeze({ allowed: false, approvalRequired: false, reason: "private_region_denied", action });
  }
  const effect = ACTION_EFFECTS.get(action.action);
  if (effect === "financial") return Object.freeze({ allowed: false, approvalRequired: false, reason: "financial_action_denied", action });
  return Object.freeze({ allowed: true, approvalRequired: APPROVAL_EFFECTS.has(effect), reason: APPROVAL_EFFECTS.has(effect) ? "signed_approval_required" : "policy_allowed", effect, action });
}

export function deviceActionBinding(value) {
  const action = normalizeDeviceAction(value);
  const payload = canonicalizeJson(action);
  return Object.freeze({ action, payload, payloadSha256: sha256Hex(payload) });
}

export function sanitizeOcrText(value) {
  if (typeof value !== "string") throw policyError("ocr_text_required");
  if (value.length > 100_000) throw policyError("ocr_text_too_large");
  const findings = [];
  let text = redactCredentials(value, { includeLooseAssignments: true, replacement: "[비밀정보 가림]" });
  if (text !== value) findings.push("credential");
  for (const pattern of PRIVATE_TEXT_PATTERNS) {
    const replaced = text.replace(pattern.expression, `[개인정보 가림:${pattern.code}]`);
    if (replaced !== text) findings.push(pattern.code);
    text = replaced;
  }
  return Object.freeze({ text, findings: Object.freeze([...new Set(findings)].sort()) });
}

export function sameDeviceApp(left, right) {
  const a = normalizeApp(left);
  const b = normalizeApp(right);
  return a.id === b.id && a.name === b.name;
}
