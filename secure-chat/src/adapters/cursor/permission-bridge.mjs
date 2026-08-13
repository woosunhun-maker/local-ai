/**
 * Cursor ACP session/request_permission → Local AI Approval Manager 연결.
 * allow-always 기본 사용 금지. Local AI가 임의 승인하지 않는다.
 *
 * Cursor가 EXECUTE로 보내도 shell의 filesystem effect는 Local AI가
 * WRITE / HIGH_RISK로 재분류한다.
 */
import { createHash, randomUUID } from "node:crypto";
import { assertWritablePath, CURSOR_PROJECT_ROOT } from "./sandbox.mjs";

export const CURSOR_PERMISSION_KIND = "cursor.tool_permission";
export const CURSOR_DEVELOP_KIND = "cursor.develop";

export const PERMISSION_RISKS = Object.freeze(["READ", "WRITE", "EXECUTE", "HIGH_RISK"]);

/** 저위험 읽기/테스트/빌드만 — filesystem write effect 없어야 한다. */
export const DEFAULT_EXECUTE_ALLOWLIST = Object.freeze([
  /^npm test(?:\s|$)/u,
  /^npm run test(?:\s|$)/u,
  /^npm run lint(?:\s|$)/u,
  /^npm run typecheck(?:\s|$)/u,
  /^npm run build(?:\s|$)/u,
  /^npm run check(?:\s|$)/u,
  /^node --test(?:\s|$)/u,
  /^git status(?:\s|$)/u,
  /^git diff(?:\s|$)/u,
  /^git log(?:\s|$)/u,
  /^git show(?:\s|$)/u,
]);

const READ_KIND_RE = /^(read|search|grep|glob)$/iu;
const WRITE_KIND_RE = /^(write|edit|create|apply_patch|strreplace|delete_file)$/iu;

/** shell filesystem write / destructive effects */
const FS_WRITE_EFFECT_RE = /(?:^|[\s;|&])(?:tee|touch|mkdir|rmdir|rm|mv|cp|install|install[_\s-]?name|dd|truncate|chmod|chown|ln|unlink|shred)\b|(?:^|[\s;|&])(?:cat|printf|echo)\b[^|;]*[>]{1,2}|[>]{1,2}\s*\/|[>]{1,2}\s*[\w./-]+|(?:^|[\s;|&])sed\s+-i\b|(?:^|[\s;|&])perl\s+-i\b|(?:^|[\s;|&])ruby\s+-i\b/iu;

const HIGH_RE = /\b(?:git\s+push|git\s+reset(?:\s+--hard)?|deploy|mkfs|keychain|privateai|curl\s+https?:\/\/(?!127\.0\.0\.1)|wget\s+https?:)/iu;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

export function extractShellCommand(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return "";
  if (typeof toolCall.rawInput?.command === "string") return toolCall.rawInput.command.trim();
  if (typeof toolCall.command === "string") return toolCall.command.trim();
  if (typeof toolCall.title === "string" && /^(shell|execute|bash|zsh)/iu.test(String(toolCall.kind ?? ""))) {
    return toolCall.title.trim();
  }
  if (typeof toolCall.title === "string" && /[|>]|npm |git |node /u.test(toolCall.title)) {
    return toolCall.title.trim();
  }
  return "";
}

function toolCallText(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return "";
  const parts = [
    toolCall.kind,
    toolCall.title,
    toolCall.toolName,
    extractShellCommand(toolCall),
    typeof toolCall.rawInput === "string" ? toolCall.rawInput : JSON.stringify(toolCall.rawInput ?? {}),
  ];
  return parts.filter(Boolean).join(" ").slice(0, 4_000);
}

/**
 * shell 명령의 실제 effect를 Local AI가 분류한다.
 * Cursor kind=EXECUTE여도 FS write면 WRITE/HIGH로 승격.
 */
export function classifyShellCommandEffect(command, {
  executeAllowlist = DEFAULT_EXECUTE_ALLOWLIST,
} = {}) {
  const cmd = String(command ?? "").trim();
  if (!cmd) {
    return Object.freeze({ risk: "HIGH_RISK", reason: "empty_shell_command", auto_allow: false });
  }
  if (HIGH_RE.test(cmd) || /privateai|diol-os/iu.test(cmd)) {
    return Object.freeze({ risk: "HIGH_RISK", reason: "high_risk_shell_pattern", auto_allow: false });
  }
  if (FS_WRITE_EFFECT_RE.test(cmd)) {
    const isDestructive = /\b(?:rm|rmdir|unlink|shred|mkfs|dd)\b/iu.test(cmd);
    return Object.freeze({
      risk: isDestructive ? "HIGH_RISK" : "WRITE",
      reason: isDestructive ? "shell_destructive_fs_effect" : "shell_filesystem_write_effect",
      auto_allow: false,
      escalated_from: "EXECUTE",
    });
  }
  const allowed = executeAllowlist.some((re) => re.test(cmd));
  if (allowed) {
    // allowlist여도 redirection이 섞이면 위에서 이미 WRITE로 걸림
    return Object.freeze({ risk: "EXECUTE", reason: "execute_allowlist", auto_allow: true });
  }
  return Object.freeze({
    risk: "EXECUTE",
    reason: "execute_not_allowlisted",
    auto_allow: false,
  });
}

