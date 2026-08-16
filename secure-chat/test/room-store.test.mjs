import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RoomStore } from "../src/room-store.mjs";

test("한 방에 말과 일이 같이 남고 끝나면 상태가 바뀐다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "room-store-"));
  const store = await new RoomStore(join(dir, "room.json")).initialize();
  const started = await store.addUser("이 화면 봐");
  assert.equal(started.job.status, "running");
  assert.equal(started.job.label, "하는 중");
  const done = await store.finishJob(started.job.id, { ok: true, answer: "봤다" });
  assert.equal(done.jobs.at(-1).label, "끝남");
  assert.equal(done.messages.at(-1).content, "봤다");
  await rm(dir, { recursive: true, force: true });
});
