import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { ApprovalStore, approvalSigningPayload } from "../src/approval-store.mjs";
import { TaskManagerStore } from "../src/task/task-manager-store.mjs";
import { DiscussionContextStore } from "../src/memory/discussion-context-store.mjs";
import { createTaskOrchestrator } from "../src/executor/task-orchestrator.mjs";
import { createTaskExecutor } from "../src/executor/task-executor.mjs";
import { assertWritablePath } from "../src/adapters/cursor/sandbox.mjs";
import { createDevelopmentProposal } from "../src/supervisor/proposal.mjs";
import {
  createApprovalEnvelope,
  verifyEnvelopeIntegrity,
  isAttemptWithinEnvelope,
  APPROVAL_ENVELOPE_KIND,
} from "../src/supervisor/approval-envelope.mjs";
import { DevelopmentRunStore } from "../src/supervisor/development-run-store.mjs";
import { worktreePathsForRun } from "../src/supervisor/workspace-isolator.mjs";
import { decideReplan } from "../src/supervisor/replan-policy.mjs";
import {
  buildSuccessCriteriaChecks,
  successCriteriaDigest,
} from "../src/supervisor/success-criteria.mjs";
import {
  createMergeToMainApprovalDraft,
  assertMergeExecutionForbidden,
} from "../src/supervisor/merge-to-main-schema.mjs";
import { createDevelopmentSupervisor } from "../src/supervisor/development-supervisor.mjs";
import { verifyTaskOutcome } from "../src/verifier/task-verifier.mjs";
import { createEvidenceRecord } from "../src/evidence/evidence.mjs";

const execFileAsync = promisify(execFile);

function keyPair() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    ...keys,
    publicKeyDER: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

async function approve(store, deviceId, approval, privateKey) {
  const signatureDER = sign("sha256", approvalSigningPayload(approval, "approved"), privateKey).toString("base64");
  return store.decide({
    id: approval.id,
    deviceId,
    decision: "approved",
    signatureDER,
  });
}

async function initGitRepo(root) {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: root });
  await writeFile(join(root, "README.md"), "# fixture\n");
  await writeFile(join(root, "secure-chat", "x.txt"), "ok\n").catch(async () => {
    await mkdir(join(root, "secure-chat"), { recursive: true });
    await writeFile(join(root, "secure-chat", "x.txt"), "ok\n");
  });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}

