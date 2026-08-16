import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JobStore } from "../src/job-store.mjs";

test("같은 clientRequestId는 일을 두 번 만들지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-store-"));
  const store = await new JobStore(join(dir, "jobs.json")).initialize();
  const first = await store.start({
    conversationId: "11111111-1111-1111-1111-111111111111",
    clientRequestId: "22222222-2222-2222-2222-222222222222",
    title: "이 사진 찾아봐",
  });
  const second = await store.start({
    conversationId: "11111111-1111-1111-1111-111111111111",
    clientRequestId: "22222222-2222-2222-2222-222222222222",
    title: "이 사진 찾아봐",
  });
  assert.equal(first.replay, false);
  assert.equal(second.replay, true);
  assert.equal(first.job.id, second.job.id);
  await store.update(first.job.id, { status: "done", detail: "찾았습니다." });
  assert.equal((await store.get(first.job.id)).label, "끝남");
  await rm(dir, { recursive: true, force: true });
});

test("끝난 일은 다시 중단하지 않는다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-cancel-"));
  const store = await new JobStore(join(dir, "jobs.json")).initialize();
  const started = await store.start({
    conversationId: "11111111-1111-1111-1111-111111111111",
    title: "찾기",
  });
  await store.update(started.job.id, { status: "done", detail: "끝났습니다." });
  const cancelled = await store.cancel(started.job.id);
  assert.equal(cancelled.status, "done");
  assert.equal((await store.events()).at(-1).type, "done");
  await rm(dir, { recursive: true, force: true });
});

test("켜질 때 하던 일은 확인 필요로 바꾼다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "job-recover-"));
  const path = join(dir, "jobs.json");
  const first = await new JobStore(path).initialize();
  const started = await first.start({
    conversationId: "11111111-1111-1111-1111-111111111111",
    title: "찾기",
  });
  assert.equal(started.job.status, "running");
  const again = await new JobStore(path).initialize();
  assert.equal((await again.get(started.job.id)).status, "needs_review");
  await rm(dir, { recursive: true, force: true });
});
