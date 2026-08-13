import { EphemeralTelegramContext } from "./ephemeral-context.mjs";
import { collectProjectProgress, formatProjectProgress } from "../project-progress.mjs";
import { askLocalModel } from "./local-chat-client.mjs";
import { formatLocalModelInventory } from "./local-model-inventory.mjs";
import { collectLocalRuntimeStatus, formatLocalRuntimeStatus } from "./local-runtime-status.mjs";
import { inspectTelegramCodexCommand } from "./codex-command-policy.mjs";
import { OwnerActionBridge } from "./owner-action-bridge.mjs";
import { inspectTelegramMessage } from "./policy.mjs";
import { normalizeTaskPrincipal } from "./principal.mjs";
import { createStructuredEventLog, newCorrelationId } from "../structured-event-log.mjs";
import { LOCAL_CONVERSATION_MODEL } from "../local-model-routing.mjs";

const CODEX_HELP = [
  "Telegram에서는 Codex 실행 작업을 접수하지 않습니다.",
  "/codex status",
  "점검·초안은 Local AI 앱에서 OpenAI 외부 전송 계획과 코드 스냅샷 해시를 확인한 뒤 Face ID 또는 기기 암호로 승인해 주세요.",
].join("\n");
const CODEX_OWNER_APP_REQUIRED = "Telegram에서는 Codex 작업을 실행하지 않습니다. Local AI 앱에서 OpenAI 외부 전송 계획과 코드 스냅샷 해시를 확인하고 Face ID 또는 기기 암호로 승인해 주세요.";

function publicJobId(job) {
  const value = String(job?.id ?? "");
  return /^[A-Za-z0-9_-]{8,128}$/.test(value) ? value.slice(0, 8) : "확인불가";
}

function canReplyTo(message, ownerId, chatId) {
  return message?.chat?.type === "private" &&
    String(message?.from?.id ?? "") === ownerId &&
    String(message?.chat?.id ?? "") === chatId;
}

export class TelegramGeneralChatService {
  constructor({
    ownerId,
    chatId,
    ownerGeneration,
    client,
    context = new EphemeralTelegramContext(),
    ask = askLocalModel,
    codexTasks = null,
    runtimeStatus = collectLocalRuntimeStatus,
    ownerActionBridge = null,
    structuredLog = null,
  } = {}) {
    const principal = normalizeTaskPrincipal({ ownerId, chatId, ownerGeneration }, "invalid_telegram");
    if (!client || typeof client.sendText !== "function") throw new Error("invalid_telegram_client");
    this.ownerId = principal.ownerId;
    this.chatId = principal.chatId;
    this.ownerGeneration = principal.ownerGeneration;
    this.client = client;
    this.context = context;
    this.ask = ask;
    this.codexTasks = codexTasks;
    if (typeof runtimeStatus !== "function") throw new Error("invalid_runtime_status_provider");
    this.runtimeStatus = runtimeStatus;
    if (ownerActionBridge != null && !(ownerActionBridge instanceof OwnerActionBridge) && typeof ownerActionBridge.handleActionText !== "function") {
      throw new Error("invalid_owner_action_bridge");
    }
    this.ownerActionBridge = ownerActionBridge;
    this.structuredLog = structuredLog;
  }

