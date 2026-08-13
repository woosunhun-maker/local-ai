import assert from "node:assert/strict";
import test from "node:test";

import {
  collectProjectProgress,
  formatProjectProgress,
  LIVE_CAPABILITIES,
  PROJECT_PROGRESS_BASELINE,
} from "../src/project-progress.mjs";

test("project progress is derived only from explicit test and operation gates", () => {
  const progress = collectProjectProgress();
  assert.equal(PROJECT_PROGRESS_BASELINE.length, 8);
  assert.deepEqual(progress.tests, { done: 29, total: 32, percent: 91 });
  assert.deepEqual(progress.operations, { done: 8, total: 32, percent: 25 });
  assert.deepEqual(progress.overall, { done: 37, total: 64, percent: 58 });
  assert.equal(progress.stages[0].combinedPercent, 75);
});

test("progress report separates tested components from live user capability", () => {
  const report = formatProjectProgress();
  assert.match(report, /전체 검증 게이트: 58% \(37\/64\)/u);
  assert.match(report, /자동시험·격리 구현: 91% \(29\/32\)/u);
  assert.match(report, /실제 운영 연결: 25% \(8\/32\)/u);
  assert.match(report, /현재 실제 가능한 기능/u);
  for (const capability of LIVE_CAPABILITIES) assert.ok(report.includes(capability), capability);
  assert.match(report, /부분 구현·문서·Mock은 완료로 계산하지 않습니다/u);
});

test("invalid or inflated gates fail closed", () => {
  assert.throws(
    () => collectProjectProgress([{ id: "fake", title: "가짜", testsDone: 5, operationsDone: 0 }]),
    /invalid_project_progress_gate_count/u,
  );
});
