import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hardenExecApprovals, hardenOpenClawConfig } from "../src/openclaw-hardening.mjs";

function fixture() {
  return {
    gateway: { bind: "loopback", auth: { mode: "token", token: "old-token-value-that-is-long-enough" } },
    tools: { profile: "coding", deny: ["group:web"], exec: { security: "allowlist" }, fs: { workspaceOnly: true } },
    agents: {
      defaults: { model: "ollama/local", models: { "ollama/local": {}, "openai/gpt-5.6-sol": {} } },
      list: [{ id: "main" }, { id: "cloud-consultant", model: "openai/gpt-5.6-sol" }],
    },
    channels: { telegram: { enabled: true, botToken: "synthetic-bot-token" } },
    plugins: { entries: { telegram: { enabled: true }, codex: { enabled: true } } },
  };
}

test("removes every direct cloud-agent route while preserving the local agent", () => {
  const source = fixture();
  const result = hardenOpenClawConfig(source, "new-gateway-token-that-is-at-least-32-characters");

  assert.equal(result.gateway.bind, "loopback");
  assert.equal(result.agents.defaults.model, "ollama/local");
  assert.equal(result.agents.defaults.models["openai/gpt-5.6-sol"], undefined);
  assert.deepEqual(result.agents.list.map((entry) => entry.id), ["main"]);
  assert.ok(result.tools.deny.includes("sessions_spawn"));
  assert.ok(result.tools.deny.includes("sessions_send"));
  assert.ok(result.agents.list[0].tools.deny.includes("session_status"));
  assert.deepEqual(result.channels.telegram, { enabled: false });
  assert.equal(result.plugins.entries.telegram.enabled, false);
  assert.equal(source.channels.telegram.enabled, true, "input must not be mutated");
});

test("refuses to harden a config whose existing local boundaries are already unsafe", () => {
  const source = fixture();
  source.gateway.bind = "lan";
  assert.throws(() => hardenOpenClawConfig(source, "new-gateway-token-that-is-at-least-32-characters"), /preconditions/);
});

test("replaces every executable allowlist entry with the wrapper that cannot accept legacy consult", () => {
  const source = {
    version: 1,
    defaults: { security: "allowlist", ask: "off", askFallback: "deny" },
    agents: {
      main: {
        allowlist: [
          { id: "legacy", pattern: "/Users/hun/PrivateAI/app/runner/local-ai-runner.sh" },
          { id: "dangerous", pattern: "/opt/homebrew/bin/openclaw" },
        ],
      },
    },
  };
  const path = "/Users/hun/PrivateAI/app/secure-chat/scripts/openclaw-safe-runner.mjs";
  const result = hardenExecApprovals(source, path);
  assert.deepEqual(result.agents.main.allowlist, [{ id: "local-ai-safe-runner-v1", pattern: path }]);
  assert.equal(source.agents.main.allowlist.length, 2);
});

test("safe runner rejects the legacy consultation argument before spawning anything", () => {
  const script = fileURLToPath(new URL("../scripts/openclaw-safe-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--consult", "SYNTHETIC0000001"], { encoding: "utf8" });
  assert.equal(result.status, 12);
  assert.match(result.stderr, /legacy GPT consultation/);
});

test("privacy hardening holds the shared runtime mutation lock for the complete transaction", async () => {
  const script = fileURLToPath(new URL("../scripts/apply-openclaw-privacy-hardening.mjs", import.meta.url));
  const source = await readFile(script, "utf8");
  assert.match(source, /\/Users\/hun\/PrivateAI\/tmp\/runtime-mutation\.lock/u);
  const acquire = source.indexOf("const lease = await runtimeMutationLock.acquire()");
  const transactionCall = source.indexOf("await hardenUnderLock()", acquire);
  const release = source.indexOf("await lease.release()", transactionCall);
  assert.ok(acquire >= 0 && acquire < transactionCall && transactionCall < release);
  assert.match(source.slice(acquire, release), /try\s*\{[\s\S]*hardenUnderLock\(\)[\s\S]*\}\s*finally/u);
});

test("privacy rollback accumulates restore failures and safe-stops before reporting failure", async () => {
  const script = fileURLToPath(new URL("../scripts/apply-openclaw-privacy-hardening.mjs", import.meta.url));
  const source = await readFile(script, "utf8");
  const rollback = source.indexOf("const rollbackFailures = []");
  const failureGate = source.indexOf("if (rollbackFailures.length > 0)", rollback);
  const safeStop = source.indexOf("await stopServices()", failureGate);
  const failure = source.indexOf('new Error("privacy_hardening_rollback_failed"', safeStop);
  const restart = source.indexOf("await restartServices()", failure);
  assert.ok(rollback >= 0 && rollback < failureGate && failureGate < safeStop && safeStop < failure && failure < restart);
  assert.doesNotMatch(source.slice(rollback, failureGate), /Promise\.all|\.catch\(\(\) => \{\}\)/u);
});
