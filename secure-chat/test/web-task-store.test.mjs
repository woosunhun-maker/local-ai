import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateWebTask } from "../src/web-task-policy.mjs";
import { WebTaskStore } from "../src/web-task-store.mjs";

test("web task store persists a hash-bound plan but never raw browser result content", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-web-tasks-"));
  const path = join(root, "jobs.json");
  const store = new WebTaskStore(path);
  await store.initialize();
  const plan = validateWebTask({
    ingress: "local_owner_app",
    action: "mail.important.list",
    parameters: { provider: "gmail", maxResults: 5, unreadOnly: true },
  });
  const job = await store.create(plan);
  assert.equal(job.status, "ready");
  await store.transition(job.id, "ready", "running");
  await store.transition(job.id, "running", "succeeded", { code: "mail_list_ready", itemCount: 3 });
  const raw = await readFile(path, "utf8");
  assert.equal(raw.includes("mail body"), false);
  assert.equal(JSON.parse(raw).jobs[0].planCanonical, plan.canonical);
  assert.equal((await store.get(job.id)).status, "succeeded");
});

test("mutation jobs require an approval binding and invalid transitions fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-web-tasks-"));
  const store = new WebTaskStore(join(root, "jobs.json"));
  await store.initialize();
  const plan = validateWebTask({
    ingress: "local_owner_app",
    action: "coupang.cart.add",
    parameters: {
      productUrl: "https://www.coupang.com/vp/products/123",
      productName: "상품",
      option: null,
      quantity: 1,
      expectedUnitPrice: 1000,
      maxTotalPrice: 1000,
      currency: "KRW",
    },
  });
  await assert.rejects(() => store.create(plan), /invalid_web_task_approval_binding/);
  const job = await store.create(plan, { approvalRequestId: "approval-123" });
  assert.equal(job.status, "awaiting_approval");
  await assert.rejects(() => store.transition(job.id, "awaiting_approval", "running"), /invalid_web_task_transition/);
});
