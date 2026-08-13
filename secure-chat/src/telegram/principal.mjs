import { randomBytes } from "node:crypto";

const OWNER_ID = /^[1-9][0-9]{5,19}$/;
const BOT_ID = /^[1-9][0-9]{4,19}$/;
const OWNER_GENERATION = /^[a-f0-9]{32}$/;

function principalError(code) {
  return Object.assign(new Error(code), { statusCode: 400 });
}

export function createOwnerGeneration() {
  return randomBytes(16).toString("hex");
}

export function validateOwnerId(value, code = "invalid_telegram_owner_id") {
  const normalized = String(value ?? "");
  if (!OWNER_ID.test(normalized)) throw principalError(code);
  return normalized;
}

export function validatePrivateChatId(value, ownerId, code = "invalid_telegram_chat_id") {
  const normalized = String(value ?? "");
  if (!OWNER_ID.test(normalized) || normalized !== String(ownerId)) throw principalError(code);
  return normalized;
}

export function validateBotId(value, code = "invalid_telegram_bot_id") {
  const normalized = String(value ?? "");
  if (!BOT_ID.test(normalized)) throw principalError(code);
  return normalized;
}

export function validateOwnerGeneration(value, code = "invalid_telegram_owner_generation") {
  if (typeof value !== "string" || !OWNER_GENERATION.test(value)) throw principalError(code);
  return value;
}

export function normalizeConfiguredTelegramPrincipal(value, { allowMissingBotId = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || value.enabled !== true) {
    throw principalError("telegram_general_not_configured");
  }
  const ownerId = validateOwnerId(value.ownerId, "telegram_general_not_configured");
  const chatId = value.chatId === undefined
    ? ownerId
    : validatePrivateChatId(value.chatId, ownerId, "telegram_general_not_configured");
  const botId = value.botId === undefined || value.botId === null
    ? null
    : validateBotId(value.botId, "telegram_general_not_configured");
  if (!allowMissingBotId && botId === null) throw principalError("telegram_general_not_configured");
  const ownerGeneration = value.ownerGeneration === undefined
    ? createOwnerGeneration()
    : validateOwnerGeneration(value.ownerGeneration, "telegram_general_not_configured");
  const migrated = value.chatId === undefined || value.ownerGeneration === undefined;
  return Object.freeze({
    ownerId,
    chatId,
    botId,
    ownerGeneration,
    migrated,
    raw: migrated ? { ...value, chatId, ownerGeneration } : value,
  });
}

export function chooseOwnerGeneration(current, nextPrincipal) {
  const nextOwnerId = validateOwnerId(nextPrincipal?.ownerId);
  const nextChatId = validatePrivateChatId(nextPrincipal?.chatId, nextOwnerId);
  const nextBotId = validateBotId(nextPrincipal?.botId);
  try {
    const previous = normalizeConfiguredTelegramPrincipal(current);
    if (
      previous.ownerId === nextOwnerId &&
      previous.chatId === nextChatId &&
      previous.botId === nextBotId
    ) {
      return previous.ownerGeneration;
    }
  } catch {
    // A missing, legacy, or invalid principal must receive a fresh generation.
  }
  return createOwnerGeneration();
}

export function normalizeTaskPrincipal(value, prefix = "invalid_codex_task") {
  const ownerId = validateOwnerId(value?.ownerId, `${prefix}_owner_id`);
  const chatId = validatePrivateChatId(value?.chatId, ownerId, `${prefix}_chat_id`);
  const ownerGeneration = validateOwnerGeneration(value?.ownerGeneration, `${prefix}_owner_generation`);
  return Object.freeze({ ownerId, chatId, ownerGeneration });
}

export function sameTelegramPrincipal(left, right, { includeBotId = true } = {}) {
  if (!left || !right) return false;
  return (!includeBotId || String(left.botId ?? "") === String(right.botId ?? "")) &&
    String(left.ownerId ?? "") === String(right.ownerId ?? "") &&
    String(left.chatId ?? "") === String(right.chatId ?? "") &&
    String(left.ownerGeneration ?? "") === String(right.ownerGeneration ?? "");
}
