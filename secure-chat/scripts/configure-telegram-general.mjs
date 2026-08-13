#!/opt/homebrew/bin/node

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { PrivateFileLock } from "../src/private-file-lock.mjs";
import { telegramClient } from "../src/telegram/telegram-client.mjs";
import { chooseOwnerGeneration } from "../src/telegram/principal.mjs";

const execFileAsync = promisify(execFile);
const ROOT = "/Users/hun/PrivateAI";
const CONFIG_PATH = `${ROOT}/config/telegram-general.json`;
const STATE_PATH = `${ROOT}/data/telegram-general/state.json`;
const LEGACY_OWNER_PATH = "/Users/hun/.openclaw/credentials/telegram-default-allowFrom.json";
const KEYCHAIN_SERVICE = "local.privateai.telegram.bot-token";
const KEYCHAIN_ACCOUNT = "local-ai";
const LAUNCH_AGENT = "/Users/hun/Library/LaunchAgents/com.local.privateai.telegram-general.plist";
const LABEL = "com.local.privateai.telegram-general";
const RUNTIME_MUTATION_LOCK_PATH = "/Users/hun/PrivateAI/tmp/runtime-mutation.lock";
const runtimeMutationLock = new PrivateFileLock(RUNTIME_MUTATION_LOCK_PATH, {
  retryAttempts: 1,
  retryDelayMs: 0,
  errorPrefix: "runtime_mutation_lock",
});
const EXECUTION = { stage: "startup", inputBytes: 0 };

async function readInput() {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 16_384) throw new Error("invalid_configuration_size");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks, totalBytes);
  EXECUTION.inputBytes = body.length;
  if (body.length < 2) throw new Error("invalid_configuration_size");
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("telegram_input_json_invalid");
  }
  if (!/^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$/.test(parsed?.botToken ?? "")) throw new Error("telegram_token_invalid");
  if (parsed.ownerId !== undefined && !/^[1-9][0-9]{5,19}$/.test(String(parsed.ownerId))) throw new Error("telegram_owner_invalid");
  return { botToken: parsed.botToken, ownerId: parsed.ownerId === undefined ? null : String(parsed.ownerId) };
}

async function optionalFile(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function resolveOwnerId(supplied, current) {
  if (supplied) return supplied;
  if (/^[1-9][0-9]{5,19}$/.test(String(current?.ownerId ?? ""))) return String(current.ownerId);
  const legacy = JSON.parse(await readFile(LEGACY_OWNER_PATH, "utf8"));
  const values = Array.isArray(legacy?.allowFrom) ? legacy.allowFrom.map(String).filter((value) => /^[1-9][0-9]{5,19}$/.test(value)) : [];
  if (values.length !== 1) throw new Error("telegram_owner_missing");
  return values[0];
}

async function keychainToken() {
  try {
    const result = await execFileAsync("/usr/bin/security", [
      "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
    ], { encoding: "utf8", timeout: 5_000, maxBuffer: 16_384 });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function setKeychainToken(value) {
  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [
      "add-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-U", "-w",
    ], { shell: false, stdio: ["pipe", "ignore", "ignore"] });
    const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("keychain_timeout")); }, 30_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0 && !signal) resolve();
      else reject(new Error("keychain_update_failed"));
    });
    child.stdin.end(`${value}\n${value}\n`);
  });
}

async function deleteKeychainToken() {
  await execFileAsync("/usr/bin/security", [
    "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT,
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 16_384 });
}

