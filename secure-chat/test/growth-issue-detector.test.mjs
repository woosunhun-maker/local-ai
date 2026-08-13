import assert from "node:assert/strict";
import test from "node:test";
import { compileOutboundDraft, inspectOutboundDraft } from "../src/growth/dlp.mjs";
import { detectPerformanceIssue } from "../src/growth/issue-detector.mjs";

test("creates a DLP-safe consultation draft from aggregate metadata only", () => {
  const events = [
    ...Array.from({ length: 9 }, (_, index) => ({ event: "chat", durationMs: index === 8 ? 7_000 : 400 + index })),
    { event: "request_failed", errorClass: "private raw error must not escape", deviceHash: "private-device-hash" },
  ];
  const draft = detectPerformanceIssue(events, { errorRateThreshold: 0.05 });

  assert.ok(draft);
  assert.equal(inspectOutboundDraft(draft).ok, true);
  const serialized = JSON.stringify(draft);
  assert.doesNotMatch(serialized, /private raw error|private-device-hash/);
  assert.deepEqual(draft.facts, {
    sampleCount: 10,
    medianLatencyMs: 404,
    p95LatencyMs: 407,
    failureCount: 1,
  });
  assert.match(JSON.stringify(compileOutboundDraft(draft)), /request_failed/);
});

test("stays quiet when sample size or materiality threshold is not met", () => {
  assert.equal(detectPerformanceIssue([{ event: "chat", durationMs: 20 }]), null);
  assert.equal(
    detectPerformanceIssue(Array.from({ length: 12 }, () => ({ event: "chat", durationMs: 300 }))),
    null,
  );
});
