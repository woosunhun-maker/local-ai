/**
 * Host Result Collector — tracked/untracked canonical change set + content hash.
 * empty diff를 실변경 증거로 쓰지 않는다. baseline delta로 task 변경만 보고한다.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { createEvidenceRecord } from "../../evidence/evidence.mjs";
import {
  CURSOR_PROJECT_ROOT,
  filterForbiddenChangedPaths,
} from "./sandbox.mjs";
import { evaluateWriteAuthorization } from "./write-authorization.mjs";

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

/** porcelain v1 한 줄 파싱 */
export function parsePorcelainLine(line) {
  if (typeof line !== "string" || line.length < 4) return null;
  const xy = line.slice(0, 2);
  let rest = line.slice(3);
  let pathFrom = null;
  let pathTo = rest;
  if (rest.includes(" -> ")) {
    const parts = rest.split(" -> ");
    pathFrom = parts[0];
    pathTo = parts[1];
  }
  let changeType = "modified";
  if (xy === "??") changeType = "untracked";
  else if (xy.includes("D") || xy === " D") changeType = "deleted";
  else if (xy.includes("R") || xy.includes("C")) changeType = "renamed";
  else if (xy.includes("A") || xy === "??") changeType = xy === "??" ? "untracked" : "added";
  return Object.freeze({
    xy,
    change_type: changeType,
    path: pathTo,
    path_from: pathFrom,
    raw: line,
  });
}

async function digestPathContent(cwd, relativePath, changeType) {
  if (changeType === "deleted") {
    return createHash("sha256").update(`deleted:${relativePath}`).digest("hex");
  }
  try {
    const absolute = path.join(cwd, relativePath);
    const body = await readFile(absolute);
    return createHash("sha256").update(body).digest("hex");
  } catch {
    return createHash("sha256").update(`missing:${relativePath}`).digest("hex");
  }
}

export async function captureGitBaseline({ cwd = CURSOR_PROJECT_ROOT } = {}) {
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  const entries = [];
  const paths = new Set();
  const pathDigests = {};
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parsePorcelainLine(line);
    if (!parsed) continue;
    entries.push(parsed);
    paths.add(parsed.path);
    if (parsed.path_from) paths.add(parsed.path_from);
    pathDigests[parsed.path] = await digestPathContent(cwd, parsed.path, parsed.change_type);
  }
  // clean tracked 파일은 포함하지 않음 — dirty/untracked만 baseline
  return Object.freeze({
    captured_at: new Date().toISOString(),
    git_status: status.stdout,
    entries: Object.freeze(entries),
    paths: Object.freeze([...paths].sort()),
    path_digests: Object.freeze(pathDigests),
  });
}

