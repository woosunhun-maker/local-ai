import { validateWebTask } from "./web-task-policy.mjs";

function coordinatorError(code, statusCode = 400) {
  return Object.assign(new Error(code), { statusCode });
}

function approvalPresentation(plan) {
  if (plan.action !== "coupang.cart.add") throw coordinatorError("unsupported_web_task_approval", 403);
  const price = new Intl.NumberFormat("ko-KR").format(plan.parameters.maxTotalPrice);
  const option = plan.parameters.option ? ` / ${plan.parameters.option}` : "";
  return {
    title: "쿠팡 장바구니 변경 승인",
    summary: `${plan.parameters.productName}${option}, 수량 ${plan.parameters.quantity}, 최대 ${price}원까지 장바구니에 추가`,
  };
}

function restorePlan(job) {
  let stored;
  try {
    stored = JSON.parse(job.planCanonical);
  } catch {
    throw coordinatorError("stored_web_task_plan_invalid", 409);
  }
  const plan = validateWebTask({
    ingress: stored.ingress,
    action: stored.action,
    parameters: stored.parameters,
  });
  if (plan.sha256 !== job.planSha256 || plan.action !== job.action) {
    throw coordinatorError("stored_web_task_plan_mismatch", 409);
  }
  return plan;
}

function resultMetadata(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw coordinatorError("invalid_web_task_executor_result", 502);
  if (typeof result.code !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(result.code)) throw coordinatorError("invalid_web_task_executor_result", 502);
  if (!Number.isSafeInteger(result.itemCount) || result.itemCount < 0 || result.itemCount > 100) {
    throw coordinatorError("invalid_web_task_executor_result", 502);
  }
  return { code: result.code, itemCount: result.itemCount };
}

export class WebTaskCoordinator {
  constructor({ taskStore, approvalStore, executor }) {
    this.taskStore = taskStore;
    this.approvalStore = approvalStore;
    this.executor = executor;
  }

  async prepare(value) {
    const plan = validateWebTask(value);
    let approval = null;
    if (plan.requiresApproval) {
      const presentation = approvalPresentation(plan);
      approval = await this.approvalStore.createRequest({
        kind: `web.${plan.action}`,
        ...presentation,
        payload: plan.canonical,
        dataCategories: plan.dataCategories,
      }, 15 * 60_000);
    }
    const job = await this.taskStore.create(plan, { approvalRequestId: approval?.id ?? null });
    return {
      job,
      plan,
      approval: approval && {
        id: approval.id,
        expiresAt: approval.expiresAt,
        payloadSha256: approval.payloadSha256,
      },
    };
  }

  async execute(id) {
    const existing = await this.taskStore.get(id);
    if (!existing) throw coordinatorError("web_task_not_found", 404);
    const plan = restorePlan(existing);
    let job = existing;
    if (job.status === "awaiting_approval") {
      const approval = await this.approvalStore.consumeApproved(job.approvalRequestId, job.planSha256);
      if (!approval) return { job, outcome: "awaiting_approval" };
      job = await this.taskStore.transition(job.id, "awaiting_approval", "ready");
    }
    if (job.status !== "ready") throw coordinatorError("web_task_not_executable", 409);
    job = await this.taskStore.transition(job.id, "ready", "running");
    try {
      const result = await this.executor.execute(plan);
      const metadata = resultMetadata(result);
      job = await this.taskStore.transition(job.id, "running", "succeeded", metadata);
      return { job, outcome: "succeeded", output: result.output ?? null };
    } catch (error) {
      const code = typeof error?.code === "string" && /^[a-z0-9._-]{1,64}$/i.test(error.code)
        ? error.code
        : "web_task_execution_failed";
      job = await this.taskStore.transition(job.id, "running", "failed", { code, itemCount: 0 });
      throw Object.assign(coordinatorError(code, error?.statusCode ?? 502), { job });
    }
  }
}
