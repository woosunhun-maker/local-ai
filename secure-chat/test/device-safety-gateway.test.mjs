import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createDevicePrivacyPolicy, DEVICE_ACTION_SCHEMA } from "../src/device/device-privacy-policy.mjs";
import { DeviceSafetyGateway } from "../src/device/device-safety-gateway.mjs";

function tapAction() {
  return { schema: DEVICE_ACTION_SCHEMA, action: "tap", app: { id: "com.example.notes", name: "Notes" }, target: "Save", parameters: { x: 0.8, y: 0.9 } };
}

function harness() {
  const approvals = new Map();
  const performed = [];
  const audits = [];
  const approvalStore = {
    async createRequest(value) {
      const request = { id: "approval-request-0001", expiresAt: "2099-01-01T00:00:00.000Z", ...value, status: "pending" };
      approvals.set(request.id, request);
      return request;
    },
    async consumeApproved(id, payloadSha256) {
      const value = approvals.get(id);
      if (!value || value.status !== "approved") return null;
      if (createHash("sha256").update(value.payload).digest("hex") !== payloadSha256) throw new Error("hash mismatch");
      value.status = "consumed";
      return value;
    },
  };
  const driver = {
    app: { id: "com.example.notes", name: "Notes" },
    async getForegroundApp() { return this.app; },
    async captureMaskedOcr({ maskRegions }) { this.receivedMasks = maskRegions; return "Call 010-1234-5678"; },
    async perform(action) { performed.push(action); return { ok: true }; },
  };
  const gateway = new DeviceSafetyGateway({
    policy: createDevicePrivacyPolicy({
      allowedApps: ["com.example.notes"],
      privateRegions: { "com.example.notes": [{ x: 0, y: 0, width: 1, height: 0.1, label: "account" }] },
    }),
    approvalStore,
    driver,
    auditSink: (event) => audits.push(event),
  });
  return { gateway, approvals, performed, audits, driver };
}

test("raw screen data is not returned and configured regions are masked before OCR", async () => {
  const { gateway, audits, driver } = harness();
  const result = await gateway.observe();
  assert.deepEqual(driver.receivedMasks, [{ x: 0, y: 0, width: 1, height: 0.1, label: "account" }]);
  assert.equal(result.text.includes("010-1234-5678"), false);
  assert.equal(JSON.stringify(audits).includes("010-1234-5678"), false);
  assert.equal(JSON.stringify(audits).includes("Notes"), false);
});

test("a write is bound to a one-time approval and cannot be replayed", async () => {
  const { gateway, approvals, performed } = harness();
  const prepared = await gateway.prepare(tapAction());
  assert.equal(prepared.status, "approval_required");
  await assert.rejects(() => gateway.execute(tapAction()), { code: "device_approval_required" });
  approvals.get(prepared.approvalId).status = "approved";
  assert.deepEqual(await gateway.execute(tapAction(), { approvalId: prepared.approvalId }), { ok: true });
  assert.equal(performed.length, 1);
  await assert.rejects(() => gateway.execute(tapAction(), { approvalId: prepared.approvalId }), { code: "device_approval_invalid_or_expired" });
  assert.equal(performed.length, 1);
});

test("approval cannot authorize a changed action or a changed foreground app", async () => {
  const { gateway, approvals, performed, driver } = harness();
  const prepared = await gateway.prepare(tapAction());
  approvals.get(prepared.approvalId).status = "approved";
  await assert.rejects(() => gateway.execute({ ...tapAction(), target: "Delete" }, { approvalId: prepared.approvalId }));
  assert.equal(performed.length, 0);
  driver.app = { id: "com.other", name: "Other" };
  await assert.rejects(() => gateway.execute(tapAction(), { approvalId: prepared.approvalId }), { code: "app_not_allowlisted" });
});
