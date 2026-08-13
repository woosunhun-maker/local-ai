const GATES_PER_KIND = 4;

// Progress is evidence-based, not an estimate. A gate is counted only after
// its automated contract (test) or real runtime path (operation) is verified.
// Partial implementations, mocks, and design documents count as zero.
export const PROJECT_PROGRESS_BASELINE = Object.freeze([
  Object.freeze({ id: "evidence", title: "사실 기준선", testsDone: 4, operationsDone: 2 }),
  Object.freeze({ id: "identity", title: "신원·채널 보안", testsDone: 3, operationsDone: 2 }),
  Object.freeze({ id: "models", title: "대화·모델·음성", testsDone: 4, operationsDone: 1 }),
  Object.freeze({ id: "intent", title: "의도·정책", testsDone: 4, operationsDone: 0 }),
  Object.freeze({ id: "memory", title: "사용자 통제 기억", testsDone: 4, operationsDone: 1 }),
  Object.freeze({ id: "tools", title: "Agent·도구 실행", testsDone: 4, operationsDone: 0 }),
  Object.freeze({ id: "approval", title: "승인·감사·효과", testsDone: 4, operationsDone: 1 }),
  Object.freeze({ id: "release", title: "릴리즈·비상 운영", testsDone: 2, operationsDone: 1 }),
]);

export const LIVE_CAPABILITIES = Object.freeze([
  "소유자 전용 Telegram 일반 대화와 짧은 임시 문맥",
  "Qwen3.6 35B 로컬 대화",
  "확인형 공통 장기기억(아이폰·맥 웹 공유 경로)",
  "격리 Codex 코드 점검·변경 초안 작업 큐와 결과 회신",
  "Mac loopback 보안 서버와 tailnet 접속",
  "iPhone Local AI앱 인증·서명 승인 기반",
  "system.status 실측 인트로스펙션과 Task Manager 상태 기계",
]);

export const NEXT_CAPABILITIES = Object.freeze([
  "브라우저 대행의 완전 자동 붙여넣기·전송",
  "암호화 Keychain 기억으로 확인형 저장소 승격",
  "Memory 4계층·Tool Registry·Approval 일반화",
  "Executor/Verifier 본문과 실패 시 재계획 루프",
  "공개 웹 조사 worker와 Gmail·Coupang·Home Assistant Adapter",
]);

function boundedGateCount(value) {
  if (!Number.isInteger(value) || value < 0 || value > GATES_PER_KIND) {
    throw new Error("invalid_project_progress_gate_count");
  }
  return value;
}

function percentage(done, total) {
  return Math.round((done / total) * 100);
}

export function collectProjectProgress(stages = PROJECT_PROGRESS_BASELINE) {
  if (!Array.isArray(stages) || stages.length < 1) throw new Error("invalid_project_progress_stages");
  const normalizedStages = stages.map((stage) => {
    const testsDone = boundedGateCount(stage?.testsDone);
    const operationsDone = boundedGateCount(stage?.operationsDone);
    if (typeof stage?.id !== "string" || !/^[a-z][a-z0-9_-]{1,31}$/u.test(stage.id)) {
      throw new Error("invalid_project_progress_stage_id");
    }
    if (typeof stage?.title !== "string" || stage.title.length < 1 || stage.title.length > 40) {
      throw new Error("invalid_project_progress_stage_title");
    }
    return Object.freeze({
      id: stage.id,
      title: stage.title,
      testsDone,
      operationsDone,
      testsPercent: percentage(testsDone, GATES_PER_KIND),
      operationsPercent: percentage(operationsDone, GATES_PER_KIND),
      combinedPercent: percentage(testsDone + operationsDone, GATES_PER_KIND * 2),
    });
  });
  const testsDone = normalizedStages.reduce((sum, stage) => sum + stage.testsDone, 0);
  const operationsDone = normalizedStages.reduce((sum, stage) => sum + stage.operationsDone, 0);
  const totalPerKind = normalizedStages.length * GATES_PER_KIND;
  return Object.freeze({
    schema: "local-ai.project-progress.v1",
    stages: Object.freeze(normalizedStages),
    tests: Object.freeze({ done: testsDone, total: totalPerKind, percent: percentage(testsDone, totalPerKind) }),
    operations: Object.freeze({ done: operationsDone, total: totalPerKind, percent: percentage(operationsDone, totalPerKind) }),
    overall: Object.freeze({
      done: testsDone + operationsDone,
      total: totalPerKind * 2,
      percent: percentage(testsDone + operationsDone, totalPerKind * 2),
    }),
  });
}

export function formatProjectProgress(progress = collectProjectProgress()) {
  if (progress?.schema !== "local-ai.project-progress.v1") throw new Error("invalid_project_progress");
  return [
    "대형 개인 AI 구축 진행 상황",
    `• 전체 검증 게이트: ${progress.overall.percent}% (${progress.overall.done}/${progress.overall.total})`,
    `• 자동시험·격리 구현: ${progress.tests.percent}% (${progress.tests.done}/${progress.tests.total})`,
    `• 실제 운영 연결: ${progress.operations.percent}% (${progress.operations.done}/${progress.operations.total})`,
    "",
    "단계별 (통합 · 시험 · 운영)",
    ...progress.stages.map((stage, index) => `${index + 1}. ${stage.title}: ${stage.combinedPercent}% · ${stage.testsPercent}% · ${stage.operationsPercent}%`),
    "",
    "현재 실제 가능한 기능",
    ...LIVE_CAPABILITIES.map((capability) => `• ${capability}`),
    "",
    `다음 구현: ${NEXT_CAPABILITIES[0]}`,
    "부분 구현·문서·Mock은 완료로 계산하지 않습니다.",
  ].join("\n");
}