async function noIndexPatch(cwd, relativePath) {
  const absolute = path.join(cwd, relativePath);
  try {
    const { stdout } = await execFileAsync("git", [
      "diff", "--no-color", "--no-index", "--", "/dev/null", relativePath,
    ], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        LANG: "C.UTF-8",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return String(stdout ?? "");
  } catch (error) {
    // git diff --no-index returns exit 1 when differences exist
    const out = String(error?.stdout ?? "");
    if (out) return out;
    try {
      const body = await readFile(absolute, "utf8");
      return `diff --git a/${relativePath} b/${relativePath}\nnew file\n--- /dev/null\n+++ b/${relativePath}\n@@\n${body.split("\n").map((l) => `+${l}`).join("\n")}\n`;
    } catch {
      return `diff --git a/${relativePath} b/${relativePath}\nnew file (unreadable)\n`;
    }
  }
}

/**
 * tracked/untracked/deleted/renamed을 포함한 canonical change set.
 * empty tracked-diff만으로 hash를 만들지 않는다.
 */
export async function buildCanonicalChangeSet({
  cwd = CURSOR_PROJECT_ROOT,
  baseline = null,
  writeRoots = null,
  mainRepo = null,
  mainReadOnly = false,
} = {}) {
  const status = await runGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd });
  const trackedDiff = await runGit(["diff", "--no-color"], { cwd });
  const cachedDiff = await runGit(["diff", "--cached", "--no-color"], { cwd });

  const baselineDigests = baseline?.path_digests ?? {};
  const allEntries = [];
  for (const line of status.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parsed = parsePorcelainLine(line);
    if (parsed) allEntries.push(parsed);
  }

  const taskEntries = [];
  const preExisting = [];
  for (const entry of allEntries) {
    if (!baseline) {
      taskEntries.push(entry);
      continue;
    }
    const digest = await digestPathContent(cwd, entry.path, entry.change_type);
    const baselineDigest = baselineDigests[entry.path];
    if (baselineDigest && baselineDigest === digest) {
      preExisting.push(entry);
      continue;
    }
    taskEntries.push(entry);
  }

  const paths = taskEntries.map((e) => e.path);
  const filtered = filterForbiddenChangedPaths(paths, {
    projectRoot: cwd,
    writeRoots,
    mainRepo,
    mainReadOnly,
  });

  const patchParts = [];
  // tracked diff는 task 경로에 해당하는 hunk만 포함 (간단화: task에 tracked 변경이 있을 때만 전체 tracked diff 포함)
  const trackedCombined = `${trackedDiff.stdout}\n${cachedDiff.stdout}`.trim();
  const hasTaskTracked = taskEntries.some((e) => e.change_type !== "untracked");
  if (trackedCombined && hasTaskTracked) patchParts.push(trackedCombined);

  for (const entry of taskEntries) {
    if (!filtered.allowed.includes(entry.path)) continue;
    if (entry.change_type === "untracked" || entry.change_type === "added") {
      const patch = await noIndexPatch(cwd, entry.path);
      if (patch.trim()) patchParts.push(patch.trim());
    }
  }

  const canonicalPatch = patchParts.join("\n").trim();
  const hasContentChanges = canonicalPatch.length > 0 || taskEntries.some((e) => e.change_type === "deleted");

  let diffHash = null;
  let diffHashKind = "none";
  if (hasContentChanges && canonicalPatch.length > 0) {
    diffHash = createHash("sha256").update(canonicalPatch).digest("hex");
    diffHashKind = "canonical_patch";
  } else if (hasContentChanges && taskEntries.some((e) => e.change_type === "deleted")) {
    const deletionManifest = taskEntries
      .filter((e) => e.change_type === "deleted")
      .map((e) => e.path)
      .sort()
      .join("\n");
    diffHash = createHash("sha256").update(`deletions:\n${deletionManifest}`).digest("hex");
    diffHashKind = "deletion_manifest";
  } else if (taskEntries.length === 0) {
    diffHash = createHash("sha256").update("no_task_changes").digest("hex");
    diffHashKind = "no_task_changes";
  } else {
    // 상태만 있고 patch를 못 만든 경우 — empty를 증거로 쓰지 않음
    diffHash = null;
    diffHashKind = "unresolved";
  }

  return Object.freeze({
    git_status: status.stdout,
    git_diff: canonicalPatch,
    tracked_diff: trackedCombined,
    diff_hash: diffHash,
    diff_hash_kind: diffHashKind,
    has_content_changes: hasContentChanges,
    changed_files: filtered.allowed,
    blocked_files: filtered.blocked,
    task_entries: Object.freeze(taskEntries),
    pre_existing_entries: Object.freeze(preExisting),
    pre_existing_files: Object.freeze(preExisting.map((e) => e.path)),
  });
}

