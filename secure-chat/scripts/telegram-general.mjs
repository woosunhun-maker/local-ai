#!/opt/homebrew/bin/node

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { CodexTaskStore } from "../src/codex/task-store.mjs";
import { ApprovalStore } from "../src/approval-store.mjs";
import { ProactiveStore } from "../src/proactive-store.mjs";
import { codexWorkerReady } from "../src/telegram/codex-runtime-readiness.mjs";
import { deliverCodexResults } from "../src/telegram/codex-result-delivery.mjs";
import { TelegramGeneralChatService } from "../src/telegram/general-chat-service.mjs";
import { OwnerActionBridge, notifyOwnerOfActionApproval } from "../src/telegram/owner-action-bridge.mjs";
import { chooseOwnerGeneration, normalizeConfiguredTelegramPrincipal } from "../src/telegram/principal.mjs";
import { telegramClient } from "../src/telegram/telegram-client.mjs";
import { createStructuredEventLog } from "../src/structured-event-log.mjs";

const execFileAsync = promisify(execFile);
const ROOT = "/Users/hun/PrivateAI";
const CONFIG_PATH = `${ROOT}/config/telegram-general.json`;
const CODEX_CONFIG_PATH = `${ROOT}/config/codex-bridge.json`;
const STATE_PATH = `${ROOT}/data/telegram-general/state.json`;
const CODEX_TASK_PATH = `${ROOT}/data/codex-bridge/tasks.json`;
const APPROVAL_PATH = `${ROOT}/data/secure-chat/approvals.json`;
const PROACTIVE_PATH = `${ROOT}/data/secure-chat/proactive.json`;
const KEYCHAIN_SERVICE = "local.privateai.telegram.bot-token";
const KEYCHAIN_ACCOUNT = "local-ai";
const HA_KEYCHAIN_SERVICE = "local.privateai.homeassistant.token";
const HA_KEYCHAIN_ACCOUNT = "local-ai";

function validateConfig(value) {
  return normalizeConfiguredTelegramPrincipal(value, { allowMissingBotId: true });
}

function validateCodexConfig(value) {
  if (value?.version !== 1 || value?.enabled !== true || value?.mode !== "isolated_inspect_and_draft") {
    throw new Error("codex_bridge_not_configured");
  }
  return true;
}

async function tokenFromKeychain() {
  const result = await execFileAsync("/usr/bin/security", [
    "find-generic-password",
    "-s", KEYCHAIN_SERVICE,
    "-a", KEYCHAIN_ACCOUNT,
    "-w",
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 16_384 });
  const token = result.stdout.trim();
  if (!/^[0-9]{5,20}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error("telegram_token_invalid");
  return token;
}

async function readState() {
  try {
    const value = JSON.parse(await readFile(STATE_PATH, "utf8"));
    if (value?.version !== 1 || !Number.isSafeInteger(value?.nextUpdateId) || value.nextUpdateId < 0) throw new Error("telegram_state_invalid");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, nextUpdateId: 0 };
    throw error;
  }
}

async function writeState(nextUpdateId) {
  const directory = `${ROOT}/data/telegram-general`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${STATE_PATH}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, nextUpdateId })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, STATE_PATH);
}

async function writeTelegramConfig(value) {
  const directory = `${ROOT}/config`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${CONFIG_PATH}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, CONFIG_PATH);
}

async function main() {
  let config;
  try {
    config = validateConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT" || error.message === "telegram_general_not_configured") {
      process.stdout.write(`${JSON.stringify({ outcome: "disabled" })}\n`);
      return;
    }
    throw error;
  }
  if (config.migrated) {
    await writeTelegramConfig(config.raw);
    config = validateConfig(config.raw);
  }

  const token = await tokenFromKeychain();
  const client = telegramClient(token);
  const bot = await client.verify();
  if (!bot || bot.is_bot !== true || !Number.isSafeInteger(bot.id) || bot.id < 1) throw new Error("telegram_bot_invalid");
  const botId = String(bot.id);
  if (config.botId !== null && config.botId !== botId) throw new Error("telegram_bot_identity_mismatch");
  if (config.botId === null) {
    const nextRaw = {
      ...config.raw,
      botId,
      ownerGeneration: chooseOwnerGeneration(config.raw, {
        ownerId: config.ownerId,
        chatId: config.chatId,
        botId,
      }),
    };
    await writeTelegramConfig(nextRaw);
    config = validateConfig(nextRaw);
  }
  const principal = Object.freeze({
    botId,
    ownerId: config.ownerId,
    chatId: config.chatId,
    ownerGeneration: config.ownerGeneration,
  });

  let codexStore = null;
  try {
    validateCodexConfig(JSON.parse(await readFile(CODEX_CONFIG_PATH, "utf8")));
    if (await codexWorkerReady()) {
      codexStore = new CodexTaskStore(CODEX_TASK_PATH);
      await codexStore.initialize();
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.message !== "codex_bridge_not_configured") throw error;
  }
  const codexTasks = codexStore
    ? Object.freeze({
      enqueue: (value) => codexStore.enqueue({ botId, ...value }),
      summary: () => codexStore.summary(principal),
    })
    : null;

  const approvalStore = new ApprovalStore(APPROVAL_PATH);
  await approvalStore.initialize();
  const proactiveStore = new ProactiveStore(PROACTIVE_PATH);
  await proactiveStore.initialize();
  const ownerActionBridge = new OwnerActionBridge({
    approvalStore,
    proactiveStore,
    notify: () => notifyOwnerOfActionApproval({
      tokenReader: async () => {
        const result = await execFileAsync("/usr/bin/security", [
          "find-generic-password", "-s", HA_KEYCHAIN_SERVICE, "-a", HA_KEYCHAIN_ACCOUNT, "-w",
        ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
        return result.stdout.trim();
      },
    }),
  });

  const service = new TelegramGeneralChatService({
    ownerId: config.ownerId,
    chatId: config.chatId,
    ownerGeneration: config.ownerGeneration,
    client,
    codexTasks,
    ownerActionBridge,
    structuredLog: createStructuredEventLog({ logDir: `${ROOT}/logs/structured` }),
  });
  let state = await readState();
  let consecutiveErrors = 0;
  process.stdout.write(`${JSON.stringify({ outcome: "running", transport: codexStore ? "telegram_general_and_isolated_codex" : "telegram_general_only" })}\n`);

  while (true) {
    try {
      if (codexStore) await deliverCodexResults({ store: codexStore, client, principal });
      const updates = await client.getUpdates(state.nextUpdateId);
      if (!Array.isArray(updates)) throw new Error("telegram_updates_invalid");
      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id) || update.update_id < state.nextUpdateId) continue;
        const result = await service.handleUpdate(update);
        state = { version: 1, nextUpdateId: update.update_id + 1 };
        await writeState(state.nextUpdateId);
        process.stdout.write(`${JSON.stringify({ outcome: result.outcome, reason: result.reason })}\n`);
      }
      if (codexStore) await deliverCodexResults({ store: codexStore, client, principal });
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors += 1;
      process.stderr.write(`${JSON.stringify({ outcome: "error", errorClass: error?.name ?? "Error" })}\n`);
      if (consecutiveErrors >= 5) throw new Error("telegram_general_repeated_failure");
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * (2 ** consecutiveErrors))));
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ outcome: "fatal", errorClass: error?.name ?? "Error" })}\n`);
  process.exitCode = 1;
});
