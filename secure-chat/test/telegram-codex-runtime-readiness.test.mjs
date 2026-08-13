import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CODEX_WORKER_CHECK_SCRIPT,
  codexWorkerReady,
} from "../src/telegram/codex-runtime-readiness.mjs";

test("Codex bridge is ready only after the exact deployed worker preflight succeeds", async () => {
  const calls = [];
  const ready = await codexWorkerReady({
    execFileImpl: async (...args) => { calls.push(args); return { stdout: "", stderr: "" }; },
  });
  assert.equal(ready, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/bin/zsh");
  assert.deepEqual(calls[0][1], [CODEX_WORKER_CHECK_SCRIPT, "--check"]);
  assert.equal(calls[0][2].timeout, 10_000);
});

test("version, configuration, and runtime failures disable the bridge without leaking details", async () => {
  const ready = await codexWorkerReady({
    execFileImpl: async () => { throw new Error("private codex version detail"); },
  });
  assert.equal(ready, false);
});

test("deployed worker preflight pins the exact Codex model as well as the version", async () => {
  const script = await readFile(new URL("../scripts/launch-codex-worker.sh", import.meta.url), "utf8");
  assert.match(script, /readonly EXPECTED_CODEX_MODEL="gpt-5\.6-sol"/u);
  assert.match(script, /value\?\.model === process\.argv\[3\]/u);
  assert.doesNotMatch(script, /test\(value\?\.model/u);
});
