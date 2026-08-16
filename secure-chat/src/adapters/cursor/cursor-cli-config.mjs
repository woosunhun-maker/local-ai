/**
 * Local AI 전용 Cursor CLI 설정 — 사용자 전역 unrestricted를 신뢰하지 않는다.
 *
 * 조사 결과 (2026-08-14, agent 2026.08.11-e8db854):
 * - ~/.cursor/cli-config.json : approvalMode=allowlist, sandbox.mode=disabled
 * - ~/.cursor/permissions.json : approvalMode=unrestricted  ← LIVE에서 WRITE 미요청 원인 가능
 * - `agent acp`는 --config 플래그가 없으나, index.js의 config dir resolver가:
 *     1) process.env.CURSOR_CONFIG_DIR (우선)
 *     2) XDG_CONFIG_HOME/cursor
 *     3) ~/.cursor
 *   순으로 cli-config.json / permissions.json 경로를 결정한다.
 *
 * Local AI ACP spawn은 반드시 ensureLocalAiCursorConfigDir()의
 * CURSOR_CONFIG_DIR를 주입한다. 사용자 전역 unrestricted는 정책 근거로
 * 쓰지 않으며, write/쓰기 경계의 최종 권한은 host envelope 검증이다.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

export const LOCAL_AI_CURSOR_CONFIG_SCHEMA = "local-ai.cursor-cli-config.v1";

export const DEFAULT_LOCAL_AI_CURSOR_CONFIG_DIR =
  "/Users/hun/PrivateAI/config/cursor-agent-local-ai";

/** Local AI ACP용 보수적 설정 — unrestricted 금지 */
export function buildLocalAiCursorCliConfig() {
  return Object.freeze({
    version: 1,
    approvalMode: "allowlist",
    permissions: {
      allow: [
        "Shell(git status)",
        "Shell(git diff)",
        "Shell(git log)",
        "Shell(git show)",
        "Shell(npm test)",
        "Shell(npm run)",
        "Shell(node --test)",
      ],
      deny: [
        "Shell(git push)",
        "Shell(git commit)",
        "Shell(git reset)",
        "Shell(rm)",
      ],
    },
    sandbox: {
      mode: "enabled",
      networkAccess: "restricted",
    },
    autoAcceptWebSearch: false,
  });
}

export function buildLocalAiCursorPermissions() {
  return Object.freeze({
    approvalMode: "allowlist",
    terminalAllowlist: [
      "git status",
      "git diff",
      "git log",
      "git show",
      "npm test",
      "npm run",
      "node --test",
      "ls",
      "pwd",
      "cat",
      // rg = ripgrep. 로컬 파일에서 글자만 찾는다. 인터넷이 필요 없다.
      "rg",
      "head",
      "tail",
    ],
    mcpAllowlist: [],
    autoRun: {
      allow_instructions: [
        "Only allow read/test/build commands already on the Local AI allowlist.",
      ],
      block_instructions: [
        "Require approval for any write outside the approved worktree.",
        "Never auto-approve commit, merge, push, deploy, or PrivateAI/diol-os access.",
      ],
    },
  });
}

/**
 * 전용 config 디렉터리 준비. agent가 CURSOR_CONFIG_DIR를 존중하면 ACP에 전달.
 * @returns {Promise<{ configDir: string, cliConfigPath: string, permissionsPath: string, env: object }>}
 */
export async function ensureLocalAiCursorConfigDir({
  configDir = process.env.LOCAL_AI_CURSOR_CONFIG_DIR || DEFAULT_LOCAL_AI_CURSOR_CONFIG_DIR,
} = {}) {
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const cliConfigPath = path.join(configDir, "cli-config.json");
  const permissionsPath = path.join(configDir, "permissions.json");
  await writeFile(cliConfigPath, `${JSON.stringify(buildLocalAiCursorCliConfig(), null, 2)}\n`, { mode: 0o600 });
  await writeFile(permissionsPath, `${JSON.stringify(buildLocalAiCursorPermissions(), null, 2)}\n`, { mode: 0o600 });
  return Object.freeze({
    schema: LOCAL_AI_CURSOR_CONFIG_SCHEMA,
    configDir,
    cliConfigPath,
    permissionsPath,
    // agent가 지원하는 경우만 효과 있음 — 미지원 시에도 host envelope 검증이 권한 경계
    env: Object.freeze({
      CURSOR_CONFIG_DIR: configDir,
      // 일부 CLI는 XDG_CONFIG_HOME 하위 cursor를 봄
      LOCAL_AI_CURSOR_CONFIG_DIR: configDir,
    }),
  });
}

/** 사용자 전역 permissions.json이 unrestricted인지 탐지 (신뢰 금지 경보용) */
export async function inspectUserCursorApprovalMode({
  home = process.env.HOME,
} = {}) {
  const permissionsPath = path.join(home ?? "", ".cursor", "permissions.json");
  const cliConfigPath = path.join(home ?? "", ".cursor", "cli-config.json");
  let permissionsMode = null;
  let cliMode = null;
  try {
    permissionsMode = JSON.parse(await readFile(permissionsPath, "utf8"))?.approvalMode ?? null;
  } catch {
    permissionsMode = null;
  }
  try {
    cliMode = JSON.parse(await readFile(cliConfigPath, "utf8"))?.approvalMode ?? null;
  } catch {
    cliMode = null;
  }
  return Object.freeze({
    permissions_path: permissionsPath,
    cli_config_path: cliConfigPath,
    permissions_approval_mode: permissionsMode,
    cli_approval_mode: cliMode,
    user_unrestricted: permissionsMode === "unrestricted",
    must_not_trust_user_global: true,
    recommendation: "Use ensureLocalAiCursorConfigDir + envelope host verification; never treat user unrestricted as Local AI policy.",
  });
}
