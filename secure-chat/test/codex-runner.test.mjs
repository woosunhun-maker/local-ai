import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { buildIsolatedRepositoryManifest } from "../src/codex/isolated-workspace.mjs";
import {
  CODEX_BINARY_PATH,
  CODEX_MODEL,
  CODEX_REASONING_EFFORT,
  CODEX_OUTPUT_SCHEMA_FILE,
  CODEX_MAX_SUMMARY_CHARACTERS,
  CodexRunnerError,
  createCodexRunner,
  EXPECTED_CODEX_VERSION,
} from "../src/codex/runner.mjs";

const OWNER = "100000001";
const execFileAsync = promisify(execFile);

async function jobFixture(jobId) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "localai-codex-runner-"));
  const workspaceRoot = await realpath(temporary);
  const jobDir = path.join(workspaceRoot, "jobs", jobId);
  const repoDir = path.join(jobDir, "repo");
  await mkdir(path.join(repoDir, ".git"), { recursive: true });
  await mkdir(path.join(repoDir, "src"));
  await writeFile(path.join(repoDir, "src", "safe.mjs"), "export const safe = true;\n");
  return { workspaceRoot, jobDir, repoDir };
}

async function realGitJobFixture(jobId) {
  const fixture = await jobFixture(jobId);
  await rm(path.join(fixture.repoDir, ".git"), { recursive: true, force: true });
  const gitEnvironment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: "/var/empty",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  await execFileAsync("/usr/bin/git", ["init", "--quiet", "--initial-branch=main", "--template="], { cwd: fixture.repoDir, env: gitEnvironment });
  await execFileAsync("/usr/bin/git", ["add", "--all"], { cwd: fixture.repoDir, env: gitEnvironment });
  await execFileAsync("/usr/bin/git", [
    "-c", "user.name=LocalAI Test", "-c", "user.email=localai-test@example.invalid",
    "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "baseline",
  ], { cwd: fixture.repoDir, env: gitEnvironment });
  return fixture;
}

function completedChild({ stdout = "", stderr = "", code = 0, capture, hang = false, pid }) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedSignals = [];
  child.kill = (signal) => { child.killedSignals.push(signal); return true; };
  let input = "";
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString("utf8");
      callback();
    },
  });
  child.stdin.on("finish", () => {
    capture.input = input;
    if (hang) return;
    queueMicrotask(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", code, null));
    });
  });
  return child;
}

function fakeSpawner({
  intent = "draft",
  actualChanges = 2,
  execCode = 0,
  execStderr = "",
  execStdout = null,
  version = EXPECTED_CODEX_VERSION,
  hangExec = false,
  oversized = false,
  responseSummary = null,
  responsePatch = null,
  responseChangedFileCount = null,
  extraEvent = null,
} = {}) {
  const calls = [];
  let gitStatusCalls = 0;
  let pid = 3000;
  const spawnProcess = (file, args, options) => {
    const capture = { file, args: [...args], options, input: null };
    calls.push(capture);
    pid += 1;
    if (file === "/usr/bin/git") {
      const isStatus = args.includes("status");
      if (isStatus) gitStatusCalls += 1;
      const output = isStatus && gitStatusCalls >= 3 && actualChanges !== 0
        ? "M  src/safe.mjs\0A  src/added.mjs\0"
        : "";
      return completedChild({ stdout: output, capture, pid });
    }
    if (args.length === 1 && args[0] === "--version") {
      return completedChild({ stdout: `${version}\n`, capture, pid });
    }
    const defaultPatch = [
      "diff --git a/src/safe.mjs b/src/safe.mjs",
      "index 0000000..1111111 100644",
      "--- a/src/safe.mjs",
      "+++ b/src/safe.mjs",
      "@@ -1 +1 @@",
      "-export const safe = true;",
      "+export const safe = false;",
      "diff --git a/src/added.mjs b/src/added.mjs",
      "new file mode 100644",
      "index 0000000..2222222",
      "--- /dev/null",
      "+++ b/src/added.mjs",
      "@@ -0,0 +1 @@",
      "+export const added = true;",
      "",
    ].join("\n");
    const response = {
      summary: responseSummary ?? (intent === "inspect" ? "격리 복사본 점검을 완료했습니다." : "격리 복사본에 초안을 작성했습니다."),
      changedFileCount: responseChangedFileCount ?? (intent === "draft" ? 2 : 0),
      needsOwnerApp: false,
      ...(intent === "draft" ? { patch: responsePatch ?? defaultPatch } : {}),
    };
    const eventLines = [
      JSON.stringify({ type: "thread.started", thread_id: "ephemeral" }),
      JSON.stringify({ type: "turn.started" }),
      ...(extraEvent ? [JSON.stringify(extraEvent)] : []),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(response) } }),
      JSON.stringify({ type: "turn.completed" }),
    ];
    const stdout = execStdout ?? (oversized
      ? "x".repeat(1_000)
      : `${eventLines.join("\n")}\n`);
    return completedChild({ stdout, stderr: execStderr, code: execCode, capture, hang: hangExec, pid });
  };
  return { calls, spawnProcess };
}

