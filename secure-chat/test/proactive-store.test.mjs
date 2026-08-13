import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProactiveStore } from "../src/proactive-store.mjs";

test("queues and consumes proactive messages once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-proactive-"));
  const path = join(directory, "messages.json");
  const store = new ProactiveStore(path);
  await store.initialize();
  await store.enqueue("먼저 건넨 말");

  const first = await store.consumePending();
  assert.equal(first.length, 1);
  assert.equal(first[0].content, "먼저 건넨 말");
  assert.deepEqual(await store.consumePending(), []);

  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.ok(persisted.messages[0].deliveredAt);
});

test("independent proactive store instances cannot lose concurrent enqueues or consume the same message twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-proactive-concurrent-"));
  const path = join(directory, "messages.json");
  const first = new ProactiveStore(path);
  const second = new ProactiveStore(path);
  await Promise.all([first.initialize(), second.initialize()]);

  await Promise.all(Array.from({ length: 12 }, (_, index) => {
    const store = index % 2 === 0 ? first : second;
    return store.enqueue(`동시 알림 ${index}`);
  }));
  const persisted = JSON.parse(await readFile(path, "utf8"));
  assert.equal(persisted.messages.length, 12);
  assert.equal(new Set(persisted.messages.map((message) => message.id)).size, 12);

  const [left, right] = await Promise.all([first.consumePending(), second.consumePending()]);
  assert.equal(left.length + right.length, 12);
  assert.equal((left.length === 12 && right.length === 0) || (left.length === 0 && right.length === 12), true);
  assert.deepEqual(await first.consumePending(), []);
});

test("rejects empty and oversized proactive messages", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-proactive-"));
  const store = new ProactiveStore(join(directory, "messages.json"));
  await store.initialize();

  await assert.rejects(() => store.enqueue("   "), /invalid_proactive_message/);
  await assert.rejects(() => store.enqueue("가".repeat(4_001)), /invalid_proactive_message/);
});

test("initialize normalizes an existing private store and rejects a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-proactive-mode-"));
  const path = join(directory, "messages.json");
  await writeFile(path, '{"messages":[]}\n', { mode: 0o644 });
  await new ProactiveStore(path).initialize();
  assert.equal((await lstat(path)).mode & 0o777, 0o600);

  const symlinkPath = join(directory, "symlink.json");
  await symlink(path, symlinkPath);
  await assert.rejects(new ProactiveStore(symlinkPath).initialize(), /invalid_proactive_store_inode/u);
});
