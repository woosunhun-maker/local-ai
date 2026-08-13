/**
 * Development Supervisor — Discussion→Inspection→Proposal→Envelope→Worktree→Cursor leaf→Replan→Report
 * Task/Approval/Evidence/Verifier/Cursor client는 재사용만 한다.
 */
import { createEvidenceRecord } from "../evidence/evidence.mjs";
import { collectProjectProgress } from "../project-progress.mjs";
import { createDevelopmentProposal } from "./proposal.mjs";
import {
  APPROVAL_ENVELOPE_KIND,
  createApprovalEnvelope,
  envelopeApprovalPayload,
  verifyEnvelopeIntegrity,
} from "./approval-envelope.mjs";
import { createIsolatedWorktree } from "./workspace-isolator.mjs";
import { decideReplan } from "./replan-policy.mjs";
import { buildSuccessCriteriaChecks, successCriteriaDigest } from "./success-criteria.mjs";
import { buildDevelopmentReport } from "./report.mjs";
import { createMergeToMainApprovalDraft } from "./merge-to-main-schema.mjs";
import { verifyTaskOutcome, verificationEvidence } from "../verifier/task-verifier.mjs";
import { verifyCursorHostOutcome } from "../adapters/cursor/cursor-development-adapter.mjs";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

export function createDevelopmentSupervisor({
  runStore,
  taskStore,
  approvalStore,
  discussionStore = null,
  taskOrchestrator = null,
  runSystemStatus = null,
  worktreeParent = undefined,
  mainRepo = undefined,
  createWorktree = createIsolatedWorktree,
  now = () => Date.now(),
} = {}) {
  if (!runStore?.create || !runStore?.transition) fail("invalid_run_store");
  if (!taskStore?.create) fail("invalid_task_store");
  if (!approvalStore?.createRequest || !approvalStore?.get) fail("invalid_approval_store");

  async function start({
    goal,
    channel = "local_owner_app",
    budget = {},
  } = {}) {
    if (channel === "telegram") fail("telegram_development_supervisor_forbidden", 403);
    let discussionId = null;
    if (discussionStore?.open) {
      const created = await discussionStore.open({
        topic: goal.trim().slice(0, 200),
        openQuestions: ["방향 결정이 필요하면 사용자에게 확인"],
      });
      discussionId = created?.id ?? null;
    }

    const run = await runStore.create({
      goal,
      channel,
      budget,
      discussionId,
    });
    return run;
  }

  /** read-only: Discussion → Inspection → Analysis 초안 Proposal (쓰기/Cursor 없음) */
  async function inspectAndPropose(runId, {
    proposalOverrides = {},
  } = {}) {
    let run = await runStore.get(runId);
    if (!run) fail("development_run_not_found", 404);

    run = await runStore.transition(runId, { toStatus: "INSPECTING" });

    let statusResult = null;
    if (typeof runSystemStatus === "function") {
      statusResult = await runSystemStatus();
    }
    const progress = collectProjectProgress();
    const inspection = Object.freeze({
      inspected_at: new Date(now()).toISOString(),
      system_status_overall: statusResult?.runtime?.overall ?? statusResult?.overall ?? null,
      project_progress_percent: progress.overall?.percent ?? null,
      evidence: Object.freeze([
        createEvidenceRecord({
          epistemic: "VERIFIED",
          claim: `supervisor.inspection.progress=${progress.overall?.percent ?? "unknown"}`,
          source: "development.supervisor",
          detail: { run_id: runId },
        }),
      ]),
    });

    run = await runStore.transition(runId, {
      toStatus: "ANALYZING",
      patch: { inspection },
    });
    run = await runStore.transition(runId, { toStatus: "PROPOSING" });

    // 휴리스틱 Proposal (로컬 LLM 연결은 이후). 성공조건/범위는 여기서 고정.
    const proposal = createDevelopmentProposal({
      goal: run.goal,
      findings: [
        `project_progress=${progress.overall?.percent ?? "?"}%`,
        statusResult ? `runtime=${statusResult.runtime?.overall ?? "checked"}` : "runtime=skipped",
      ],
      proposed_tasks: proposalOverrides.proposed_tasks ?? [
        {
          title: "격리 worktree에서 최소 안전 개선",
          prompt: `${run.goal}\n\n제약: worktree 안에서만 수정, commit/push/deploy 금지, diol-os/PrivateAI 금지.`,
          tool_name: "cursor.develop",
          test_command: proposalOverrides.test_command
            ?? "npm test --prefix secure-chat -- test/phase5-cursor-adapter.test.mjs",
        },
      ],
      risk_class: proposalOverrides.risk_class ?? "HIGH",
      success_criteria: proposalOverrides.success_criteria ?? [
        { type: "session_present" },
        { type: "sandbox_clean" },
        { type: "write_path_observed_if_changed" },
        { type: "changed_files_within_allowed_paths" },
        { type: "out_of_scope_not_touched" },
        { type: "test_exit_zero" },
      ],
      out_of_scope: proposalOverrides.out_of_scope ?? [
        "diol-os/",
        "/Users/hun/PrivateAI",
        "auto commit",
        "push",
        "deploy",
      ],
      allowed_paths: proposalOverrides.allowed_paths ?? ["secure-chat/"],
      allowed_commands: proposalOverrides.allowed_commands ?? [
        "npm test",
        "npm run lint",
        "npm run typecheck",
        "npm run build",
        "git status",
        "git diff",
      ],
      requires_direction_decision: proposalOverrides.requires_direction_decision === true,
    });

    if (proposal.requires_direction_decision) {
      run = await runStore.transition(runId, {
        toStatus: "WAITING_OWNER",
        patch: { proposal },
        blockedReason: null,
      });
      return Object.freeze({
        run,
        phase: "WAITING_OWNER",
        reason: "direction_decision_required",
        proposal,
      });
    }

    run = await runStore.update(runId, { proposal });
    return Object.freeze({
      run,
      phase: "PROPOSING",
      proposal,
    });
  }

  /** worktree 생성 + immutable envelope 승인 요청 */
  async function prepareExecution(runId) {
    let run = await runStore.get(runId);
    if (!run) fail("development_run_not_found", 404);
    if (!run.proposal) fail("proposal_required_before_execution", 409);

    const budget = runStore.evaluateBudget(run, { nowMs: now() });
    if (!budget.ok) {
      run = await runStore.transition(runId, {
        toStatus: "BLOCKED",
        blockedReason: budget.reason,
      });
      return Object.freeze({ run, phase: "BLOCKED", reason: budget.reason });
    }

    const worktree = await createWorktree({
      runId: run.run_id,
      parent: worktreeParent,
      mainRepo,
    });

    const envelope = createApprovalEnvelope({
      runId: run.run_id,
      goal: run.goal,
      proposalDigest: run.proposal.proposal_digest,
      successCriteria: run.proposal.success_criteria,
      outOfScope: run.proposal.out_of_scope,
      worktreePath: worktree.worktree_path,
      branch: worktree.branch,
      allowedPaths: run.proposal.allowed_paths,
      allowedCommands: run.proposal.allowed_commands,
      riskClass: run.proposal.risk_class,
      maxLeafTasks: run.budget.max_leaf_tasks,
      maxReplansPerTask: run.budget.max_replans_per_task,
      maxTotalAttempts: run.budget.max_total_attempts,
      maxRuntimeMs: run.budget.max_runtime_ms,
      expiresAt: run.expires_at,
      now,
    });

    const integrity = verifyEnvelopeIntegrity(envelope);
    if (!integrity.ok) fail(integrity.reason, 500);

    const approval = await approvalStore.createRequest({
      kind: APPROVAL_ENVELOPE_KIND,
      title: "Development Supervisor 승인 (Envelope)",
      summary: `목표: ${run.goal.slice(0, 160)} / worktree write-only / no merge·push·deploy`,
      payload: envelopeApprovalPayload(envelope),
      dataCategories: ["development_envelope", "task_instruction", "code_change"],
    }, Math.max(60_000, Date.parse(envelope.expires_at) - now()), {
      id: `devenv-${envelope.envelope_digest.slice(0, 24)}`,
    });

    run = await runStore.transition(runId, {
      toStatus: "WAITING_ENVELOPE_APPROVAL",
      patch: {
        worktree,
        envelope,
        envelope_approval_id: approval.id,
      },
    });

    return Object.freeze({
      run,
      phase: "WAITING_ENVELOPE_APPROVAL",
      approval_id: approval.id,
      envelope_digest: envelope.envelope_digest,
      worktree,
    });
  }

  async function ensureEnvelopeApproved(run) {
    const approval = await approvalStore.get(run.envelope_approval_id);
    if (!approval || approval.status === "pending") {
      return Object.freeze({ ok: false, phase: "WAITING_ENVELOPE_APPROVAL", approval });
    }
    if (!["approved", "consumed"].includes(approval.status)) {
      return Object.freeze({ ok: false, phase: "FAILED", approval });
    }
    const integrity = verifyEnvelopeIntegrity(run.envelope);
    if (!integrity.ok) {
      return Object.freeze({ ok: false, phase: "BLOCKED", reason: integrity.reason, approval });
    }
    return Object.freeze({ ok: true, approval });
  }

  /**
   * Envelope 승인 후 leaf cursor.develop 실행.
   * write root = worktree만. success_criteria는 envelope 고정본.
   */
  async function runLeafTasks(runId, { maxTasks = null } = {}) {
    if (!taskOrchestrator?.run) fail("task_orchestrator_required", 503);

    let run = await runStore.get(runId);
    if (!run) fail("development_run_not_found", 404);

    const approved = await ensureEnvelopeApproved(run);
    if (!approved.ok) {
      if (approved.phase === "FAILED") {
        run = await runStore.transition(runId, {
          toStatus: "FAILED",
          error: `envelope_approval_${approved.approval?.status ?? "missing"}`,
        });
      }
      return Object.freeze({
        run,
        phase: approved.phase,
        reason: approved.reason ?? "envelope_not_approved",
        approval_id: run.envelope_approval_id,
      });
    }

    const budget = runStore.evaluateBudget(run, { nowMs: now() });
    if (!budget.ok) {
      run = await runStore.transition(runId, {
        toStatus: "BLOCKED",
        blockedReason: budget.reason,
      });
      return Object.freeze({ run, phase: "BLOCKED", reason: budget.reason });
    }

    if (run.status === "WAITING_ENVELOPE_APPROVAL") {
      run = await runStore.transition(runId, { toStatus: "RUNNING_TASKS" });
    }

    const tasks = run.proposal?.proposed_tasks ?? [];
    const limit = Math.min(
      maxTasks ?? tasks.length,
      run.budget.max_leaf_tasks - (run.counters.leaf_tasks_created ?? 0),
    );
    const leafResults = [];

    for (let i = 0; i < limit; i += 1) {
      const planned = tasks[i];
      if (!planned) break;
      if (!runStore.canCreateLeafTask(run)) {
        run = await runStore.transition(runId, {
          toStatus: "BLOCKED",
          blockedReason: "max_leaf_tasks_exceeded",
        });
        break;
      }

      const leaf = await taskStore.create({
        goal: planned.title,
        approvalRequired: true,
        currentStep: "supervisor_leaf",
        nextStep: "cursor.develop",
        correlationId: run.run_id,
      });

      const counters = {
        ...run.counters,
        leaf_tasks_created: (run.counters.leaf_tasks_created ?? 0) + 1,
        total_attempts: (run.counters.total_attempts ?? 0) + 1,
        replans_by_task: { ...(run.counters.replans_by_task ?? {}) },
      };
      const leafTaskIds = [...(run.leaf_task_ids ?? []), leaf.task_id];
      run = await runStore.update(runId, {
        counters,
        leaf_task_ids: leafTaskIds,
      });

      // bindings: worktree write roots + frozen criteria digest
      await taskStore.setBindings(leaf.task_id, {
        cursor: {
          module: "cursor",
          kind: "cursor.develop",
        },
        supervisor: {
          run_id: run.run_id,
          envelope_digest: run.envelope.envelope_digest,
          worktree_path: run.worktree.worktree_path,
          write_roots: run.worktree.write_roots,
          main_repo: run.worktree.main_repo,
          main_read_only: true,
          success_criteria: run.envelope.success_criteria,
          success_criteria_digest: successCriteriaDigest(run.envelope.success_criteria),
          out_of_scope: run.envelope.out_of_scope,
          allowed_paths: run.envelope.allowed_paths,
        },
      });

      let result = await taskOrchestrator.run({
        taskId: leaf.task_id,
        toolName: planned.tool_name ?? "cursor.develop",
        channel: run.channel,
        prompt: planned.prompt,
        testCommand: planned.test_command,
        projectRoot: run.worktree.worktree_path,
        writeRoots: run.worktree.write_roots,
        mainRepo: run.worktree.main_repo,
        mainReadOnly: true,
        envelope: run.envelope,
        successCriteria: run.envelope.success_criteria,
      });

      // WAITING_APPROVAL for cursor.develop — 상위는 envelope 승인 후에도
      // leaf cursor.develop / WRITE permission은 기존 ApprovalStore 유지
      if (result.phase === "WAITING_APPROVAL") {
        leafResults.push({
          task_id: leaf.task_id,
          phase: result.phase,
          approval_id: result.approval_id,
        });
        run = await runStore.transition(runId, {
          toStatus: "WAITING_OWNER",
        });
        return Object.freeze({
          run,
          phase: "WAITING_OWNER",
          reason: "leaf_cursor_develop_approval",
          leaf_results: leafResults,
          approval_id: result.approval_id,
        });
      }

      // success criteria 기반 재판정 (실행 후 모델이 조건 못 바꿈)
      const hostOutcome = result.host
        ? verifyCursorHostOutcome(result.host)
        : { result: "UNKNOWN", reason: "missing_host", checks: [] };
      const criteriaChecks = buildSuccessCriteriaChecks({
        successCriteria: run.envelope.success_criteria,
        envelope: run.envelope,
        host: result.host,
        task: result.task,
        expectedDigest: successCriteriaDigest(run.envelope.success_criteria),
      });
      const verification = verifyTaskOutcome({
        task: result.task ?? { task_id: leaf.task_id, evidence: result.task?.evidence ?? [] },
        checks: [...(hostOutcome.checks ?? []), ...criteriaChecks],
        requireVerified: true,
      });

      leafResults.push({
        task_id: leaf.task_id,
        phase: result.phase,
        verification,
        host: result.host ? {
          diff_hash: result.host.diff_hash,
          changed_files: result.host.changed_files,
        } : null,
      });

      const decision = decideReplan({
        run,
        envelope: run.envelope,
        verification,
        taskId: leaf.task_id,
        attempt: {
          proposal_digest: run.proposal.proposal_digest,
          worktree_path: run.worktree.worktree_path,
          risk_class: run.envelope.risk_class,
          allowed_paths: run.envelope.allowed_paths,
          allowed_commands: run.envelope.allowed_commands,
          success_criteria_digest: successCriteriaDigest(run.envelope.success_criteria),
          no_merge: true,
          no_push: true,
          no_deploy: true,
          nowMs: now(),
        },
        nowMs: now(),
      });

      if (decision.action === "auto_replan") {
        if (!runStore.canReplanTask(run, leaf.task_id)) {
          run = await runStore.transition(runId, {
            toStatus: "BLOCKED",
            blockedReason: "max_replans_per_task_exceeded",
          });
          break;
        }
        const replans = {
          ...(run.counters.replans_by_task ?? {}),
          [leaf.task_id]: (run.counters.replans_by_task?.[leaf.task_id] ?? 0) + 1,
        };
        run = await runStore.update(runId, {
          counters: {
            ...run.counters,
            total_attempts: (run.counters.total_attempts ?? 0) + 1,
            replans_by_task: replans,
          },
        });
        await taskOrchestrator.replan(leaf.task_id);
        result = await taskOrchestrator.run({
          taskId: leaf.task_id,
          toolName: planned.tool_name ?? "cursor.develop",
          channel: run.channel,
          prompt: planned.prompt,
          testCommand: planned.test_command,
          projectRoot: run.worktree.worktree_path,
          writeRoots: run.worktree.write_roots,
          mainRepo: run.worktree.main_repo,
          mainReadOnly: true,
          envelope: run.envelope,
          successCriteria: run.envelope.success_criteria,
        });
        leafResults[leafResults.length - 1] = {
          task_id: leaf.task_id,
          phase: result.phase,
          verification: result.verification,
          replanned: true,
        };
        continue;
      }

      if (decision.action === "require_reapproval") {
        run = await runStore.transition(runId, {
          toStatus: "WAITING_OWNER",
          blockedReason: null,
          error: decision.reason,
        });
        return Object.freeze({
          run,
          phase: "WAITING_OWNER",
          reason: decision.reason,
          leaf_results: leafResults,
        });
      }

      if (decision.action === "block") {
        run = await runStore.transition(runId, {
          toStatus: "BLOCKED",
          blockedReason: decision.reason,
        });
        break;
      }
    }

    return finalizeReport(runId, leafResults);
  }

  async function finalizeReport(runId, leafResults = []) {
    let run = await runStore.get(runId);
    if (!run) fail("development_run_not_found", 404);
    if (run.status === "BLOCKED" || run.status === "FAILED") {
      const report = buildDevelopmentReport({ run, leafResults });
      run = await runStore.update(runId, { report });
      return Object.freeze({ run, phase: run.status, report, leaf_results: leafResults });
    }

    if (run.status === "RUNNING_TASKS" || run.status === "WAITING_OWNER") {
      run = await runStore.transition(runId, { toStatus: "REPORTING" }).catch(async () => {
        if (run.status === "WAITING_OWNER") {
          return runStore.transition(runId, { toStatus: "REPORTING" });
        }
        return run;
      });
    }

    const report = buildDevelopmentReport({ run, leafResults });
    const mergeDraft = createMergeToMainApprovalDraft({
      runId: run.run_id,
      envelopeDigest: run.envelope?.envelope_digest,
      worktreePath: run.worktree?.worktree_path,
      branch: run.worktree?.branch,
      diffHash: leafResults.find((item) => item.host?.diff_hash)?.host?.diff_hash ?? null,
      leafTaskIds: run.leaf_task_ids,
    });

    run = await runStore.transition(runId, {
      toStatus: "DONE",
      patch: {
        report: {
          ...report,
          merge_to_main_draft: mergeDraft,
        },
      },
    }).catch(async () => runStore.update(runId, {
      report: { ...report, merge_to_main_draft: mergeDraft },
    }));

    return Object.freeze({
      run,
      phase: run.status,
      report: run.report ?? report,
      leaf_results: leafResults,
      merge_to_main_draft: mergeDraft,
    });
  }

  /** 편의: start → inspect/propose (read-only까지) */
  async function advanceReadOnly(runId, options = {}) {
    return inspectAndPropose(runId, options);
  }

  return Object.freeze({
    start,
    inspectAndPropose,
    advanceReadOnly,
    prepareExecution,
    runLeafTasks,
    finalizeReport,
    ensureEnvelopeApproved,
  });
}