export async function collectHostGitSnapshot({
  cwd = CURSOR_PROJECT_ROOT,
  taskId = null,
  sessionId = null,
  baseline = null,
  writeRoots = null,
  mainRepo = null,
  mainReadOnly = false,
} = {}) {
  const changeSet = await buildCanonicalChangeSet({
    cwd,
    baseline,
    writeRoots,
    mainRepo,
    mainReadOnly,
  });

  const evidence = [];
  if (changeSet.diff_hash && changeSet.diff_hash_kind !== "unresolved") {
    evidence.push(createEvidenceRecord({
      epistemic: "VERIFIED",
      claim: `host.git.diff_hash=${changeSet.diff_hash}`,
      source: "host.git",
      taskId,
      detail: {
        diff_hash_kind: changeSet.diff_hash_kind,
        changed_file_count: changeSet.changed_files.length,
        blocked_file_count: changeSet.blocked_files.length,
        has_content_changes: changeSet.has_content_changes,
        pre_existing_file_count: changeSet.pre_existing_files.length,
      },
    }));
  } else if (changeSet.changed_files.length > 0) {
    evidence.push(createEvidenceRecord({
      epistemic: "UNKNOWN",
      claim: "host.git.diff_hash unresolved for task changes",
      source: "host.git",
      taskId,
      detail: {
        diff_hash_kind: changeSet.diff_hash_kind,
        changed_files: changeSet.changed_files,
      },
    }));
  } else {
    evidence.push(createEvidenceRecord({
      epistemic: "VERIFIED",
      claim: "host.git.no_task_content_changes",
      source: "host.git",
      taskId,
      detail: { diff_hash_kind: changeSet.diff_hash_kind },
    }));
  }

  if (changeSet.pre_existing_files.length > 0) {
    evidence.push(createEvidenceRecord({
      epistemic: "VERIFIED",
      claim: `host.git.pre_existing_unchanged_count=${changeSet.pre_existing_files.length}`,
      source: "host.git.baseline",
      taskId,
      detail: { pre_existing_files: changeSet.pre_existing_files.slice(0, 50) },
    }));
  }

  return Object.freeze({
    task_id: taskId,
    session_id: sessionId,
    git_status: changeSet.git_status,
    git_diff: changeSet.git_diff,
    diff_hash: changeSet.diff_hash,
    diff_hash_kind: changeSet.diff_hash_kind,
    has_content_changes: changeSet.has_content_changes,
    changed_files: changeSet.changed_files,
    blocked_files: changeSet.blocked_files,
    pre_existing_files: changeSet.pre_existing_files,
    evidence: Object.freeze(evidence),
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
          claim: "host.test.exit_code=0",
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
  baseline = null,
  permissionEvents = [],
  writeRoots = null,
  mainRepo = null,
  mainReadOnly = false,
  envelope = null,
} = {}) {
  if (typeof taskId !== "string" || !taskId) fail("invalid_task_id");

  const git = await collectHostGitSnapshot({
    cwd,
    taskId,
    sessionId,
    baseline,
    writeRoots,
    mainRepo,
    mainReadOnly,
  });
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

  // main tree 독립 검증: worktree 변경과 동일한 relative path가 main에서도 dirty인가
  const mainRepoWrites = [];
  if (mainReadOnly && mainRepo && git.has_content_changes) {
    for (const relative of git.changed_files) {
      const mainStatus = await runGit(["status", "--porcelain=v1", "--", relative], { cwd: mainRepo });
      if (mainStatus.stdout.trim()) mainRepoWrites.push(relative);
    }
  }

  const writeAuth = evaluateWriteAuthorization({
    hasContentChanges: git.has_content_changes,
    changedFiles: git.changed_files,
    blockedFiles: git.blocked_files,
    mainRepoWrites,
    writeRoots: writeRoots ?? (envelope?.worktree_path ? [envelope.worktree_path] : null),
    mainRepo,
    mainReadOnly,
    envelope,
    permissionEvents,
  });

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

  if (writeAuth.write_authorization_verified) {
    evidence.push(createEvidenceRecord({
      epistemic: "VERIFIED",
      claim: `cursor.write_authorization_verified kind=${writeAuth.kind}`,
      source: "host.write_authorization",
      taskId,
      detail: {
        kind: writeAuth.kind,
        reason: writeAuth.reason,
        acp_write_observed: writeAuth.acp_write_observed,
        envelope_authorized_write: writeAuth.envelope_authorized_write,
      },
    }));
  } else if (git.has_content_changes) {
    evidence.push(createEvidenceRecord({
      epistemic: "UNKNOWN",
      claim: `cursor.write_authorization_unverified reason=${writeAuth.reason}`,
      source: "host.write_authorization",
      taskId,
      detail: {
        kind: writeAuth.kind,
        reason: writeAuth.reason,
        note: "ACP WRITE event is optional; envelope scope host verification failed or missing",
      },
    }));
  }

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
    pre_existing_files: git.pre_existing_files,
    main_repo_writes: Object.freeze(mainRepoWrites),
    git_status: git.git_status,
    git_diff: git.git_diff,
    diff_hash: git.diff_hash,
    diff_hash_kind: git.diff_hash_kind,
    has_content_changes: git.has_content_changes,
    // 하위 호환: ACP WRITE 관측 여부 (필수 불변조건 아님)
    write_path_observed: writeAuth.acp_write_observed,
    write_authorization: writeAuth,
    write_authorization_verified: writeAuth.write_authorization_verified,
    test_command: test?.command ?? null,
    test_exit_code: test?.exit_code ?? null,
    evidence: Object.freeze(evidence),
  });
}
