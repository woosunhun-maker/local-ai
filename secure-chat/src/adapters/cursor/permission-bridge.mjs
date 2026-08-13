/**
 * Cursor ACP session/request_permission → Local AI Approval Manager 연결.
 * allow-always 기본 사용 금지. Local AI가 임의 승인하지 않는다.
 */
import { createHash, randomUUID } from "node:crypto";
import { assertWritablePath, CURSOR_PROJECT_ROOT } from "./sandbox.mjs";

export const CURSOR_PERMISSION_KIND = "cursor.tool_permission";
export const CURSOR_DEVELOP_KIND = "cursor.develop";

export const PERMISSION_RISKS = Object.freeze(["READ", "WRITE", "EXECUTE", "HIGH_RISK"]);

const READ_TITLE_RE = /\b(read|list|stat|cat|git status|git diff|git log|git show)\b/iu;
const WRITE_KIND_RE = /\b(write|edit|create|apply_patch|strreplace)\b/iu;
const HIGH_RE = /\b(rm\b|unlink|delete|git\s+push|git\s+reset|deploy|chmod|chown|mkfs|\bdd\b|keychain|privateai)\b/iu;
const DEFAULT_EXECUTE_ALLOWLIST = Object.freeze([
  /^npm test(?:\s|$)/u,
  /^npm run test(?:\s|$)/u,
  /^node --test(?:\s|$)/u,
  /^git status(?:\s|$)/u,
  /^git diff(?:\s|$)/u,
  /^git log(?:\s|$)/u,
]);

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function toolCallText(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return "";
  const parts = [
    toolCall.kind,
    toolCall.title,
    toolCall.toolName,
    typeof toolCall.rawInput === "string" ? toolCall.rawInput : JSON.stringify(toolCall.rawInput ?? {}),
  ];
  return parts.filter(Boolean).join(" ").slice(0, 4_000);
}

export function classifyCursorPermission(toolCall, {
  executeAllowlist = DEFAULT_EXECUTE_ALLOWLIST,
  projectRoot = CURSOR_PROJECT_ROOT,
} = {}) {
  const text = toolCallText(toolCall);
  const kind = String(toolCall?.kind ?? "").toLowerCase();

  if (HIGH_RE.test(text) || /privateai|diol-os/iu.test(text)) {
    return Object.freeze({ risk: "HIGH_RISK", reason: "high_risk_pattern", auto_allow: false });
  }

  // path 추출 시도
  const pathMatch = text.match(/(?:^|[\s"'])(\/?Users\/[^\s"']+|[\w./-]+\.[a-z0-9]{1,12})/iu);
  if (pathMatch) {
    try {
      assertWritablePath(pathMatch[1], { projectRoot });
    } catch (error) {
      return Object.freeze({
        risk: "HIGH_RISK",
        reason: error?.message ?? "sandbox_forbidden_path",
        auto_allow: false,
      });
    }
  }

  if (kind === "read" || READ_TITLE_RE.test(text)) {
    return Object.freeze({ risk: "READ", reason: "read_class", auto_allow: true });
  }

  if (kind === "shell" || kind === "execute" || /\bshell\b/iu.test(text)) {
    const command = String(toolCall?.title ?? toolCall?.rawInput?.command ?? text).trim();
    const allowed = executeAllowlist.some((re) => re.test(command));
    if (allowed) {
      return Object.freeze({ risk: "EXECUTE", reason: "execute_allowlist", auto_allow: true });
    }
    return Object.freeze({ risk: "EXECUTE", reason: "execute_not_allowlisted", auto_allow: false });
  }

  if (kind === "edit" || kind === "write" || WRITE_KIND_RE.test(text)) {
    return Object.freeze({ risk: "WRITE", reason: "write_class", auto_allow: false });
  }

  return Object.freeze({ risk: "HIGH_RISK", reason: "unclassified_require_approval", auto_allow: false });
}

/**
 * @param {{
 *   approvalStore: { createRequest: Function, get: Function },
 *   waitForDecision?: (approvalId: string) => Promise<"approved"|"rejected"|"expired"|"cancelled">,
 * }} deps
 */
export function createCursorPermissionBridge({
  approvalStore,
  waitForDecision = null,
  executeAllowlist = DEFAULT_EXECUTE_ALLOWLIST,
  projectRoot = CURSOR_PROJECT_ROOT,
  now = () => Date.now(),
} = {}) {
  if (!approvalStore?.createRequest || !approvalStore?.get) fail("invalid_approval_store");

  async function decide(toolCall, { taskId = null, sessionId = null } = {}) {
    const classification = classifyCursorPermission(toolCall, { executeAllowlist, projectRoot });
    if (classification.auto_allow) {
      return Object.freeze({
        optionId: "allow-once",
        risk: classification.risk,
        reason: classification.reason,
        approval_id: null,
      });
    }

    const payload = JSON.stringify({
      schema: "local-ai.cursor-permission.v1",
      task_id: taskId,
      session_id: sessionId,
      risk: classification.risk,
      tool_call: {
        toolCallId: toolCall?.toolCallId ?? null,
        kind: toolCall?.kind ?? null,
        title: typeof toolCall?.title === "string" ? toolCall.title.slice(0, 200) : null,
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
      // 폴링: 테스트/런타임이 외부에서 decide 할 때까지 짧게 대기하지 않고 거부 기본
      // 실제 서버는 waitForDecision을 ApprovalStore 폴링으로 주입한다.
      const latest = await approvalStore.get(created.id);
      status = latest?.status ?? "pending";
      if (status === "pending") {
        return Object.freeze({
          optionId: "reject-once",
          risk: classification.risk,
          reason: "approval_pending_no_waiter",
          approval_id: created.id,
        });
      }
    }

    if (status === "approved" || status === "consumed") {
      return Object.freeze({
        optionId: "allow-once", // allow-always 사용 금지
        risk: classification.risk,
        reason: "owner_approved",
        approval_id: created.id,
      });
    }

    return Object.freeze({
      optionId: "reject-once",
      risk: classification.risk,
      reason: `approval_${status}`,
      approval_id: created.id,
    });
  }

  return Object.freeze({ decide, classifyCursorPermission });
}

export { DEFAULT_EXECUTE_ALLOWLIST };
