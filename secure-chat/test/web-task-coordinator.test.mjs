import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalStore, approvalSigningPayload } from "../src/approval-store.mjs";
import { WebTaskCoordinator } from "../src/web-task-coordinator.mjs";
import { WebTaskStore } from "../src/web-task-store.mjs";

async function fixture(execute) {
  const root = await mkdtemp(join(tmpdir(), "local-ai-web-coordinator-"));
  const approvalStore = new ApprovalStore(join(root, "approvals.json"));
  const taskStore = new WebTaskStore(join(root, "jobs.json"));
  await approvalStore.initialize();
  await taskStore.initialize();
  return {
    root,
    approvalStore,
    taskStore,
    coordinator: new WebTaskCoordinator({ taskStore, approvalStore, executor: { execute } }),
  };
}

test("private mail output is returned ephemerally to the owner app and never written to the job store", async () => {
  const { root, coordinator } = await fixture(async () => ({
    code: "mail_list_ready",
    itemCount: 1,
    output: [{ sender: "private@example.com", subject: "비공개 제목" }],
  }));
  const prepared = await coordinator.prepare({
    ingress: "local_owner_app",
    action: "mail.important.list",
    parameters: { provider: "gmail", maxResults: 5, unreadOnly: true },
  });
  assert.equal(prepared.approval, null);
  const completed = await coordinator.execute(prepared.job.id);
  assert.equal(completed.output[0].subject, "비공개 제목");
  const persisted = await readFile(join(root, "jobs.json"), "utf8");
  assert.equal(persisted.includes("비공개 제목"), false);
  assert.equal(persisted.includes("private@example.com"), false);
});

test("cart mutation executes once only after the exact owner-device approval", async () => {
  let calls = 0;
  const { coordinator, approvalStore } = await fixture(async (plan) => {
    calls += 1;
    assert.equal(plan.parameters.maxTotalPrice, 7500);
    return { code: "cart_item_added", itemCount: 1, output: { confirmed: true } };
  });
  const prepared = await coordinator.prepare({
    ingress: "local_owner_app",
    action: "coupang.cart.add",
    parameters: {
      productUrl: "https://www.coupang.com/vp/products/123?itemId=456&vendorItemId=789",
      productName: "생수 2L 6개",
      option: "2L × 6",
      quantity: 1,
      expectedUnitPrice: 7000,
      maxTotalPrice: 7500,
      currency: "KRW",
    },
  });
  assert.equal((await coordinator.execute(prepared.job.id)).outcome, "awaiting_approval");
  assert.equal(calls, 0);

  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyDER = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  await approvalStore.registerDeviceKey("owner-iphone", publicKeyDER);
  const pending = (await approvalStore.listPending()).find((entry) => entry.id === prepared.approval.id);
  const signatureDER = sign("sha256", approvalSigningPayload(pending, "approved"), key.privateKey).toString("base64");
  await approvalStore.decide({ id: pending.id, deviceId: "owner-iphone", decision: "approved", signatureDER });

  const completed = await coordinator.execute(prepared.job.id);
  assert.equal(completed.outcome, "succeeded");
  assert.equal(calls, 1);
  await assert.rejects(() => coordinator.execute(prepared.job.id), /web_task_not_executable/);
  assert.equal(calls, 1);
});

test("an uncertain browser failure is terminal and is never automatically retried", async () => {
  let calls = 0;
  const { coordinator } = await fixture(async () => {
    calls += 1;
    throw Object.assign(new Error("connection lost"), { code: "browser_result_uncertain", statusCode: 502 });
  });
  const prepared = await coordinator.prepare({
    ingress: "local_owner_app",
    action: "mail.important.list",
    parameters: { provider: "gmail", maxResults: 5, unreadOnly: true },
  });
  await assert.rejects(() => coordinator.execute(prepared.job.id), /browser_result_uncertain/);
  await assert.rejects(() => coordinator.execute(prepared.job.id), /web_task_not_executable/);
  assert.equal(calls, 1);
});
