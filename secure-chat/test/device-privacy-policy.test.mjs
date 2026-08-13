import assert from "node:assert/strict";
import test from "node:test";
import { createDevicePrivacyPolicy, DEVICE_ACTION_SCHEMA, inspectDeviceAction, inspectDeviceApp, sanitizeOcrText } from "../src/device/device-privacy-policy.mjs";

const policy = createDevicePrivacyPolicy({
  allowedApps: ["com.example.notes"],
  blockedApps: ["com.example.private"],
  privateRegions: {
    "com.example.notes": [{ x: 0, y: 0, width: 1, height: 0.2, label: "account header" }],
  },
});

function action(actionName, parameters = {}) {
  return { schema: DEVICE_ACTION_SCHEMA, action: actionName, app: { id: "com.example.notes", name: "메모" }, target: "새 메모 버튼", parameters };
}

test("phone apps are denied by default and sensitive categories cannot be allowlisted", () => {
  assert.equal(inspectDeviceApp({ id: "com.unknown", name: "Unknown" }, policy).reason, "app_not_allowlisted");
  assert.equal(inspectDeviceApp({ id: "com.example.private", name: "Private" }, policy).reason, "configured_app_denied");
  const permissive = createDevicePrivacyPolicy({ allowedApps: ["com.bank.mobile"] });
  assert.equal(inspectDeviceApp({ id: "com.bank.mobile", name: "My Bank" }, permissive).reason, "sensitive_app_denied");
});

test("screen reads and navigation are bounded while writes require signed approval", () => {
  assert.equal(inspectDeviceAction(action("observe"), policy).approvalRequired, false);
  assert.equal(inspectDeviceAction(action("swipe", { direction: "down" }), policy).approvalRequired, false);
  assert.equal(inspectDeviceAction(action("tap", { x: 0.5, y: 0.8 }), policy).approvalRequired, true);
  assert.equal(inspectDeviceAction(action("type_text", { text: "안전한 메모" }), policy).approvalRequired, true);
  assert.equal(inspectDeviceAction(action("payment", { amount: 1000, currency: "KRW" }), policy).reason, "financial_action_denied");
  assert.equal(inspectDeviceAction(action("tap", { x: 0.5, y: 0.1 }), policy).reason, "private_region_denied");
});

test("OCR is redacted before model-visible output", () => {
  const result = sanitizeOcrText("이메일 me@example.com, 전화 010-1234-5678, 인증번호 123456, password=very-long-password");
  assert.equal(result.text.includes("me@example.com"), false);
  assert.equal(result.text.includes("010-1234-5678"), false);
  assert.equal(result.text.includes("123456"), false);
  assert.equal(result.text.includes("very-long-password"), false);
  assert.deepEqual(result.findings, ["credential", "email", "otp", "phone"]);
});

test("unknown action fields and unsupported actions fail closed", () => {
  assert.equal(inspectDeviceAction({ ...action("observe"), effect: "read" }, policy).allowed, false);
  assert.equal(inspectDeviceAction(action("read_otp"), policy).reason, "unsupported_device_action");
  assert.equal(inspectDeviceAction(action("tap", { x: 200, y: 400 }), policy).reason, "invalid_device_coordinate");
  assert.equal(inspectDeviceAction(action("swipe", { direction: "diagonal" }), policy).reason, "invalid_device_swipe_direction");
  assert.throws(() => createDevicePrivacyPolicy({
    allowedApps: ["com.example.notes"],
    privateRegions: { "com.example.notes": [{ x: 0.9, y: 0, width: 0.2, height: 0.2, label: "outside" }] },
  }), { code: "invalid_private_region_bounds" });
});
