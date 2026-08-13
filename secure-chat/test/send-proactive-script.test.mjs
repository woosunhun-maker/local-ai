import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/send-proactive.mjs", import.meta.url));

test("proactive sender reads piped stdin and rejects it before external work when oversized", async () => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.end(Buffer.alloc(16_385, "a"));
  });

  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "오류: 메시지가 너무 큽니다.\n");
});
