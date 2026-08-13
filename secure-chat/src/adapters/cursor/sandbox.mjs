/**
 * Cursor 개발 작업 sandbox — 허용 root와 금지 경로를 강제한다.
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

export function assertWritablePath(candidate, {
  projectRoot = CURSOR_PROJECT_ROOT,
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

  if (!isPathInsideRoot(absolute, projectRoot)) fail("sandbox_outside_project_root");
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
