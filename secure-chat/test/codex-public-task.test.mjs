import assert from "node:assert/strict";
import test from "node:test";
import { safeCodexSummary } from "../src/codex/public-task.mjs";

test("safeCodexSummary accepts an ordinary bounded summary", () => {
  assert.equal(safeCodexSummary("격리된 코드 점검을 완료했습니다."), "격리된 코드 점검을 완료했습니다.");
});

test("safeCodexSummary suppresses provider credentials", () => {
  const syntheticCredentials = [
    ["thin", "qpat_", "a".repeat(56)].join(""),
    ["A", "KIA", "B".repeat(16)].join(""),
    ["AI", "za", "C".repeat(35)].join(""),
    ["123456789", ":", "D".repeat(35)].join(""),
  ];
  for (const credential of syntheticCredentials) {
    assert.equal(safeCodexSummary(`점검 결과 ${credential}`), null);
  }
});
