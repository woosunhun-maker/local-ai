# PHASE 2 — System Introspection · Task Manager · Evidence

## 구현됨

1. **Evidence Layer** — `src/evidence/evidence.mjs`  
   - `VERIFIED` / `RETRIEVED` / `INFERRED` / `UNKNOWN`  
   - 런타임 프로브 → 자동 `VERIFIED` 기록
2. **Task Manager** — `src/task/task-manager-store.mjs`  
   - 상태: `CREATED` … `NEEDS_REPLAN`  
   - 필드: task_id, goal, status, created_at, updated_at, current_step, next_step, evidence, error, approval_required  
   - 저장: `/Users/hun/PrivateAI/data/task-manager/tasks.json`  
   - API: `GET/POST /api/tasks`, `GET /api/tasks/:id`, `POST .../transition`, `POST .../evidence`
3. **System Introspection** — `system.status`  
   - `GET /api/system/status`, `POST /api/system/command`  
   - CLI: `node scripts/system-status.mjs [--text]`  
   - 결과에 evidence 배열 포함 (추측 금지)

## 설계만 / 미완 (의도적)

- Task **자동 실행기(Executor)** · **Verifier 본문** → PHASE 4  
- Memory 4계층 · Tool Registry · Approval 일반화 → PHASE 3  
- 기존 Codex/web-task/owner-action 큐는 **대체하지 않음** (병행)

## 실행

```bash
node /Users/hun/Documents/로컬ai/secure-chat/scripts/system-status.mjs --text
cd /Users/hun/Documents/로컬ai/secure-chat && npm test
```

배포 후 owner 기기 토큰으로 `/api/system/status` · `/api/tasks` 호출.
