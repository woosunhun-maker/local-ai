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
import { createTaskOrchestrator } from "../src/executor/task-orchestrator.mjs";
import { createTaskExecutor } from "../src/executor/task-executor.mjs";
import { createBuiltinToolRegistry } from "../src/tools/tool-registry.mjs";
import { assertToolExecutionAllowed } from "../src/approval/approval-policy.mjs";
import {
  assertWritablePath,
  filterForbiddenChangedPaths,
  CURSOR_PROJECT_ROOT,
} from "../src/adapters/cursor/sandbox.mjs";
import {
  classifyCursorPermission,
  classifyShellCommandEffect,
  createCursorPermissionBridge,
} from "../src/adapters/cursor/permission-bridge.mjs";
import {
  createCursorDevelopmentAdapter,
  verifyCursorHostOutcome,
  cursorDevelopApprovalId,
} from "../src/adapters/cursor/cursor-development-adapter.mjs";
import {
  captureGitBaseline,
  buildCanonicalChangeSet,
  collectHostGitSnapshot,
  collectCursorHostResult,
} from "../src/adapters/cursor/host-result-collector.mjs";
import { createEvidenceRecord } from "../src/evidence/evidence.mjs";
import { verifyTaskOutcome } from "../src/verifier/task-verifier.mjs";

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

