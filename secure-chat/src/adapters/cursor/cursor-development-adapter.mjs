/**
 * CursorDevelopmentAdapter — cursor.develop vertical slice.
 * GUI 자동화 없음. agent acp + Approval Manager + host collector만 사용.
 */
import { createHash } from "node:crypto";
import { createEvidenceRecord } from "../../evidence/evidence.mjs";
import { createCursorAcpClient } from "./acp-client.mjs";
import {
  createCursorPermissionBridge,
  CURSOR_DEVELOP_KIND,
} from "./permission-bridge.mjs";
import { collectCursorHostResult } from "./host-result-collector.mjs";
import { CURSOR_PROJECT_ROOT } from "./sandbox.mjs";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

export function cursorDevelopApprovalId(taskId) {
  return `cursordev-${createHash("sha256").update(`cursor.develop:${taskId}`).digest("hex").slice(0, 24)}`;
}

export function createCursorDevelopmentAdapter({
  approvalStore,
  createAcpClient = createCursorAcpClient,
  permissionBridge = null,
  projectRoot = CURSOR_PROJECT_ROOT,
  agentPath = process.env.LOCAL_AI_CURSOR_AGENT_PATH || `${process.env.HOME}/.local/bin/agent`,
  waitForPermissionDecision = null,
  developmentLedger = null,
  now = () => Date.now(),
} = {}) {
  if (!approvalStore?.createRequest || !approvalStore?.get) fail("invalid_approval_store");

  const bridge = permissionBridge ?? createCursorPermissionBridge({
    approvalStore,
    waitForDecision: waitForPermissionDecision,
    projectRoot,
    now,
  });

  async function ensureTaskApproval({ task, prompt, testCommand }) {
    const approvalId = task.bindings?.cursor?.approval_id ?? cursorDevelopApprovalId(task.task_id);
    const existing = await approvalStore.get(approvalId);
    if (existing) {
      return Object.freeze({
        approval: existing,
        binding: Object.freeze({
          module: "cursor",
          approval_id: existing.id,
          kind: CURSOR_DEVELOP_KIND,
        }),
        created: false,
      });
    }

    const payload = JSON.stringify({
      schema: "local-ai.cursor-develop.v1",
      task_id: task.task_id,
      prompt,
      test_command: testCommand,
      cwd: projectRoot,
      forbidden: ["diol-os", "/Users/hun/PrivateAI"],
      auto_commit: false,
      auto_push: false,
      auto_deploy: false,
    });

    const created = await approvalStore.createRequest({
      kind: CURSOR_DEVELOP_KIND,
      title: "Cursor 개발 작업 승인",
      summary: `Local AI Task가 Cursor ACP로 코드 수정을 위임합니다: ${String(prompt).slice(0, 160)}`,
      payload,
      dataCategories: ["cursor_develop", "task_instruction", "code_change"],
    }, 30 * 60_000, { id: approvalId });

    return Object.freeze({
      approval: created,
      binding: Object.freeze({
        module: "cursor",
        approval_id: created.id,
        kind: CURSOR_DEVELOP_KIND,
      }),
      created: true,
    });
  }

  async function runDevelop({
    task,
    prompt,
    testCommand = null,
    channel = "local_owner_app",
  }) {
    if (channel === "telegram") fail("telegram_cursor_develop_forbidden", 403);
    if (typeof prompt !== "string" || prompt.trim().length < 8) fail("invalid_cursor_prompt");
    if (task?.approval_required !== true) fail("cursor_develop_requires_approval_flag", 409);

    const ensured = await ensureTaskApproval({
      task,
      prompt: prompt.trim(),
      testCommand,
    });

    const approval = await approvalStore.get(ensured.binding.approval_id);
    if (!approval || approval.status === "pending") {
      return Object.freeze({
        phase: "WAITING_APPROVAL",
        binding: ensured.binding,
        approval_id: ensured.binding.approval_id,
        approval_status: approval?.status ?? "missing",
        message: "owner 앱에서 cursor.develop 승인 후 재실행. has_approval boolean은 무시됩니다.",
        evidence: Object.freeze([
          createEvidenceRecord({
            epistemic: "VERIFIED",
            claim: `approval.status=${approval?.status ?? "missing"}`,
            source: "approval_store.lookup",
            taskId: task.task_id,
            detail: {
              approval_id: ensured.binding.approval_id,
              kind: CURSOR_DEVELOP_KIND,
            },
          }),
        ]),
        host: null,
        session_id: null,
      });
    }
    if (!["approved", "consumed"].includes(approval.status)) {
      return Object.freeze({
        phase: "FAILED",
        binding: ensured.binding,
        approval_id: approval.id,
        approval_status: approval.status,
        message: `cursor.develop 승인 상태=${approval.status}`,
        evidence: Object.freeze([
          createEvidenceRecord({
            epistemic: "VERIFIED",
            claim: `approval.status=${approval.status}`,
            source: "approval_store.lookup",
            taskId: task.task_id,
            detail: { approval_id: approval.id },
          }),
        ]),
        host: null,
        session_id: null,
      });
    }

    const startedAt = new Date(now()).toISOString();
    const client = createAcpClient({
      agentPath,
      cwd: projectRoot,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
      },
    });

    let sessionId = null;
    let stopReason = null;
    let exitCode = null;
    let cancelled = false;
    let runError = null;
    const updates = [];

    try {
      await client.start();
      await client.initialize({ name: "local-ai-cursor-development-adapter", version: "0.1.0" });
      await client.authenticate();
      const session = await client.newSession({ mcpServers: [] });
      sessionId = session?.sessionId ?? null;
      if (!sessionId) fail("acp_session_missing", 502);

      const boundedPrompt = [
        "You are running under Local AI CursorDevelopmentAdapter.",
        `Project root (only writable area): ${projectRoot}`,
        "Do NOT modify diol-os/, /Users/hun/PrivateAI, or any path outside the project root.",
        "Do NOT git commit, push, or deploy.",
        "Make the smallest safe change requested below, then stop.",
        "",
        prompt.trim(),
      ].join("\n");

      const promptResult = await client.prompt({
        sessionId,
        text: boundedPrompt,
        onUpdate: (params) => {
          updates.push(params);
        },
        onPermission: async (params) => bridge.decide(params?.toolCall ?? params, {
          taskId: task.task_id,
          sessionId,
        }),
      });
      stopReason = promptResult?.stopReason ?? null;
    } catch (error) {
      runError = error?.message ?? String(error);
      try {
        if (sessionId) {
          cancelled = true;
          await client.cancel(sessionId);
        }
      } catch {
        // ignore
      }
    } finally {
      const closed = await client.close().catch(() => ({ exitCode: null }));
      exitCode = closed?.exitCode ?? null;
    }

    const finishedAt = new Date(now()).toISOString();
    const host = await collectCursorHostResult({
      taskId: task.task_id,
      sessionId,
      startedAt,
      finishedAt,
      stopReason,
      exitCode,
      error: runError,
      cancelled,
      testCommand,
      cwd: projectRoot,
    });

    if (host.blocked_files.length > 0) {
      return Object.freeze({
        phase: "FAILED",
        binding: ensured.binding,
        approval_id: ensured.binding.approval_id,
        approval_status: approval.status,
        session_id: sessionId,
        host,
        evidence: Object.freeze([
          ...host.evidence,
          createEvidenceRecord({
            epistemic: "VERIFIED",
            claim: "sandbox_forbidden_change_detected",
            source: "cursor.sandbox",
            taskId: task.task_id,
            detail: { blocked_files: host.blocked_files },
          }),
        ]),
        message: "금지 경로 변경이 관측됨",
      });
    }

    if (developmentLedger?.record) {
      await developmentLedger.record({
        request: `cursor.develop task_id=${task.task_id}; session=${sessionId}; diff=${host.diff_hash}`,
        proposedBy: "cursor-development-adapter",
        approvedBy: "owner-approval-store",
        filesChanged: host.changed_files.slice(0, 50),
        tests: host.test_command
          ? `${host.test_command} exit=${host.test_exit_code}`
          : null,
        verification: host.status,
        rollbackReference: `cursor-diff:${host.diff_hash.slice(0, 16)}`,
      }).catch(() => null);
    }

    return Object.freeze({
      phase: "VERIFYING",
      binding: ensured.binding,
      approval_id: ensured.binding.approval_id,
      approval_status: approval.status,
      session_id: sessionId,
      host,
      evidence: Object.freeze([
        createEvidenceRecord({
          epistemic: "VERIFIED",
          claim: `approval.status=${approval.status}`,
          source: "approval_store.lookup",
          taskId: task.task_id,
          detail: { approval_id: approval.id, kind: CURSOR_DEVELOP_KIND },
        }),
        ...host.evidence,
        createEvidenceRecord({
          epistemic: "INFERRED",
          claim: "cursor natural-language completion is not success evidence",
          source: "cursor.adapter",
          taskId: task.task_id,
          detail: { updates_count: updates.length },
        }),
      ]),
      message: null,
    });
  }

  return Object.freeze({
    runDevelop,
    ensureTaskApproval,
    cursorDevelopApprovalId,
  });
}

export function verifyCursorHostOutcome(host) {
  if (!host) {
    return Object.freeze({ result: "UNKNOWN", reason: "missing_host_result" });
  }
  if (host.blocked_files?.length > 0) {
    return Object.freeze({ result: "FAIL", reason: "forbidden_paths_changed" });
  }
  if (host.cancelled && host.error) {
    return Object.freeze({ result: "UNKNOWN", reason: "cancelled" });
  }
  if (host.error) {
    return Object.freeze({ result: "FAIL", reason: "acp_error" });
  }
  if (host.test_command && host.test_exit_code !== 0) {
    return Object.freeze({ result: "FAIL", reason: "test_failed" });
  }
  if (!host.diff_hash || !host.session_id) {
    return Object.freeze({ result: "UNKNOWN", reason: "insufficient_host_observation" });
  }
  return Object.freeze({
    result: "PASS",
    reason: "host_verified_cursor_session",
    expectations: Object.freeze([
      { claim_includes: "cursor.session.status=" },
      { claim_includes: "host.git.diff_hash=" },
    ]),
  });
}

export { CURSOR_DEVELOP_KIND };
