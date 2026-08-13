import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as FS_CONSTANTS } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { credentialFindingCodes } from "../security/credential-patterns.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_CODEX_WORKSPACE_ROOT = "/Users/Shared/LocalAI-Codex-Workspace";
export const SYNTHETIC_OWNER_ID = "900000000000000001";
export const SYNTHETIC_USER_HOME = "/Users/localai-synthetic";
export const SYNTHETIC_HOME_ASSISTANT_HOST = "homeassistant.invalid";
export const SYNTHETIC_TAILNET_HOST = "localai-mac.synthetic.invalid";
export const SYNTHETIC_APPLE_TEAM_ID = "LOCALAI000";
export const SYNTHETIC_BUNDLE_IDENTIFIER_PREFIX = "com.localai.synthetic";
export const SYNTHETIC_GIT_NAME = "LocalAI Synthetic Worker";
export const SYNTHETIC_GIT_EMAIL = "localai-synthetic@example.invalid";

const PRIVATE_TAILNET_HOST = "macstudio.tail4ad006.ts.net";
const PRIVATE_APPLE_TEAM_ID = "8UUD85JPJ2";
const PRIVATE_BUNDLE_IDENTIFIER_PREFIX = "com.hun.localai";

const GIT_BINARY = "/usr/bin/git";
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const OWNER_ID = /^[1-9][0-9]{5,19}$/u;
const MAX_SOURCE_FILES = 4_096;
const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_SNAPSHOT_BYTES = 352 * 1024;
export const DEFAULT_MAX_SNAPSHOT_FILES = 48;
const SOURCE_ALLOWED_ROOT_DIRECTORIES = new Set(["ios", "public", "scripts", "src", "test"]);
const SOURCE_ALLOWED_ROOT_FILES = new Set(["README.md", "package.json"]);

const SNAPSHOT_QUERY_ALIASES = Object.freeze(new Map([
  ["서버", ["server", "http", "request", "response", "route"]],
  ["오류", ["error", "exception", "failure", "failed", "throw", "catch"]],
  ["에러", ["error", "exception", "failure", "failed", "throw", "catch"]],
  ["실패", ["error", "failure", "failed", "exception", "throw", "catch"]],
  ["처리", ["handler", "handling", "process", "lifecycle"]],
  ["경계", ["boundary", "timeout", "abort", "lifecycle"]],
  ["인증", ["auth", "authentication", "session", "token"]],
  ["승인", ["approval", "approve", "signature", "plan"]],
  ["텔레그램", ["telegram", "bot", "message"]],
  ["아이폰", ["ios", "swift", "iphone", "app"]],
  ["앱", ["app", "ios", "swift", "view"]],
  ["기억", ["memory", "store", "recall"]],
  ["음성", ["speech", "audio", "tts", "transcription"]],
  ["배포", ["deploy", "release", "launchagent", "runtime"]],
  ["보안", ["security", "privacy", "credential", "dlp", "policy"]],
]));

const SNAPSHOT_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "only",
  "코드", "현재", "읽기", "전용", "점검", "해줘", "해주세요", "있는", "없는",
]);

const ALLOWED_TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".css", ".csv", ".entitlements",
  ".h", ".hpp", ".htm", ".html", ".java", ".js", ".json", ".jsx", ".kt",
  ".kts", ".md", ".mjs", ".mm", ".pbxproj", ".plist", ".properties", ".py",
  ".rb", ".rs", ".sb", ".sh", ".sql", ".swift", ".text", ".toml", ".ts",
  ".tsx", ".txt", ".webmanifest", ".xcconfig", ".xcworkspacedata", ".xcscheme",
  ".xml", ".yaml", ".yml", ".zsh",
]);

const ALLOWED_EXTENSIONLESS_FILES = new Set([
  "brewfile", "dockerfile", "gemfile", "license", "makefile",
  "notice", "procfile", "readme", "rakefile", "security", "yarn.lock",
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".build", ".codex", ".git", ".gradle", ".idea", ".next", ".swiftpm",
  ".venv", "__pycache__", "build", "deriveddata", "dist", "node_modules",
  "xcuserdata",
]);

const EXCLUDED_FILE_EXTENSIONS = new Set([
  ".a", ".app", ".bin", ".class", ".dmg", ".dylib", ".gif", ".gz", ".heic",
  ".ico", ".jar", ".jpeg", ".jpg", ".jsonl", ".lockb", ".log", ".mov",
  ".mp3", ".mp4", ".ndjson", ".o", ".out", ".pdf", ".pid", ".png",
  ".pyc", ".sqlite", ".sqlite3", ".sock", ".tar", ".tiff", ".wav", ".xcarchive",
  ".xcuserstate", ".zip",
]);