function oneFilePatch(relativePath = "src/safe.mjs") {
  return [
    `diff --git a/${relativePath} b/${relativePath}`,
    "index 0000000..1111111 100644",
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    "@@ -1 +1 @@",
    "-export const safe = true;",
    "+export const safe = false;",
    "",
  ].join("\n");
}

test("draft gives Codex only a sanitized snapshot and applies its validated patch locally", async (t) => {
  const fixture = await jobFixture("draft-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({ intent: "draft", actualChanges: 2 });
  const groupSignals = [];
  const runner = createCodexRunner({
    spawnProcess: fake.spawnProcess,
    killProcess: (pid, signal) => { groupSignals.push([pid, signal]); },
    workspaceRoot: fixture.workspaceRoot,
  });
  const result = await runner({
    jobId: "draft-job",
    ownerId: OWNER,
    intent: "draft",
    prompt: `상태 표시를 보강해. 합성 경로는 /Users/hun/PrivateAI, 합성 ID는 ${OWNER}.`,
  });

  assert.equal(result.summary, "격리 복사본에 초안을 작성했습니다.");
  assert.equal(result.changedFileCount, 2);
  assert.deepEqual(result.changedPaths, ["src/added.mjs", "src/safe.mjs"]);
  assert.equal(typeof result.patch, "string");
  assert.equal(result.patchSha256, createHash("sha256").update(result.patch, "utf8").digest("hex"));
  assert.equal(result.needsOwnerApp, false);
  const versionCall = fake.calls.find((call) => call.args[0] === "--version");
  const execCall = fake.calls.find((call) => call.args[0] === "exec");
  assert.equal(versionCall.file, CODEX_BINARY_PATH);
  assert.equal(execCall.file, CODEX_BINARY_PATH);
  assert.equal(execCall.options.shell, false);
  assert.equal(execCall.options.detached, true);
  assert.equal(groupSignals.some(([pid, signal]) => pid < 0 && signal === "SIGTERM"), true);
  assert.equal(groupSignals.some(([pid, signal]) => pid < 0 && signal === "SIGKILL"), true);
  assert.equal(execCall.options.cwd, fixture.repoDir);
  assert.equal(execCall.args.at(-1), "-");
  assert.equal(execCall.args.includes("--ephemeral"), true);
  assert.equal(execCall.args.includes("--ignore-user-config"), true);
  assert.equal(execCall.args.includes("--ignore-rules"), true);
  assert.equal(execCall.args.includes("--strict-config"), true);
  assert.equal(execCall.args.includes("--json"), true);
  assert.equal(execCall.args[execCall.args.indexOf("--model") + 1], CODEX_MODEL);
  assert.equal(execCall.args.some((arg) => arg.includes(`model_reasoning_effort="${CODEX_REASONING_EFFORT}"`)), true);
  assert.equal(execCall.args.includes("--skip-git-repo-check"), false);
  assert.equal(execCall.args.some((arg) => arg.includes('approval_policy="never"')), true);
  assert.equal(execCall.args.some((arg) => arg.includes('web_search="disabled"')), true);
  assert.equal(execCall.args.some((arg) => arg.includes("features.apps=false")), true);
  assert.equal(execCall.args.some((arg) => arg.includes("features.shell_tool=false")), true);
  assert.equal(execCall.args.some((arg) => arg.includes("features.shell_snapshot=false")), true);
  assert.equal(execCall.args.some((arg) => arg.includes("features.unified_exec=false")), true);
  assert.equal(execCall.args.some((arg) => arg.includes("features.computer_use=false")), true);
  assert.equal(execCall.args.some((arg) => arg.includes("features.remote_plugin=false")), true);
  assert.equal(execCall.args.some((arg) => arg.includes('default_permissions=":read-only"')), true);
  assert.equal(execCall.args.some((arg) => arg.startsWith("permissions.")), false);
  assert.equal(execCall.args.includes(OWNER), false);
  assert.equal(execCall.args.some((arg) => arg.includes("/Users/hun/PrivateAI")), false);
  assert.equal(execCall.input.includes(OWNER), false);
  assert.equal(execCall.input.includes("/Users/hun/PrivateAI"), false);
  assert.equal(execCall.input.includes("900000000000000001"), true);
  assert.equal(execCall.input.includes("/Users/localai-synthetic/PrivateAI"), true);
  assert.equal(execCall.input.includes('\"path\":\"src/safe.mjs\"'), true);
  assert.equal(execCall.input.includes("no local execution, shell, browser"), true);

  const schemaPath = path.join(fixture.jobDir, CODEX_OUTPUT_SCHEMA_FILE);
  assert.equal(execCall.args[execCall.args.indexOf("--output-schema") + 1], schemaPath);
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  assert.deepEqual(schema.required, ["summary", "changedFileCount", "needsOwnerApp", "patch"]);
  assert.equal(schema.properties.summary.maxLength, CODEX_MAX_SUMMARY_CHARACTERS);
  assert.equal(schema.properties.changedFileCount.maximum, 20);
  assert.equal(schema.properties.patch.maxLength, 32 * 1024);
  assert.equal(schema.additionalProperties, false);
});

test("trusted git applies the exact validated patch only inside the isolated repository", async (t) => {
  const fixture = await realGitJobFixture("real-git-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({ intent: "draft" });
  const hybridSpawn = (file, args, options) => (
    file === CODEX_BINARY_PATH ? fake.spawnProcess(file, args, options) : spawn(file, args, options)
  );
  const runner = createCodexRunner({
    spawnProcess: hybridSpawn,
    killProcess: () => {},
    workspaceRoot: fixture.workspaceRoot,
    killGraceMs: 1,
  });
  const result = await runner({ jobId: "real-git-job", ownerId: OWNER, intent: "draft", prompt: "안전한 초안을 작성해." });
  assert.equal(result.changedFileCount, 2);
  assert.equal(await readFile(path.join(fixture.repoDir, "src", "safe.mjs"), "utf8"), "export const safe = false;\n");
  assert.equal(await readFile(path.join(fixture.repoDir, "src", "added.mjs"), "utf8"), "export const added = true;\n");
});

test("inspect has no local tools and requires zero actual changes", async (t) => {
  const fixture = await jobFixture("inspect-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({ intent: "inspect", actualChanges: 0 });
  const runner = createCodexRunner({ spawnProcess: fake.spawnProcess, workspaceRoot: fixture.workspaceRoot });
  const result = await runner({ jobId: "inspect-job", ownerId: OWNER, intent: "inspect", prompt: "상태 구조를 점검해." });
  assert.equal(result.changedFileCount, 0);
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.patch, null);
  assert.equal(result.patchSha256, null);
  const execCall = fake.calls.find((call) => call.args[0] === "exec");
  assert.equal(execCall.args.some((arg) => arg.includes('default_permissions=":read-only"')), true);
  assert.match(execCall.input, /Inspect only/u);
  const schema = JSON.parse(await readFile(path.join(fixture.jobDir, CODEX_OUTPUT_SCHEMA_FILE), "utf8"));
  assert.deepEqual(schema.required, ["summary", "changedFileCount", "needsOwnerApp"]);
  assert.equal(schema.properties.changedFileCount.maximum, 0);
  assert.equal("patch" in schema.properties, false);
});

test("runner requires the exact approved source manifest before any Codex process starts", async (t) => {
  const matching = await jobFixture("manifest-match-job");
  t.after(() => rm(matching.workspaceRoot, { recursive: true, force: true }));
  const matchingManifest = await buildIsolatedRepositoryManifest(matching.repoDir, { ownerId: OWNER });
  const matchingFake = fakeSpawner({ intent: "inspect", actualChanges: 0 });
  const matchingRunner = createCodexRunner({
    spawnProcess: matchingFake.spawnProcess,
    workspaceRoot: matching.workspaceRoot,
  });
  await matchingRunner({
    jobId: "manifest-match-job",
    ownerId: OWNER,
    intent: "inspect",
    prompt: "승인 경로 보안 점검",
    expectedSourceManifestSha256: matchingManifest.sha256,
    expectedSourceFileCount: matchingManifest.fileCount,
    expectedSourceTotalBytes: matchingManifest.totalBytes,
  });
  assert.equal(matchingFake.calls.some((call) => call.file === CODEX_BINARY_PATH && call.args[0] === "exec"), true);

  const changed = await jobFixture("manifest-changed-job");
  t.after(() => rm(changed.workspaceRoot, { recursive: true, force: true }));
  const approvedManifest = await buildIsolatedRepositoryManifest(changed.repoDir, { ownerId: OWNER });
  await writeFile(path.join(changed.repoDir, "src", "safe.mjs"), "export const safe = false;\n");
  const changedFake = fakeSpawner({ intent: "inspect", actualChanges: 0 });
  const changedRunner = createCodexRunner({
    spawnProcess: changedFake.spawnProcess,
    workspaceRoot: changed.workspaceRoot,
  });
  await assert.rejects(
    changedRunner({
      jobId: "manifest-changed-job",
      ownerId: OWNER,
      intent: "inspect",
      prompt: "승인 경로 보안 점검",
      expectedSourceManifestSha256: approvedManifest.sha256,
      expectedSourceFileCount: approvedManifest.fileCount,
      expectedSourceTotalBytes: approvedManifest.totalBytes,
    }),
    (error) => error instanceof CodexRunnerError && error.code === "source_manifest_mismatch",
  );
  assert.equal(changedFake.calls.some((call) => call.file === CODEX_BINARY_PATH), false);
});

test("version mismatch and subprocess stderr fail with generic errors only", async (t) => {
  const mismatchFixture = await jobFixture("version-job");
  const stderrFixture = await jobFixture("stderr-job");
  t.after(() => rm(mismatchFixture.workspaceRoot, { recursive: true, force: true }));
  t.after(() => rm(stderrFixture.workspaceRoot, { recursive: true, force: true }));

  const mismatch = fakeSpawner({ version: "codex-cli unexpected-secret-version" });
  await assert.rejects(
    createCodexRunner({ spawnProcess: mismatch.spawnProcess, workspaceRoot: mismatchFixture.workspaceRoot })({
      jobId: "version-job", ownerId: OWNER, intent: "inspect", prompt: "구조를 점검해.",
    }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_version_mismatch" && !error.message.includes("unexpected-secret-version"),
  );

  const failed = fakeSpawner({ execCode: 1, execStderr: "raw sk-proj-synthetic_DO_NOT_EXPOSE_12345678901234567890" });
  await assert.rejects(
    createCodexRunner({ spawnProcess: failed.spawnProcess, workspaceRoot: stderrFixture.workspaceRoot })({
      jobId: "stderr-job", ownerId: OWNER, intent: "draft", prompt: "안전한 초안을 작성해.",
    }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_task_failed" && !error.message.includes("DO_NOT_EXPOSE"),
  );
});

test("safe failure classification distinguishes bounded stderr categories without exposing raw text", async (t) => {
  const rateFixture = await jobFixture("rate-limit-job");
  const contextFixture = await jobFixture("context-limit-job");
  t.after(() => rm(rateFixture.workspaceRoot, { recursive: true, force: true }));
  t.after(() => rm(contextFixture.workspaceRoot, { recursive: true, force: true }));

  const rate = fakeSpawner({ execCode: 1, execStderr: "429 rate limit sk-proj-synthetic_DO_NOT_EXPOSE_12345678901234567890" });
  await assert.rejects(
    createCodexRunner({ spawnProcess: rate.spawnProcess, workspaceRoot: rateFixture.workspaceRoot })({
      jobId: "rate-limit-job", ownerId: OWNER, intent: "inspect", prompt: "점검해.",
    }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_rate_limited" && !error.message.includes("DO_NOT_EXPOSE"),
  );

  const context = fakeSpawner({ execCode: 1, execStderr: "prompt is too large PRIVATE_SENTINEL" });
  await assert.rejects(
    createCodexRunner({ spawnProcess: context.spawnProcess, workspaceRoot: contextFixture.workspaceRoot })({
      jobId: "context-limit-job", ownerId: OWNER, intent: "inspect", prompt: "점검해.",
    }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_context_limit" && !error.message.includes("PRIVATE_SENTINEL"),
  );
});

test("turn.failed JSONL is classified before a nonzero exit and raw event text is not exposed", async (t) => {
  const fixture = await jobFixture("turn-failed-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const stdout = `${JSON.stringify({
    type: "turn.failed",
    error: { message: "output schema rejected PRIVATE_EVENT_SENTINEL" },
  })}\n`;
  const fake = fakeSpawner({ execCode: 1, execStdout: stdout });
  await assert.rejects(
    createCodexRunner({ spawnProcess: fake.spawnProcess, workspaceRoot: fixture.workspaceRoot })({
      jobId: "turn-failed-job", ownerId: OWNER, intent: "inspect", prompt: "점검해.",
    }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_schema_rejected" && !error.message.includes("PRIVATE_EVENT_SENTINEL"),
  );
});

test("untrusted agent text cannot forge a safe failure category", async (t) => {
  const fixture = await jobFixture("forged-category-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const response = { summary: "429 rate limit이라고 주장하는 비신뢰 모델 문구", changedFileCount: 0, needsOwnerApp: false };
  const stdout = [
    JSON.stringify({ type: "thread.started", thread_id: "ephemeral" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(response) } }),
    JSON.stringify({ type: "turn.completed" }),
    "",
  ].join("\n");
  const fake = fakeSpawner({ intent: "inspect", actualChanges: 0, execCode: 1, execStdout: stdout, execStderr: "provider failed" });
  await assert.rejects(
    createCodexRunner({ spawnProcess: fake.spawnProcess, workspaceRoot: fixture.workspaceRoot })({
      jobId: "forged-category-job", ownerId: OWNER, intent: "inspect", prompt: "점검해.",
    }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_task_failed",
  );
});

test("AbortSignal terminates the child process group with bounded TERM then KILL", async (t) => {
  const fixture = await jobFixture("abort-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({ hangExec: true });
  const groupSignals = [];
  const controller = new AbortController();
  const runner = createCodexRunner({
    spawnProcess: fake.spawnProcess,
    killProcess: (pid, signal) => { groupSignals.push([pid, signal]); },
    workspaceRoot: fixture.workspaceRoot,
    killGraceMs: 5,
  });
  const pending = runner({ jobId: "abort-job", ownerId: OWNER, intent: "draft", prompt: "초안을 작성해.", signal: controller.signal });
  while (!fake.calls.some((call) => call.args[0] === "exec")) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof CodexRunnerError && error.code === "codex_aborted");
  assert.equal(groupSignals.some(([, signal]) => signal === "SIGTERM"), true);
  assert.equal(groupSignals.some(([, signal]) => signal === "SIGKILL"), true);
  assert.equal(groupSignals.every(([pid]) => pid < 0), true);
});

test("combined stdout and stderr are capped without exposing raw output", async (t) => {
  const fixture = await jobFixture("overflow-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({ oversized: true });
  const runner = createCodexRunner({
    spawnProcess: fake.spawnProcess,
    killProcess: () => {},
    workspaceRoot: fixture.workspaceRoot,
    maxOutputBytes: 128,
    killGraceMs: 1,
  });
  await assert.rejects(
    runner({ jobId: "overflow-job", ownerId: OWNER, intent: "draft", prompt: "초안을 작성해." }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_output_too_large" && !error.message.includes("xxx"),
  );
});

test("an absolute host path in the model summary is rejected", async (t) => {
  const fixture = await jobFixture("summary-path-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({ intent: "inspect", actualChanges: 0, responseSummary: "결과는 /Users/localai-synthetic/private 에 있습니다." });
  const runner = createCodexRunner({ spawnProcess: fake.spawnProcess, workspaceRoot: fixture.workspaceRoot });
  await assert.rejects(
    runner({ jobId: "summary-path-job", ownerId: OWNER, intent: "inspect", prompt: "구조를 점검해." }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_response_invalid",
  );
});

test("draft patch parser rejects traversal, metadata tricks, malformed hunks, and protected paths", async (t) => {
  const cases = new Map([
    ["traversal", oneFilePatch("../escape.mjs")],
    ["duplicate section", `${oneFilePatch()}${oneFilePatch()}`],
    ["binary patch", oneFilePatch().replace("--- a/src/safe.mjs", "GIT binary patch\n--- a/src/safe.mjs")],
    ["deletion", oneFilePatch().replace("+++ b/src/safe.mjs", "+++ /dev/null")],
    ["executable mode", oneFilePatch().replace("index 0000000..1111111 100644", "new file mode 100755\nindex 0000000..1111111")],
    ["CRLF", oneFilePatch().replaceAll("\n", "\r\n")],
    ["missing final LF", oneFilePatch().slice(0, -1)],
    ["quoted spaced path", oneFilePatch().replace("diff --git a/src/safe.mjs b/src/safe.mjs", 'diff --git "a/src/safe file.mjs" "b/src/safe file.mjs"')],
    ["protected attributes", oneFilePatch(".gitattributes")],
    ["bad hunk count", oneFilePatch().replace("@@ -1 +1 @@", "@@ -1,2 +1 @@")],
    ["symlink mode", oneFilePatch().replace("index 0000000..1111111 100644", "new file mode 120000\nindex 0000000..1111111")],
    ["non ASCII path", oneFilePatch("한글.mjs")],
  ]);
  for (const [name, responsePatch] of cases) {
    await t.test(name, async (subtest) => {
      const fixture = await jobFixture(`blocked-${name.replaceAll(" ", "-")}`);
      subtest.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
      const fake = fakeSpawner({ intent: "draft", actualChanges: 0, responsePatch, responseChangedFileCount: 1 });
      const runner = createCodexRunner({
        spawnProcess: fake.spawnProcess,
        killProcess: () => {},
        workspaceRoot: fixture.workspaceRoot,
        killGraceMs: 1,
      });
      await assert.rejects(
        runner({ jobId: `blocked-${name.replaceAll(" ", "-")}`, ownerId: OWNER, intent: "draft", prompt: "안전한 초안을 작성해." }),
        (error) => error instanceof CodexRunnerError && error.code === "codex_patch_blocked",
      );
    });
  }
});

test("any attempted local tool event fails closed", async (t) => {
  const fixture = await jobFixture("tool-event-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({
    intent: "inspect",
    actualChanges: 0,
    extraEvent: { type: "item.completed", item: { type: "command_execution", command: "security" } },
  });
  const runner = createCodexRunner({ spawnProcess: fake.spawnProcess, workspaceRoot: fixture.workspaceRoot, killGraceMs: 1 });
  await assert.rejects(
    runner({ jobId: "tool-event-job", ownerId: OWNER, intent: "inspect", prompt: "구조를 점검해." }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_forbidden_tool_event",
  );
});

test("benign plan progress is accepted and the final completed agent message wins", async (t) => {
  const fixture = await jobFixture("plan-event-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({
    intent: "inspect",
    actualChanges: 0,
    extraEvent: { type: "item.completed", item: { type: "plan_update", text: "검토 중" } },
  });
  const runner = createCodexRunner({ spawnProcess: fake.spawnProcess, workspaceRoot: fixture.workspaceRoot });
  const result = await runner({ jobId: "plan-event-job", ownerId: OWNER, intent: "inspect", prompt: "오류 경계를 점검해." });
  assert.equal(result.summary, "격리 복사본 점검을 완료했습니다.");
});

test("unknown item events fail closed with a stable code", async (t) => {
  const fixture = await jobFixture("unknown-event-job");
  t.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
  const fake = fakeSpawner({
    intent: "inspect",
    actualChanges: 0,
    extraEvent: { type: "item.completed", item: { type: "future_unrecognized_item" } },
  });
  const runner = createCodexRunner({ spawnProcess: fake.spawnProcess, workspaceRoot: fixture.workspaceRoot });
  await assert.rejects(
    runner({ jobId: "unknown-event-job", ownerId: OWNER, intent: "inspect", prompt: "점검해." }),
    (error) => error instanceof CodexRunnerError && error.code === "codex_unexpected_item_event",
  );
});

test("malformed item payloads and invalid JSONL lifecycle order fail closed", async (t) => {
  const cases = [
    ["missing-item", { type: "item.completed" }],
    ["null-item", { type: "item.completed", item: null }],
    ["missing-item-type", { type: "item.completed", item: {} }],
    ["premature-completion", { type: "turn.completed" }],
    ["duplicate-thread", { type: "thread.started", thread_id: "duplicate" }],
  ];
  for (const [name, extraEvent] of cases) {
    await t.test(name, async (subtest) => {
      const jobId = `lifecycle-${name}`;
      const fixture = await jobFixture(jobId);
      subtest.after(() => rm(fixture.workspaceRoot, { recursive: true, force: true }));
      const fake = fakeSpawner({ intent: "inspect", actualChanges: 0, extraEvent });
      const runner = createCodexRunner({ spawnProcess: fake.spawnProcess, workspaceRoot: fixture.workspaceRoot });
      await assert.rejects(
        runner({ jobId, ownerId: OWNER, intent: "inspect", prompt: "점검해." }),
        (error) => error instanceof CodexRunnerError && error.code === "codex_unexpected_item_event",
      );
    });
  }
});
