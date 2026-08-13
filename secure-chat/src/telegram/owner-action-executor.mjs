/**
 * 앱 승인 후 안전 실행만 수행. 결제·장바구니 확정·민감 조회는 하지 않는다.
 */
import { createHash } from "node:crypto";
import { SharedChromeClient } from "../browser/shared-chrome-client.mjs";
import { OWNER_ACTION_KIND, parseOwnerActionPayload } from "./owner-action-plan.mjs";
import { createBuiltinToolRegistry } from "../tools/tool-registry.mjs";
import { assertToolExecutionAllowed } from "../approval/approval-policy.mjs";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

export class OwnerActionExecutor {
  constructor({
    approvalStore,
    proactiveStore = null,
    browser = new SharedChromeClient(),
    audit = async () => {},
    toolRegistry = createBuiltinToolRegistry(),
  } = {}) {
    if (!approvalStore || typeof approvalStore.consumeApproved !== "function") {
      throw new Error("invalid_owner_action_executor");
    }
    this.approvalStore = approvalStore;
    this.proactiveStore = proactiveStore;
    this.browser = browser;
    this.audit = audit;
    this.toolRegistry = toolRegistry;
  }

  async executeApproved(approvalId, payloadSha256) {
    assertToolExecutionAllowed({
      registry: this.toolRegistry,
      toolName: "owner.action.execute",
      channel: "local_owner_app",
      hasApproval: true,
      trustState: "owner_device",
    });
    const consumed = await this.approvalStore.consumeApproved(approvalId, payloadSha256);
    if (!consumed || consumed.kind !== OWNER_ACTION_KIND) {
      throw Object.assign(new Error("owner_action_approval_invalid"), { statusCode: 403 });
    }
    const plan = parseOwnerActionPayload(consumed.payload);
    if (sha256(consumed.payload) !== payloadSha256) {
      throw Object.assign(new Error("owner_action_payload_mismatch"), { statusCode: 403 });
    }

    if (plan.action === "owner.prepare_only") {
      const message = "승인 완료. 이 작업의 자동 실행기는 아직 연결 전입니다. 결제·민감은 직접 하세요.";
      await this.proactiveStore?.enqueue(message);
      await this.audit({ event: "owner_action_prepared", action: plan.action, payloadSha256 });
      return Object.freeze({ ok: true, action: plan.action, detail: "prepared_only" });
    }

    if (plan.action === "coupang.search") {
      const status = await this.browser.status();
      if (!status.connected) {
        const message = "승인됨. 공유 Chrome이 연결되어 있지 않아 쿠팡 검색을 열지 못했습니다. 맥에서 쿠팡 탭을 공유한 뒤 다시 요청하세요.";
        await this.proactiveStore?.enqueue(message);
        await this.audit({ event: "owner_action_blocked", action: plan.action, reason: "shared_chrome_unavailable", payloadSha256 });
        return Object.freeze({ ok: false, action: plan.action, detail: "shared_chrome_unavailable" });
      }
      const tab = await this.browser.findSharedTab("coupang");
      if (!tab) {
        const message = "승인됨. 공유된 쿠팡 탭이 없습니다. Chrome에서 쿠팡을 연 뒤 Local AI에 탭을 공유하세요.";
        await this.proactiveStore?.enqueue(message);
        await this.audit({ event: "owner_action_blocked", action: plan.action, reason: "coupang_tab_required", payloadSha256 });
        return Object.freeze({ ok: false, action: plan.action, detail: "coupang_tab_required" });
      }
      const navigated = await this.browser.navigateCoupangSearch(tab.id, plan.query);
      const followUp = plan.escalateCart
        ? `쿠팡에서 ‘${plan.query}’ 검색을 열었습니다. 상품을 고른 뒤 장바구니·결제는 직접 하세요.`
        : `쿠팡에서 ‘${plan.query}’ 검색을 열었습니다.`;
      await this.proactiveStore?.enqueue(followUp);
      await this.audit({
        event: "owner_action_executed",
        action: plan.action,
        payloadSha256,
        queryHash: sha256(plan.query),
      });
      return Object.freeze({ ok: true, action: plan.action, detail: navigated.url });
    }

    throw Object.assign(new Error("unsupported_owner_action"), { statusCode: 400 });
  }
}