const PERSONAL_DATA_PATTERNS = Object.freeze([
  Object.freeze({ code: "email", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu }),
  Object.freeze({ code: "resident_identifier", expression: /\b[0-9]{6}[- ]?[1-4][0-9]{6}\b/gu }),
]);

const SYNTHETIC_PERSONAL_VALUES = new Set([
  "900101-1234567",
]);

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function validateExpectedManifest(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new IsolatedWorkspaceError("source_manifest_invalid");
  }
  return value;
}

function validateExpectedFileCount(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SOURCE_FILES) {
    throw new IsolatedWorkspaceError("source_manifest_invalid");
  }
  return value;
}

function validateExpectedTotalBytes(value) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SOURCE_TOTAL_BYTES) {
    throw new IsolatedWorkspaceError("source_manifest_invalid");
  }
  return value;
}

function sourceManifest(entries, totalBytes) {
  const normalized = entries
    .map((entry) => ({ path: entry.path.split(path.sep).join("/"), sha256: entry.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  for (const entry of normalized) {
    assertAllowedIsolatedRelativePath(entry.path);
    if (!/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new IsolatedWorkspaceError("source_manifest_invalid");
  }
  const canonical = JSON.stringify(normalized);
  return Object.freeze({
    sha256: createHash("sha256").update(canonical).digest("hex"),
    fileCount: normalized.length,
    totalBytes,
  });
}

function manifestFromCollected(files, totalBytes) {
  return sourceManifest(files.map((file) => ({
    path: file.relativePath,
    sha256: createHash("sha256").update(file.text, "utf8").digest("hex"),
  })), totalBytes);
}

function manifestFromScan(scan) {
  return sourceManifest(
    [...scan.hashes.entries()].map(([relativePath, sha256]) => ({ path: relativePath, sha256 })),
    scan.totalBytes,
  );
}

function assertManifestMatches(actual, expected, expectedFileCount = null, expectedTotalBytes = null) {
  const normalizedExpected = validateExpectedManifest(expected);
  const normalizedFileCount = validateExpectedFileCount(expectedFileCount);
  const normalizedTotalBytes = validateExpectedTotalBytes(expectedTotalBytes);
  if (
    (normalizedExpected !== null && actual.sha256 !== normalizedExpected) ||
    (normalizedFileCount !== null && actual.fileCount !== normalizedFileCount) ||
    (normalizedTotalBytes !== null && actual.totalBytes !== normalizedTotalBytes)
  ) {
    throw new IsolatedWorkspaceError("source_manifest_mismatch");
  }
  return actual;
}

function isSyntheticFinding(code, value) {
  if (SYNTHETIC_PERSONAL_VALUES.has(value)) return true;
  if (code === "email") {
    const domain = value.toLowerCase().split("@").at(-1);
    return domain === "example.com" || domain === "example.invalid" || domain === "example.test";
  }
  return false;
}

function finding(code, relativePath) {
  return Object.freeze({ code, path: relativePath });
}

function assertAbsoluteDirectoryRoot(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new IsolatedWorkspaceError(`${label}_invalid`);
  }
}

function ensureInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".") return;
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new IsolatedWorkspaceError("workspace_path_escape");
  }
}

function isExcludedDirectory(name) {
  const lower = name.toLowerCase();
  return lower === ".env" || lower.startsWith(".env.") || EXCLUDED_DIRECTORY_NAMES.has(lower);
}

function isExcludedFile(name) {
  const lower = name.toLowerCase();
  if (lower === "agents.md" || lower === "agents.override.md") return true;
  if (lower === ".gitattributes" || lower === ".gitmodules") return true;
  if (lower === ".env" || lower.startsWith(".env.")) return true;
  if (lower === ".ds_store" || lower.endsWith(".db") || lower.endsWith(".db-shm") || lower.endsWith(".db-wal")) return true;
  return EXCLUDED_FILE_EXTENSIONS.has(path.extname(lower));
}

function isAllowedTextFile(name) {
  const lower = name.toLowerCase();
  if (isExcludedFile(lower)) return false;
  if (ALLOWED_TEXT_EXTENSIONS.has(path.extname(lower))) return true;
  return ALLOWED_EXTENSIONLESS_FILES.has(lower);
}

function isAllowedSourceRelativePath(relativePath) {
  const segments = relativePath.split("/");
  if (segments.length === 1) return SOURCE_ALLOWED_ROOT_FILES.has(relativePath);
  if (!SOURCE_ALLOWED_ROOT_DIRECTORIES.has(segments[0])) return false;
  if (path.posix.extname(segments.at(-1).toLowerCase()) === ".md") return false;
  return isAllowedTextFile(segments.at(-1));
}

