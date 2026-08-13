/**
 * Cursor ACP JSON-RPC 클라이언트 — `agent acp` child process.
 * API key 무인 인증은 사용하지 않는다. authenticate는 cursor_login만.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { CURSOR_PROJECT_ROOT } from "./sandbox.mjs";

function fail(code, statusCode = 500) {
  throw Object.assign(new Error(code), { statusCode });
}

export function createCursorAcpClient({
  agentPath = "agent",
  cwd = CURSOR_PROJECT_ROOT,
  env = process.env,
  spawnImpl = spawn,
  onLog = null,
} = {}) {
  let child = null;
  let rl = null;
  let nextId = 1;
  const pending = new Map();
  let closed = false;

  function emitLog(line) {
    if (typeof onLog === "function") onLog(line);
  }

  function send(method, params) {
    if (!child?.stdin) fail("acp_not_started");
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  }

  function respond(id, result) {
    if (!child?.stdin) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  function respondError(id, error) {
    if (!child?.stdin) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error })}\n`);
  }

  async function start() {
    if (child) fail("acp_already_started");
    child = spawnImpl(agentPath, ["acp"], {
      cwd,
      env: { ...env, PATH: `${env.PATH ?? ""}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => emitLog(String(chunk)));

    rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        emitLog(`acp_non_json:${line.slice(0, 200)}`);
        return;
      }

      if (msg.id != null && (Object.hasOwn(msg, "result") || Object.hasOwn(msg, "error"))) {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if (msg.error) waiter.reject(Object.assign(new Error(msg.error.message ?? "acp_error"), { acp: msg.error }));
        else waiter.resolve(msg.result);
        return;
      }

      if (typeof msg.method === "string") {
        handlers.onNotification?.(msg);
      }
    });

    return Object.freeze({ pid: child.pid });
  }

  const handlers = {
    onNotification: null,
  };

  async function initialize(clientInfo = { name: "local-ai-cursor-adapter", version: "0.1.0" }) {
    return send("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo,
    });
  }

  /** API key 경로 없음 — CLI 로그인(cursor_login)만 */
  async function authenticate() {
    return send("authenticate", { methodId: "cursor_login" });
  }

  async function newSession({ mcpServers = [] } = {}) {
    return send("session/new", { cwd, mcpServers });
  }

  async function loadSession(sessionId) {
    return send("session/load", { sessionId, cwd });
  }

  /**
   * prompt를 보내고 session/update·permission을 처리한다.
   */
  async function prompt({
    sessionId,
    text,
    onUpdate = null,
    onPermission = null,
    onExtension = null,
  }) {
    if (typeof sessionId !== "string" || !sessionId) fail("invalid_session_id");
    if (typeof text !== "string" || !text.trim()) fail("invalid_prompt");

    handlers.onNotification = async (msg) => {
      try {
        if (msg.method === "session/update") {
          onUpdate?.(msg.params);
          return;
        }
        if (msg.method === "session/request_permission") {
          if (typeof onPermission !== "function") {
            respond(msg.id, { outcome: { outcome: "selected", optionId: "reject-once" } });
            return;
          }
          const decision = await onPermission(msg.params);
          const optionId = decision?.optionId === "allow-once" ? "allow-once" : "reject-once";
          // allow-always 금지
          respond(msg.id, { outcome: { outcome: "selected", optionId } });
          return;
        }
        if (msg.method === "cursor/ask_question") {
          respond(msg.id, { outcome: { outcome: "skipped", reason: "local_ai_requires_owner_path" } });
          onExtension?.(msg);
          return;
        }
        if (msg.method === "cursor/create_plan") {
          respond(msg.id, { outcome: { outcome: "rejected", reason: "plan_requires_separate_approval" } });
          onExtension?.(msg);
          return;
        }
        if (msg.method?.startsWith("cursor/")) {
          // notifications — no response required for some; if id present, accept
          if (msg.id != null) respond(msg.id, { outcome: { outcome: "accepted" } });
          onExtension?.(msg);
        }
      } catch (error) {
        if (msg.id != null) {
          respond(msg.id, { outcome: { outcome: "selected", optionId: "reject-once" } });
        }
        emitLog(`acp_handler_error:${error?.message ?? error}`);
      }
    };

    return send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: text.trim() }],
    });
  }

  async function cancel(sessionId) {
    if (!child?.stdin) return;
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId },
    })}\n`);
  }

  async function close() {
    if (closed) return { exitCode: null };
    closed = true;
    handlers.onNotification = null;
    for (const waiter of pending.values()) {
      waiter.reject(Object.assign(new Error("acp_closed"), { statusCode: 499 }));
    }
    pending.clear();
    try {
      rl?.close();
    } catch {
      // ignore
    }
    if (!child) return { exitCode: null };
    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 3_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      try {
        child.stdin?.end();
        child.kill("SIGTERM");
      } catch {
        resolve(child.exitCode);
      }
    });
    child = null;
    return Object.freeze({ exitCode });
  }

  return Object.freeze({
    start,
    initialize,
    authenticate,
    newSession,
    loadSession,
    prompt,
    cancel,
    close,
    respond,
    respondError,
  });
}
