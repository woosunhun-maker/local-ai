import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/store-telegram-bot-token.sh", import.meta.url));
const PRODUCTION_SCRIPT = "/Users/hun/PrivateAI/app/secure-chat/scripts/store-telegram-bot-token.sh";

test("Telegram token helper source and production copy are identical owner-only executables", async () => {
  const [source, production, sourceStat, productionStat] = await Promise.all([
    readFile(SCRIPT),
    readFile(PRODUCTION_SCRIPT),
    stat(SCRIPT),
    stat(PRODUCTION_SCRIPT),
  ]);

  assert.deepEqual(production, source);
  assert.equal(sourceStat.mode & 0o777, 0o700);
  assert.equal(productionStat.mode & 0o777, 0o700);
});

test("Telegram token has one silent tty input and one stdin-only JSON boundary", async () => {
  const source = await readFile(SCRIPT, "utf8");

  assert.match(source, /exec 3<>\/dev\/tty/u);
  assert.match(source, /IFS= read -r -s telegram_bot_token_input <&3/u);
  assert.match(source, /\^\[1-9\]\[0-9\]\{5,19\}:\[A-Za-z0-9_-\]\{30,128\}\$/u);
  assert.match(source, /builtin printf '\{"botToken":"%s"\}\\n' "\$\{telegram_bot_token_input\}" \| \\\n\s+\/opt\/homebrew\/bin\/node "\$\{CONFIGURATOR\}"/u);
  assert.match(source, /trap cleanup EXIT/u);
  assert.match(source, /unset telegram_bot_token_input/u);
  assert.match(source, /^umask 077$/mu);

  assert.doesNotMatch(source, /(?:^|\s)export\s+telegram_bot_token_input\b/mu);
  assert.doesNotMatch(source, /\/usr\/bin\/(?:env|logger)|\btee\b/u);
  assert.doesNotMatch(source, /--(?:bot[-_]?token|token)(?:=|\s)/iu);
  assert.doesNotMatch(source, /(?:>|>>)\s*[^\n]*telegram_bot_token_input/u);

  const secretReferenceCount = source.match(/\$\{telegram_bot_token_input\}/gu)?.length ?? 0;
  assert.equal(secretReferenceCount, 2, "input may be used only for validation, JSON stdin, and no other boundary");
});

test("Telegram token helper accepts no argv input or alternate configuration command", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /if \(\( \$# != 0 \)\)/u);
  assert.equal(source.match(/\/opt\/homebrew\/bin\/node/gu)?.length, 1);
  assert.equal(source.match(/configure-telegram-general\.mjs/gu)?.length, 1);
});
