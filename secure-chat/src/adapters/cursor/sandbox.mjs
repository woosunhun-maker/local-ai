/**
 * Cursor 개발 작업 sandbox — 허용 root와 금지 경로를 강제한다.
 *
 * Self-development: writeRoots가 주어지면 해당 worktree만 쓰기 허용.
 * main repo는 read-only (writeRoots에 없을 때 쓰기 거부).
 */
import { realpath } from "node:fs/promises";
import path from "node:path";

export const CURSOR_PROJECT_ROOT = "/Users/hun/Documents/로컬ai";

export const CURSOR_FORBIDDEN_PREFIXES = Object.freeze([
  path.join(CURSOR_PROJECT_ROOT, "diol-os"),
  "/Users/hun/PrivateAI",
]);

function fail(code, statusCode = 403) {
  throw Object.assign(new Error(code), { statusCode });
}

export function isPathInsideRoot(candidate, root) {
  const normalizedRoot = path.resolve(root);
  const normalized = path.resolve(candidate);
  return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${path.sep}`);
}

/**
 * @param {string} candidate
 * @param {{
 *   projectRoot?: string,
 *   writeRoots?: string[]|null,
 *   mainRepo?: string|null,
 *   mainReadOnly?: boolean,
 *   forbiddenPrefixes?: string[],
 * }} options
 */
export function assertWritablePath(candidate, {
  projectRoot = CURSOR_PROJECT_ROOT,
  writeRoots = null,
  mainRepo = null,
  mainReadOnly = false,
  forbiddenPrefixes = CURSOR_FORBIDDEN_PREFIXES,
} = {}) {
  if (typeof candidate !== "string" || !candidate.trim()) fail("invalid_sandbox_path");
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(projectRoot, candidate);

  for (const prefix of forbiddenPrefixes) {
    const resolvedPrefix = path.resolve(prefix);
    if (isPathInsideRoot(absolute, resolvedPrefix) || absolute === resolvedPrefix) {
      fail("sandbox_forbidden_path");
    }
  }

  const roots = Array.isArray(writeRoots) && writeRoots.length > 0
    ? writeRoots.map((root) => path.resolve(root))
    : [path.resolve(projectRoot)];

  const insideWriteRoot = roots.some((root) => isPathInsideRoot(absolute, root));
  if (!insideWriteRoot) fail("sandbox_outside_write_root");

  // main read-only: writeRoots가 worktree만이면 main은 자동 거부.
  // 명시적 mainReadOnly + mainRepo가 writeRoots에 없으면 이중 확인.
  if (mainReadOnly && mainRepo) {
    const main = path.resolve(mainRepo);
    if (isPathInsideRoot(absolute, main) && !roots.some((root) => root === main || isPathInsideRoot(root, main) && root !== main)) {
      // path is under main AND not under a separate write root that is outside... 
      // Actually worktree is outside main. If absolute is under main, reject.
      const underDedicatedWorktree = roots.some((root) => root !== main && isPathInsideRoot(absolute, root));
      if (!underDedicatedWorktree && isPathInsideRoot(absolute, main)) {
        fail("sandbox_main_repo_read_only");
      }
    }
  }

  return absolute;
}

export async function assertWritablePathExistsOrParent(candidate, options = {}) {
  const absolute = assertWritablePath(candidate, options);
  try {
    return await realpath(absolute);
  } catch {
    const parent = path.dirname(absolute);
    const resolvedParent = await realpath(parent).catch(() => null);
    if (!resolvedParent) fail("sandbox_parent_missing");
    assertWritablePath(resolvedParent, options);
    return absolute;
  }
}

export function assertGitPathAllowed(relativePath, options = {}) {
  if (typeof relativePath !== "string") fail("invalid_git_path");
  if (relativePath.startsWith("/") || relativePath.includes("\0")) fail("invalid_git_path");
  if (relativePath.split(/[/\\]/u).includes("..")) fail("sandbox_path_escape");
  return assertWritablePath(relativePath, options);
}

export function filterForbiddenChangedPaths(paths, options = {}) {
  const allowed = [];
  const blocked = [];
  for (const entry of paths ?? []) {
    try {
      assertGitPathAllowed(entry, options);
      allowed.push(entry);
    } catch {
      blocked.push(entry);
    }
  }
  return Object.freeze({ allowed: Object.freeze(allowed), blocked: Object.freeze(blocked) });
}
