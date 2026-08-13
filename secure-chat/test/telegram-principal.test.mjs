import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseOwnerGeneration,
  normalizeConfiguredTelegramPrincipal,
  sameTelegramPrincipal,
} from "../src/telegram/principal.mjs";

const OWNER_A = "100000001";
const OWNER_B = "100000002";
const BOT_ID = "1234567890";

test("legacy Telegram config receives a private chat binding and stable random generation", () => {
  const migrated = normalizeConfiguredTelegramPrincipal({
    version: 1,
    enabled: true,
    ownerId: OWNER_A,
    botId: BOT_ID,
  });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.chatId, OWNER_A);
  assert.match(migrated.ownerGeneration, /^[a-f0-9]{32}$/);

  const persisted = normalizeConfiguredTelegramPrincipal(migrated.raw);
  assert.equal(persisted.migrated, false);
  assert.equal(persisted.ownerGeneration, migrated.ownerGeneration);
  assert.equal(chooseOwnerGeneration(persisted.raw, persisted), migrated.ownerGeneration);
});

test("owner or chat rotation receives a new generation and mismatched private chat fails closed", () => {
  const current = normalizeConfiguredTelegramPrincipal({
    version: 1,
    enabled: true,
    ownerId: OWNER_A,
    chatId: OWNER_A,
    ownerGeneration: "a".repeat(32),
    botId: BOT_ID,
  });
  const rotated = chooseOwnerGeneration(current.raw, { ownerId: OWNER_B, chatId: OWNER_B, botId: BOT_ID });
  assert.match(rotated, /^[a-f0-9]{32}$/);
  assert.notEqual(rotated, current.ownerGeneration);
  assert.equal(sameTelegramPrincipal(current, { ...current, ownerGeneration: rotated }), false);
  assert.throws(() => normalizeConfiguredTelegramPrincipal({ ...current.raw, chatId: OWNER_B }), /telegram_general_not_configured/);
});
