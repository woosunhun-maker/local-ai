import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { streamTtsEvents, writeWithDrain } from "../src/tts/http-stream.mjs";

class BackpressuredResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writes = [];
  acceptWrites = false;

  write(value) {
    this.writes.push(value);
    return this.acceptWrites;
  }

  end() {
    this.writableEnded = true;
  }
}

test("TTS HTTP streaming waits for drain before requesting another private audio event", async () => {
  const response = new BackpressuredResponse();
  let produced = 0;
  async function* events() {
    produced += 1;
    yield { type: "state", state: "preparing" };
    produced += 1;
    yield { type: "state", state: "completed" };
  }

  const streaming = streamTtsEvents(response, events());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(produced, 1);
  assert.equal(response.writes.length, 1);
  response.acceptWrites = true;
  response.emit("drain");
  await streaming;
  assert.equal(produced, 2);
  assert.equal(response.writableEnded, true);
});

test("TTS HTTP drain wait aborts immediately when the client disconnects", async () => {
  const response = new BackpressuredResponse();
  const controller = new AbortController();
  const pending = writeWithDrain(response, "private audio", { signal: controller.signal });
  controller.abort("client_disconnected");
  await assert.rejects(pending, /client_disconnected/);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
});
