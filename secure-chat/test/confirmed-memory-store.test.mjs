import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ConfirmedMemoryStore,
  withMemorySystemMessage,
} from "../src/confirmed-memory-store.mjs";

test("propose confirm and on-demand select", async () => {
  const root = await mkdtemp(join(tmpdir(), "confirmed-memory-"));
  const store = await new ConfirmedMemoryStore(join(root, "memory.json")).initialize();
  const candidate = await store.propose("커피는 아이스로");
  assert.equal(candidate.status, "candidate");
  assert.equal(await store.countActive(), 0);

  const active = await store.confirm(candidate.id);
  assert.equal(active.status, "active");
  assert.equal(await store.countActive(), 1);

  const block = await store.activeContextBlock("커피 뭐 마실까");
  assert.match(block, /아이스/);

  await assert.rejects(store.propose("비밀번호는 1234"), /forbidden_sensitive_memory/);
  const mode = (await readFile(join(root, "memory.json"))).toString();
  assert.ok(mode.includes("아이스"));
});

test("withMemorySystemMessage prepends system block", () => {
  const messages = [{ role: "user", content: "안녕" }];
  const withMemory = withMemorySystemMessage(messages, "사용자에 대해 확인된 기억:\n- 커피는 아이스");
  assert.equal(withMemory[0].role, "system");
  assert.match(withMemory[0].content, /아이스/);
  assert.equal(withMemory[1].content, "안녕");
});