export function assertAllowedIsolatedRelativePath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length < 1 || relativePath !== relativePath.normalize("NFC")) {
    throw new IsolatedWorkspaceError("relative_path_invalid");
  }
  if (relativePath.includes("\\") || path.posix.isAbsolute(relativePath) || path.posix.normalize(relativePath) !== relativePath) {
    throw new IsolatedWorkspaceError("relative_path_invalid");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new IsolatedWorkspaceError("relative_path_invalid");
  }
  if (segments.slice(0, -1).some((segment) => isExcludedDirectory(segment))) {
    throw new IsolatedWorkspaceError("relative_path_blocked");
  }
  if (!isAllowedSourceRelativePath(relativePath)) throw new IsolatedWorkspaceError("relative_path_blocked");
  return true;
}

function decodeText(buffer, relativePath) {
  if (buffer.includes(0)) throw new IsolatedWorkspaceError("non_text_source", [finding("nul_byte", relativePath)]);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new IsolatedWorkspaceError("non_text_source", [finding("invalid_utf8", relativePath)]);
  }
}

export class IsolatedWorkspaceError extends Error {
  constructor(code, findings = []) {
    super(code);
    this.name = "IsolatedWorkspaceError";
    this.code = code;
    this.findings = Object.freeze([...findings]);
  }
}

export function sanitizeCodexText(text, { ownerId } = {}) {
  if (typeof text !== "string") throw new IsolatedWorkspaceError("text_required");
  if (!OWNER_ID.test(String(ownerId ?? ""))) throw new IsolatedWorkspaceError("owner_id_invalid");
  const owner = String(ownerId);
  const scrubOwner = owner !== SYNTHETIC_OWNER_ID;
  const replacements = Object.freeze({
    ownerId: scrubOwner ? countOccurrences(text, owner) : 0,
    userHome: countOccurrences(text, "/Users/hun"),
    homeAssistantHost: countOccurrences(text.toLowerCase(), "homeassistant.local"),
    tailnetHost: countOccurrences(text.toLowerCase(), PRIVATE_TAILNET_HOST),
    appleTeamId: countOccurrences(text, PRIVATE_APPLE_TEAM_ID),
    bundleIdentifier: countOccurrences(text, PRIVATE_BUNDLE_IDENTIFIER_PREFIX),
  });
  const sanitized = (scrubOwner ? text.split(owner).join(SYNTHETIC_OWNER_ID) : text)
    .split("/Users/hun").join(SYNTHETIC_USER_HOME)
    .replace(/homeassistant\.local/giu, SYNTHETIC_HOME_ASSISTANT_HOST)
    .replace(/macstudio\.tail4ad006\.ts\.net/giu, SYNTHETIC_TAILNET_HOST)
    .split(PRIVATE_APPLE_TEAM_ID).join(SYNTHETIC_APPLE_TEAM_ID)
    .split(PRIVATE_BUNDLE_IDENTIFIER_PREFIX).join(SYNTHETIC_BUNDLE_IDENTIFIER_PREFIX);
  return Object.freeze({ text: sanitized, replacements });
}

export function inspectCodexText(text, { ownerId, relativePath = "$" } = {}) {
  if (typeof text !== "string") return Object.freeze({ ok: false, findings: Object.freeze([finding("text_required", relativePath)]) });
  const findings = [];
  if (ownerId && String(ownerId) !== SYNTHETIC_OWNER_ID && text.includes(String(ownerId))) {
    findings.push(finding("owner_identifier", relativePath));
  }
  if (text.includes("/Users/hun")) findings.push(finding("owner_home_path", relativePath));
  if (/homeassistant\.local/iu.test(text)) findings.push(finding("private_home_assistant_host", relativePath));
  if (/macstudio\.tail4ad006\.ts\.net/iu.test(text)) findings.push(finding("private_tailnet_host", relativePath));
  if (text.includes(PRIVATE_APPLE_TEAM_ID)) findings.push(finding("private_apple_team_id", relativePath));
  if (text.includes(PRIVATE_BUNDLE_IDENTIFIER_PREFIX)) findings.push(finding("private_bundle_identifier", relativePath));
  for (const code of credentialFindingCodes(text, { allowSynthetic: true, allowCodeReferences: true })) {
    findings.push(finding(code, relativePath));
  }
  for (const { code, expression } of PERSONAL_DATA_PATTERNS) {
    expression.lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      const value = match[0];
      if (!isSyntheticFinding(code, value)) findings.push(finding(code, relativePath));
    }
  }
  return Object.freeze({ ok: findings.length === 0, findings: Object.freeze(findings) });
}

export function assertCodexTextSafe(text, options = {}) {
  const inspection = inspectCodexText(text, options);
  if (!inspection.ok) throw new IsolatedWorkspaceError("dlp_blocked", inspection.findings);
  return true;
}

