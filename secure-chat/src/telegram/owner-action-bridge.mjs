/**
 * Telegram → 승인 요청 생성 → (선택) 알림/받은함.
 * 실행은 앱 승인 후에만 owner-action-executor가 담당한다.
 */
import {
  approvalRequestFromClassification,
  classifyOwnerAction,
} from "./owner-action-plan.mjs";
import { createBuiltinToolRegistry } from "../tools/tool-registry.mjs";
import { assertToolExecutionAllowed } from "../approval/approval-policy.mjs";

export async function notifyOwnerOfActionApproval({
  fetchImpl = fetch,
  tokenReader,
  haUrl = "http://homeassistant.local:8123",
} = {}) {
  if (typeof tokenReader !== "function") return false;
  let token;
  try {
    token = await tokenReader();
    const response = await fetchImpl(`${haUrl}/api/services/notify/mobile_app_aibbon`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "로컬AI 실행 승인",
        message: "Telegram에서 요청한 작업 승인이 준비되었습니다. 앱에서 확인하세요. 결제·민감은 직접.",
        data: {
          tag: "local_ai_owner_action_approval",
          url: "localai://growth",
          push: { "interruption-level": "time-sensitive" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok === true;
  } catch {
    return false;
  } finally {
    token = undefined;
  }
}

export class OwnerActionBridge {
  constructor({
    approvalStore,
    proactiveStore = null,
    notify = notifyOwnerOfActionApproval,
    toolRegistry = createBuiltinToolRegistry(),
    channel = "telegram",
  } = {}) {
    if (!approvalStore || typeof approvalStore.createRequest !== "function") {
      throw new Error("invalid_owner_action_bridge");
    }
    this.approvalStore = approvalStore;
    this.proactiveStore = proactiveStore;
    this.notify = notify;
    this.toolRegistry = toolRegistry;
    this.channel = channel;
  }

  async handleActionText(text) {
    assertToolExecutionAllowed({
      registry: this.toolRegistry,
      toolName: "owner.action.request",
      channel: this.channel,
      hasApproval: false,
      trustState: "owner_device",
    });

    const classification = classifyOwnerAction(text);
    if (classification.mode === "human_only" || classification.mode === "reject") {
      return Object.freeze({
        outcome: "human_only",
        reason: classification.reason,
        telegramMessage: classification.message
          ?? "이 요청은 자동 실행 대상이 아닙니다. 직접 진행해 주세요.",
      });
    }

    const request = approvalRequestFromClassification(classification);
    const created = await this.approvalStore.createRequest(request, 10 * 60_000);
    try {
      await this.proactiveStore?.enqueue(
        `승인 대기: ${created.title}. 앱에서 Face ID/암호로 승인하면 Mac이 진행합니다. 결제·민감은 직접.`,
      );
    } catch {
      // 받은함 실패해도 승인 자체는 유지
    }
    try {
      await this.notify();
    } catch {
      // 푸시 실패해도 Telegram 안내는 보냄
    }

    return Object.freeze({
      outcome: "approval_created",
      reason: "owner_action_pending",
      approvalId: created.id,
      telegramMessage: [
        "앱에 실행 승인 요청을 보냈습니다.",
        `내용: ${created.summary}`,
        "나의 Local AI 앱 → 보안 승인에서 확인하세요.",
        "결제·비밀번호 등 민감 단계는 직접 하세요.",
      ].join("\n"),
    });
  }
}