export function classifyCursorPermission(toolCall, {
  executeAllowlist = DEFAULT_EXECUTE_ALLOWLIST,
  projectRoot = CURSOR_PROJECT_ROOT,
  writeRoots = null,
  mainRepo = null,
  mainReadOnly = false,
} = {}) {
  const text = toolCallText(toolCall);
  const kind = String(toolCall?.kind ?? "").toLowerCase();
  const shellCommand = extractShellCommand(toolCall);
  const sandboxOpts = { projectRoot, writeRoots, mainRepo, mainReadOnly };

  if (HIGH_RE.test(text) || /privateai|\/Users\/hun\/PrivateAI/iu.test(text)) {
    return Object.freeze({ risk: "HIGH_RISK", reason: "high_risk_pattern", auto_allow: false });
  }

  const pathMatch = text.match(/(?:^|[\s"'])(\/?Users\/[^\s"']+|[\w./-]+\.[a-z0-9]{1,12})/iu);
  if (pathMatch) {
    try {
      assertWritablePath(pathMatch[1], sandboxOpts);
    } catch (error) {
      return Object.freeze({
        risk: "HIGH_RISK",
        reason: error?.message ?? "sandbox_forbidden_path",
        auto_allow: false,
      });
    }
  }

  const isShell = kind === "shell" || kind === "execute" || kind === "terminal"
    || /\bshell\b/iu.test(String(toolCall?.title ?? ""))
    || shellCommand.length > 0;

  if (isShell && shellCommand) {
    return classifyShellCommandEffect(shellCommand, { executeAllowlist });
  }

  if (isShell && !shellCommand) {
    // EXECUTE라고만 오고 command를 못 뽑으면 보수적으로 WRITE 승인 요구
    return Object.freeze({
      risk: "WRITE",
      reason: "execute_without_parsable_command",
      auto_allow: false,
      escalated_from: "EXECUTE",
    });
  }

  if (READ_KIND_RE.test(kind) || /\b(read|list|stat)\b/iu.test(text)) {
    return Object.freeze({ risk: "READ", reason: "read_class", auto_allow: true });
  }

  if (WRITE_KIND_RE.test(kind) || /\b(write|edit|create|apply_patch|strreplace)\b/iu.test(text)) {
    return Object.freeze({ risk: "WRITE", reason: "write_class", auto_allow: false });
  }

  return Object.freeze({ risk: "HIGH_RISK", reason: "unclassified_require_approval", auto_allow: false });
}

export function createCursorPermissionBridge({
  approvalStore,
  waitForDecision = null,
  executeAllowlist = DEFAULT_EXECUTE_ALLOWLIST,
  projectRoot = CURSOR_PROJECT_ROOT,
  writeRoots = null,
  mainRepo = null,
  mainReadOnly = false,
  now = () => Date.now(),
} = {}) {
  if (!approvalStore?.createRequest || !approvalStore?.get) fail("invalid_approval_store");

  async function decide(toolCall, {
    taskId = null,
    sessionId = null,
    writeRoots: runWriteRoots = null,
    mainRepo: runMainRepo = null,
    mainReadOnly: runMainReadOnly = null,
    projectRoot: runProjectRoot = null,
  } = {}) {
    const classification = classifyCursorPermission(toolCall, {
      executeAllowlist,
      projectRoot: runProjectRoot ?? projectRoot,
      writeRoots: runWriteRoots ?? writeRoots,
      mainRepo: runMainRepo ?? mainRepo,
      mainReadOnly: runMainReadOnly ?? mainReadOnly,
    });
    if (classification.auto_allow) {
      return Object.freeze({
        optionId: "allow-once",
        risk: classification.risk,
        reason: classification.reason,
        approval_id: null,
        escalated_from: classification.escalated_from ?? null,
      });
    }

    const payload = JSON.stringify({
      schema: "local-ai.cursor-permission.v1",
      task_id: taskId,
      session_id: sessionId,
      risk: classification.risk,
      escalated_from: classification.escalated_from ?? null,
      tool_call: {
        toolCallId: toolCall?.toolCallId ?? null,
        kind: toolCall?.kind ?? null,
        title: typeof toolCall?.title === "string" ? toolCall.title.slice(0, 200) : null,
        command: extractShellCommand(toolCall).slice(0, 500) || null,
      },
      created_at: new Date(now()).toISOString(),
    });

    const approvalId = `cursorperm-${createHash("sha256")
      .update(`${taskId ?? "task"}:${sessionId ?? "sess"}:${toolCall?.toolCallId ?? randomUUID()}`)
      .digest("hex")
      .slice(0, 24)}`;

    const created = await approvalStore.createRequest({
      kind: CURSOR_PERMISSION_KIND,
      title: `Cursor ${classification.risk} 승인`,
      summary: `Cursor ACP 도구 권한(${classification.risk}): ${String(toolCall?.title ?? toolCall?.kind ?? "tool").slice(0, 180)}`,
      payload,
      dataCategories: ["cursor_tool_permission", "task_instruction"],
    }, 15 * 60_000, { id: approvalId });

    let status = created.status;
    if (status === "pending" && typeof waitForDecision === "function") {
      status = await waitForDecision(created.id);
    } else if (status === "pending") {
      const latest = await approvalStore.get(created.id);
      status = latest?.status ?? "pending";
      if (status === "pending") {
        return Object.freeze({
          optionId: "reject-once",
          risk: classification.risk,
          reason: "approval_pending_no_waiter",
          approval_id: created.id,
          escalated_from: classification.escalated_from ?? null,
        });
      }
    }

    if (status === "approved" || status === "consumed") {
      return Object.freeze({
        optionId: "allow-once",
        risk: classification.risk,
        reason: "owner_approved",
        approval_id: created.id,
        escalated_from: classification.escalated_from ?? null,
      });
    }

    return Object.freeze({
      optionId: "reject-once",
      risk: classification.risk,
      reason: `approval_${status}`,
      approval_id: created.id,
      escalated_from: classification.escalated_from ?? null,
    });
  }

  return Object.freeze({ decide, classifyCursorPermission, classifyShellCommandEffect });
}
