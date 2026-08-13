import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CODEX_WORKER_CHECK_SCRIPT = "/Users/hun/PrivateAI/app/secure-chat/scripts/launch-codex-worker.sh";

export async function codexWorkerReady({ execFileImpl = execFileAsync } = {}) {
  if (typeof execFileImpl !== "function") throw new Error("invalid_codex_readiness_runner");
  try {
    await execFileImpl("/bin/zsh", [CODEX_WORKER_CHECK_SCRIPT, "--check"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16_384,
    });
    return true;
  } catch {
    return false;
  }
}