describe("Development Supervisor", { concurrency: false }, () => {
  test("proposal freezes success_criteria digest", () => {
    const proposal = createDevelopmentProposal({
      goal: "Local AI 상태를 분석하고 개선한다",
      success_criteria: [
        { type: "sandbox_clean" },
        { type: "test_exit_zero" },
      ],
      out_of_scope: ["diol-os/", "push"],
    });
    assert.match(proposal.proposal_digest, /^[a-f0-9]{64}$/u);
    assert.equal(proposal.success_criteria.length, 2);
    const again = createDevelopmentProposal({
      goal: "Local AI 상태를 분석하고 개선한다",
      success_criteria: [
        { type: "sandbox_clean" },
        { type: "test_exit_zero" },
      ],
      out_of_scope: ["diol-os/", "push"],
      findings: proposal.findings,
      proposed_tasks: proposal.proposed_tasks,
      allowed_paths: proposal.allowed_paths,
      allowed_commands: proposal.allowed_commands,
      risk_class: proposal.risk_class,
    });
    // frozen_at differs — digest excludes frozen_at via explicit fields
    assert.equal(proposal.proposal_digest, again.proposal_digest);
  });

  test("approval envelope integrity and scope expansion require reapproval", () => {
    const envelope = createApprovalEnvelope({
      runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      goal: "개선 작업 진행",
      proposalDigest: "a".repeat(64),
      successCriteria: [{ type: "sandbox_clean" }],
      outOfScope: ["push"],
      worktreePath: "/Users/hun/Documents/로컬ai-worktrees/aaaaaaaa",
      branch: "local-ai/dev/aaaaaaaa",
      allowedPaths: ["secure-chat/"],
      allowedCommands: ["npm test"],
      riskClass: "HIGH",
      maxLeafTasks: 2,
      maxReplansPerTask: 1,
      maxTotalAttempts: 3,
      maxRuntimeMs: 3_600_000,
    });
    assert.equal(verifyEnvelopeIntegrity(envelope).ok, true);
    assert.equal(isAttemptWithinEnvelope(envelope, {
      allowed_paths: ["secure-chat/", "apps/"],
    }).allowed, false);
    assert.equal(isAttemptWithinEnvelope(envelope, {
      allowed_paths: ["secure-chat/"],
      no_merge: true,
      no_push: true,
      no_deploy: true,
    }).allowed, true);
    const tampered = { ...envelope, risk_class: "LOW" };
    assert.equal(verifyEnvelopeIntegrity(tampered).ok, false);
  });

  test("worktree write root allows only isolated path; main is read-only", () => {
    const paths = worktreePathsForRun({
      runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      parent: "/Users/hun/Documents/로컬ai-worktrees",
      mainRepo: "/Users/hun/Documents/로컬ai",
    });
    assert.equal(paths.main_read_only, true);
    assert.deepEqual(paths.write_roots, [paths.worktree_path]);
    assert.equal(
      assertWritablePath(`${paths.worktree_path}/secure-chat/a.mjs`, {
        projectRoot: paths.worktree_path,
        writeRoots: paths.write_roots,
        mainRepo: paths.main_repo,
        mainReadOnly: true,
      }),
      `${paths.worktree_path}/secure-chat/a.mjs`,
    );
    assert.throws(() => assertWritablePath("/Users/hun/Documents/로컬ai/secure-chat/a.mjs", {
      projectRoot: paths.worktree_path,
      writeRoots: paths.write_roots,
      mainRepo: paths.main_repo,
      mainReadOnly: true,
    }), /sandbox_outside_write_root|sandbox_main_repo_read_only/);
  });

  test("success criteria cannot be relaxed after freeze", () => {
    const criteria = [
      { type: "sandbox_clean" },
      { type: "test_exit_zero" },
    ];
    const digest = successCriteriaDigest(criteria);
    const relaxed = [{ type: "sandbox_clean" }];
    const checks = buildSuccessCriteriaChecks({
      successCriteria: relaxed,
      expectedDigest: digest,
      host: { session_id: "s", blocked_files: [], test_exit_code: 0 },
    });
    assert.equal(checks[0].status, "fail");
    assert.match(String(checks[0].detail), /digest_mismatch/);

    const passChecks = buildSuccessCriteriaChecks({
      successCriteria: criteria,
      expectedDigest: digest,
      envelope: { success_criteria: criteria, allowed_paths: ["secure-chat/"], out_of_scope: [] },
      host: {
        session_id: "s",
        blocked_files: [],
        test_exit_code: 0,
        changed_files: ["secure-chat/a.mjs"],
        has_content_changes: true,
        write_path_observed: true,
        write_authorization_verified: true,
        write_authorization: { kind: "acp_write_observed" },
        main_repo_writes: [],
        diff_hash: "abc",
        diff_hash_kind: "canonical_patch",
      },
    });
    const result = verifyTaskOutcome({
      task: {
        task_id: "t1",
        evidence: [createEvidenceRecord({ epistemic: "VERIFIED", claim: "ok", source: "test" })],
      },
      checks: passChecks,
    });
    assert.equal(result.result, "PASS");
  });

  test("replan policy blocks outside envelope and allows within budget", () => {
    const envelope = createApprovalEnvelope({
      runId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      goal: "재시도 정책 검증용 목표입니다",
      proposalDigest: "b".repeat(64),
      successCriteria: [{ type: "sandbox_clean" }],
      outOfScope: [],
      worktreePath: "/tmp/wt",
      branch: "local-ai/dev/cccccccc",
      allowedPaths: ["secure-chat/"],
      allowedCommands: ["npm test"],
      maxReplansPerTask: 2,
      maxTotalAttempts: 5,
      maxRuntimeMs: 3_600_000,
    });
    const run = {
      budget: { max_replans_per_task: 2, max_total_attempts: 5 },
      counters: { total_attempts: 1, replans_by_task: { "task-1": 0 } },
    };
    assert.equal(decideReplan({
      run,
      envelope,
      verification: { result: "FAIL", reason: "test_failed" },
      taskId: "task-1",
      attempt: {
        proposal_digest: "b".repeat(64),
        worktree_path: "/tmp/wt",
        allowed_paths: ["secure-chat/"],
      },
    }).action, "auto_replan");

    assert.equal(decideReplan({
      run,
      envelope,
      verification: { result: "FAIL", reason: "test_failed" },
      taskId: "task-1",
      attempt: {
        proposal_digest: "b".repeat(64),
        worktree_path: "/tmp/wt",
        allowed_paths: ["secure-chat/", "extra/"],
      },
    }).action, "require_reapproval");

    assert.equal(decideReplan({
      run: {
        budget: { max_replans_per_task: 0, max_total_attempts: 5 },
        counters: { total_attempts: 1, replans_by_task: { "task-1": 0 } },
      },
      envelope,
      verification: { result: "FAIL", reason: "test_failed" },
      taskId: "task-1",
      attempt: { proposal_digest: "b".repeat(64), worktree_path: "/tmp/wt" },
    }).action, "block");
  });

  test("development run budget blocks infinite loop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devrun-"));
    try {
      const store = new DevelopmentRunStore(join(dir, "runs.json"), {
        idFactory: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      });
      await store.initialize();
      const run = await store.create({
        goal: "예산 초과를 검증하는 목표입니다",
        budget: {
          max_leaf_tasks: 1,
          max_replans_per_task: 0,
          max_total_attempts: 1,
          max_runtime_ms: 60_000,
        },
      });
      await store.update(run.run_id, {
        counters: {
          leaf_tasks_created: 2,
          total_attempts: 2,
          replans_by_task: {},
        },
      });
      const latest = await store.get(run.run_id);
      const budget = store.evaluateBudget(latest);
      assert.equal(budget.ok, false);
      assert.match(budget.reason, /max_leaf_tasks|max_total_attempts/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("supervisor read-only path: start → inspect/propose without cursor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sup-ro-"));
    try {
      const runStore = new DevelopmentRunStore(join(dir, "runs.json"), {
        idFactory: () => "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      });
      await runStore.initialize();
      const taskStore = new TaskManagerStore(join(dir, "tasks.json"));
      await taskStore.initialize();
      const approvalStore = new ApprovalStore(join(dir, "a.json"));
      await approvalStore.initialize();
      const discussion = new DiscussionContextStore(join(dir, "d.json"));
      await discussion.initialize();

      const supervisor = createDevelopmentSupervisor({
        runStore,
        taskStore,
        approvalStore,
        discussionStore: discussion,
        runSystemStatus: async () => ({ runtime: { overall: "ok" } }),
      });

      const run = await supervisor.start({
        goal: "현재 Local AI 상태를 분석해서 개선점을 찾아라",
      });
      assert.equal(run.status, "DISCUSSING");

      const proposed = await supervisor.inspectAndPropose(run.run_id, {
        proposalOverrides: {
          success_criteria: [
            { type: "session_present" },
            { type: "sandbox_clean" },
          ],
          out_of_scope: ["deploy"],
          proposed_tasks: [{
            title: "분석만",
            prompt: "읽기만 하고 작은 주석을 추가한다",
            test_command: null,
          }],
        },
      });
      assert.equal(proposed.phase, "PROPOSING");
      assert.ok(proposed.proposal.proposal_digest);
      assert.equal(proposed.proposal.success_criteria.length, 2);
      assert.equal(proposed.run.inspection.system_status_overall, "ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("prepareExecution creates envelope approval and mocked worktree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sup-prep-"));
    try {
      const runStore = new DevelopmentRunStore(join(dir, "runs.json"), {
        idFactory: () => "ffffffff-ffff-4fff-8fff-ffffffffffff",
      });
      await runStore.initialize();
      const taskStore = new TaskManagerStore(join(dir, "tasks.json"));
      await taskStore.initialize();
      const approvalStore = new ApprovalStore(join(dir, "a.json"));
      await approvalStore.initialize();

      const supervisor = createDevelopmentSupervisor({
        runStore,
        taskStore,
        approvalStore,
        createWorktree: async ({ runId }) => worktreePathsForRun({
          runId,
          parent: join(dir, "worktrees"),
          mainRepo: join(dir, "main"),
        }),
      });

      const run = await supervisor.start({ goal: "worktree와 envelope를 준비하는 목표" });
      await supervisor.inspectAndPropose(run.run_id, {
        proposalOverrides: {
          success_criteria: [{ type: "sandbox_clean" }],
          out_of_scope: ["push"],
          proposed_tasks: [{
            title: "leaf",
            prompt: "작은 변경을 수행한다",
          }],
        },
      });
      const prepared = await supervisor.prepareExecution(run.run_id);
      assert.equal(prepared.phase, "WAITING_ENVELOPE_APPROVAL");
      assert.ok(prepared.approval_id);
      assert.ok(prepared.envelope_digest);
      assert.equal(prepared.worktree.main_read_only, true);
      const row = await approvalStore.get(prepared.approval_id);
      assert.equal(row.kind, APPROVAL_ENVELOPE_KIND);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("dev.merge_to_main schema exists but execution is forbidden", () => {
    const draft = createMergeToMainApprovalDraft({
      runId: "gggggggg-gggg-4ggg-8ggg-gggggggggggg",
      envelopeDigest: "c".repeat(64),
      worktreePath: "/tmp/wt",
      branch: "local-ai/dev/x",
    });
    assert.equal(draft.kind, "dev.merge_to_main");
    assert.equal(draft.execution_enabled, false);
    assert.equal(draft.auto_merge, false);
    assert.throws(() => assertMergeExecutionForbidden(), /dev_merge_to_main_execution_forbidden/);
  });

  test("telegram cannot start development supervisor run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sup-tg-"));
    try {
      const runStore = new DevelopmentRunStore(join(dir, "runs.json"));
      await runStore.initialize();
      const supervisor = createDevelopmentSupervisor({
        runStore,
        taskStore: { create: async () => ({}) },
        approvalStore: { createRequest: async () => ({}), get: async () => null },
      });
      await assert.rejects(
        () => supervisor.start({ goal: "텔레그램에서 개발 루프 시작 시도", channel: "telegram" }),
        /telegram_development/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
