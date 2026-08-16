#!/opt/homebrew/bin/node

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AuthStore } from "./auth-store.mjs";
import { ApprovalStore } from "./approval-store.mjs";
import { SharedChromeClient } from "./browser/shared-chrome-client.mjs";
import { OwnerCodexTaskCoordinator } from "./codex/owner-task-coordinator.mjs";
import { CodexTaskStore } from "./codex/task-store.mjs";
import { GrowthCoordinator } from "./growth/coordinator.mjs";
import { DLP_POLICY_VERSION } from "./growth/dlp.mjs";
import {
  createOpenClawGrowthDispatchAdapter,
  parseStructuredAdvice,
  proposalContentFromAdvice,
} from "./growth/openclaw-dispatch-adapter.mjs";
import { GrowthProposalStore } from "./growth/proposal-store.mjs";
import { assertChatModeAccess, resolveChatMode, trimChatContext } from "./chat-routing.mjs";
import { readOwnerAppPhoto } from "./vision/app-photo-read.mjs";
import {
  ConfirmedMemoryStore,
  ConfirmedMemoryStoreError,
  withMemorySystemMessage,
} from "./confirmed-memory-store.mjs";
import { assertConversationModel, LOCAL_CONVERSATION_MODEL, LOCAL_EFFECT_PLANNING_MODEL } from "./local-model-routing.mjs";
import { ollamaStreamToSSE, toOpenAICompletion } from "./ollama-protocol.mjs";
import { verifyOpenAIEventStream } from "./openai-stream.mjs";
import { ProactiveStore } from "./proactive-store.mjs";
import { FixedWindowRateLimiter, ratePolicyFor } from "./rate-limiter.mjs";
import { createRequestSignal } from "./request-lifecycle.mjs";
import { createStructuredEventLog } from "./structured-event-log.mjs";
import { runSystemCommand } from "./system/introspection.mjs";
import { TaskManagerStore } from "./task/task-manager-store.mjs";
import { createEvidenceRecord } from "./evidence/evidence.mjs";
import { createTaskExecutor } from "./executor/task-executor.mjs";
import { createTaskOrchestrator } from "./executor/task-orchestrator.mjs";
import { createCursorDevelopmentAdapter } from "./adapters/cursor/cursor-development-adapter.mjs";
import { DevelopmentLedgerStore } from "./ledger/development-ledger.mjs";
import { DecisionMemoryStore } from "./memory/decision-memory-store.mjs";
import { DiscussionContextStore } from "./memory/discussion-context-store.mjs";
import { createMemoryContextFacade } from "./memory/context-facade.mjs";
import { createBuiltinToolRegistry } from "./tools/tool-registry.mjs";
import { evaluateApprovalPolicy } from "./approval/approval-policy.mjs";
import { getIosAppReleaseInfo } from "./ios-app-release.mjs";
import { DevelopmentRunStore } from "./supervisor/development-run-store.mjs";
import { createDevelopmentSupervisor } from "./supervisor/development-supervisor.mjs";
import { assertMergeExecutionForbidden } from "./supervisor/merge-to-main-schema.mjs";
import { streamTtsEvents } from "./tts/http-stream.mjs";
import { createRuntimeTtsRegistry } from "./tts/pinned-runtime.mjs";
import { SpeechSession } from "./tts/speech-session.mjs";
import { WEB_TASK_ACTIONS } from "./web-task-policy.mjs";
import { IntentShadowMonitor } from "./trust/intent-shadow-monitor.mjs";
import { codexWorkerReady } from "./telegram/codex-runtime-readiness.mjs";
import { OWNER_ACTION_KIND } from "./telegram/owner-action-plan.mjs";
import { OwnerActionExecutor } from "./telegram/owner-action-executor.mjs";
import { RoomStore } from "./room-store.mjs";
import { openaiAskStatus } from "./openai-ask.mjs";
import { askRoomModelTokens } from "./room-ask.mjs";
import { LessonStore } from "./lesson-store.mjs";
import {
  executeApprovedHouseDo,
  isFaceIdGateCommand,
  ROOM_HOUSE_DO_KIND,
} from "./room-faceid-gate.mjs";
import { isMacDoCommand } from "./room-mac-do.mjs";
import { planRoomTurn, roomTurnAnswer, roomTurnTokens } from "./room-turn.mjs";
import { PairPinStore } from "./pair-pin.mjs";
import { ConversationStore } from "./conversation-store.mjs";
import { JoinStore } from "./join-store.mjs";
import { CAPABILITIES, JobStore } from "./job-store.mjs";

const execFileAsync = promisify(execFile);
const ROOT = "/Users/hun/PrivateAI";
const HOST = process.env.LOCAL_AI_CHAT_HOST ?? "127.0.0.1";
const PORT = Number(process.env.LOCAL_AI_CHAT_PORT ?? "18791");
const DEEP_UPSTREAM = "http://127.0.0.1:18790/v1/chat/completions";
const FAST_UPSTREAM = "http://127.0.0.1:11434/api/chat";
const FAST_MODEL = assertConversationModel(process.env.LOCAL_AI_FAST_MODEL ?? LOCAL_CONVERSATION_MODEL);
const GROWTH_TRANSPORT = process.env.LOCAL_AI_GROWTH_TRANSPORT ?? "disabled";
const INTENT_SHADOW_MODE = process.env.LOCAL_AI_INTENT_SHADOW ?? "disabled";
const AUTH_PATH = `${ROOT}/data/secure-chat/auth.json`;
const ROOM_PATH = `${ROOT}/data/secure-chat/room.json`;
const LESSON_PATH = process.env.LOCAL_AI_LESSON_PATH ?? `${ROOT}/data/secure-chat/lessons.json`;
const CONVERSATION_PATH = `${ROOT}/data/secure-chat/conversations.json`;
const CONVERSATION_IMAGE_DIR = `${ROOT}/data/secure-chat/chat-images`;
const JOIN_PATH = `${ROOT}/data/secure-chat/joins.json`;
const JOB_PATH = `${ROOT}/data/secure-chat/jobs.json`;
const liveJobs = new Map();
const PAIR_PIN_PATH = `${ROOT}/data/secure-chat/pair-pins.json`;
const SAY_BODY_BYTES = 12 * 1024 * 1024;
const LAN_PUBLIC_URL = process.env.LOCAL_AI_CHAT_PUBLIC_URL ?? "http://192.168.50.235:18791/";
const APPROVAL_PATH = `${ROOT}/data/secure-chat/approvals.json`;
const PROACTIVE_PATH = `${ROOT}/data/secure-chat/proactive.json`;
const GROWTH_ROOT = `${ROOT}/data/growth`;
const INTENT_SHADOW_PATH = `${ROOT}/data/intent-shadow/metrics.json`;
const LOG_DIR = `${ROOT}/logs/secure-chat`;
const STRUCTURED_LOG_DIR = `${ROOT}/logs/structured`;
const PUBLIC_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "public");
const structuredLog = createStructuredEventLog({ logDir: STRUCTURED_LOG_DIR });
const KEYCHAIN_SERVICE = "local.privateai.openwebui.proxy.token";
const KEYCHAIN_ACCOUNT = "local-ai";
const TELEGRAM_CONFIG_PATH = `${ROOT}/config/telegram-general.json`;
const CODEX_BRIDGE_CONFIG_PATH = `${ROOT}/config/codex-bridge.json`;
const CODEX_TASK_PATH = `${ROOT}/data/codex-bridge/tasks.json`;
const TASK_MANAGER_PATH = `${ROOT}/data/task-manager/tasks.json`;
const DECISION_MEMORY_PATH = `${ROOT}/data/decision-memory/decisions.json`;
const DISCUSSION_CONTEXT_PATH = `${ROOT}/data/discussion-context/active.json`;
const DEVELOPMENT_LEDGER_PATH = `${ROOT}/data/development-ledger/changes.json`;
const DEVELOPMENT_RUN_PATH = `${ROOT}/data/development-runs/runs.json`;
const CODEX_SOURCE_ROOT = `${ROOT}/app/secure-chat`;
const TELEGRAM_CONFIG_SCRIPT = `${ROOT}/app/secure-chat/scripts/configure-telegram-general.mjs`;
const CONFIRMED_MEMORY_PATH =
  process.env.CONFIRMED_MEMORY_PATH ?? `${ROOT}/data/confirmed-memory/memory.json`;