async function atomicWriteText(path, text) {
  const directory = path.slice(0, path.lastIndexOf("/"));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function atomicWriteConfig(value) {
  await atomicWriteText(CONFIG_PATH, `${JSON.stringify(value, null, 2)}\n`);
}

async function resetState() {
  await atomicWriteText(STATE_PATH, `${JSON.stringify({ version: 1, nextUpdateId: 0 })}\n`);
}

async function restoreFile(path, previousText) {
  if (previousText === null) {
    await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  await atomicWriteText(path, previousText);
}

async function serviceIsLoaded() {
  const domain = `gui/${process.getuid()}`;
  try {
    await execFileAsync("/bin/launchctl", ["print", `${domain}/${LABEL}`], { timeout: 10_000, maxBuffer: 64 * 1024 });
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServiceToUnload({ attempts = 50, intervalMs = 100 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await serviceIsLoaded())) return;
    await delay(intervalMs);
  }
  throw new Error("launch_agent_unload_timeout");
}

async function serviceIsRunning() {
  const domain = `gui/${process.getuid()}`;
  try {
    const result = await execFileAsync("/bin/launchctl", ["print", `${domain}/${LABEL}`], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    return /(?:^|\n)\s*state = running\s*(?:\n|$)/.test(result.stdout);
  } catch {
    return false;
  }
}

async function waitForServiceToRun({ attempts = 40, intervalMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await serviceIsRunning()) return;
    await delay(intervalMs);
  }
  throw new Error("launch_agent_start_timeout");
}

async function stopService(wasLoaded) {
  if (!wasLoaded) return;
  const domain = `gui/${process.getuid()}`;
  try {
    await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${LABEL}`], { timeout: 15_000, maxBuffer: 64 * 1024 });
  } catch {
    // launchd may report an in-progress unload even though the job is already
    // disappearing. Treat that race as success only after bounded verification.
  }
  try {
    await waitForServiceToUnload();
  } catch {
    throw new Error("launch_agent_stop_failed");
  }
}

async function startService({ requireRunning = false } = {}) {
  const domain = `gui/${process.getuid()}`;
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await execFileAsync("/bin/launchctl", ["bootstrap", domain, LAUNCH_AGENT], { timeout: 15_000, maxBuffer: 64 * 1024 });
      if (requireRunning) await waitForServiceToRun();
      return;
    } catch (error) {
      lastError = error;
      await execFileAsync("/bin/launchctl", ["bootout", `${domain}/${LABEL}`], {
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      }).catch(() => {});
      await waitForServiceToUnload().catch(() => {});
      await delay(250);
    }
  }
  throw new Error(requireRunning ? "launch_agent_start_failed" : "launch_agent_bootstrap_failed", { cause: lastError });
}

function safeErrorCode(error) {
  const message = typeof error?.message === "string" ? error.message : "";
  return /^[a-z][a-z0-9_]{2,63}$/.test(message) ? message : "configuration_failed";
}

async function runStage(errorCode, operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(errorCode, { cause: error });
  }
}

async function configureUnderLock(input) {
  EXECUTION.stage = "read_previous_files";
  const [currentConfigText, currentStateText] = await Promise.all([optionalFile(CONFIG_PATH), optionalFile(STATE_PATH)]);
  EXECUTION.stage = "parse_previous_config";
  const current = currentConfigText === null
    ? null
    : await runStage("telegram_config_read_failed", async () => JSON.parse(currentConfigText));
  EXECUTION.stage = "resolve_owner";
  const ownerId = await runStage("telegram_owner_resolution_failed", () => resolveOwnerId(input.ownerId, current));
  EXECUTION.stage = "create_client";
  const client = telegramClient(input.botToken);
  EXECUTION.stage = "verify_bot";
  const bot = await runStage("telegram_bot_verification_failed", () => client.verify());
  if (!bot || bot.is_bot !== true || typeof bot.username !== "string" || !Number.isSafeInteger(bot.id) || bot.id < 1) {
    throw new Error("telegram_bot_invalid");
  }
  const chatId = ownerId;
  const botId = String(bot.id);
  const ownerGeneration = chooseOwnerGeneration(current, { ownerId, chatId, botId });
  EXECUTION.stage = "discard_pending_updates";
  await runStage("telegram_update_reset_failed", () => client.discardPendingUpdates());

  EXECUTION.stage = "read_runtime_state";
  const [previousToken, wasLoaded] = await Promise.all([keychainToken(), serviceIsLoaded()]);
  EXECUTION.stage = "stop_launch_agent";
  await runStage("launch_agent_stop_failed", () => stopService(wasLoaded));
  try {
    EXECUTION.stage = "write_keychain";
    await runStage("keychain_update_failed", () => setKeychainToken(input.botToken));
    EXECUTION.stage = "write_config";
    await runStage("telegram_config_write_failed", () => atomicWriteConfig({
      version: 1,
      enabled: true,
      ownerId,
      chatId,
      ownerGeneration,
      botId,
      botUsername: bot.username,
      configuredAt: new Date().toISOString(),
      transport: "telegram_general_only",
    }));
    EXECUTION.stage = "reset_state";
    await runStage("telegram_state_reset_failed", () => resetState());
    EXECUTION.stage = "start_launch_agent";
    await runStage("launch_agent_start_failed", () => startService({ requireRunning: true }));
  } catch (error) {
    EXECUTION.stage = `rollback_after_${EXECUTION.stage}`;
    const rollbackFailures = [];
    for (const [name, operation] of [
      ["config", () => restoreFile(CONFIG_PATH, currentConfigText)],
      ["state", () => restoreFile(STATE_PATH, currentStateText)],
      ["keychain", () => previousToken ? setKeychainToken(previousToken) : deleteKeychainToken()],
    ]) {
      try {
        await operation();
      } catch (rollbackError) {
        rollbackFailures.push(new Error(`telegram_${name}_restore_failed`, { cause: rollbackError }));
      }
    }
    if (rollbackFailures.length > 0) {
      EXECUTION.stage = "safe_stop_after_rollback_failure";
      throw new Error("telegram_rollback_failed", { cause: new AggregateError(rollbackFailures) });
    }
    if (wasLoaded) {
      try {
        await startService();
      } catch (restartError) {
        EXECUTION.stage = "safe_stop_after_restart_failure";
        throw new Error("telegram_rollback_restart_failed", { cause: restartError });
      }
    }
    throw error;
  }
  EXECUTION.stage = "complete";
  process.stdout.write(`${JSON.stringify({ configured: true, enabled: true, botUsername: bot.username, mode: "general_chat_only" })}\n`);
}

async function main() {
  EXECUTION.stage = "read_input";
  const input = await readInput();
  EXECUTION.stage = "acquire_runtime_mutation_lock";
  const lease = await runtimeMutationLock.acquire();
  try {
    await configureUnderLock(input);
  } finally {
    await lease.release();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ outcome: "error", errorCode: safeErrorCode(error), stage: EXECUTION.stage, inputBytes: EXECUTION.inputBytes })}\n`);
  process.exitCode = 1;
});
