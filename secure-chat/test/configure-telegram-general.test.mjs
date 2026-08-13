import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/configure-telegram-general.mjs", import.meta.url));

function runConfigurator(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("configuration JSON is read from piped stdin on Node 26", async () => {
  const result = await runConfigurator({ botToken: "not-a-token" });

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.outcome, "error");
  assert.equal(failure.errorCode, "telegram_token_invalid");
  assert.equal(failure.stage, "read_input");
  assert.ok(failure.inputBytes > 2);
});

test("configuration transaction holds the shared runtime mutation lock before reading previous state", async () => {
  const source = await readFile(SCRIPT, "utf8");
  assert.match(source, /\/Users\/hun\/PrivateAI\/tmp\/runtime-mutation\.lock/u);
  const acquire = source.indexOf("const lease = await runtimeMutationLock.acquire()");
  const transactionCall = source.indexOf("await configureUnderLock(input)", acquire);
  const previousRead = source.indexOf("optionalFile(CONFIG_PATH)");
  const release = source.indexOf("await lease.release()", transactionCall);
  assert.ok(acquire >= 0 && acquire < transactionCall);
  assert.ok(previousRead >= 0 && previousRead < acquire, "function declaration may precede main, but must not be invoked before lock");
  assert.ok(transactionCall < release);
  assert.match(source.slice(acquire, release), /try\s*\{[\s\S]*configureUnderLock\(input\)[\s\S]*\}\s*finally/u);
});

test("a partial Telegram rollback is never masked by restart", async () => {
  const source = await readFile(SCRIPT, "utf8");
  const rollback = source.indexOf("const rollbackFailures = []");
  const failureGate = source.indexOf("if (rollbackFailures.length > 0)", rollback);
  const safeError = source.indexOf('new Error("telegram_rollback_failed"', failureGate);
  const restart = source.indexOf("if (wasLoaded)", failureGate);
  assert.ok(rollback >= 0 && rollback < failureGate && failureGate < safeError && safeError < restart);
  assert.doesNotMatch(source.slice(rollback, restart), /\.catch\(\(\) => \{\}\)/u);
  assert.match(source.slice(failureGate, restart), /safe_stop_after_rollback_failure/u);
});
