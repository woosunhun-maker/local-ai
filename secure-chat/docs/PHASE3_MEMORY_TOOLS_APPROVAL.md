# PHASE 3 — Memory 계층 확장 · Tool Registry · Approval Policy

## 조사 결과 (기존 Memory — 대체하지 않음)

| 항목 | 실제 코드 |
|------|-----------|
| 저장 | `ConfirmedMemoryStore` → `PrivateAI/data/confirmed-memory/memory.json` |
| 상태 | `candidate` → `confirm` → `active` |
| 주입 | `activeContextBlock` → fast chat `withMemorySystemMessage` (on-demand) |
| 공유 | ai-council 동일 스키마 |

## 구현됨

1. **Memory Context Facade** (`src/memory/context-facade.mjs`)
   - User Memory = **기존 ConfirmedMemoryStore만** (이중화 없음)
   - Project Context = 운영 상태 자동 산출 (확인 불필요, 사용자 사실 주입 안 함)
   - Decision Memory = 별도 파일 + propose→confirm
   - Active Discussion = TTL 소프트 상태, 사용자 기억으로 자동 승격 금지
2. **Tool Registry** (`src/tools/tool-registry.mjs`) — 기존 모듈 메타데이터 등록만
3. **Approval Policy** (`src/approval/approval-policy.mjs`) — Face ID/ApprovalStore 대체 없음
4. API: `/api/memory/context`, decisions/discussions, `/api/tools`, `/api/tools/authorize-check`
5. owner-action bridge/executor에 채널·승인 게이트 연결

## 설계만 / 자동 실행 안 됨

- Tool을 플러그인으로 동적 로딩·재작성하지 않음
- Registry가 web-task/codex를 직접 실행하지 않음
- Decision/Discussion을 채팅 시스템 프롬프트에 자동 주입하지 않음
- **Executor/Verifier 본문 → PHASE 4**

## 테스트 포인트

- 확인형 기억 파일에 decision/discussion이 섞이지 않음
- Telegram에서 effect tool 실행 deny
- 승인 없이 web_task.execute deny
- enabled vs available 구분