async function readSafeSourceFile(sourcePath, relativePath, limits) {
  let handle;
  try {
    handle = await open(sourcePath, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return null;
    if (info.nlink !== 1) throw new IsolatedWorkspaceError("source_hardlink_blocked", [finding("hardlink", relativePath)]);
    if (info.size > limits.maxFileBytes) {
      throw new IsolatedWorkspaceError("source_limit_exceeded", [finding("file_too_large", relativePath)]);
    }
    const buffer = await handle.readFile();
    const after = await handle.stat();
    if (buffer.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      throw new IsolatedWorkspaceError("source_changed_during_copy");
    }
    return decodeText(buffer, relativePath);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new IsolatedWorkspaceError("source_symlink_blocked", [finding("symlink", relativePath)]);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function collectSourceFiles(sourceRoot, options) {
  const files = [];
  let totalBytes = 0;
  async function walk(relativeDirectory) {
    const absoluteDirectory = relativeDirectory ? path.join(sourceRoot, relativeDirectory) : sourceRoot;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      if (
        relativeDirectory === "" &&
        !SOURCE_ALLOWED_ROOT_DIRECTORIES.has(entry.name) &&
        !SOURCE_ALLOWED_ROOT_FILES.has(entry.name)
      ) continue;
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      const absolutePath = path.join(sourceRoot, relativePath);
      ensureInside(sourceRoot, absolutePath);
      if (entry.isSymbolicLink()) {
        throw new IsolatedWorkspaceError("source_symlink_blocked", [finding("symlink", relativePath)]);
      }
      if (entry.isDirectory()) {
        if (!isExcludedDirectory(entry.name)) await walk(relativePath);
        continue;
      }
      if (!entry.isFile() || !isAllowedTextFile(entry.name)) continue;
      const normalizedRelativePath = relativePath.split(path.sep).join("/");
      if (!isAllowedSourceRelativePath(normalizedRelativePath)) continue;
      const text = await readSafeSourceFile(absolutePath, relativePath, options);
      if (text === null) continue;
      const sanitized = sanitizeCodexText(text, { ownerId: options.ownerId });
      assertCodexTextSafe(sanitized.text, { ownerId: options.ownerId, relativePath });
      const byteLength = Buffer.byteLength(sanitized.text, "utf8");
      totalBytes += byteLength;
      if (files.length + 1 > options.maxFiles || totalBytes > options.maxTotalBytes) {
        throw new IsolatedWorkspaceError("source_limit_exceeded");
      }
      files.push(Object.freeze({ relativePath, text: sanitized.text, byteLength, replacements: sanitized.replacements }));
    }
  }
  await walk("");
  return Object.freeze({ files: Object.freeze(files), totalBytes });
}

export async function buildSanitizedSourceManifest(sourceRoot, {
  ownerId,
  maxFiles = MAX_SOURCE_FILES,
  maxFileBytes = MAX_SOURCE_FILE_BYTES,
  maxTotalBytes = MAX_SOURCE_TOTAL_BYTES,
} = {}) {
  if (!OWNER_ID.test(String(ownerId ?? ""))) throw new IsolatedWorkspaceError("owner_id_invalid");
  assertAbsoluteDirectoryRoot(sourceRoot, "source_root");
  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new IsolatedWorkspaceError("source_root_invalid");
  const canonicalSourceRoot = await realpath(sourceRoot);
  if (canonicalSourceRoot !== sourceRoot) throw new IsolatedWorkspaceError("source_root_invalid");
  const collected = await collectSourceFiles(canonicalSourceRoot, {
    ownerId: String(ownerId), maxFiles, maxFileBytes, maxTotalBytes,
  });
  return manifestFromCollected(collected.files, collected.totalBytes);
}

async function writeCollectedFiles(repoDir, files) {
  for (const file of files) {
    const destination = path.join(repoDir, file.relativePath);
    ensureInside(repoDir, destination);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
}

async function runGit(gitRun, args, cwd) {
  try {
    return await gitRun(GIT_BINARY, args, {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 64 * 1024,
      shell: false,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: "/var/empty",
        LANG: "C.UTF-8",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  } catch {
    throw new IsolatedWorkspaceError("git_baseline_failed");
  }
}

async function initializeSyntheticGit(repoDir, gitRun) {
  await runGit(gitRun, ["init", "--quiet", "--initial-branch=main", "--template="], repoDir);
  await runGit(gitRun, ["-c", "core.hooksPath=/dev/null", "add", "--all"], repoDir);
  await runGit(gitRun, [
    "-c", `user.name=${SYNTHETIC_GIT_NAME}`,
    "-c", `user.email=${SYNTHETIC_GIT_EMAIL}`,
    "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null",
    "commit", "--quiet", "--no-verify", "--allow-empty", "-m", "Synthetic isolated baseline",
  ], repoDir);
  const status = await runGit(gitRun, ["status", "--porcelain=v1", "--untracked-files=all"], repoDir);
  if (String(status.stdout ?? "").length !== 0) throw new IsolatedWorkspaceError("git_baseline_not_clean");
}

async function scanRepositoryDirectory(repoDir, relativeDirectory, options, state) {
  const absoluteDirectory = relativeDirectory ? path.join(repoDir, relativeDirectory) : repoDir;
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const absolutePath = path.join(repoDir, relativePath);
    ensureInside(repoDir, absolutePath);
    if (relativePath === ".git" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.isSymbolicLink()) throw new IsolatedWorkspaceError("repository_scan_blocked", [finding("symlink", relativePath)]);
    if (entry.isDirectory()) {
      if (isExcludedDirectory(entry.name)) {
        throw new IsolatedWorkspaceError("repository_scan_blocked", [finding("excluded_directory", relativePath)]);
      }
      await scanRepositoryDirectory(repoDir, relativePath, options, state);
      continue;
    }
    if (!entry.isFile() || !isAllowedTextFile(entry.name)) {
      throw new IsolatedWorkspaceError("repository_scan_blocked", [finding("non_allowlisted_file", relativePath)]);
    }
    try {
      assertAllowedIsolatedRelativePath(relativePath.split(path.sep).join("/"));
    } catch {
      throw new IsolatedWorkspaceError("repository_scan_blocked", [finding("non_allowlisted_path", relativePath)]);
    }
    const text = await readSafeSourceFile(absolutePath, relativePath, options);
    if (text === null) throw new IsolatedWorkspaceError("repository_scan_blocked", [finding("non_regular_file", relativePath)]);
    assertCodexTextSafe(text, { ownerId: options.ownerId, relativePath });
    const bytes = Buffer.byteLength(text, "utf8");
    state.totalBytes += bytes;
    state.fileCount += 1;
    if (state.fileCount > options.maxFiles || state.totalBytes > options.maxTotalBytes) {
      throw new IsolatedWorkspaceError("source_limit_exceeded");
    }
    state.hashes.set(relativePath, createHash("sha256").update(text, "utf8").digest("hex"));
  }
}

export async function scanIsolatedRepository(repoDir, {
  ownerId,
  maxFiles = MAX_SOURCE_FILES,
  maxFileBytes = MAX_SOURCE_FILE_BYTES,
  maxTotalBytes = MAX_SOURCE_TOTAL_BYTES,
} = {}) {
  assertAbsoluteDirectoryRoot(repoDir, "repo_dir");
  if (!OWNER_ID.test(String(ownerId ?? ""))) throw new IsolatedWorkspaceError("owner_id_invalid");
  const info = await lstat(repoDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new IsolatedWorkspaceError("repo_dir_invalid");
  const state = { fileCount: 0, totalBytes: 0, hashes: new Map() };
  await scanRepositoryDirectory(repoDir, "", { ownerId: String(ownerId), maxFiles, maxFileBytes, maxTotalBytes }, state);
  return Object.freeze({
    fileCount: state.fileCount,
    totalBytes: state.totalBytes,
    hashes: new Map(state.hashes),
  });
}

export async function buildIsolatedRepositoryManifest(repoDir, options = {}) {
  return manifestFromScan(await scanIsolatedRepository(repoDir, options));
}

function compareUtf8Path(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function snapshotQueryTerms(selectionPrompt) {
  const normalized = String(selectionPrompt ?? "").normalize("NFKC").toLowerCase();
  const terms = new Set();
  for (const match of normalized.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_.-]{1,63}/gu)) {
    for (const part of match[0].split(/[_.-]+/u)) {
      if (part.length >= 2 && !SNAPSHOT_STOP_WORDS.has(part)) terms.add(part);
    }
  }
  for (const [needle, aliases] of SNAPSHOT_QUERY_ALIASES) {
    if (!normalized.includes(needle)) continue;
    terms.add(needle);
    for (const alias of aliases) terms.add(alias);
  }
  return Object.freeze({ normalized, terms: Object.freeze([...terms].sort(compareUtf8Path)) });
}

export function extractStaticRelativeImports(relativePath, content, availablePaths = new Set()) {
  const dependencies = new Set();
  const directory = path.posix.dirname(relativePath);
  const source = String(content);
  const specifiers = [];
  const expressions = [
    /^\s*import\b[^;"']{0,4096}?(?:\bfrom\s*)?["'](\.[^"']+)["']/gmu,
    /^\s*export\b[^;]{0,4096}?\bfrom\s*["'](\.[^"']+)["']/gmu,
  ];
  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) specifiers.push(match[1]);
  }
  for (const specifier of specifiers) {
    const normalized = path.posix.normalize(path.posix.join(directory, specifier));
    if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) continue;
    const candidates = path.posix.extname(normalized)
      ? [normalized]
      : [normalized, `${normalized}.mjs`, `${normalized}.js`, `${normalized}.ts`, `${normalized}/index.mjs`, `${normalized}/index.js`, `${normalized}/index.ts`];
    const resolved = candidates.find((candidate) => availablePaths.has(candidate));
    if (resolved) dependencies.add(resolved);
  }
  return Object.freeze([...dependencies].sort(compareUtf8Path));
}

function relevanceScore(file, query) {
  const relativePath = file.path.toLowerCase();
  const content = file.content.toLowerCase();
  let score = relativePath.startsWith("src/") ? 40
    : relativePath.startsWith("test/") ? 24
      : relativePath.startsWith("scripts/") ? 18
        : relativePath.startsWith("ios/") ? 12 : 4;
  if (relativePath === "package.json") score += 20;
  for (const term of query.terms) {
    if (relativePath.includes(term)) score += 160;
    let offset = 0;
    let matches = 0;
    while (matches < 6 && (offset = content.indexOf(term, offset)) !== -1) {
      score += 3;
      matches += 1;
      offset += term.length;
    }
  }
  return score;
}

export function selectRelevantRepositoryFiles(files, {
  selectionPrompt = "",
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
  maxSnapshotFiles = DEFAULT_MAX_SNAPSHOT_FILES,
} = {}) {
  if (!Array.isArray(files) || files.length < 1) throw new IsolatedWorkspaceError("snapshot_empty");
  if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 2 || maxSnapshotBytes > MAX_SOURCE_TOTAL_BYTES) {
    throw new IsolatedWorkspaceError("snapshot_limit_invalid");
  }
  if (!Number.isSafeInteger(maxSnapshotFiles) || maxSnapshotFiles < 1 || maxSnapshotFiles > DEFAULT_MAX_SNAPSHOT_FILES) {
    throw new IsolatedWorkspaceError("snapshot_limit_invalid");
  }
  const orderedFiles = [...files].sort((left, right) => compareUtf8Path(left.path, right.path));
  const completeSnapshot = JSON.stringify(orderedFiles);
  if (orderedFiles.length <= maxSnapshotFiles && Buffer.byteLength(completeSnapshot, "utf8") <= maxSnapshotBytes) {
    return Object.freeze({ files: Object.freeze(orderedFiles), json: completeSnapshot });
  }

  const query = snapshotQueryTerms(selectionPrompt);
  const byPath = new Map(orderedFiles.map((file) => [file.path, file]));
  const availablePaths = new Set(byPath.keys());
  const priority = new Map();
  const setPriority = (relativePath, value) => {
    if (byPath.has(relativePath)) priority.set(relativePath, Math.max(priority.get(relativePath) ?? 0, value));
  };

  const serverBoundaryProfile = /(?:서버|server)/u.test(query.normalized)
    && /(?:오류|에러|실패|예외|경계|error|exception|fail|boundary)/u.test(query.normalized);
  if (serverBoundaryProfile && byPath.has("src/server.mjs")) {
    setPriority("src/server.mjs", 100_000);
    setPriority("package.json", 95_000);
    const dependencies = extractStaticRelativeImports("src/server.mjs", byPath.get("src/server.mjs").content, availablePaths);
    for (const dependency of dependencies) setPriority(dependency, 90_000);
    const dependencyNeedles = ["src/server.mjs", ...dependencies]
      .flatMap((relativePath) => [relativePath, path.posix.basename(relativePath, path.posix.extname(relativePath))]);
    for (const file of orderedFiles) {
      if (!file.path.startsWith("test/")) continue;
      if (dependencyNeedles.some((needle) => file.path.includes(needle) || file.content.includes(needle))) {
        setPriority(file.path, 80_000);
      }
    }
  }

  setPriority("package.json", 10_000);
  const ranked = orderedFiles.map((file) => ({
    file,
    priority: priority.get(file.path) ?? 0,
    score: relevanceScore(file, query),
  })).sort((left, right) => (
    right.priority - left.priority
    || right.score - left.score
    || compareUtf8Path(left.file.path, right.file.path)
  ));
  const targetedCount = ranked.filter((candidate) => candidate.priority > 0 || candidate.score >= 100).length;

  const selected = [];
  for (const candidate of ranked) {
    if (selected.length >= maxSnapshotFiles) break;
    if (targetedCount >= 2 && candidate.priority === 0 && candidate.score < 100) continue;
    const tentative = [...selected, candidate.file].sort((left, right) => compareUtf8Path(left.path, right.path));
    const json = JSON.stringify(tentative);
    if (Buffer.byteLength(json, "utf8") <= maxSnapshotBytes) {
      selected.push(candidate.file);
    } else if (candidate.priority >= 90_000) {
      throw new IsolatedWorkspaceError("snapshot_limit_exceeded");
    }
  }
  if (selected.length < 1) throw new IsolatedWorkspaceError("snapshot_limit_exceeded");
  const finalFiles = selected.sort((left, right) => compareUtf8Path(left.path, right.path));
  const json = JSON.stringify(finalFiles);
  if (Buffer.byteLength(json, "utf8") > maxSnapshotBytes) throw new IsolatedWorkspaceError("snapshot_limit_exceeded");
  return Object.freeze({ files: Object.freeze(finalFiles), json });
}

