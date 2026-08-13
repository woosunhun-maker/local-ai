/**
 * Workspace Isolator — self-development용 명시적 임시 write root (git worktree).
 * main repo는 기본 read-only. write allowlist에는 해당 run의 worktree만.
 */
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CURSOR_PROJECT_ROOT } from "../adapters/cursor/sandbox.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_WORKTREE_PARENT = "/Users/hun/Documents/로컬ai-worktrees";

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

export function worktreePathsForRun({
  runId,
  parent = DEFAULT_WORKTREE_PARENT,
  mainRepo = CURSOR_PROJECT_ROOT,
} = {}) {
  if (typeof runId !== "string" || runId.length < 8) fail("invalid_worktree_run_id");
  const safeId = runId.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 64);
  if (safeId.length < 8) fail("invalid_worktree_run_id");
  const worktreePath = path.join(parent, safeId);
  const branch = `local-ai/dev/${safeId}`;
  return Object.freeze({
    main_repo: path.resolve(mainRepo),
    worktree_path: path.resolve(worktreePath),
    branch,
    write_roots: Object.freeze([path.resolve(worktreePath)]),
    main_read_only: true,
  });
}

export async function createIsolatedWorktree({
  runId,
  parent = DEFAULT_WORKTREE_PARENT,
  mainRepo = CURSOR_PROJECT_ROOT,
  runGit = defaultRunGit,
} = {}) {
  const paths = worktreePathsForRun({ runId, parent, mainRepo });
  if (!paths.worktree_path.startsWith(path.resolve(parent))) fail("worktree_outside_parent", 403);
  if (paths.worktree_path === paths.main_repo || paths.worktree_path.startsWith(`${paths.main_repo}${path.sep}`)) {
    // worktree는 main working tree 내부가 아닌 별도 parent 아래여야 함
    fail("worktree_must_be_outside_main_workdir", 403);
  }

  await mkdir(parent, { recursive: true, mode: 0o700 });

  const add = await runGit([
    "worktree", "add", "-b", paths.branch, paths.worktree_path,
  ], { cwd: paths.main_repo });
  if (!add.ok) {
    // 브랜치가 이미 있으면 기존 브랜치로 추가 시도
    const retry = await runGit([
      "worktree", "add", paths.worktree_path, paths.branch,
    ], { cwd: paths.main_repo });
    if (!retry.ok) fail(`worktree_create_failed:${retry.stderr.slice(0, 200)}`, 500);
  }

  return Object.freeze({
    ...paths,
    created_at: new Date().toISOString(),
  });
}

export async function removeIsolatedWorktree({
  worktreePath,
  mainRepo = CURSOR_PROJECT_ROOT,
  runGit = defaultRunGit,
  force = false,
} = {}) {
  if (typeof worktreePath !== "string" || !worktreePath.startsWith("/")) fail("invalid_worktree_path");
  const args = force
    ? ["worktree", "remove", "--force", worktreePath]
    : ["worktree", "remove", worktreePath];
  const result = await runGit(args, { cwd: mainRepo });
  return Object.freeze({ ok: result.ok, stderr: result.stderr });
}

async function defaultRunGit(args, { cwd } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
        LANG: "C.UTF-8",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return Object.freeze({
      ok: true,
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      stdout: String(error?.stdout ?? ""),
      stderr: String(error?.stderr ?? error?.message ?? ""),
    });
  }
}
