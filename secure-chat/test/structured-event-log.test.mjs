import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STRUCTURED_EVENTS,
  createStructuredEventLog,
  newCorrelationId,
} from "../src/structured-event-log.mjs";

test("structured log writes correlation id and timestamp without free-form payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "structured-log-"));
  try {
    const log = createStructuredEventLog({
      logDir: dir,
      clock: () => new Date("2026-08-14T00:00:00.000Z"),
    });
    const correlationId = newCorrelationId();
    const record = await log.emit("request_received", {
      correlationId,
      ingress: "test",
      secret_blob: { nested: true },
    });
    assert.equal(record.event, "request_received");
    assert.equal(record.correlationId, correlationId);
    assert.equal(record.timestamp, "2026-08-14T00:00:00.000Z");
    assert.equal(record.ingress, "test");
    assert.equal(record.secret_blob, undefined);
    const raw = await readFile(join(dir, "2026-08-14.jsonl"), "utf8");
    assert.match(raw, /request_received/);
    assert.ok(STRUCTURED_EVENTS.includes("router_selected"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects unknown structured events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "structured-log-"));
  try {
    const log = createStructuredEventLog({ logDir: dir });
    await assert.rejects(() => log.emit("not_a_real_event", {}), /unsupported_structured_event/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
