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
  createCursorPermissionBridge,
} from "../src/adapters/cursor/permission-bridge.mjs";
import {
  createCursorDevelopmentAdapter,
  verifyCursorHostOutcome,
  cursorDevelopApprovalId,
} from "../src/adapters/cursor/cursor-development-adapter.mjs";
import { collectHostGitSnapshot } from "../src/adapters/cursor/host-result-collector.mjs";
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

function mockAcpFactory({ permissionToolCall = null, failPrompt = false } = {}) {
  return () => ({
    start: async () => ({ pid: 42 }),
    initialize: async () => ({ protocolVersion: 1 }),
    authenticate: async () => ({}),
    newSession: async () => ({ sessionId: "11111111-2222-4333-8444-555555555555" }),
    prompt: async ({ onPermission }) => {
      if (failPrompt) throw new Error("acp_prompt_failed");
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
    }).auto_allow, true);
    assert.equal(classifyCursorPermission({
      kind: "shell",
      title: "git push origin main",
    }).risk, "HIGH_RISK");
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

      // host 측 작은 변경을 미리 만들어 collector가 관측
      await writeFile(join(dir, "README.md"), "# fixture\n# cursor-slice\n");

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
      assert.ok(done.task.evidence.some((e) => e.epistemic === "VERIFIED" && e.claim.includes("host.git.diff_hash=")));
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

  test("verifyCursorHostOutcome requires session and diff hash", () => {
    assert.equal(verifyCursorHostOutcome({
      session_id: null,
      diff_hash: "abc",
      blocked_files: [],
    }).result, "UNKNOWN");
    assert.equal(verifyCursorHostOutcome({
      session_id: "s1",
      diff_hash: "abc",
      blocked_files: [],
      error: null,
      cancelled: false,
      test_command: null,
    }).result, "PASS");
  });

  test("host collector captures git status/diff hash", async () => {
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