export async function buildIsolatedRepositorySnapshot(repoDir, {
  ownerId,
  maxFileBytes = MAX_SOURCE_FILE_BYTES,
  maxSnapshotBytes = DEFAULT_MAX_SNAPSHOT_BYTES,
  maxSnapshotFiles = DEFAULT_MAX_SNAPSHOT_FILES,
  selectionPrompt = "",
  expectedSourceManifestSha256 = null,
  expectedSourceFileCount = null,
  expectedSourceTotalBytes = null,
} = {}) {
  assertAbsoluteDirectoryRoot(repoDir, "repo_dir");
  if (!OWNER_ID.test(String(ownerId ?? ""))) throw new IsolatedWorkspaceError("owner_id_invalid");
  if (!Number.isSafeInteger(maxSnapshotBytes) || maxSnapshotBytes < 1 || maxSnapshotBytes > MAX_SOURCE_TOTAL_BYTES) {
    throw new IsolatedWorkspaceError("snapshot_limit_invalid");
  }
  const scan = await scanIsolatedRepository(repoDir, { ownerId: String(ownerId), maxFileBytes });
  assertManifestMatches(
    manifestFromScan(scan), expectedSourceManifestSha256, expectedSourceFileCount, expectedSourceTotalBytes,
  );
  const files = [];
  async function walk(relativeDirectory) {
    const absoluteDirectory = relativeDirectory ? path.join(repoDir, relativeDirectory) : repoDir;
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
      if (relativePath === ".git" && entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.isSymbolicLink()) throw new IsolatedWorkspaceError("repository_scan_blocked", [finding("symlink", relativePath)]);
      if (entry.isDirectory()) {
        await walk(relativePath);
        continue;
      }
      assertAllowedIsolatedRelativePath(relativePath);
      const text = await readSafeSourceFile(path.join(repoDir, relativePath), relativePath, { maxFileBytes });
      if (text === null) throw new IsolatedWorkspaceError("repository_scan_blocked", [finding("non_regular_file", relativePath)]);
      assertCodexTextSafe(text, { ownerId: String(ownerId), relativePath });
      files.push(Object.freeze({ path: relativePath.split(path.sep).join("/"), content: text }));
    }
  }
  await walk("");
  const snapshotBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  assertManifestMatches(sourceManifest(files.map((file) => ({
    path: file.path,
    sha256: createHash("sha256").update(file.content, "utf8").digest("hex"),
  })), snapshotBytes), expectedSourceManifestSha256, expectedSourceFileCount, expectedSourceTotalBytes);
  return selectRelevantRepositoryFiles(files, { selectionPrompt, maxSnapshotBytes, maxSnapshotFiles }).json;
}