  async #emit(event, fields) {
    if (!this.structuredLog?.emit) return;
    await this.structuredLog.emit(event, fields).catch(() => {});
  }

  async handleUpdate(update) {
    const message = update?.message;
    const correlationId = newCorrelationId();
    const codexDecision = inspectTelegramCodexCommand(message, this.ownerId);
    const chatId = message?.chat?.id;
    if (codexDecision.matched) {
      if (!codexDecision.allowed) {
        if (canReplyTo(message, this.ownerId, this.chatId)) await this.client.sendText(chatId, codexDecision.response);
        return Object.freeze({ outcome: "blocked", reason: codexDecision.reason });
      }
      if (codexDecision.command === "help") {
        await this.client.sendText(chatId, CODEX_HELP);
        return Object.freeze({ outcome: "replied", reason: "codex_help" });
      }
      if (!this.codexTasks) {
        await this.client.sendText(chatId, "Codex 격리 작업 통로가 아직 활성화되지 않았습니다. Local AI 앱에서 상태를 확인해 주세요.");
        return Object.freeze({ outcome: "blocked", reason: "codex_bridge_disabled" });
      }
      if (codexDecision.command === "status") {
        const status = await this.codexTasks.summary();
        const recent = status.recent ? ` · 최근 #${publicJobId(status.recent)} ${status.recent.status}` : "";
        await this.client.sendText(chatId, `Codex 작업: 대기 ${status.queued} · 실행 ${status.running} · 결과 대기 ${status.undelivered}${recent}`);
        return Object.freeze({ outcome: "replied", reason: "codex_status" });
      }
      await this.client.sendText(chatId, CODEX_OWNER_APP_REQUIRED);
      return Object.freeze({ outcome: "blocked", reason: "owner_app_approval_required" });
    }

    const decision = inspectTelegramMessage(message, this.ownerId);
    if (decision.clearContext) this.context.clear(this.ownerId);
    if (decision.statusCommand && canReplyTo(message, this.ownerId, this.chatId)) {
      const status = await this.runtimeStatus({ codexTasks: this.codexTasks });
      await this.client.sendText(chatId, formatLocalRuntimeStatus(status));
      return Object.freeze({ outcome: "replied", reason: "runtime_status" });
    }
    if (decision.modelsCommand && canReplyTo(message, this.ownerId, this.chatId)) {
      await this.client.sendText(chatId, formatLocalModelInventory({ codexReady: Boolean(this.codexTasks) }));
      return Object.freeze({ outcome: "replied", reason: "runtime_models" });
    }
    if (decision.progressCommand && canReplyTo(message, this.ownerId, this.chatId)) {
      await this.client.sendText(chatId, formatProjectProgress(collectProjectProgress()));
      return Object.freeze({ outcome: "replied", reason: "project_progress" });
    }
    if (!decision.allowed) {
      if (
        decision.reason === "private_or_action_intent"
        && this.ownerActionBridge
        && typeof message?.text === "string"
        && canReplyTo(message, this.ownerId, this.chatId)
      ) {
        const bridged = await this.ownerActionBridge.handleActionText(message.text);
        await this.client.sendText(chatId, bridged.telegramMessage);
        return Object.freeze({
          outcome: bridged.outcome === "approval_created" ? "approval_created" : "blocked",
          reason: bridged.reason,
        });
      }
      if (chatId !== undefined && canReplyTo(message, this.ownerId, this.chatId)) {
        await this.client.sendText(chatId, decision.response);
      }
      return Object.freeze({ outcome: "blocked", reason: decision.reason });
    }

    await this.#emit("request_received", { correlationId, ingress: "telegram" });
    await this.#emit("router_selected", {
      correlationId,
      mode: "fast",
      conversation_model: LOCAL_CONVERSATION_MODEL,
    });
    await this.#emit("model_invoked", {
      correlationId,
      route: "telegram_general",
      model: LOCAL_CONVERSATION_MODEL,
      ingress: "telegram",
    });

    const previous = this.context.get(this.ownerId);
    const prompt = [...previous, { role: "user", content: decision.text }];
    try {
      const answer = await this.ask(prompt);
      if (typeof answer !== "string" || !answer.trim() || answer.length > 8_000) throw new Error("invalid_local_model_response");
      const normalizedAnswer = answer.trim();
      this.context.append(this.ownerId, "user", decision.text);
      this.context.append(this.ownerId, "assistant", normalizedAnswer);
      await this.client.sendText(chatId, normalizedAnswer);
      await this.#emit("task_completed", { correlationId, mode: "fast", ingress: "telegram" });
      return Object.freeze({ outcome: "replied", reason: "ordinary_conversation" });
    } catch (error) {
      await this.#emit("task_failed", {
        correlationId,
        mode: "fast",
        ingress: "telegram",
        error_class: error?.name ?? "Error",
      });
      throw error;
    }
  }
}

export function defaultTelegramStructuredLog() {
  return createStructuredEventLog({ logDir: "/Users/hun/PrivateAI/logs/structured" });
}
