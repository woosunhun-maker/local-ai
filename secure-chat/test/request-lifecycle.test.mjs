import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createRequestSignal } from "../src/request-lifecycle.mjs";

function connection() {
  const request = new EventEmitter();
  const response = new EventEmitter();
  response.writableEnded = false;
  return { request, response };
}

test("aborts upstream work when the request is aborted", () => {
  const { request, response } = connection();
  const signal = createRequestSignal(request, response, 10_000);

  request.emit("aborted");

  assert.equal(signal.aborted, true);
});

test("aborts upstream work when the response closes before completion", () => {
  const { request, response } = connection();
  const signal = createRequestSignal(request, response, 10_000);

  response.emit("close");

  assert.equal(signal.aborted, true);
});

test("does not mark a normally completed response as a client cancellation", () => {
  const { request, response } = connection();
  const signal = createRequestSignal(request, response, 10_000);

  response.writableEnded = true;
  response.emit("close");

  assert.equal(signal.aborted, false);
});