export async function createIsolatedWorkspace({
  jobId,
  sourceRoot,
  ownerId,
  expectedSourceManifestSha256 = null,
  expectedSourceFileCount = null,
  expectedSourceTotalBytes = null,
  workspaceRoot = DEFAULT_CODEX_WORKSPACE_ROOT,
  maxFiles = MAX_SOURCE_FILES,
  maxFileBytes = MAX_SOURCE_FILE_BYTES,
  maxTotalBytes = MAX_SOURCE_TOTAL_BYTES,
  gitRun = execFileAsync,
} = {}) {
  if (!JOB_ID.test(String(jobId ?? ""))) throw new IsolatedWorkspaceError("job_id_invalid");
  if (!OWNER_ID.test(String(ownerId ?? ""))) throw new IsolatedWorkspaceError("owner_id_invalid");
  validateExpectedManifest(expectedSourceManifestSha256);
  validateExpectedFileCount(expectedSourceFileCount);
  validateExpectedTotalBytes(expectedSourceTotalBytes);
  assertAbsoluteDirectoryRoot(sourceRoot, "source_root");
  assertAbsoluteDirectoryRoot(workspaceRoot, "workspace_root");
  const sourceInfo = await lstat(sourceRoot);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) throw new IsolatedWorkspaceError("source_root_invalid");
  const canonicalSourceRoot = await realpath(sourceRoot);
  if (canonicalSourceRoot !== sourceRoot) throw new IsolatedWorkspaceError("source_root_invalid");
  const existingWorkspaceRoot = await lstat(workspaceRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existingWorkspaceRoot && (!existingWorkspaceRoot.isDirectory() || existingWorkspaceRoot.isSymbolicLink())) {
    throw new IsolatedWorkspaceError("workspace_root_invalid");
  }
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const workspaceInfo = await lstat(workspaceRoot);
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) throw new IsolatedWorkspaceError("workspace_root_invalid");
  await chmod(workspaceRoot, 0o700);
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  if (canonicalWorkspaceRoot !== workspaceRoot) throw new IsolatedWorkspaceError("workspace_root_invalid");
  const jobsRoot = path.join(canonicalWorkspaceRoot, "jobs");
  await mkdir(jobsRoot, { recursive: true, mode: 0o700 });
  const jobsInfo = await lstat(jobsRoot);
  if (!jobsInfo.isDirectory() || jobsInfo.isSymbolicLink() || await realpath(jobsRoot) !== jobsRoot) {
    throw new IsolatedWorkspaceError("workspace_root_invalid");
  }
  await chmod(jobsRoot, 0o700);
  const jobDir = path.join(jobsRoot, String(jobId));
  const repoDir = path.join(jobDir, "repo");
  ensureInside(jobsRoot, jobDir);
  if (canonicalWorkspaceRoot === canonicalSourceRoot || canonicalWorkspaceRoot.startsWith(`${canonicalSourceRoot}${path.sep}`)) {
    throw new IsolatedWorkspaceError("workspace_root_inside_source");
  }

  let created = false;
  try {
    await mkdir(jobDir, { recursive: false, mode: 0o700 });
    created = true;
    await mkdir(repoDir, { recursive: false, mode: 0o700 });
    const collected = await collectSourceFiles(canonicalSourceRoot, {
      ownerId: String(ownerId), maxFiles, maxFileBytes, maxTotalBytes,
    });
    assertManifestMatches(
      manifestFromCollected(collected.files, collected.totalBytes),
      expectedSourceManifestSha256,
      expectedSourceFileCount,
      expectedSourceTotalBytes,
    );
    await writeCollectedFiles(repoDir, collected.files);
    const scan = await scanIsolatedRepository(repoDir, {
      ownerId: String(ownerId), maxFiles, maxFileBytes, maxTotalBytes,
    });
    const copiedManifest = assertManifestMatches(
      manifestFromScan(scan), expectedSourceManifestSha256, expectedSourceFileCount, expectedSourceTotalBytes,
    );
    await initializeSyntheticGit(repoDir, gitRun);
    const replacements = collected.files.reduce((total, file) => ({
      ownerId: total.ownerId + file.replacements.ownerId,
      userHome: total.userHome + file.replacements.userHome,
      homeAssistantHost: total.homeAssistantHost + file.replacements.homeAssistantHost,
      tailnetHost: total.tailnetHost + file.replacements.tailnetHost,
      appleTeamId: total.appleTeamId + file.replacements.appleTeamId,
      bundleIdentifier: total.bundleIdentifier + file.replacements.bundleIdentifier,
    }), {
      ownerId: 0,
      userHome: 0,
      homeAssistantHost: 0,
      tailnetHost: 0,
      appleTeamId: 0,
      bundleIdentifier: 0,
    });
    return Object.freeze({
      jobId: String(jobId),
      jobDir,
      repoDir,
      fileCount: scan.fileCount,
      byteCount: scan.totalBytes,
      sourceManifestSha256: copiedManifest.sha256,
      replacements: Object.freeze(replacements),
    });
  } catch (error) {
    if (created) await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof IsolatedWorkspaceError) throw error;
    throw new IsolatedWorkspaceError("workspace_creation_failed");
  }
}

