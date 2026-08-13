# PHASE 4 — Executor · Verifier · Replan · Development Ledger

## 구현됨

1. **Task Executor** (`src/executor/task-executor.mjs`)
   - Tool Registry + Approval Policy 게이트
   - `system.status` 실측 실행 + VERIFIED evidence
   - `web_task`/`codex`/`owner.action.execute` 등은 **자동 실행하지 않음** (`deferred: existing_module_path_required`)
2. **Task Verifier** (`src/verifier/task-verifier.mjs`)
   - `PASS` / `FAIL` / `UNKNOWN`
   - INFERRED만으로 성공 판정 **거부**
3. **Orchestrator** (`src/executor/task-orchestrator.mjs`)
   - 상태 전이 → 실행 → 검증 → `SUCCESS` 또는 `NEEDS_REPLAN`
   - `replan()` 지원
4. **Development Ledger** (`src/ledger/development-ledger.mjs`)
5. API: `POST /api/tasks/:id/run`, `.../replan`, `GET/POST /api/ledger/development`

## 기존 확장

- Task Manager 상태기계를 실제로 구동
- 승인 없는 고위험 실행 차단 유지
- Codex/web-task/owner-action **본체 대체 없음**

## 아직 자동 실행되지 않는 부분

- 쿠팡/Chrome/Codex를 TaskExecutor가 직접 수행하지 않음 (기존 승인 모듈 경로 유지)
- Verifier가 모든 외부 부수효과를 독립 관측하지는 않음 (system.status·evidence 중심)
- Ledger는 기록만 — 자동 커밋/배포 없음

## 실행

```bash
# 작업 생성 후
POST /api/tasks/:id/run
{ "tool_name": "system.status", "channel": "local_owner_app" }
```
