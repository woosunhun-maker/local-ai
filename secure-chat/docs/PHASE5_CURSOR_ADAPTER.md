# PHASE 5 — CursorDevelopmentAdapter (vertical slice)

## 범위

- Tool: `cursor.develop` 만
- Transport: `agent acp` (GUI 자동화 없음)
- 인증: 사용자 `agent login` (API key 무인 인증 제외)
- 자동 commit/push/deploy 금지
- CodexPollingAdapter / owner-action / web-task / growth 미포함

## 환경 (실측)

- Cursor Desktop 3.15.19
- agent `~/.local/bin/agent` → `2026.08.11-e8db854`
- CLI 로그인 후 `agent --list-models` 정상
- ACP `initialize` → `authenticate(cursor_login)` → `session/new` → `session/prompt` 확인됨

## 흐름

```
Task Manager
  → ApprovalStore (kind=cursor.develop)
  → Cursor ACP (agent acp)
  → session/request_permission → ApprovalStore (kind=cursor.tool_permission)
  → Host Result Collector (git/test)
  → VERIFIED Evidence
  → Verifier
  → SUCCESS / NEEDS_REPLAN / FAILED
  → Development Ledger (비비밀 메타)
```

## API

```http
POST /api/tasks/:id/run
{
  "tool_name": "cursor.develop",
  "channel": "local_owner_app",
  "prompt": "작은 안전 변경 지시",
  "test_command": "npm test --prefix secure-chat -- test/phase5-cursor-adapter.test.mjs"
}
```

- `has_approval` boolean은 cursor.develop 실행 권한에 사용하지 않음
- 승인: 기존 ApprovalStore decide (owner 앱)

## Sandbox

- cwd / write root: `/Users/hun/Documents/로컬ai`
- 금지: `diol-os/`, `/Users/hun/PrivateAI`, root 밖
- Telegram: `cursor.develop` 실행 금지

## Permission

| 등급 | 처리 |
|------|------|
| READ | `allow-once` 자동 가능 |
| EXECUTE (allowlist) | `allow-once` 자동 가능 |
| WRITE | ApprovalStore 대기 → `allow-once`만 |
| HIGH RISK | ApprovalStore 대기 또는 거부 |
| — | **`allow-always` 사용 금지** |

## Host collector (VERIFIED)

task_id, session_id, 시작/종료, stop/exit/error/cancel, 변경 파일, git status/diff/hash, test 명령/exit code

Cursor 자연어 “완료”는 INFERRED이며 SUCCESS 근거가 아님.

## 구현 파일

- `src/adapters/cursor/acp-client.mjs`
- `src/adapters/cursor/sandbox.mjs`
- `src/adapters/cursor/permission-bridge.mjs`
- `src/adapters/cursor/host-result-collector.mjs`
- `src/adapters/cursor/cursor-development-adapter.mjs`
- Orchestrator / server / tool-registry / task bindings 연동
- `test/phase5-cursor-adapter.test.mjs`
