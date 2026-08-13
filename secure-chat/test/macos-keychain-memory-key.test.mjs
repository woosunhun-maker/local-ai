import assert from "node:assert/strict";
import test from "node:test";

import {
  createMacOSMemoryKeyProvider,
  MEMORY_KEYCHAIN_ACCOUNT,
  MEMORY_KEYCHAIN_SERVICE,
  MEMORY_KEY_ID,
} from "../src/trust/macos-keychain-memory-key.mjs";

test("reads one exact 256-bit key from the fixed macOS Keychain item and caches only in RAM", async () => {
  const calls = [];
  const encoded = Buffer.alloc(32, 7).toString("base64url");
  const provider = createMacOSMemoryKeyProvider({
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: `${encoded}\n`, stderr: "" };
    },
  });
  const first = await provider(MEMORY_KEY_ID);
  first.fill(0);
  const second = await provider(MEMORY_KEY_ID);
  assert.deepEqual(second, Buffer.alloc(32, 7));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/security");
  assert.deepEqual(calls[0].args, [
    "find-generic-password", "-w",
    "-s", MEMORY_KEYCHAIN_SERVICE,
    "-a", MEMORY_KEYCHAIN_ACCOUNT,
  ]);
  assert.equal(JSON.stringify(calls).includes(encoded), false);
  provider.clear();
  await provider(MEMORY_KEY_ID);
  assert.equal(calls.length, 2);
});

test("unknown ids and malformed or unavailable Keychain values fail without exposing subprocess details", async () => {
  let calls = 0;
  const provider = createMacOSMemoryKeyProvider({
    run: async () => {
      calls += 1;
      throw new Error("secret subprocess detail");
    },
  });
  await assert.rejects(provider("other.key"), /unknown_memory_key_id/u);
  assert.equal(calls, 0);
  await assert.rejects(provider(MEMORY_KEY_ID), (error) => error.message === "memory_key_unavailable" && !error.message.includes("secret"));

  const malformed = createMacOSMemoryKeyProvider({ run: async () => ({ stdout: "not-a-key", stderr: "private" }) });
  await assert.rejects(malformed(MEMORY_KEY_ID), (error) => error.message === "memory_key_invalid" && !error.message.includes("private"));
});
