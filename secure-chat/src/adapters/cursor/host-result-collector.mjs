/**
 * Host Result Collector — Cursor 자연어가 아닌 filesystem/git/test 관측.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createEvidenceRecord } from "../../evidence/evidence.mjs";
import {
  CURSOR_PROJECT_ROOT,
  filterForbiddenChangedPaths,
} from "./sandbox.mjs";

const execFileAsync = promisify(execFile);

function fail(code, statusCode = 500) {
  throw Object.assign(new Error(code), { statusCode });
}

const DEFAULT_TEST_ALLOWLIST = Object.freeze([
  /^npm test(?:\s|$)/u,
  /^npm run test(?:\s|$)/u,
  /^node --test(?:\s|$)/u,
]);

export async function runGit(args, { cwd = CURSOR_PROJECT_ROOT } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return Object.freeze({
      ok: true,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      exitCode: 0,
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? ""),
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
    });
  }
}

export async function collectHostGitSnapshot({
  cwd = CURSOR_PROJECT_ROOT,
  taskId = null,
  sessionId = null,
} = {}) {
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  const diff = await runGit(["diff", "--no-color"], { cwd });
  const diffCached = await runGit(["diff", "--cached", "--no-color"], { cwd });
  const combinedDiff = `${diff.stdout}\n${diffCached.stdout}`.trim();
  const diffHash = createHash("sha256").update(combinedDiff || "empty").digest("hex");

  const changed = [];
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const pathPart = line.slice(3).trim();
    if (pathPart) changed.push(pathPart.includes(" -> ") ? pathPart.split(" -> ").pop() : pathPart);
  }
  const filtered = filterForbiddenChangedPaths(changed);

  return Object.freeze({
    task_id: taskId,
    session_id: sessionId,
    git_status: status.stdout,
    git_diff: combinedDiff,
    diff_hash: diffHash,
    changed_files: filtered.allowed,
    blocked_files: filtered.blocked,
    evidence: Object.freeze([
      createEvidenceRecord({
        epistemic: "VERIFIED",
        claim: `host.git.diff_hash=${diffHash}`,
        source: "host.git",
        taskId,
        detail: {
          changed_file_count: filtered.allowed.length,
          blocked_file_count: filtered.blocked.length,
          status_exit: status.exitCode,
          diff_exit: diff.exitCode,
        },
      }),
    ]),
  });
}

export async function runAllowlistedTest({
  command,
  cwd = CURSOR_PROJECT_ROOT,
  allowlist = DEFAULT_TEST_ALLOWLIST,
  taskId = null,
} = {}) {
  if (typeof command !== "string" || !command.trim()) fail("invalid_test_command");
  const trimmed = command.trim();
  if (!allowlist.some((re) => re.test(trimmed))) fail("test_command_not_allowlisted", 403);

  const shell = "/bin/bash";
  try {
    const { stdout, stderr } = await execFileAsync(shell, ["-lc", trimmed], {
      cwd,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/bin:/bin`,
      },
    });
    return Object.freeze({
      command: trimmed,
      exit_code: 0,
      ok: true,
      stdout: String(stdout ?? "").slice(0, 20_000),
      stderr: String(stderr ?? "").slice(0, 5_000),
      evidence: Object.freeze([
        createEvidenceRecord({
          epistemic: "VERIFIED",
          claim: `host.test.exit_code=0`,
          source: "host.test",
          taskId,
          detail: { command: trimmed, exit_code: 0 },
        }),
      ]),
    });
  } catch (error) {
    const exitCode = Number.isInteger(error?.code) ? error.code : 1;
    return Object.freeze({
      command: trimmed,
      exit_code: exitCode,
      ok: false,
      stdout: String(error?.stdout ?? "").slice(0, 20_000),
      stderr: String(error?.stderr ?? error?.message ?? "").slice(0, 5_000),
      evidence: Object.freeze([
        createEvidenceRecord({
          epistemic: "VERIFIED",
          claim: `host.test.exit_code=${exitCode}`,
          source: "host.test",
          taskId,
          detail: { command: trimmed, exit_code: exitCode },
        }),
      ]),
    });
  }
}

/**
 * ACP 세션 메타 + host git/test를 한 묶음으로 수집.
 */
export async function collectCursorHostResult({
  taskId,
  sessionId,
  startedAt,
  finishedAt = new Date().toISOString(),
  stopReason = null,
  exitCode = null,
  error = null,
  cancelled = false,
  testCommand = null,
  cwd = CURSOR_PROJECT_ROOT,
} = {}) {
  if (typeof taskId !== "string" || !taskId) fail("invalid_task_id");

  const git = await collectHostGitSnapshot({ cwd, taskId, sessionId });
  let test = null;
  if (typeof testCommand === "string" && testCommand.trim()) {
    test = await runAllowlistedTest({ command: testCommand, cwd, taskId });
  }

  const status = cancelled
    ? "cancelled"
    : error
      ? "error"
      : stopReason
        ? `stop:${stopReason}`
        : exitCode === 0 || exitCode === null
          ? "completed"
          : `exit:${exitCode}`;

  const evidence = [
    createEvidenceRecord({
      epistemic: "VERIFIED",
      claim: `cursor.session.status=${status}`,
      source: "cursor.acp",
      taskId,
      detail: {
        session_id: sessionId,
        started_at: startedAt,
        finished_at: finishedAt,
        stop_reason: stopReason,
        exit_code: exitCode,
        cancelled,
        error: error ? String(error).slice(0, 300) : null,
      },
    }),
    ...git.evidence,
  ];
  if (test) evidence.push(...test.evidence);

  return Object.freeze({
    task_id: taskId,
    session_id: sessionId,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    stop_reason: stopReason,
    exit_code: exitCode,
    error: error ? String(error).slice(0, 500) : null,
    cancelled: cancelled === true,
    changed_files: git.changed_files,
    blocked_files: git.blocked_files,
    git_status: git.git_status,
    git_diff: git.git_diff,
    diff_hash: git.diff_hash,
    test_command: test?.command ?? null,
    test_exit_code: test?.exit_code ?? null,
    evidence: Object.freeze(evidence),
  });
}
