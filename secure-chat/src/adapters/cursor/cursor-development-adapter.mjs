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
import { collectCursorHostResult, captureGitBaseline } from "./host-result-collector.mjs";
import { CURSOR_PROJECT_ROOT } from "./sandbox.mjs";
import {
  ensureLocalAiCursorConfigDir,
  inspectUserCursorApprovalMode,
} from "./cursor-cli-config.mjs";

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
    projectRoot: runProjectRoot = null,
    writeRoots = null,
    mainRepo = null,
    mainReadOnly = false,
    envelope = null,
  }) {
    if (channel === "telegram") fail("telegram_cursor_develop_forbidden", 403);
    if (typeof prompt !== "string" || prompt.trim().length < 8) fail("invalid_cursor_prompt");
    if (task?.approval_required !== true) fail("cursor_develop_requires_approval_flag", 409);

    const effectiveRoot = runProjectRoot ?? projectRoot;
    const effectiveEnvelope = envelope ?? task?.bindings?.supervisor?.envelope ?? null;
    const sandboxOpts = {
      projectRoot: effectiveRoot,
      writeRoots: writeRoots ?? (task?.bindings?.supervisor?.write_roots ?? null),
      mainRepo: mainRepo ?? task?.bindings?.supervisor?.main_repo ?? null,
      mainReadOnly: mainReadOnly || task?.bindings?.supervisor?.main_read_only === true,
    };

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

    const baseline = await captureGitBaseline({ cwd: effectiveRoot });

    // 사용자 전역 unrestricted를 신뢰하지 않음 — Local AI 전용 CURSOR_CONFIG_DIR 주입
    const localAiCursorConfig = await ensureLocalAiCursorConfigDir();
    const userCursorMode = await inspectUserCursorApprovalMode();

    const startedAt = new Date(now()).toISOString();
    const client = createAcpClient({
      agentPath,
      cwd: effectiveRoot,
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:${process.env.PATH ?? ""}`,
        ...localAiCursorConfig.env,
      },
    });

    let sessionId = null;
    let stopReason = null;
    let exitCode = null;
    let cancelled = false;
    let runError = null;
    const updates = [];
    const permissionEvents = [];

    const writeRootLabel = Array.isArray(sandboxOpts.writeRoots) && sandboxOpts.writeRoots.length > 0
      ? sandboxOpts.writeRoots.join(", ")
      : effectiveRoot;

    try {
      await client.start();
      await client.initialize({ name: "local-ai-cursor-development-adapter", version: "0.1.0" });
      await client.authenticate();
      const session = await client.newSession({ mcpServers: [] });
      sessionId = session?.sessionId ?? null;
      if (!sessionId) fail("acp_session_missing", 502);

      const boundedPrompt = [
        "You are running under Local AI CursorDevelopmentAdapter.",
        `Writable roots only: ${writeRootLabel}`,
        sandboxOpts.mainReadOnly
          ? `Main repo is READ-ONLY: ${sandboxOpts.mainRepo ?? "main"}`
          : null,
        "Do NOT modify diol-os/, /Users/hun/PrivateAI, or any path outside writable roots.",
        "Do NOT git commit, push, or deploy.",
        "Make the smallest safe change requested below, then stop.",
        "",
        prompt.trim(),
      ].filter(Boolean).join("\n");

      const promptResult = await client.prompt({
        sessionId,
        text: boundedPrompt,
        onUpdate: (params) => {
          updates.push(params);
        },
        onPermission: async (params) => {
          const decision = await bridge.decide(params?.toolCall ?? params, {
            taskId: task.task_id,
            sessionId,
            ...sandboxOpts,
          });
          permissionEvents.push({
            at: new Date(now()).toISOString(),
            risk: decision.risk,
            optionId: decision.optionId,
            reason: decision.reason,
            approval_id: decision.approval_id,
            escalated_from: decision.escalated_from ?? null,
          });
          return decision;
        },
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
      cwd: effectiveRoot,
      baseline,
      permissionEvents,
      writeRoots: sandboxOpts.writeRoots,
      mainRepo: sandboxOpts.mainRepo,
      mainReadOnly: sandboxOpts.mainReadOnly,
      envelope: effectiveEnvelope,
    });

    if (host.blocked_files.length > 0) {
      return Object.freeze({
        phase: "FAILED",
        binding: ensured.binding,
        approval_id: ensured.binding.approval_id,
        approval_status: approval.status,
        session_id: sessionId,
        host,
        permission_events: permissionEvents,
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
        rollbackReference: host.diff_hash
          ? `cursor-diff:${host.diff_hash.slice(0, 16)}`
          : `cursor-session:${sessionId}`,
      }).catch(() => null);
    }

    return Object.freeze({
      phase: "VERIFYING",
      binding: ensured.binding,
      approval_id: ensured.binding.approval_id,
      approval_status: approval.status,
      session_id: sessionId,
      host,
      permission_events: Object.freeze(permissionEvents),
      evidence: Object.freeze([
        createEvidenceRecord({
          epistemic: "VERIFIED",
          claim: `approval.status=${approval.status}`,
          source: "approval_store.lookup",
          taskId: task.task_id,
          detail: { approval_id: approval.id, kind: CURSOR_DEVELOP_KIND },
        }),
        createEvidenceRecord({
          epistemic: "VERIFIED",
          claim: `cursor.cli_config.dir=${localAiCursorConfig.configDir}`,
          source: "cursor.cli-config",
          taskId: task.task_id,
          detail: {
            config_dir: localAiCursorConfig.configDir,
            user_permissions_approval_mode: userCursorMode.permissions_approval_mode,
            user_cli_approval_mode: userCursorMode.cli_approval_mode,
            user_unrestricted: userCursorMode.user_unrestricted,
            must_not_trust_user_global: true,
            note: "agent reads CURSOR_CONFIG_DIR for permissions.json/cli-config.json",
          },
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

/**
 * Cursor host 관측을 구조화 checks로 검증.
 * 보안 필수 항목이 UNKNOWN/PARTIAL이면 PASS/all_expectations_verified 불가.
 */
export function verifyCursorHostOutcome(host) {
  if (!host) {
    return Object.freeze({
      result: "UNKNOWN",
      reason: "missing_host_result",
      checks: Object.freeze([]),
    });
  }

  const checks = [
    {
      id: "session",
      required: true,
      security: true,
      status: host.session_id ? "verified" : "unknown",
      detail: host.session_id ?? null,
    },
    {
      id: "sandbox",
      required: true,
      security: true,
      status: (host.blocked_files?.length ?? 0) > 0 ? "fail" : "verified",
    },
    {
      id: "diff_hash_content",
      required: true,
      security: true,
      status: host.diff_hash
        && host.diff_hash_kind
        && host.diff_hash_kind !== "unresolved"
        && (host.has_content_changes ? host.diff_hash_kind === "canonical_patch" || host.diff_hash_kind === "deletion_manifest" : true)
        ? "verified"
        : (host.has_content_changes ? "unknown" : "verified"),
      detail: host.diff_hash_kind ?? null,
    },
    {
      id: "test",
      required: Boolean(host.test_command),
      security: false,
      status: !host.test_command
        ? "verified"
        : host.test_exit_code === 0
          ? "verified"
          : "fail",
    },
    {
      id: "write_authorization_verified",
      // ACP WRITE 이벤트는 필수 불변조건이 아님.
      // PASS: 명시적 ACP WRITE 관측 OR envelope isolated scope host VERIFIED
      required: Boolean(host.has_content_changes),
      security: true,
      status: host.write_authorization_verified
        ? "verified"
        : !host.has_content_changes
          ? "verified"
          : (host.write_authorization?.kind === "out_of_envelope" ? "fail" : "unknown"),
      detail: host.write_authorization?.kind
        ?? (host.write_path_observed ? "acp_write_observed" : "unverified"),
    },
    {
      id: "main_repo_unchanged",
      required: true,
      security: true,
      status: (host.main_repo_writes?.length ?? 0) > 0 ? "fail" : "verified",
      detail: (host.main_repo_writes?.length ?? 0) > 0
        ? host.main_repo_writes.slice(0, 20).join(",")
        : null,
    },
    {
      id: "acp_error",
      required: true,
      security: false,
      status: host.error ? "fail" : "verified",
    },
  ];

  if (host.cancelled && host.error) {
    return Object.freeze({
      result: "UNKNOWN",
      reason: "cancelled",
      checks: Object.freeze(checks),
    });
  }

  // verifyTaskOutcome checks 경로와 동일한 판정
  const failed = checks.filter((c) => c.status === "fail");
  const securityGaps = checks.filter(
    (c) => c.security && (c.status === "unknown" || c.status === "partial")
      && c.required !== false,
  );

  if (failed.length > 0) {
    return Object.freeze({
      result: "FAIL",
      reason: `checks_failed:${failed.map((c) => c.id).join(",")}`,
      checks: Object.freeze(checks),
    });
  }
  if (securityGaps.length > 0) {
    return Object.freeze({
      result: "UNKNOWN",
      reason: `security_expectation_unknown:${securityGaps.map((c) => c.id).join(",")}`,
      checks: Object.freeze(checks),
      expectations: Object.freeze([]),
    });
  }

  const warnings = checks.filter((c) => c.warning === true);
  if (warnings.length > 0) {
    return Object.freeze({
      result: "PASS_WITH_WARNINGS",
      reason: "required_verified_with_warnings",
      checks: Object.freeze(checks),
    });
  }

  return Object.freeze({
    result: "PASS",
    reason: "all_expectations_verified",
    checks: Object.freeze(checks),
  });
}

export { CURSOR_DEVELOP_KIND };
