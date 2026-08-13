# Development Supervisor

상위 Discussion→Task 오케스트레이션. PHASE1~5 Task/Approval/Evidence/Verifier/Cursor를 재사용한다.

## UX

사용자가 목표를 한 번 말하면 Local AI가 분석·개발·검증을 진행하고, Envelope/WRITE/고위험만 승인 요청한 뒤 결과를 보고한다.

## 흐름

```
Discussion → Inspection(system.status) → Proposal(고정 success_criteria)
  → Worktree(write root) → Approval Envelope(digest)
  → leaf Task + cursor.develop → Host Evidence → Verifier(고정 criteria)
  → ReplanPolicy(envelope 범위) → Report
```

## 4대 규칙

1. **Worktree write root** — main repo는 self-dev 중 read-only. 해당 run worktree만 write allowlist.
2. **Approval Envelope** — goal/proposal/worktree/paths/commands/risk/예산/no-merge·push·deploy를 digest로 고정. 범위 증가 시 재승인.
3. **예산** — `max_leaf_tasks`, `max_replans_per_task`, `max_total_attempts`, `max_runtime`/`expires_at`. 초과 시 `BLOCKED`.
4. **고정 success_criteria** — Cursor 실행 전 동결. Verifier는 이 기준만으로 PASS. 실행 후 모델이 완화 불가.

## API

- `POST /api/development/runs` — start
- `POST /api/development/runs/:id/inspect` — read-only inspect+propose
- `POST /api/development/runs/:id/prepare` — worktree + envelope 승인 요청
- `POST /api/development/runs/:id/continue` — leaf cursor 실행 (envelope 승인 후)
- `POST /api/development/runs/:id/merge-to-main` — **항상 403** (schema only)

## 아직 실행 금지

- 자동 commit / merge / push / deploy
- `dev.merge_to_main` 실행기
- LIVE E2E (별도 승인 후)
- owner-action / web-task / growth / Codex 연동
