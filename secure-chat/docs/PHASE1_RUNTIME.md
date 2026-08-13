# PHASE 1 — 상시 실행 · Health · Structured Logging

## 구현됨

1. Git baseline (`d98b2e5`) — `secure-chat` + `ai-council`
2. Health monitor 소스화 — `ops/health/` + `scripts/sync-health-monitor.sh`
3. 런타임 검증 — `scripts/verify-local-ai-runtime.sh`
4. 시스템 상태 API — `GET /api/system/status` (owner + status scope)
5. 구조화 로그 — `src/structured-event-log.mjs` → `/Users/hun/PrivateAI/logs/structured/`
6. secure-chat / Telegram 일반대화에 `request_received` · `router_selected` · `model_invoked` · `task_*` 연동

## 설계만 / 미완 (의도적)

- Task Manager, Evidence, Memory 4계층, Tool Registry, Approval 일반화, Verifier, Dev Ledger → PHASE 2+
- `planner_invoked` / `tool_invoked` / `verification_*` 이벤트는 스키마만 준비 (실제 Planner·Tool 프로세스 없음)
- Cursor Run 버튼 제거는 해당 없음 — 서비스는 이미 launchd KeepAlive

## 실행

```bash
# 소스 → health monitor 런타임 동기화
zsh /Users/hun/Documents/로컬ai/secure-chat/scripts/sync-health-monitor.sh

# 상시 실행 점검
zsh /Users/hun/Documents/로컬ai/secure-chat/scripts/verify-local-ai-runtime.sh

# 코드 배포(기존 절차, 서비스 재시작 포함)
zsh /Users/hun/Documents/로컬ai/secure-chat/scripts/deploy-runtime.sh
```

재부팅 후: LaunchAgent `RunAtLoad`/`KeepAlive`로 Ollama·secure-chat·Telegram 등이 자동 기동되는지 `verify-local-ai-runtime.sh`로 확인한다.
