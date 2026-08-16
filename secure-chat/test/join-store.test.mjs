import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JoinStore } from "../src/join-store.mjs";

test("맥이 허용하기 전에는 토큰이 없고, 허용하면 받을 수 있다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "join-store-"));
  const store = await new JoinStore(join(dir, "joins.json")).initialize();
  const asked = await store.request("아이폰");
  assert.equal((await store.wait(asked.id)).status, "pending");
  assert.equal((await store.pending()).length, 1);
  await store.allow(asked.id, "device-token-value-ok");
  const ready = await store.wait(asked.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.deviceToken, "device-token-value-ok");
  await rm(dir, { recursive: true, force: true });
});