function mockAcpFactory({ permissionToolCall = null, failPrompt = false, onPrompt = null } = {}) {
  return () => ({
    start: async () => ({ pid: 42 }),
    initialize: async () => ({ protocolVersion: 1 }),
    authenticate: async () => ({}),
    newSession: async () => ({ sessionId: "11111111-2222-4333-8444-555555555555" }),
    prompt: async ({ onPermission }) => {
      if (failPrompt) throw new Error("acp_prompt_failed");
      if (typeof onPrompt === "function") await onPrompt();
      if (permissionToolCall && onPermission) {
        const decision = await onPermission({ toolCall: permissionToolCall });
        if (decision?.optionId !== "allow-once") throw new Error("permission_rejected");
      }
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    close: async () => ({ exitCode: 0 }),
  });
}

async function initGitRepo(root) {
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@local"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "test"], { cwd: root });
  await writeFile(join(root, "README.md"), "# fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: root });
}

describe("PHASE5 CursorDevelopmentAdapter", { concurrency: false }, () => {
  test("sandbox blocks diol-os, PrivateAI, and outside root", () => {
    assert.throws(() => assertWritablePath(`${CURSOR_PROJECT_ROOT}/diol-os/foo`), /sandbox_forbidden/);
    assert.throws(() => assertWritablePath("/Users/hun/PrivateAI/config"), /sandbox_forbidden/);
    assert.throws(() => assertWritablePath("/tmp/outside"), /sandbox_outside/);
    assert.equal(
      assertWritablePath(`${CURSOR_PROJECT_ROOT}/secure-chat/src/x.mjs`),
      `${CURSOR_PROJECT_ROOT}/secure-chat/src/x.mjs`,
    );
    const filtered = filterForbiddenChangedPaths([
      "secure-chat/a.mjs",
      "diol-os/apps/api/x.py",
    ]);
    assert.deepEqual(filtered.allowed, ["secure-chat/a.mjs"]);
    assert.deepEqual(filtered.blocked, ["diol-os/apps/api/x.py"]);
  });

  test("permission classifier separates READ/WRITE/EXECUTE/HIGH", () => {
    assert.equal(classifyCursorPermission({ kind: "read", title: "Read file" }).auto_allow, true);
    assert.equal(classifyCursorPermission({ kind: "edit", title: "Write file" }).auto_allow, false);
    assert.equal(classifyCursorPermission({
      kind: "shell",
      title: "npm test --prefix secure-chat",
      rawInput: { command: "npm test --prefix secure-chat" },
    }).auto_allow, true);
    assert.equal(classifyCursorPermission({
      kind: "shell",
      title: "git push origin main",
      rawInput: { command: "git push origin main" },
    }).risk, "HIGH_RISK");
  });

  test("EXECUTE shell with filesystem write escalates to WRITE or HIGH_RISK", () => {
    const cases = [
      { command: "echo LIVE_E2E_OK > test/fixtures/marker.txt", risk: "WRITE" },
      { command: "printf 'x' >> secure-chat/out.txt", risk: "WRITE" },
      { command: "cat src/a.mjs | tee out.mjs", risk: "WRITE" },
      { command: "touch new-file.txt", risk: "WRITE" },
      { command: "mkdir -p tmp/live", risk: "WRITE" },
      { command: "rm -f marker.txt", risk: "HIGH_RISK" },
      { command: "mv a.txt b.txt", risk: "WRITE" },
      { command: "cp a.txt b.txt", risk: "WRITE" },
      { command: "npm test", risk: "EXECUTE", auto_allow: true },
      { command: "git status", risk: "EXECUTE", auto_allow: true },
      { command: "git diff", risk: "EXECUTE", auto_allow: true },
      { command: "npm run lint", risk: "EXECUTE", auto_allow: true },
    ];
    for (const item of cases) {
      const effect = classifyShellCommandEffect(item.command);
      assert.equal(effect.risk, item.risk, item.command);
      if (item.auto_allow) assert.equal(effect.auto_allow, true, item.command);
      if (item.risk === "WRITE" || item.risk === "HIGH_RISK") {
        const asExecute = classifyCursorPermission({
          kind: "execute",
          title: item.command,
          rawInput: { command: item.command },
        });
        assert.equal(asExecute.risk, item.risk, `cursor EXECUTE bypass: ${item.command}`);
        assert.equal(asExecute.auto_allow, false, item.command);
        assert.ok(asExecute.escalated_from === "EXECUTE" || asExecute.reason.includes("shell"));
      }
    }
  });

  test("telegram cannot run cursor.develop via policy or orchestrator", async () => {
    const registry = createBuiltinToolRegistry();
    assert.throws(
      () => assertToolExecutionAllowed({
        registry,
        toolName: "cursor.develop",
        channel: "telegram",
        hasApproval: true,
      }),
      /channel_not_allowed|telegram_effect_execution_forbidden/,
    );

    const dir = await mkdtemp(join(tmpdir(), "cursor-tg-"));
    try {
      const store = new TaskManagerStore(join(dir, "tasks.json"), {
        idFactory: () => "task-cursor-tg-1",
      });
      await store.initialize();
      await store.create({ goal: "텔레그램 Cursor 시도", approvalRequired: true });
      const orch = createTaskOrchestrator({
        taskStore: store,
        executor: createTaskExecutor(),
        cursorAdapter: createCursorDevelopmentAdapter({
          approvalStore: {
            createRequest: async () => {
              throw new Error("should_not_create");
            },
            get: async () => null,
          },
        }),
      });
      const result = await orch.run({
        taskId: "task-cursor-tg-1",
        toolName: "cursor.develop",
        channel: "telegram",
        prompt: "작은 변경을 해줘",
      });
      assert.equal(result.phase, "FAILED");
      assert.match(result.verification.reason, /telegram_cursor/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("cursor.develop waits for ApprovalStore and ignores has_approval boolean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-wait-"));
    try {
      const approvalStore = new ApprovalStore(join(dir, "approvals.json"));
      await approvalStore.initialize();
      const taskStore = new TaskManagerStore(join(dir, "tasks.json"), {
        idFactory: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      });
      await taskStore.initialize();
      await taskStore.create({ goal: "작은 안전 변경", approvalRequired: true });

      const adapter = createCursorDevelopmentAdapter({
        approvalStore,
        createAcpClient: mockAcpFactory(),
        projectRoot: dir,
      });
      const orch = createTaskOrchestrator({
        taskStore,
        executor: createTaskExecutor(),
        cursorAdapter: adapter,
      });

      const waiting = await orch.run({
        taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        toolName: "cursor.develop",
        channel: "local_owner_app",
        prompt: "README에 한 줄 주석만 추가",
        hasApproval: true,
      });
      assert.equal(waiting.phase, "WAITING_APPROVAL");
      assert.ok(waiting.approval_id);
      assert.equal(waiting.approval_id, cursorDevelopApprovalId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("approved cursor.develop reaches SUCCESS with host VERIFIED evidence (mock ACP)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-ok-"));
    try {
      await initGitRepo(dir);
      const deviceId = "owner-device-cursor01";
      const keys = keyPair();
      const approvalStore = new ApprovalStore(join(dir, "approvals.json"));
      await approvalStore.initialize();
      await approvalStore.registerDeviceKey(deviceId, keys.publicKeyDER);

      const taskStore = new TaskManagerStore(join(dir, "tasks.json"), {
        idFactory: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      });
      await taskStore.initialize();
      await taskStore.create({ goal: "작은 안전 변경", approvalRequired: true });

      const adapter = createCursorDevelopmentAdapter({
        approvalStore,
        createAcpClient: mockAcpFactory(),
        projectRoot: dir,
        waitForPermissionDecision: async () => "rejected",
      });
      const orch = createTaskOrchestrator({
        taskStore,
        executor: createTaskExecutor(),
        cursorAdapter: adapter,
      });

      const waiting = await orch.run({
        taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        toolName: "cursor.develop",
        channel: "local_owner_app",
        prompt: "README에 fixture marker 한 줄 추가",
      });
      assert.equal(waiting.phase, "WAITING_APPROVAL");

      const pending = await approvalStore.get(waiting.approval_id);
      await approve(approvalStore, deviceId, pending, keys.privateKey);

      // 작업 트리 변경 없이 ACP만 성공 → write_path 불필요, SUCCESS
      const done = await orch.run({
        taskId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        toolName: "cursor.develop",
        channel: "local_owner_app",
        prompt: "README에 fixture marker 한 줄 추가",
      });
      assert.equal(done.phase, "SUCCESS");
      assert.equal(done.verification.result, "PASS");
      assert.ok(done.session_id);
      assert.ok(done.host.diff_hash);
      assert.equal(done.host.diff_hash_kind, "no_task_changes");
      assert.ok(done.task.evidence.some((e) => e.epistemic === "VERIFIED" && e.claim.includes("cursor.session.status=")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("WRITE permission creates ApprovalStore request and does not allow-always", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-perm-"));
    try {
      const approvalStore = new ApprovalStore(join(dir, "a.json"));
      await approvalStore.initialize();
      const bridge = createCursorPermissionBridge({
        approvalStore,
        waitForDecision: async () => "pending",
      });
      const decision = await bridge.decide({
        toolCallId: "call1",
        kind: "edit",
        title: "Write secure-chat/x.mjs",
      }, { taskId: "task-1", sessionId: "sess-1" });
      assert.equal(decision.optionId, "reject-once");
      assert.ok(decision.approval_id);
      assert.notEqual(decision.optionId, "allow-always");
      const row = await approvalStore.get(decision.approval_id);
      assert.equal(row.kind, "cursor.tool_permission");
      assert.equal(row.status, "pending");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("INFERRED-only cannot PASS verifier", () => {
    const result = verifyTaskOutcome({
      task: {
        task_id: "t1",
        evidence: [
          createEvidenceRecord({
            epistemic: "INFERRED",
            claim: "cursor.session.status=completed",
            source: "model",
          }),
        ],
      },
      expectations: [{ claim_includes: "cursor.session.status=" }],
    });
    assert.equal(result.result, "FAIL");
  });

  test("verifyCursorHostOutcome: security UNKNOWN blocks PASS", () => {
    assert.equal(verifyCursorHostOutcome({
      session_id: null,
      diff_hash: "abc",
      diff_hash_kind: "canonical_patch",
      has_content_changes: false,
      blocked_files: [],
      write_path_observed: false,
      write_authorization_verified: true,
    }).result, "UNKNOWN");

    assert.equal(verifyCursorHostOutcome({
      session_id: "s1",
      diff_hash: "abc",
      diff_hash_kind: "no_task_changes",
      has_content_changes: false,
      blocked_files: [],
      error: null,
      cancelled: false,
      test_command: null,
      write_path_observed: false,
      write_authorization_verified: true,
      main_repo_writes: [],
    }).result, "PASS");

    const withWriteUnknown = verifyCursorHostOutcome({
      session_id: "s1",
      diff_hash: "deadbeef".repeat(8),
      diff_hash_kind: "canonical_patch",
      has_content_changes: true,
      blocked_files: [],
      error: null,
      cancelled: false,
      test_command: null,
      write_path_observed: false,
      write_authorization_verified: false,
      write_authorization: { kind: "unauthorized", reason: "envelope_missing" },
      main_repo_writes: [],
    });
    assert.equal(withWriteUnknown.result, "UNKNOWN");
    assert.match(withWriteUnknown.reason, /security_expectation_unknown/);
    assert.notEqual(withWriteUnknown.reason, "all_expectations_verified");
  });

  test("verifier strictness: required UNKNOWN/PARTIAL cannot all_expectations_verified", () => {
    const partial = verifyTaskOutcome({
      task: {
        task_id: "t-strict",
        evidence: [
          createEvidenceRecord({
            epistemic: "VERIFIED",
            claim: "cursor.session.status=completed",
            source: "host",
          }),
        ],
      },
      checks: [
        { id: "session", status: "verified", required: true, security: true },
        { id: "write_path", status: "unknown", required: true, security: true },
        { id: "git_diff", status: "partial", required: true, security: false },
      ],
    });
    assert.equal(partial.result, "UNKNOWN");
    assert.notEqual(partial.reason, "all_expectations_verified");

    const securityOnly = verifyTaskOutcome({
      task: {
        task_id: "t-sec",
        evidence: [
          createEvidenceRecord({ epistemic: "VERIFIED", claim: "ok", source: "host" }),
        ],
      },
      checks: [
        { id: "session", status: "verified", required: true, security: true },
        { id: "write_path", status: "unknown", required: true, security: true },
      ],
    });
    assert.equal(securityOnly.result, "UNKNOWN");
    assert.match(securityOnly.reason, /security_expectation_unknown/);
  });

  test("untracked files enter canonical change set and content hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-untracked-"));
    try {
      await initGitRepo(dir);
      await mkdir(join(dir, "test", "fixtures"), { recursive: true });
      const marker = "LIVE_E2E_OK phase5-hardening\n";
      await writeFile(join(dir, "test", "fixtures", "live-e2e-marker.txt"), marker);

      const snap = await collectHostGitSnapshot({
        cwd: dir,
        taskId: "task-untracked",
        sessionId: "sess",
      });
      assert.ok(snap.git_diff.includes("live-e2e-marker.txt") || snap.git_diff.includes("LIVE_E2E_OK"));
      assert.match(snap.diff_hash, /^[a-f0-9]{64}$/u);
      assert.equal(snap.diff_hash_kind, "canonical_patch");
      assert.equal(snap.has_content_changes, true);
      assert.ok(snap.changed_files.some((f) => f.includes("live-e2e-marker.txt")));
      assert.ok(snap.git_diff.length > 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("baseline delta excludes pre-existing untracked from task changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-baseline-"));
    try {
      await initGitRepo(dir);
      await writeFile(join(dir, "pre-existing.txt"), "already here\n");
      await mkdir(join(dir, "scripts"), { recursive: true });
      await writeFile(join(dir, "scripts", "noise.sh"), "echo noise\n");

      const baseline = await captureGitBaseline({ cwd: dir });
      assert.ok(baseline.paths.includes("pre-existing.txt"));

      await writeFile(join(dir, "task-created.txt"), "from this task\n");

      const changeSet = await buildCanonicalChangeSet({ cwd: dir, baseline });
      assert.ok(changeSet.changed_files.includes("task-created.txt"));
      assert.ok(changeSet.pre_existing_files.includes("pre-existing.txt"));
      assert.ok(changeSet.pre_existing_files.some((f) => f.includes("noise.sh")));
      assert.ok(!changeSet.changed_files.includes("pre-existing.txt"));
      assert.ok(changeSet.git_diff.includes("task-created") || changeSet.git_diff.includes("from this task"));
      assert.ok(!changeSet.git_diff.includes("already here"));
      assert.equal(changeSet.diff_hash_kind, "canonical_patch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("content change without WRITE and without envelope yields UNKNOWN", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-write-unknown-"));
    try {
      await initGitRepo(dir);
      const baseline = await captureGitBaseline({ cwd: dir });
      await writeFile(join(dir, "new-from-shell.txt"), "via execute redirect\n");
      const host = await collectCursorHostResult({
        taskId: "task-write-unk",
        sessionId: "sess-1",
        startedAt: new Date().toISOString(),
        stopReason: "end_turn",
        exitCode: 0,
        cwd: dir,
        baseline,
        permissionEvents: [
          { risk: "EXECUTE", optionId: "allow-once", reason: "misclassified" },
        ],
      });
      assert.equal(host.has_content_changes, true);
      assert.equal(host.write_path_observed, false);
      assert.equal(host.write_authorization_verified, false);
      assert.equal(host.write_authorization.kind, "unauthorized");
      const outcome = verifyCursorHostOutcome(host);
      assert.equal(outcome.result, "UNKNOWN");
      assert.match(outcome.reason, /write_authorization|security_expectation_unknown/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("envelope_authorized_write PASS without ACP WRITE event", async () => {
    const { createApprovalEnvelope } = await import("../src/supervisor/approval-envelope.mjs");
    const dir = await mkdtemp(join(tmpdir(), "cursor-env-auth-"));
    try {
      await initGitRepo(dir);
      await mkdir(join(dir, "secure-chat", "test", "fixtures"), { recursive: true });
      const baseline = await captureGitBaseline({ cwd: dir });
      await writeFile(
        join(dir, "secure-chat", "test", "fixtures", "envelope-auth-marker.txt"),
        "envelope authorized\n",
      );

      const envelope = createApprovalEnvelope({
        runId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        goal: "envelope authorized write 검증용 목표입니다",
        proposalDigest: "ab".repeat(32),
        successCriteria: [{ type: "write_authorization_verified" }],
        outOfScope: ["diol-os/", "/Users/hun/PrivateAI"],
        worktreePath: dir,
        branch: "dev/test-envelope-auth",
        allowedPaths: ["secure-chat/"],
        allowedCommands: ["npm test", "git status"],
        riskClass: "HIGH",
        maxRuntimeMs: 60 * 60_000,
      });

      const host = await collectCursorHostResult({
        taskId: "task-env-auth",
        sessionId: "sess-env",
        startedAt: new Date().toISOString(),
        stopReason: "end_turn",
        exitCode: 0,
        cwd: dir,
        baseline,
        permissionEvents: [],
        writeRoots: [dir],
        mainRepo: null,
        mainReadOnly: true,
        envelope,
      });

      assert.equal(host.has_content_changes, true);
      assert.equal(host.write_path_observed, false);
      assert.equal(host.write_authorization.kind, "envelope_authorized_write");
      assert.equal(host.write_authorization_verified, true);
      const outcome = verifyCursorHostOutcome(host);
      assert.equal(outcome.result, "PASS");
      assert.equal(
        outcome.checks.find((c) => c.id === "write_authorization_verified")?.status,
        "verified",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("out-of-envelope path fails write authorization even with ACP WRITE", async () => {
    const { createApprovalEnvelope } = await import("../src/supervisor/approval-envelope.mjs");
    const dir = await mkdtemp(join(tmpdir(), "cursor-oob-"));
    try {
      await initGitRepo(dir);
      await mkdir(join(dir, "outside"), { recursive: true });
      const baseline = await captureGitBaseline({ cwd: dir });
      await writeFile(join(dir, "outside", "leak.txt"), "nope\n");

      const envelope = createApprovalEnvelope({
        runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        goal: "out of envelope 실패 검증용 목표입니다",
        proposalDigest: "cd".repeat(32),
        successCriteria: [{ type: "write_authorization_verified" }],
        outOfScope: ["diol-os/"],
        worktreePath: dir,
        branch: "dev/test-oob",
        allowedPaths: ["secure-chat/"],
        allowedCommands: ["npm test"],
        riskClass: "HIGH",
      });

      const host = await collectCursorHostResult({
        taskId: "task-oob",
        sessionId: "sess-oob",
        startedAt: new Date().toISOString(),
        stopReason: "end_turn",
        exitCode: 0,
        cwd: dir,
        baseline,
        permissionEvents: [
          { risk: "WRITE", optionId: "allow-once", decision: "approved" },
        ],
        writeRoots: [dir],
        mainReadOnly: true,
        envelope,
      });
      assert.equal(host.write_path_observed, true);
      assert.equal(host.write_authorization_verified, false);
      assert.equal(host.write_authorization.kind, "out_of_envelope");
      const outcome = verifyCursorHostOutcome(host);
      assert.equal(outcome.result, "FAIL");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("host collector captures git status/diff hash for tracked edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-git-"));
    try {
      await initGitRepo(dir);
      await writeFile(join(dir, "README.md"), "# changed\n");
      const snap = await collectHostGitSnapshot({
        cwd: dir,
        taskId: "task-git",
        sessionId: "sess",
      });
      assert.match(snap.diff_hash, /^[a-f0-9]{64}$/u);
      assert.ok(snap.git_status.includes("README.md") || snap.changed_files.includes("README.md"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