const MAX_BODY_BYTES = 256 * 1024;
const rateLimiter = new FixedWindowRateLimiter();

const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
  ["/icon.svg", ["icon.svg", "image/svg+xml"]],
]);

function securityHeaders(contentType) {
  return {
    "Content-Type": contentType,
    "Cache-Control": contentType.startsWith("text/html") || contentType.includes("javascript") || contentType.includes("css")
      ? "no-store"
      : "public, max-age=300",
    "Content-Security-Policy": "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; manifest-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), display-capture=(self), geolocation=(), microphone=(), payment=(), usb=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function json(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function roomCookie(token) {
  return { "Set-Cookie": `room_token=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; SameSite=Lax` };
}

function cookieToken(request) {
  const match = /(?:^|;\s*)room_token=([^;]+)/.exec(request.headers.cookie ?? "");
  return match ? decodeURIComponent(match[1]) : "";
}

async function readBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error("too_large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function bearer(request) {
  return /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? cookieToken(request);
}

function isLoopback(request) {
  const ip = request.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function conversationIdFrom(pathname, suffix = "") {
  const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^/api/conversations/([0-9a-f-]{36})${escaped}$`, "i").exec(pathname)?.[1] ?? "";
}

function writeSse(response, event, data) {
  if (response.writableEnded || response.destroyed) return false;
  return response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamRoomSay(response, roomStore, started, body = {}, lessonStore, approvalStore) {
  const plan = await planRoomTurn(started.room.messages, { ask: body?.ask, text: body?.text, lessonStore });
  const waitingFaceId = plan.mode === "faceid_gate"
    || (plan.mode === "mac_work" && (isMacDoCommand(body?.text) || isFaceIdGateCommand(body?.text)));
  response.writeHead(200, {
    ...securityHeaders("text/event-stream; charset=utf-8"),
    "Cache-Control": "no-store, no-transform",
  });
  writeSse(response, "status", {
    label: plan.mode === "openai_only"
      ? "맥이 오픈에게 묻는 중"
      : waitingFaceId
        ? "아이폰에서 Face ID로 승인해 주세요"
        : plan.mode === "mac_work"
          ? "맥이 집을 보고 있습니다"
          : plan.mode === "deny"
            ? "하지 않습니다"
            : started.job.label,
    job: started.job,
    ask: plan.mode,
  });
  const abort = new AbortController();
  liveJobs.set(started.job.id, abort);
  let clientGone = false;
  try {
    let answer = "";
    for await (const fragment of roomTurnTokens(started.room.messages, {
      ask: body?.ask,
      text: body?.text,
      signal: abort.signal,
      readToken: proxyToken,
      lessonStore,
      approvalStore,
    })) {
      if (abort.signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      answer += fragment;
      if (!clientGone) {
        try {
          writeSse(response, "delta", { choices: [{ index: 0, delta: { content: fragment } }] });
        } catch {
          clientGone = true;
        }
      }
    }
    if (!answer.trim()) throw new Error("empty_room_model_response");
    const room = await roomStore.finishJob(started.job.id, { ok: true, answer });
    if (!clientGone) writeSse(response, "done", { ok: true, job: room.jobs.at(-1), room });
  } catch (error) {
    const cancelled = error?.name === "AbortError" || abort.signal.aborted;
    const room = await roomStore.finishJob(started.job.id, {
      ok: false,
      answer: cancelled ? "중단했습니다." : "지금은 답을 못 만들었습니다. 다시 시키면 됩니다.",
    });
    if (!clientGone && !cancelled) writeSse(response, "error", { message: "지금은 답을 못 만들었습니다. 다시 시키면 됩니다." });
    if (!clientGone) writeSse(response, "done", { ok: false, job: room.jobs.at(-1), room });
  } finally {
    liveJobs.delete(started.job.id);
  }
  if (!response.writableEnded) response.end();
}

async function streamConversationSay(response, conversationStore, jobStore, conversationId, body) {
  const title = String(body?.text ?? "사진").replace(/\s+/g, " ").trim().slice(0, 48) || "사진";
  const accepted = await jobStore.start({
    conversationId,
    clientRequestId: body?.clientRequestId,
    title,
    detail: "확인하고 있습니다.",
  });
  response.writeHead(200, {
    ...securityHeaders("text/event-stream; charset=utf-8"),
    "Cache-Control": "no-store, no-transform",
  });
  writeSse(response, "status", { requestId: accepted.job.id, conversationId, job: accepted.job, replay: accepted.replay });
  if (accepted.replay) {
    writeSse(response, "done", { requestId: accepted.job.id, ok: accepted.job.status === "done", job: accepted.job, replay: true });
    response.end();
    return;
  }
  const abort = new AbortController();
  liveJobs.set(accepted.job.id, abort);
  try {
    const started = await conversationStore.addUser(conversationId, {
      text: body?.text,
      images: body?.images,
    });
    await jobStore.update(accepted.job.id, { userMessageId: started.message.id, detail: "확인하고 있습니다." });
    const messages = started.conversation.messages.map((item) => {
      const extra = item.images?.length ? `\n[사진 ${item.images.length}장]` : "";
      return { role: item.role, content: `${item.content}${extra}` };
    });
    let answer = "";
    for await (const fragment of askRoomModelTokens(messages, { signal: abort.signal })) {
      if (abort.signal.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });
      answer += fragment;
      writeSse(response, "delta", { requestId: accepted.job.id, jobId: accepted.job.id, choices: [{ index: 0, delta: { content: fragment } }] });
    }
    if (!answer.trim()) throw new Error("empty_room_model_response");
    const saved = await conversationStore.addAssistant(conversationId, answer);
    const job = await jobStore.update(accepted.job.id, { status: "done", detail: "끝났습니다." });
    writeSse(response, "done", {
      requestId: accepted.job.id,
      ok: true,
      job,
      message: saved.message,
      conversation: { id: saved.conversation.id, title: saved.conversation.title },
    });
  } catch (error) {
    const cancelled = error?.name === "AbortError" || abort.signal.aborted;
    const job = await jobStore.update(accepted.job.id, {
      status: cancelled ? "cancelled" : "failed",
      detail: cancelled ? "중단했습니다." : "지금은 답을 못 만들었습니다.",
    });
    writeSse(response, cancelled ? "done" : "error", {
      requestId: accepted.job.id,
      ok: false,
      job,
      message: job.detail,
    });
    if (!cancelled) writeSse(response, "done", { requestId: accepted.job.id, ok: false, job });
  } finally {
    liveJobs.delete(accepted.job.id);
  }
  response.end();
}

function originAllowed(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function hasScope(device, scope) {
  return Array.isArray(device.scopes) && device.scopes.includes(scope);
}

function validateChat(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 60) {
    throw Object.assign(new Error("invalid_messages"), { statusCode: 400 });
  }
  let characters = 0;
  const messages = body.messages.map((message) => {
    if (!message || !["user", "assistant"].includes(message.role) || typeof message.content !== "string") {
      throw Object.assign(new Error("invalid_message"), { statusCode: 400 });
    }
    characters += message.content.length;
    return { role: message.role, content: message.content.slice(0, 16_000) };
  });
  if (characters > 100_000) throw Object.assign(new Error("too_many_characters"), { statusCode: 413 });
  const mode = body.mode ?? "auto";
  if (!["auto", "fast", "deep"].includes(mode)) {
    throw Object.assign(new Error("invalid_mode"), { statusCode: 400 });
  }
  const image = typeof body.image === "string" && body.image.trim() ? body.image.trim() : "";
  return { messages, stream: body.stream === true, mode, image };
}

function beginEventStream(response, requestId) {
  response.writeHead(200, {
    ...securityHeaders("text/event-stream; charset=utf-8"),
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Request-ID": requestId,
  });
  response.flushHeaders?.();
}

function sendEvent(response, event, value) {
  if (response.writableEnded || response.destroyed) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function finishStreamError(response, requestId, code, message) {
  if (response.writableEnded || response.destroyed) return;
  sendEvent(response, "error", { requestId, code, message });
  sendEvent(response, "done", { requestId, ok: false });
  response.end();
}

async function proxyToken() {
  try {
    const result = await execFileAsync("/usr/bin/security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

async function processJson(scriptPath, value, timeoutMs = 60_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn("/opt/homebrew/bin/node", [scriptPath], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(Object.assign(new Error("private_configuration_timeout"), { statusCode: 504 }));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { if (stdout.length < 64 * 1024) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0 || signal) {
        reject(Object.assign(new Error("private_configuration_failed"), { statusCode: 502 }));
        return;
      }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(Object.assign(new Error("private_configuration_response_invalid"), { statusCode: 502 })); }
    });
    child.stdin.end(`${JSON.stringify(value)}\n`);
  });
}

async function communicationStatus(codexTaskStore = null) {
  let telegram = { configured: false, enabled: false, running: false, mode: "general_chat_only", botUsername: null };
  try {
    const configured = JSON.parse(await readFile(TELEGRAM_CONFIG_PATH, "utf8"));
    const domain = `gui/${process.getuid()}`;
    const service = await execFileAsync("/bin/launchctl", ["print", `${domain}/com.local.privateai.telegram-general`], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 128 * 1024,
    }).then((result) => result.stdout, () => "");
    telegram = {
      configured: configured?.version === 1,
      enabled: configured?.enabled === true,
      running: /\bstate = running\b/.test(service),
      mode: configured?.transport === "telegram_general_only" ? "general_chat_only" : "unknown",
      botUsername: typeof configured?.botUsername === "string" ? configured.botUsername : null,
    };
  } catch (error) {
    if (error.code !== "ENOENT") telegram = { ...telegram, status: "unavailable" };
  }

  let codexBridge = { configured: false, enabled: false, running: false, mode: "isolated_inspect_and_draft" };
  try {
    const configured = JSON.parse(await readFile(CODEX_BRIDGE_CONFIG_PATH, "utf8"));
    const domain = `gui/${process.getuid()}`;
    const service = await execFileAsync("/bin/launchctl", ["print", `${domain}/com.local.privateai.codex-worker`], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 128 * 1024,
    }).then((result) => result.stdout, () => "");
    const preflightReady = await codexWorkerReady();
    const leaseReady = codexTaskStore ? await codexTaskStore.workerReady() : false;
    codexBridge = {
      configured: configured?.version === 1 && configured?.mode === "isolated_inspect_and_draft",
      enabled: configured?.enabled === true,
      running: /\bstate = running\b/.test(service) && preflightReady && leaseReady,
      mode: "isolated_inspect_and_draft",
    };
  } catch (error) {
    if (error.code !== "ENOENT") codexBridge = { ...codexBridge, status: "unavailable" };
  }

  let browser = { profile: "shared_chrome_tabs", connected: false, sharedTabs: 0, services: [] };
  try {
    const client = new SharedChromeClient();
    const status = await client.status();
    const tabs = status.connected ? await client.tabs() : [];
    browser = {
      profile: "shared_chrome_tabs",
      connected: status.connected,
      sharedTabs: tabs.length,
      services: [...new Set(tabs.map((tab) => tab.service).filter(Boolean))],
    };
  } catch {
    // An unpaired extension is the normal initial state.
  }
  return {
    telegram,
    codexBridge,
    browser,
    webTasks: {
      policy: "default_deny_v1",
      stage: browser.connected && browser.sharedTabs > 0 ? "live_ui_validation_required" : "shared_tabs_required",
      preparedActions: WEB_TASK_ACTIONS,
      blockedFinalActions: ["checkout", "purchase", "payment", "mail_send", "mail_delete", "mail_archive"],
    },
    privilegedIngress: "local_owner_app_only",
    blockedInTelegram: ["authenticated_web", "email", "files", "home_control", "purchases", "credentials"],
  };
}

async function audit(entry) {
  await mkdir(LOG_DIR, { recursive: true, mode: 0o700 });
  const path = `${LOG_DIR}/${new Date().toISOString().slice(0, 10)}.jsonl`;
  await appendFile(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

async function forwardDeepChat(request, response, device, payload, requestId) {
  let token;
  const startedAt = Date.now();
  try {
    if (payload.stream) {
      beginEventStream(response, requestId);
      sendEvent(response, "status", { requestId, phase: "accepted", mode: "deep", label: "요청을 안전하게 받았습니다" });
      sendEvent(response, "status", { requestId, phase: "routing", mode: "deep", label: "깊은 작업 경로로 연결하는 중" });
      sendEvent(response, "status", { requestId, phase: "thinking", mode: "deep", label: "생각하고 작업을 처리하는 중" });
    }
    await structuredLog.emit("model_invoked", {
      correlationId: requestId,
      route: "deep",
      model: "openclaw/default",
      ingress: "secure_chat",
    }).catch(() => {});
    token = await proxyToken();
    const { mode: _mode, ...upstreamPayload } = payload;
    const upstream = await fetch(DEEP_UPSTREAM, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-OpenWebUI-Chat-Id": `secure-chat-${device.id}`,
      },
      body: JSON.stringify({ model: "openclaw/default", ...upstreamPayload }),
      signal: createRequestSignal(request, response),
    });

    if (!upstream.ok || !upstream.body) {
      if (payload.stream) {
        sendEvent(response, "error", { requestId, code: "deep_model_unavailable", message: "깊은 생각 경로에서 응답을 받지 못했습니다." });
        sendEvent(response, "done", { requestId, ok: false });
        response.end();
      } else {
        json(response, upstream.status, { error: "deep_model_unavailable" });
      }
    } else if (payload.stream) {
      try {
        for await (const chunk of verifyOpenAIEventStream(upstream.body)) response.write(chunk);
        sendEvent(response, "done", { requestId, ok: true });
        response.end();
      } catch (error) {
        if (error?.name !== "AbortError") {
          finishStreamError(response, requestId, "deep_stream_interrupted", "깊은 작업 응답이 중간에 끊겼습니다. 다시 시도할 수 있습니다.");
        }
      }
    } else {
      response.writeHead(upstream.status, {
        ...securityHeaders(upstream.headers.get("content-type") ?? "application/json"),
        "Cache-Control": "no-store",
      });
      for await (const chunk of upstream.body) response.write(chunk);
      response.end();
    }
    await audit({ event: "chat", mode: "deep", deviceHash: createHash("sha256").update(device.id).digest("hex"), status: upstream.status, durationMs: Date.now() - startedAt });
  } finally {
    token = undefined;
  }
}

async function forwardFastChat(request, response, device, payload, requestId, memoryStore) {
  const startedAt = Date.now();
  if (payload.stream) {
    beginEventStream(response, requestId);
    sendEvent(response, "status", { requestId, phase: "accepted", mode: "fast", label: "요청을 안전하게 받았습니다" });
    sendEvent(response, "status", { requestId, phase: "routing", mode: "fast", label: "빠른 로컬 모델로 연결하는 중" });
    sendEvent(response, "status", { requestId, phase: "loading", mode: "fast", label: "로컬 모델을 준비하는 중" });
  }
  await structuredLog.emit("model_invoked", {
    correlationId: requestId,
    route: "fast",
    model: FAST_MODEL,
    ingress: "secure_chat",
  }).catch(() => {});
  const latestUser = [...payload.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const memoryBlock = memoryStore
    ? await memoryStore.activeContextBlock(latestUser, { forExternal: false })
    : "";
  const messages = withMemorySystemMessage(payload.messages, memoryBlock);
  const upstream = await fetch(FAST_UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: FAST_MODEL,
      messages,
      stream: payload.stream,
      think: false,
      keep_alive: "10m",
      options: { num_ctx: 16_384 },
    }),
    signal: createRequestSignal(request, response),
  });

  if (!upstream.ok || !upstream.body) {
    await audit({ event: "chat", mode: "fast", deviceHash: createHash("sha256").update(device.id).digest("hex"), status: upstream.status, durationMs: Date.now() - startedAt });
    if (payload.stream) {
      sendEvent(response, "error", { requestId, code: "local_model_unavailable", message: "로컬 모델을 시작하지 못했습니다." });
      sendEvent(response, "done", { requestId, ok: false });
      return response.end();
    }
    return json(response, 502, { error: "local_model_unavailable" });
  }

  if (payload.stream) {
    sendEvent(response, "status", { requestId, phase: "generating", mode: "fast", label: "답변을 작성하는 중" });
    try {
      for await (const chunk of ollamaStreamToSSE(upstream.body, requestId)) response.write(chunk);
      sendEvent(response, "done", { requestId, ok: true });
      response.end();
    } catch (error) {
      if (error?.name !== "AbortError") {
        finishStreamError(response, requestId, "local_stream_interrupted", "로컬 모델 응답이 중간에 끊겼습니다. 다시 시도할 수 있습니다.");
      }
    }
  } else {
    json(response, 200, toOpenAICompletion(await upstream.json(), FAST_MODEL));
  }
  await audit({ event: "chat", mode: "fast", deviceHash: createHash("sha256").update(device.id).digest("hex"), status: 200, durationMs: Date.now() - startedAt });
}

async function forwardChat(request, response, device, body, intentShadow = null, memoryStore = null) {
  const payload = validateChat(body);
  const requestedMode = payload.mode;
  const mode = resolveChatMode(requestedMode, payload.messages);
  assertChatModeAccess(mode, device);
  const requestId = randomUUID();
  payload.mode = mode;
  payload.messages = trimChatContext(payload.messages, mode);
  if (payload.image) {
    const last = payload.messages.at(-1);
    if (!last || last.role !== "user") {
      throw Object.assign(new Error("invalid_app_image_sequence"), { statusCode: 400 });
    }
    const ocr = await readOwnerAppPhoto(payload.image);
    last.content = `${last.content}\n\n[로컬 앱 사진 인식]\n${ocr}`.slice(0, 16_000);
    delete payload.image;
  }
  await structuredLog.emit("request_received", {
    correlationId: requestId,
    ingress: "secure_chat",
    requested_mode: typeof requestedMode === "string" ? requestedMode : "auto",
  }).catch(() => {});
  await structuredLog.emit("router_selected", {
    correlationId: requestId,
    mode,
    conversation_model: FAST_MODEL,
    planner_model: LOCAL_EFFECT_PLANNING_MODEL,
  }).catch(() => {});
  if (intentShadow && mode === "deep") {
    const latest = [...payload.messages].reverse().find((message) => message.role === "user")?.content;
    if (latest) {
      void intentShadow.observe({ utterance: latest, ingress: "local_owner_app" }).catch(() => {
        void audit({ event: "intent_shadow_failed", errorClass: "IntentShadowError" }).catch(() => {});
      });
    }
  }
  try {
    if (mode === "deep") {
      await forwardDeepChat(request, response, device, payload, requestId);
    } else {
      await forwardFastChat(request, response, device, payload, requestId, memoryStore);
    }
    await structuredLog.emit("task_completed", {
      correlationId: requestId,
      mode,
    }).catch(() => {});
  } catch (error) {
    await structuredLog.emit("task_failed", {
      correlationId: requestId,
      mode,
      error_class: error?.name ?? "Error",
    }).catch(() => {});
    throw error;
  }
}

async function main() {
  if (HOST !== "127.0.0.1") throw new Error("승인 전에는 secure chat을 loopback 외 주소에 바인딩할 수 없습니다.");
  if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("포트 설정이 올바르지 않습니다.");
  if (!["disabled", "enabled"].includes(INTENT_SHADOW_MODE)) throw new Error("지원하지 않는 intent shadow 설정입니다.");
  const authStore = new AuthStore(AUTH_PATH);
  const approvalStore = new ApprovalStore(APPROVAL_PATH);
  const codexTaskStore = new CodexTaskStore(CODEX_TASK_PATH);
  const ownerCodexTasks = new OwnerCodexTaskCoordinator({
    taskStore: codexTaskStore,
    approvalStore,
    sourceRoot: CODEX_SOURCE_ROOT,
  });
  const proactiveStore = new ProactiveStore(PROACTIVE_PATH);
  const proposalStore = new GrowthProposalStore(`${GROWTH_ROOT}/proposals`);
  if (!["disabled", "openclaw"].includes(GROWTH_TRANSPORT)) throw new Error("지원하지 않는 성장 전송 설정입니다.");
  const growth = new GrowthCoordinator({
    rootPath: GROWTH_ROOT,
    approvalStore,
    proposalStore,
    dispatchAdapter: GROWTH_TRANSPORT === "openclaw" ? createOpenClawGrowthDispatchAdapter() : null,
  });
  const intentShadow = INTENT_SHADOW_MODE === "enabled" ? new IntentShadowMonitor(INTENT_SHADOW_PATH) : null;
  const ttsRegistry = await createRuntimeTtsRegistry();
  const confirmedMemory = await new ConfirmedMemoryStore(CONFIRMED_MEMORY_PATH).initialize();
  const roomStore = await new RoomStore(ROOM_PATH).initialize();
  const lessonStore = await new LessonStore(LESSON_PATH).initialize();
  const conversationStore = await new ConversationStore(CONVERSATION_PATH, CONVERSATION_IMAGE_DIR).initialize();
  const jobStore = await new JobStore(JOB_PATH).initialize();
  const joinStore = await new JoinStore(JOIN_PATH).initialize();
  const pairPins = await new PairPinStore(PAIR_PIN_PATH).initialize();
  const decisionMemory = await new DecisionMemoryStore(DECISION_MEMORY_PATH).initialize();
  const discussionContext = await new DiscussionContextStore(DISCUSSION_CONTEXT_PATH).initialize();
  const memoryContext = createMemoryContextFacade({
    confirmedMemory,
    decisionStore: decisionMemory,
    discussionStore: discussionContext,
  });
  const toolRegistry = createBuiltinToolRegistry({
    growthAvailable: GROWTH_TRANSPORT === "openclaw",
  });
  const taskManager = new TaskManagerStore(TASK_MANAGER_PATH, { structuredLog });
  await taskManager.initialize();
  const developmentLedger = await new DevelopmentLedgerStore(DEVELOPMENT_LEDGER_PATH).initialize();
  const taskExecutor = createTaskExecutor({ toolRegistry, structuredLog });
  const cursorDevelopmentAdapter = createCursorDevelopmentAdapter({
    approvalStore,
    developmentLedger,
    // 권한 대기: ApprovalStore를 폴링 (API key 무인 인증 없음). LIVE에서 owner 앱이 decide.
    waitForPermissionDecision: async (approvalId) => {
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        const row = await approvalStore.get(approvalId);
        if (!row) return "expired";
        if (row.status !== "pending") return row.status;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return "expired";
    },
  });
  const taskOrchestrator = createTaskOrchestrator({
    taskStore: taskManager,
    executor: taskExecutor,
    cursorAdapter: cursorDevelopmentAdapter,
    structuredLog,
  });
  const developmentRunStore = await new DevelopmentRunStore(DEVELOPMENT_RUN_PATH).initialize();
  const developmentSupervisor = createDevelopmentSupervisor({
    runStore: developmentRunStore,
    taskStore: taskManager,
    approvalStore,
    discussionStore: discussionContext,
    taskOrchestrator,
    runSystemStatus: ownerSystemStatus,
  });
  const ownerActionExecutor = new OwnerActionExecutor({
    approvalStore,
    proactiveStore,
    toolRegistry,
    audit: async (entry) => {
      await audit(entry).catch(() => {});
    },
  });
  await authStore.initialize();
  await approvalStore.initialize();
  await codexTaskStore.initialize();
  await ownerCodexTasks.reconcileAll();
  await ownerCodexTasks.pruneRetention();
  await proactiveStore.initialize();
  await growth.initialize();
  await intentShadow?.initialize();

  async function ownerSystemStatus() {
    const ttsCatalog = ttsRegistry.catalog();
    return runSystemCommand("system.status", {
      healthOptions: {
        ttsCatalog: {
          providers: (ttsCatalog.providers ?? []).map((provider) => ({
            id: provider.id,
            state: provider.availability?.state ?? "unknown",
          })),
        },
        taskManagerReady: true,
        toolRegistryReady: true,
      },
      taskSummary: await taskManager.summary(),
    });
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (!originAllowed(request)) return json(response, 403, { error: "origin_denied" });
      const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true, exposure: "loopback_only" });
      if (request.method === "GET" && url.pathname === "/api/capabilities") {
        return json(response, 200, CAPABILITIES);
      }

      if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
        const [filename, contentType] = STATIC_FILES.get(url.pathname);
        const content = await readFile(join(PUBLIC_DIR, filename));
        response.writeHead(200, securityHeaders(contentType));
        return response.end(content);
      }

      if (request.method === "POST" && url.pathname === "/api/pair") {
        const body = await readBody(request);
        if (typeof body?.deviceName !== "string") return json(response, 400, { error: "invalid_pairing" });
        let secret = typeof body?.secret === "string" ? body.secret : "";
        if (!secret && body?.pin) secret = await pairPins.take(body.pin) ?? "";
        if (!secret) return json(response, 400, { error: "invalid_pairing" });
        const claimed = await authStore.claimPairing(secret, body.deviceName);
        if (!claimed) return json(response, 401, { error: "pairing_expired_or_used" });
        await audit({ event: "device_paired", deviceHash: createHash("sha256").update(claimed.deviceId).digest("hex") });
        return json(response, 201, claimed, roomCookie(claimed.deviceToken));
      }
      if (request.method === "POST" && url.pathname === "/api/join-request") {
        const body = await readBody(request);
        return json(response, 201, await joinStore.request(body?.deviceName));
      }
      if (request.method === "GET" && url.pathname === "/api/join-wait") {
        const waiting = await joinStore.wait(url.searchParams.get("id"));
        return json(response, 200, waiting, waiting.status === "ready" ? roomCookie(waiting.deviceToken) : {});
      }
      if (request.method === "POST" && url.pathname === "/api/local-pair") {
        if (!isLoopback(request)) return json(response, 403, { error: "loopback_only" });
        const body = await readBody(request).catch(() => ({}));
        const pairing = await authStore.createPairing(undefined, { role: "owner" });
        const claimed = await authStore.claimPairing(pairing.secret, String(body?.deviceName ?? "맥 웹").slice(0, 60));
        if (!claimed) return json(response, 401, { error: "pairing_expired_or_used" });
        await audit({ event: "device_local_paired", deviceHash: createHash("sha256").update(claimed.deviceId).digest("hex") });
        return json(response, 201, claimed, roomCookie(claimed.deviceToken));
      }

      const device = await authStore.authenticate(bearer(request));
      if (!device) return json(response, 401, { error: "device_authentication_required" });
      if (!rateLimiter.allow(device.id, ratePolicyFor(request.method, url.pathname))) {
        return json(response, 429, { error: "rate_limit" });
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        if (!hasScope(device, "status")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 200, {
          ok: true,
          deviceName: device.name,
          deviceRole: device.role,
          deviceScopes: device.scopes,
          fastModel: FAST_MODEL,
          deepModel: "openclaw/default",
          privacy: "direct_to_mac",
          approvals: "p256_device_signature_v1",
          activeMemoryCount: await confirmedMemory.countActive(),
          intentShadow: intentShadow ? { enabled: true, metrics: await intentShadow.status() } : { enabled: false },
          iosApp: getIosAppReleaseInfo(),
          lanUrl: LAN_PUBLIC_URL,
          loopback: isLoopback(request),
          openaiAsk: openaiAskStatus(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/room") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 200, await roomStore.snapshot());
      }
      if (request.method === "POST" && url.pathname === "/api/room/clear") {
        if (!hasScope(device, "chat") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        const room = await roomStore.clear();
        await audit({ event: "room_cleared" });
        return json(response, 200, room);
      }
      if (request.method === "POST" && url.pathname === "/api/room/say") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        const body = await readBody(request);
        const started = await roomStore.addUser(body?.text);
        if (body?.stream === false) {
          try {
            const plan = await planRoomTurn(started.room.messages, { ask: body?.ask, text: body?.text, lessonStore });
            if (plan.consult) {
              await audit({ event: "openai_ask", reason: plan.reason, questionChars: plan.question.length });
            }
            const answer = await roomTurnAnswer(started.room.messages, {
              ask: body?.ask,
              text: body?.text,
              readToken: proxyToken,
              lessonStore,
              approvalStore,
            });
            return json(response, 200, await roomStore.finishJob(started.job.id, { ok: true, answer }));
          } catch (error) {
            await audit({ event: "room_say_failed", errorClass: error?.name ?? "Error" });
            return json(response, 200, await roomStore.finishJob(started.job.id, {
              ok: false,
              answer: "지금은 답을 못 만들었습니다. 다시 시키면 됩니다.",
            }));
          }
        }
        return streamRoomSay(response, roomStore, started, body, lessonStore, approvalStore);
      }
      if (request.method === "GET" && url.pathname === "/api/join-pending") {
        if (device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        return json(response, 200, { requests: await joinStore.pending() });
      }
      if (request.method === "POST" && url.pathname === "/api/join-allow") {
        if (device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const body = await readBody(request);
        const pending = (await joinStore.pending()).find((item) => item.id === body?.id);
        if (!pending) return json(response, 404, { error: "join_not_found" });
        const pairing = await authStore.createPairing(30 * 60 * 1000, { role: "owner" });
        const claimed = await authStore.claimPairing(pairing.secret, pending.deviceName);
        if (!claimed) return json(response, 401, { error: "pairing_expired_or_used" });
        await joinStore.allow(pending.id, claimed.deviceToken);
        await audit({ event: "device_join_allowed", deviceHash: createHash("sha256").update(claimed.deviceId).digest("hex") });
        return json(response, 201, { ok: true, id: pending.id });
      }
      if (request.method === "GET" && url.pathname === "/api/conversations") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 200, {
          conversations: await conversationStore.list({ full: url.searchParams.get("full") === "1" }),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/conversations") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 201, await conversationStore.create());
      }
      {
        const conversationId = conversationIdFrom(url.pathname);
        if (conversationId && hasScope(device, "chat")) {
          if (request.method === "GET") return json(response, 200, await conversationStore.get(conversationId));
          if (request.method === "DELETE") return json(response, 200, await conversationStore.remove(conversationId));
          if (request.method === "PUT") {
            const body = await readBody(request, SAY_BODY_BYTES);
            return json(response, 200, await conversationStore.upsert({ ...body, id: conversationId }));
          }
        }
        const sayId = conversationIdFrom(url.pathname, "/say");
        if (sayId && request.method === "POST") {
          if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
          return streamConversationSay(response, conversationStore, jobStore, sayId, await readBody(request, SAY_BODY_BYTES));
        }
        const imageMatch = /^\/api\/conversations\/([0-9a-f-]{36})\/images\/([0-9a-f-]{36})$/i.exec(url.pathname);
        if (imageMatch && request.method === "GET") {
          if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
          const image = await conversationStore.readImage(imageMatch[1], imageMatch[2]);
          response.writeHead(200, {
            ...securityHeaders(image.mime),
            "Cache-Control": "no-store",
          });
          response.end(image.bytes);
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 200, {
          jobs: await jobStore.list({
            conversationId: url.searchParams.get("conversationId") || undefined,
            status: url.searchParams.get("status") || undefined,
          }),
        });
      }
      {
        const jobId = /^\/api\/jobs\/([0-9a-f-]{36})$/i.exec(url.pathname)?.[1];
        if (jobId && request.method === "GET") {
          if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
          return json(response, 200, await jobStore.get(jobId));
        }
        const cancelId = /^\/api\/jobs\/([0-9a-f-]{36})\/cancel$/i.exec(url.pathname)?.[1];
        if (cancelId && request.method === "POST") {
          if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
          liveJobs.get(cancelId)?.abort();
          return json(response, 200, await jobStore.cancel(cancelId));
        }
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 200, { events: await jobStore.events({ since: url.searchParams.get("since") || undefined }) });
      }
      if (request.method === "POST" && url.pathname === "/api/room/invite") {
        if (!hasScope(device, "chat") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        const pairing = await authStore.createPairing(30 * 60 * 1000, { role: "owner" });
        const pin = await pairPins.issue(pairing.secret, 30 * 60 * 1000);
        return json(response, 201, {
          pin,
          expiresAt: new Date(pairing.expiresAt).toISOString(),
        });
      }
      if (request.method === "GET" && url.pathname === "/api/system/status") {
        if (!hasScope(device, "status") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        const result = await ownerSystemStatus();
        await structuredLog.emit("verification_completed", {
          correlationId: structuredLog.correlationId(),
          ingress: "system_status",
          overall: result.runtime.overall,
        }).catch(() => {});
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/system/command") {
        if (!hasScope(device, "status") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        const body = await readBody(request);
        if (body?.command !== "system.status") return json(response, 400, { error: "unsupported_system_command" });
        return json(response, 200, await ownerSystemStatus());
      }
      if (request.method === "GET" && url.pathname === "/api/tasks") {
        if (!hasScope(device, "status") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        const status = url.searchParams.get("status");
        const limit = Number(url.searchParams.get("limit") ?? "50");
        return json(response, 200, {
          tasks: await taskManager.list({ status: status || null, limit }),
          summary: await taskManager.summary(),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/tasks") {
        if (!hasScope(device, "chat") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        try {
          const body = await readBody(request);
          const task = await taskManager.create({
            goal: body?.goal,
            approvalRequired: body?.approval_required !== false,
            currentStep: body?.current_step ?? null,
            nextStep: body?.next_step ?? "analyze",
            correlationId: typeof body?.correlation_id === "string" ? body.correlation_id : null,
            evidence: Array.isArray(body?.evidence) ? body.evidence : [],
          });
          await audit({
            event: "task_created",
            deviceHash: createHash("sha256").update(device.id).digest("hex"),
            taskHash: createHash("sha256").update(task.task_id).digest("hex"),
          });
          return json(response, 201, task);
        } catch (error) {
          return json(response, error?.statusCode ?? 400, { error: error?.message ?? "task_create_failed" });
        }
      }
      {
        const transitionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
        if (request.method === "POST" && transitionMatch) {
          if (!hasScope(device, "chat") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          try {
            const body = await readBody(request);
            const task = await taskManager.transition(transitionMatch[1], {
              toStatus: body?.to_status,
              currentStep: body?.current_step,
              nextStep: body?.next_step,
              error: body?.error,
              evidence: Array.isArray(body?.evidence) ? body.evidence : [],
              correlationId: typeof body?.correlation_id === "string" ? body.correlation_id : null,
            });
            return json(response, 200, task);
          } catch (error) {
            return json(response, error?.statusCode ?? 400, { error: error?.message ?? "task_transition_failed" });
          }
        }
        const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (request.method === "GET" && taskMatch) {
          if (!hasScope(device, "status") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          const task = await taskManager.get(taskMatch[1]);
          if (!task) return json(response, 404, { error: "task_not_found" });
          return json(response, 200, task);
        }
        if (request.method === "POST" && url.pathname.match(/^\/api\/tasks\/([^/]+)\/evidence$/)) {
          const evidenceMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/evidence$/);
          if (!hasScope(device, "chat") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          try {
            const body = await readBody(request);
            const record = body?.epistemic
              ? createEvidenceRecord(body)
              : body;
            const task = await taskManager.appendEvidence(evidenceMatch[1], record);
            return json(response, 200, task);
          } catch (error) {
            return json(response, error?.statusCode ?? 400, { error: error?.message ?? "task_evidence_failed" });
          }
        }
        const runMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
        if (request.method === "POST" && runMatch) {
          if (!hasScope(device, "chat") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          try {
            const body = await readBody(request);
            const result = await taskOrchestrator.run({
              taskId: runMatch[1],
              toolName: body?.tool_name,
              channel: body?.channel ?? "local_owner_app",
              hasApproval: body?.has_approval === true,
              prompt: typeof body?.prompt === "string" ? body.prompt : null,
              testCommand: typeof body?.test_command === "string" ? body.test_command : null,
              expectations: Array.isArray(body?.expectations) ? body.expectations : [],
            });
            return json(response, 200, result);
          } catch (error) {
            return json(response, error?.statusCode ?? 400, { error: error?.message ?? "task_run_failed" });
          }
        }
        const replanMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/replan$/);
        if (request.method === "POST" && replanMatch) {
          if (!hasScope(device, "chat") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          try {
            return json(response, 200, await taskOrchestrator.replan(replanMatch[1]));
          } catch (error) {
            return json(response, error?.statusCode ?? 400, { error: error?.message ?? "task_replan_failed" });
          }
        }
      }
      if (request.method === "GET" && url.pathname === "/api/ledger/development") {
        if (!hasScope(device, "status") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        return json(response, 200, { entries: await developmentLedger.list() });
      }
      if (request.method === "GET" && url.pathname === "/api/development/runs") {
        if (!hasScope(device, "status") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        return json(response, 200, {
          runs: await developmentRunStore.list({
            status: url.searchParams.get("status") || null,
            limit: Number(url.searchParams.get("limit") ?? "50"),
          }),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/development/runs") {
        if (!hasScope(device, "chat") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        try {
          const body = await readBody(request);
          const run = await developmentSupervisor.start({
            goal: body?.goal,
            channel: body?.channel ?? "local_owner_app",
            budget: body?.budget ?? {},
          });
          return json(response, 201, run);
        } catch (error) {
          return json(response, error?.statusCode ?? 400, { error: error?.message ?? "development_run_create_failed" });
        }
      }
      {
        const devRunMatch = url.pathname.match(/^\/api\/development\/runs\/([^/]+)$/);
        if (request.method === "GET" && devRunMatch) {
          if (!hasScope(device, "status") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          const run = await developmentRunStore.get(devRunMatch[1]);
          if (!run) return json(response, 404, { error: "development_run_not_found" });
          return json(response, 200, run);
        }
        const inspectMatch = url.pathname.match(/^\/api\/development\/runs\/([^/]+)\/inspect$/);
        if (request.method === "POST" && inspectMatch) {
          if (!hasScope(device, "chat") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          try {
            const body = await readBody(request);
            return json(response, 200, await developmentSupervisor.inspectAndPropose(inspectMatch[1], {
              proposalOverrides: body?.proposal_overrides ?? {},
            }));
          } catch (error) {
            return json(response, error?.statusCode ?? 400, { error: error?.message ?? "development_inspect_failed" });
          }
        }
        const prepareMatch = url.pathname.match(/^\/api\/development\/runs\/([^/]+)\/prepare$/);
        if (request.method === "POST" && prepareMatch) {
          if (!hasScope(device, "chat") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          try {
            return json(response, 200, await developmentSupervisor.prepareExecution(prepareMatch[1]));
          } catch (error) {
            return json(response, error?.statusCode ?? 400, { error: error?.message ?? "development_prepare_failed" });
          }
        }
        const continueMatch = url.pathname.match(/^\/api\/development\/runs\/([^/]+)\/continue$/);
        if (request.method === "POST" && continueMatch) {
          if (!hasScope(device, "chat") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          try {
            return json(response, 200, await developmentSupervisor.runLeafTasks(continueMatch[1]));
          } catch (error) {
            return json(response, error?.statusCode ?? 400, { error: error?.message ?? "development_continue_failed" });
          }
        }
        const mergeMatch = url.pathname.match(/^\/api\/development\/runs\/([^/]+)\/merge-to-main$/);
        if (request.method === "POST" && mergeMatch) {
          if (!hasScope(device, "chat") || device.role !== "owner") {
            return json(response, 403, { error: "owner_device_required" });
          }
          try {
            assertMergeExecutionForbidden();
          } catch (error) {
            return json(response, error?.statusCode ?? 403, {
              error: error?.message ?? "dev_merge_to_main_execution_forbidden",
              note: "스키마만 준비됨. 자동 merge/commit/push/deploy 미구현.",
            });
          }
        }
      }
      if (request.method === "POST" && url.pathname === "/api/ledger/development") {
        if (!hasScope(device, "chat") || device.role !== "owner") {
          return json(response, 403, { error: "owner_device_required" });
        }
        try {
          const body = await readBody(request);
          const entry = await developmentLedger.record({
            request: body?.request,
            proposedBy: body?.proposed_by ?? device.name ?? "owner",
            approvedBy: body?.approved_by ?? null,
            filesChanged: body?.files_changed,
            tests: body?.tests,
            verification: body?.verification,
            rollbackReference: body?.rollback_reference,
          });
          return json(response, 201, entry);
        } catch (error) {
          return json(response, error?.statusCode ?? 400, { error: error?.message ?? "ledger_record_failed" });
        }
      }
      if (request.method === "GET" && url.pathname === "/api/memory") {
        if (!hasScope(device, "chat") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const [active, candidates] = await Promise.all([
          confirmedMemory.listActive(),
          confirmedMemory.listCandidates(),
        ]);
        return json(response, 200, {
          active,
          candidates,
          count: active.length,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/memory/propose") {
        if (!hasScope(device, "chat") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        try {
          const body = await readBody(request);
          const item = await confirmedMemory.propose(body?.text);
          await audit({
            event: "memory_proposed",
            deviceHash: createHash("sha256").update(device.id).digest("hex"),
            memoryHash: createHash("sha256").update(item.id).digest("hex"),
          });
          return json(response, 200, {
            ...item,
            message: "후보로 저장됨. 확인하면 장기기억에 들어갑니다.",
          });
        } catch (error) {
          if (error instanceof ConfirmedMemoryStoreError) {
            return json(response, error.statusCode, { error: error.message });
          }
          throw error;
        }
      }
      if (request.method === "POST" && url.pathname === "/api/memory/confirm") {
        if (!hasScope(device, "chat") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        try {
          const body = await readBody(request);
          const item = await confirmedMemory.confirm(body?.id, {
            shareExternal: Boolean(body?.share_external),
          });
          await audit({
            event: "memory_confirmed",
            deviceHash: createHash("sha256").update(device.id).digest("hex"),
            memoryHash: createHash("sha256").update(item.id).digest("hex"),
          });
          return json(response, 200, {
            ...item,
            active_memory_count: await confirmedMemory.countActive(),
          });
        } catch (error) {
          if (error instanceof ConfirmedMemoryStoreError) {
            return json(response, error.statusCode, { error: error.message });
          }
          throw error;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/memory/context") {
        if (!hasScope(device, "chat") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const query = url.searchParams.get("q") ?? "";
        return json(response, 200, await memoryContext.snapshot({ query }));
      }
      if (request.method === "POST" && url.pathname === "/api/memory/decisions") {
        if (!hasScope(device, "chat") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        try {
          const body = await readBody(request);
          const item = await decisionMemory.propose({ decision: body?.decision, reason: body?.reason });
          return json(response, 201, item);
        } catch (error) {
          return json(response, error?.statusCode ?? 400, { error: error?.message ?? "decision_propose_failed" });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/memory/decisions/confirm") {
        if (!hasScope(device, "chat") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        try {
          const body = await readBody(request);
          return json(response, 200, await decisionMemory.confirm(body?.id));
        } catch (error) {
          return json(response, error?.statusCode ?? 400, { error: error?.message ?? "decision_confirm_failed" });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/memory/discussions") {
        if (!hasScope(device, "chat") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        try {
          const body = await readBody(request);
          return json(response, 201, await discussionContext.open({
            topic: body?.topic,
            openQuestions: body?.open_questions,
          }));
        } catch (error) {
          return json(response, error?.statusCode ?? 400, { error: error?.message ?? "discussion_open_failed" });
        }
      }
      if (request.method === "POST" && url.pathname === "/api/memory/discussions/resolve") {
        if (!hasScope(device, "chat") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        try {
          const body = await readBody(request);
          return json(response, 200, await discussionContext.resolve(body?.id));
        } catch (error) {
          return json(response, error?.statusCode ?? 400, { error: error?.message ?? "discussion_resolve_failed" });
        }
      }
      if (request.method === "GET" && url.pathname === "/api/tools") {
        if (!hasScope(device, "status") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        return json(response, 200, {
          tools: toolRegistry.list().map((tool) => toolRegistry.describe(tool.tool_name)),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/tools/authorize-check") {
        if (!hasScope(device, "status") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const body = await readBody(request);
        const tool = toolRegistry.get(body?.tool_name);
        if (!tool) return json(response, 404, { error: "unknown_tool" });
        const policy = evaluateApprovalPolicy({
          tool,
          channel: body?.channel,
          hasApproval: body?.has_approval === true,
          trustState: body?.trust_state ?? "owner_device",
        });
        return json(response, 200, {
          tool: toolRegistry.describe(tool.tool_name),
          policy,
        });
      }
      if (request.method === "POST" && url.pathname === "/api/codex/approval-key") {
        if (!hasScope(device, "approvals") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const body = await readBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).join(",") !== "publicKeyDER") {
          return json(response, 400, { error: "invalid_codex_approval_key_request" });
        }
        const result = await ownerCodexTasks.registerApprovalKey(device.id, body?.publicKeyDER);
        await audit({
          event: "codex_approval_key_registered",
          deviceHash: createHash("sha256").update(device.id).digest("hex"),
          created: result.created,
        });
        return json(response, result.created ? 201 : 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/codex/tasks") {
        if (!hasScope(device, "approvals") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const body = await readBody(request);
        const replayed = await ownerCodexTasks.replay(device.id, body);
        if (replayed) {
          await audit({
            event: "codex_owner_task_deduplicated",
            taskHash: createHash("sha256").update(replayed.task.id).digest("hex"),
            planSha256: replayed.task.planSha256,
            deviceHash: createHash("sha256").update(device.id).digest("hex"),
          });
          return json(response, 202, { task: replayed.task, approval: replayed.approval });
        }
        if (!await codexWorkerReady() || !await codexTaskStore.workerReady()) return json(response, 503, { error: "codex_bridge_unavailable" });
        const prepared = await ownerCodexTasks.prepare(device.id, body);
        await audit({
          event: prepared.created ? "codex_owner_task_prepared" : "codex_owner_task_deduplicated",
          taskHash: createHash("sha256").update(prepared.task.id).digest("hex"),
          planSha256: prepared.task.planSha256,
          deviceHash: createHash("sha256").update(device.id).digest("hex"),
        });
        return json(response, 202, { task: prepared.task, approval: prepared.approval });
      }
      if (request.method === "GET" && url.pathname === "/api/codex/tasks") {
        if (!hasScope(device, "approvals") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const queryKeys = [...url.searchParams.keys()];
        if (queryKeys.some((key) => key !== "limit") || url.searchParams.getAll("limit").length > 1) {
          return json(response, 400, { error: "invalid_codex_task_query" });
        }
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 20 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return json(response, 400, { error: "invalid_codex_task_query" });
        return json(response, 200, { tasks: await ownerCodexTasks.list(device.id, { limit }) });
      }
      const codexTaskMatch = /^\/api\/codex\/tasks\/([0-9a-f-]{36})$/iu.exec(url.pathname);
      if (request.method === "GET" && codexTaskMatch) {
        if (!hasScope(device, "approvals") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const result = await ownerCodexTasks.get(device.id, codexTaskMatch[1]);
        if (!result) return json(response, 404, { error: "codex_task_not_found" });
        return json(response, 200, result);
      }
      const codexApprovalDecisionMatch = /^\/api\/codex\/approvals\/([A-Za-z0-9_-]{16,128})\/decision$/.exec(url.pathname);
      if (request.method === "POST" && codexApprovalDecisionMatch) {
        if (!hasScope(device, "approvals") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const body = await readBody(request);
        if (
          !body || typeof body !== "object" || Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "decision,signatureDER"
        ) return json(response, 400, { error: "invalid_codex_approval_decision" });
        const result = await ownerCodexTasks.decide(
          device.id,
          codexApprovalDecisionMatch[1],
          body?.decision,
          body?.signatureDER,
        );
        await audit({
          event: "codex_owner_task_decided",
          taskHash: createHash("sha256").update(result.id).digest("hex"),
          planSha256: result.task.planSha256,
          decision: result.status,
          deviceHash: createHash("sha256").update(device.id).digest("hex"),
        });
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/approval-key") {
        if (!hasScope(device, "approvals")) return json(response, 403, { error: "device_scope_required" });
        const body = await readBody(request);
        const result = await approvalStore.registerDeviceKey(device.id, body?.publicKeyDER);
        await audit({
          event: "approval_key_registered",
          deviceHash: createHash("sha256").update(device.id).digest("hex"),
          created: result.created,
        });
        return json(response, result.created ? 201 : 200, result);
      }
      if (request.method === "GET" && url.pathname === "/api/approvals") {
        if (!hasScope(device, "approvals")) return json(response, 403, { error: "device_scope_required" });
        const requests = (await approvalStore.listPending()).filter((entry) => entry.kind !== "codex.execute");
        return json(response, 200, { requests });
      }
      const approvalDecisionMatch = /^\/api\/approvals\/([A-Za-z0-9_-]{16,128})\/decision$/.exec(url.pathname);
      if (request.method === "POST" && approvalDecisionMatch) {
        if (!hasScope(device, "approvals")) return json(response, 403, { error: "device_scope_required" });
        if (await ownerCodexTasks.approvalKind(approvalDecisionMatch[1]) === "codex.execute") {
          return json(response, 403, { error: "codex_dedicated_approval_required" });
        }
        const body = await readBody(request);
        const result = await approvalStore.decide({
          id: approvalDecisionMatch[1],
          deviceId: device.id,
          decision: body?.decision,
          signatureDER: body?.signatureDER,
        });
        await audit({
          event: "approval_decided",
          requestHash: createHash("sha256").update(result.id).digest("hex"),
          payloadSha256: result.payloadSha256,
          decision: result.status,
          deviceHash: createHash("sha256").update(device.id).digest("hex"),
        });
        json(response, 200, result);
        if (result.status === "approved" && result.kind === "gpt.consult" && GROWTH_TRANSPORT === "openclaw") {
          setImmediate(async () => {
            try {
              const dispatched = await growth.dispatchApprovedRequest(result.id);
              if (!dispatched) return;
              const proposalContent = proposalContentFromAdvice(parseStructuredAdvice(dispatched.externalResponse));
              await growth.quarantineAdvice({
                requestId: result.id,
                correlationId: dispatched.receipt.correlationId,
                proposalContent,
              });
              await audit({
                event: "growth_advice_quarantined",
                requestHash: createHash("sha256").update(result.id).digest("hex"),
                payloadSha256: result.payloadSha256,
              });
            } catch (error) {
              await audit({
                event: "growth_dispatch_failed",
                requestHash: createHash("sha256").update(result.id).digest("hex"),
                errorClass: error?.name ?? "Error",
              });
            }
          });
        }
        if (result.status === "approved" && result.kind === OWNER_ACTION_KIND) {
          setImmediate(async () => {
            try {
              await ownerActionExecutor.executeApproved(result.id, result.payloadSha256);
            } catch (error) {
              await audit({
                event: "owner_action_execute_failed",
                requestHash: createHash("sha256").update(result.id).digest("hex"),
                errorClass: error?.name ?? "Error",
              });
            }
          });
        }
        if (result.kind === ROOM_HOUSE_DO_KIND) {
          setImmediate(async () => {
            try {
              if (result.status === "rejected") {
                await roomStore.addAssistant("거절해서 이번 점검은 하지 않았습니다.");
                return;
              }
              if (result.status !== "approved") return;
              const report = await executeApprovedHouseDo({
                approvalStore,
                approvalId: result.id,
                payloadSha256: result.payloadSha256,
              });
              await roomStore.addAssistant(report);
              await audit({
                event: "room_house_do_executed",
                requestHash: createHash("sha256").update(result.id).digest("hex"),
                payloadSha256: result.payloadSha256,
              });
            } catch (error) {
              try {
                await roomStore.addAssistant("승인은 됐지만 이번 점검은 끝내지 못했습니다. 다시 시키면 Face ID 한 번 후에 맥이 합니다.");
              } catch {
                // 방 기록이 안 되어도 승인은 이미 소비됐을 수 있다
              }
              await audit({
                event: "room_house_do_execute_failed",
                requestHash: createHash("sha256").update(result.id).digest("hex"),
                errorClass: error?.name ?? "Error",
              });
            }
          });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/tts/catalog") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 200, ttsRegistry.catalog());
      }
      if (request.method === "GET" && url.pathname === "/api/communication/status") {
        if (!hasScope(device, "approvals") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        return json(response, 200, await communicationStatus(codexTaskStore));
      }
      if (request.method === "POST" && url.pathname === "/api/communication/telegram") {
        if (!hasScope(device, "approvals") || device.role !== "owner") return json(response, 403, { error: "owner_device_required" });
        const body = await readBody(request);
        if (typeof body?.botToken !== "string" || !/^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$/.test(body.botToken)) {
          return json(response, 400, { error: "invalid_telegram_token" });
        }
        if (body.ownerId !== undefined && !/^[1-9][0-9]{5,19}$/.test(String(body.ownerId))) {
          return json(response, 400, { error: "invalid_telegram_owner" });
        }
        const configured = await processJson(TELEGRAM_CONFIG_SCRIPT, {
          botToken: body.botToken,
          ...(body.ownerId === undefined ? {} : { ownerId: String(body.ownerId) }),
        });
        await audit({ event: "telegram_general_configured", mode: "general_chat_only", deviceHash: createHash("sha256").update(device.id).digest("hex") });
        return json(response, 200, configured);
      }
      if (request.method === "GET" && url.pathname === "/api/growth/status") {
        if (!hasScope(device, "approvals")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 200, {
          ...(await growth.status()),
          dlpPolicy: DLP_POLICY_VERSION,
          blockedCategories: "personal_and_unclassified",
        });
      }
      if (request.method === "GET" && url.pathname === "/api/growth/proposals") {
        if (!hasScope(device, "approvals")) return json(response, 403, { error: "device_scope_required" });
        const records = await proposalStore.listLatest({ limit: 50 });
        return json(response, 200, {
          proposals: records.map((record) => ({
            id: record.id,
            revision: record.revision,
            updatedAt: record.updatedAt,
            status: record.lifecycle.status,
            title: record.content.title,
            summary: record.content.summary,
            scopes: record.content.scopes,
            trust: record.trust,
          })),
        });
      }
      if (request.method === "POST" && url.pathname === "/api/tts/stream") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        const body = await readBody(request);
        const deviceHash = createHash("sha256").update(device.id).digest("hex");
        const session = new SpeechSession({
          registry: ttsRegistry,
          auditSink: (entry) => audit({ ...entry, deviceHash }),
        });
        response.writeHead(200, {
          ...securityHeaders("application/x-ndjson; charset=utf-8"),
          "Cache-Control": "no-store, no-transform",
          "X-Content-Type-Options": "nosniff",
        });
        const signal = createRequestSignal(request, response, 120_000);
        await streamTtsEvents(response, session.stream(body?.text, {
          providerId: body?.providerId,
          voiceId: body?.voiceId,
          style: body?.style,
          allowClientFallback: body?.allowClientFallback !== false,
          signal,
        }), { signal });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/inbox") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        return json(response, 200, { messages: await proactiveStore.consumePending() });
      }
      if (request.method === "POST" && url.pathname === "/api/chat") {
        if (!hasScope(device, "chat")) return json(response, 403, { error: "device_scope_required" });
        return await forwardChat(request, response, device, await readBody(request), intentShadow, confirmedMemory);
      }
      return json(response, 404, { error: "not_found" });
    } catch (error) {
      if (!response.headersSent) json(response, error?.statusCode ?? (error instanceof SyntaxError ? 400 : 502), { error: "request_failed" });
      else response.end();
      await audit({ event: "request_failed", errorClass: error?.name ?? "Error" });
    }
  });

  let codexReconcileRunning = false;
  const codexReconcileTimer = setInterval(() => {
    if (codexReconcileRunning) return;
    codexReconcileRunning = true;
    void ownerCodexTasks.reconcileAll()
      .then(() => ownerCodexTasks.pruneRetention())
      .catch(() => audit({ event: "codex_owner_task_reconcile_failed", errorClass: "CodexReconcileError" }))
      .finally(() => { codexReconcileRunning = false; });
  }, 30_000);
  codexReconcileTimer.unref();
  server.once("close", () => clearInterval(codexReconcileTimer));

  server.listen(PORT, HOST, () => console.log(`Local AI Secure Chat listening on http://${HOST}:${PORT}`));
}

main().catch((error) => {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
});
