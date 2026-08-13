import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compileIntentHypothesis, INTENT_HYPOTHESIS_SCHEMA } from "../src/trust/intent-negotiation.mjs";
import { IntentShadowMonitor } from "../src/trust/intent-shadow-monitor.mjs";

const hash = (character) => character.repeat(64);

function hypothesis() {
  return compileIntentHypothesis({
    schema: INTENT_HYPOTHESIS_SCHEMA,
    hypothesis_id: "intent-hypothesis.shadow.001",
    request_sha256: hash("a"),
    ingress: "local_owner_app",
    objective: { kind: "conversation.answer", summary: "합성 질문에 답한다.", effect_class: "none" },
    confidence_bps: 9_000,
    slots: [],
    ambiguities: [],
    preparations: [],
    created_at: "2026-08-05T00:00:00.000Z",
  });
}

async function createMonitor(analyze) {
  const root = await mkdtemp(join(tmpdir(), "local-ai-intent-shadow-"));
  await chmod(root, 0o700);
  const path = join(root, "metrics.json");
  const ticks = [1_000, 1_025, 2_000, 2_040];
  const monitor = new IntentShadowMonitor(path, { analyze, now: () => ticks.shift() ?? 3_000 });
  await monitor.initialize();
  return { monitor, path };
}

test("persists only aggregate outcomes and latency, never utterance or request digest", async () => {
  const privateText = "synthetic private sentence that must not persist";
  const { monitor, path } = await createMonitor(async () => hypothesis());
  assert.deepEqual(await monitor.observe({ utterance: privateText }), { ok: true, next: "answer", duration_ms: 25 });
  const stored = await readFile(path, "utf8");
  assert.equal(stored.includes(privateText), false);
  assert.equal(stored.includes(hash("a")), false);
  const status = await monitor.status();
  assert.equal(status.total, 1);
  assert.equal(status.succeeded, 1);
  assert.equal(status.next.answer, 1);
  assert.equal(status.latency.total_ms, 25);
});

test("model failures become bounded counters and concurrent writes stay consistent", async () => {
  let calls = 0;
  const { monitor } = await createMonitor(async () => {
    calls += 1;
    if (calls === 1) throw new Error("private failure detail");
    return hypothesis();
  });
  const outcomes = await Promise.all([
    monitor.observe({ utterance: "first private input" }),
    monitor.observe({ utterance: "second private input" }),
  ]);
  assert.equal(outcomes.filter((entry) => entry.ok).length, 1);
  const status = await monitor.status();
  assert.equal(status.total, 2);
  assert.equal(status.succeeded, 1);
  assert.equal(status.failed, 1);
  assert.equal(status.next.answer, 1);
  assert.equal(JSON.stringify(status).includes("private"), false);
});