export async function removeIsolatedWorkspace({ jobId, workspaceRoot = DEFAULT_CODEX_WORKSPACE_ROOT } = {}) {
  if (!JOB_ID.test(String(jobId ?? ""))) throw new IsolatedWorkspaceError("job_id_invalid");
  assertAbsoluteDirectoryRoot(workspaceRoot, "workspace_root");
  const workspaceInfo = await lstat(workspaceRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (workspaceInfo === null) return false;
  if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
    throw new IsolatedWorkspaceError("workspace_root_invalid");
  }
  const canonicalWorkspaceRoot = await realpath(workspaceRoot);
  if (canonicalWorkspaceRoot !== workspaceRoot) throw new IsolatedWorkspaceError("workspace_root_invalid");
  const jobsRoot = path.join(canonicalWorkspaceRoot, "jobs");
  const jobsInfo = await lstat(jobsRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (jobsInfo === null) return false;
  if (!jobsInfo.isDirectory() || jobsInfo.isSymbolicLink() || await realpath(jobsRoot) !== jobsRoot) {
    throw new IsolatedWorkspaceError("workspace_root_invalid");
  }
  const jobDir = path.join(jobsRoot, String(jobId));
  ensureInside(jobsRoot, jobDir);
  const jobInfo = await lstat(jobDir).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (jobInfo === null) return false;
  if (!jobInfo.isDirectory() || jobInfo.isSymbolicLink() || await realpath(jobDir) !== jobDir) {
    throw new IsolatedWorkspaceError("workspace_job_invalid");
  }
  await rm(jobDir, { recursive: true, force: false });
  return true;
}
