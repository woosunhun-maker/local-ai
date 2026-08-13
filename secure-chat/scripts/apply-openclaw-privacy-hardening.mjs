#!/opt/homebrew/bin/node

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { hardenExecApprovals, hardenOpenClawConfig } from "../src/openclaw-hardening.mjs";
import { PrivateFileLock } from "../src/private-file-lock.mjs";

const execFileAsync = promisify(execFile);
const OPENCLAW_ROOT = "/Users/hun/.openclaw";
const CONFIG_PATH = `${OPENCLAW_ROOT}/openclaw.json`;
const EXEC_APPROVALS_PATH = `${OPENCLAW_ROOT}/exec-approvals.json`;
const SAFE_RUNNER_PATH = "/Users/hun/PrivateAI/app/secure-chat/scripts/openclaw-safe-runner.mjs";
const KEYCHAIN_SERVICE = "local.privateai.openwebui.proxy.token";
const KEYCHAIN_ACCOUNT = "local-ai";
const RUNTIME_MUTATION_LOCK_PATH = "/Users/hun/PrivateAI/tmp/runtime-mutation.lock";
const runtimeMutationLock = new PrivateFileLock(RUNTIME_MUTATION_LOCK_PATH, {
  retryAttempts: 1,
  retryDelayMs: 0,
  errorPrefix: "runtime_mutation_lock",
});

async function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function scrubCredentials(root, credentials) {
  let modified = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || [".git", "node_modules", "cache"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024) continue;
      let content;
      try {
        content = await readFile(path, "utf8");
      } catch {
        continue;
      }
      let next = content;
      for (const credential of credentials) {
        if (credential) next = next.split(credential).join("[REDACTED_REVOKED_CREDENTIAL]");
      }
      if (next !== content) {
        await atomicWrite(path, next);
        modified += 1;
      }
    }
  }
  await walk(root);
  return modified;
}

async function setProxyToken(value) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [
      "add-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_SERVICE,
      "-U",
      "-w",
    ], {
      shell: false,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("keychain_update_timeout"));
    }, 30_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < 4_096) stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !signal) resolve();
      else reject(new Error("keychain_update_failed"));
    });
    child.stdin.end(`${value}\n${value}\n`);
  });
}

async function getProxyToken() {
  const result = await execFileAsync("/usr/bin/security", [
    "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
  ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  return result.stdout.trim();
}

async function validateConfig() {
  await execFileAsync("/opt/homebrew/bin/openclaw", ["config", "validate", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 512 * 1024,
  });
}

const SERVICE_LABELS = [
  "ai.openclaw.gateway",
  "com.local.privateai.openwebui-proxy",
  "com.local.privateai.openwebui",
  "com.local.privateai.secure-chat",
];

async function restartServices() {
  const domain = `gui/${process.getuid()}`;
  for (const label of SERVICE_LABELS) {
    await execFileAsync("/bin/launchctl", ["kickstart", "-k", `${domain}/${label}`], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
  }
}

async function stopServices() {
  const domain = `gui/${process.getuid()}`;
  for (const label of SERVICE_LABELS) {
    await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${label}`], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    }).catch(() => {});
  }
  const stillLoaded = [];
  for (const label of SERVICE_LABELS) {
    try {
      await execFileAsync("/bin/launchctl", ["print", `${domain}/${label}`], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      stillLoaded.push(label);
    } catch {
      // launchctl print fails only after the job has left the domain.
    }
  }
  if (stillLoaded.length > 0) throw new Error("privacy_hardening_safe_stop_failed");
}

async function waitForHealth(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch {
      // Service restart may temporarily refuse connections.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("service_health_timeout");
}

async function validateServices() {
  await Promise.all([
    waitForHealth("http://127.0.0.1:18789/health"),
    waitForHealth("http://127.0.0.1:18790/health"),
    waitForHealth("http://127.0.0.1:3000/health"),
    waitForHealth("http://127.0.0.1:18791/health"),
  ]);
}

async function hardenUnderLock() {
  const [originalText, originalExecApprovalsText, safeRunnerMetadata, oldProxyToken] = await Promise.all([
    readFile(CONFIG_PATH, "utf8"),
    readFile(EXEC_APPROVALS_PATH, "utf8"),
    lstat(SAFE_RUNNER_PATH),
    getProxyToken(),
  ]);
  if (
    !safeRunnerMetadata.isFile() ||
    safeRunnerMetadata.isSymbolicLink() ||
    (safeRunnerMetadata.mode & 0o111) === 0 ||
    (safeRunnerMetadata.mode & 0o022) !== 0 ||
    safeRunnerMetadata.uid !== process.getuid()
  ) {
    throw new Error("safe_runner_missing_or_not_executable");
  }
  const originalConfig = JSON.parse(originalText);
  const originalExecApprovals = JSON.parse(originalExecApprovalsText);
  const telegramToken = originalConfig.channels?.telegram?.botToken;
  const oldGatewayToken = originalConfig.gateway?.auth?.token;
  if (typeof oldGatewayToken !== "string" || oldGatewayToken.length < 24) throw new Error("gateway_token_missing");
  const newGatewayToken = randomBytes(32).toString("base64url");
  const newProxyToken = randomBytes(32).toString("base64url");
  const config = hardenOpenClawConfig(originalConfig, newGatewayToken);
  const execApprovals = hardenExecApprovals(originalExecApprovals, SAFE_RUNNER_PATH);

  try {
    await atomicWrite(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
    await atomicWrite(EXEC_APPROVALS_PATH, `${JSON.stringify(execApprovals, null, 2)}\n`);
    await validateConfig();
    await setProxyToken(newProxyToken);
    await restartServices();
    await validateServices();
  } catch (error) {
    const rollbackFailures = [];
    for (const [name, operation] of [
      ["config", () => atomicWrite(CONFIG_PATH, originalText)],
      ["exec_approvals", () => atomicWrite(EXEC_APPROVALS_PATH, originalExecApprovalsText)],
      ["proxy_token", () => setProxyToken(oldProxyToken)],
    ]) {
      try {
        await operation();
      } catch (rollbackError) {
        rollbackFailures.push(new Error(`privacy_hardening_${name}_restore_failed`, { cause: rollbackError }));
      }
    }
    if (rollbackFailures.length > 0) {
      try {
        await stopServices();
      } catch (safeStopError) {
        rollbackFailures.push(safeStopError);
      }
      throw new Error("privacy_hardening_rollback_failed", { cause: new AggregateError(rollbackFailures) });
    }
    try {
      await restartServices();
    } catch (restartError) {
      const restartFailures = [restartError];
      try {
        await stopServices();
      } catch (safeStopError) {
        restartFailures.push(safeStopError);
      }
      throw new Error("privacy_hardening_rollback_restart_failed", { cause: new AggregateError(restartFailures) });
    }
    throw error;
  }
  const scrubbedFiles = await scrubCredentials(OPENCLAW_ROOT, [telegramToken, oldGatewayToken, oldProxyToken]).catch(() => -1);
  console.log(JSON.stringify({
    outcome: "hardened",
    gatewayTokenRotated: true,
    proxyClientTokenRotated: true,
    telegramDisabled: true,
      externalModelAliasRemoved: true,
      externalAgentRemoved: true,
    modelSpawnBlocked: true,
    legacyConsultRunnerBlocked: true,
    scrubbedFiles,
  }));
}

async function main() {
  const lease = await runtimeMutationLock.acquire();
  try {
    await hardenUnderLock();
  } finally {
    await lease.release();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ outcome: "error", errorClass: error?.name ?? "Error" }));
  process.exitCode = 1;
});
