import assert from "node:assert/strict";
import test from "node:test";
import { BoundedAsyncQueue } from "../src/tts/bounded-async-queue.mjs";

test("bounded queue applies producer backpressure until a consumer makes room", async () => {
  const queue = new BoundedAsyncQueue(1);
  await queue.push("first");
  let secondSettled = false;
  const secondPush = queue.push("second").then(() => { secondSettled = true; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  assert.equal(queue.pendingWriters, 1);
  assert.deepEqual(await queue.shift(), { value: "first", done: false });
  await secondPush;
  assert.equal(secondSettled, true);
  assert.deepEqual(await queue.shift(), { value: "second", done: false });
  queue.close();
  assert.deepEqual(await queue.shift(), { value: undefined, done: true });
});

test("aborting a blocked producer removes it without discarding queued audio", async () => {
  const queue = new BoundedAsyncQueue(1);
  const controller = new AbortController();
  await queue.push(Buffer.from([1]));
  const blocked = queue.push(Buffer.from([2]), { signal: controller.signal });
  controller.abort("user_stopped_playback");

  await assert.rejects(blocked, (error) => error.code === "cancelled");
  assert.equal(queue.pendingWriters, 0);
  assert.deepEqual((await queue.shift()).value, Buffer.from([1]));
});
