import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DevelopmentLedgerStore } from "../src/ledger/development-ledger.mjs";

test("development ledger records required change fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ledger-"));
  try {
    const store = await new DevelopmentLedgerStore(join(dir, "changes.json"), {
      now: () => Date.parse("2026-08-14T04:00:00.000Z"),
    }).initialize();
    const entry = await store.record({
      request: "PHASE4 Executor/Verifier 추가",
      proposedBy: "local-ai",
      approvedBy: "owner",
      filesChanged: ["src/executor/task-executor.mjs", "src/verifier/task-verifier.mjs"],
      tests: "npm test 384+",
      verification: "PASS",
      rollbackReference: "git:ec32afe",
    });
    assert.ok(entry.change_id);
    assert.equal(entry.request.includes("PHASE4"), true);
    assert.equal(entry.files_changed.length, 2);
    assert.equal(entry.timestamp, "2026-08-14T04:00:00.000Z");
    const listed = await store.list();
    assert.equal(listed[0].change_id, entry.change_id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
