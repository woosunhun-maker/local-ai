# Telegram Agent Bridge

상태: 현재 보안 경계와 장기 목표를 함께 기록한 설계 문서. 아래에서 **현재**와 **목표**를 명시적으로 구분한다.

## 1. 목표

장기적으로 Telegram을 일반 대화·상태 확인용 편의 콘솔로 사용하되, Codex 작업 생성·외부 전송 승인·상세 결과는 소유자 iPhone 앱에만 둔다.

```text
사용자 Telegram
  → Mac의 Channel Gateway
  ├─ 짧은 일반 대화: 로컬 Qwen
  └─ 비민감 상태·모델·진행률: 코드 기반 결정 응답

사용자 iPhone Local AI 앱
  → exact plan 확인 + Face ID/Secure Enclave 서명
  → 격리 Codex 작업 큐
  → 상세 결과·검증된 patch 초안은 같은 소유자 앱에서만 열람
```

Telegram은 일반 대화와 비민감 상태만 운반한다. Codex 작업 원문·승인·상세 결과·기억·감사 기록의 원본은 Mac과 iPhone에 둔다.

## 2. 장기 목표 사용자 경험

이 절은 아직 전부 연결된 현재 기능이 아니라 목표 동작이다. 현재 구현 범위는 6절이 기준이다.

- 평소에는 슬래시 명령 없이 자연어로 지시한다.
- 2초 안에 `접수`, `바로 답변`, `작업 시작`, `Local AI 확인 필요` 중 하나를 알려준다.
- 오래 걸리는 작업에는 하나의 작업 ID를 부여하고 `계획 중 → 작업 중 → 검증 중 → 완료` 상태를 소유자 앱에서 갱신한다.
- 승인이 늦어지면 그 작업의 위험 단계만 멈추고, 다른 안전한 조사·작성·테스트는 계속한다.
- 결과에는 실제 수행한 일, 확인된 증거, 실패·미확인 항목, 생성된 산출물을 구분해 표시한다.
- `/status`, `/models`, `/agent status`는 모델이 꾸며낸 문장이 아니라 로컬 상태를 코드로 읽어 답한다.

## 3. 역할 분리

### Telegram

- 소유자 전용 일반 대화 입력
- 비민감 런타임 상태와 구축 진행률 표시
- 민감하지 않은 추가 지시

Telegram에서 금지할 것:

- 비밀번호, 인증번호, 토큰, 개인 문서 원문
- 구매·메일 발송·삭제·보안 변경의 최종 승인
- Local AI 장기 기억 원문 전체 노출

### Local Qwen

- 빠른 대화
- 직전 문맥 해석
- 의도 후보와 누락 조건 제안
- 외부로 보낼 내용의 개인정보 탐지 보조

Qwen은 작업 허용·거부를 최종 결정하거나 도구를 직접 실행하지 않는다.

### Mac Local Orchestrator

- 채널 인증
- 작업 레코드와 상태 저장
- 정책·권한·중복 실행 검사
- 선택적 기억 검색
- Agent 선택과 결과 검증
- 승인 대기 중 다른 안전 작업 계속
- 감사 로그와 복구

### Codex/GPT Agent

- 긴 조사, 설계, 코드 점검, 격리 초안, 테스트 제안
- 명시적으로 제공된 최소 문맥만 사용
- 결과는 제안 또는 검증 대상이며 운영 환경을 직접 변경하지 않음

이 ChatGPT 앱의 현재 대화 세션을 Telegram에서 그대로 원격 조종할 수 있다고 가정하지 않는다. 대화 연속성은 로컬 작업 저장소와 선택적 기억이 제공하고, 깊은 작업은 고정된 Codex CLI/API worker가 수행한다.

### iPhone Local AI

- 민감 원문 열람
- 정확한 실행 계획 확인
- Face ID·Secure Enclave 기반 1회 승인 또는 거부
- 긴급 중지, 승인 취소, 기기 관리

## 4. 장기 목표 라우팅 결과

모델의 자유 형식 문장을 바로 실행하지 않고 Gateway가 다음 중 하나로 확정한다.

```json
{
  "route": "LOCAL_REPLY | AGENT_TASK | OWNER_APP_REQUIRED | DENY",
  "goal": "사용자의 실제 목적",
  "facts": [],
  "inferences": [],
  "unknowns": [],
  "risk": "R0 | R1 | R2 | R3 | R4 | R5",
  "allowed_tools": [],
  "needs_approval": false
}
```

- `LOCAL_REPLY`: 일반 설명과 짧은 대화
- `AGENT_TASK`: 공개 자료 조사, 분석, 문서·코드 초안처럼 안전하고 오래 걸리는 작업
- `OWNER_APP_REQUIRED`: 민감 정보 접근 또는 실제 상태 변경
- `DENY`: 현재 권한으로 허용할 수 없거나 안전하게 고정할 수 없는 작업

이 계약은 목표 설계다. 현재 Telegram은 `AGENT_TASK`를 생성하지 않으며 `/codex inspect|draft`도 소유자 앱으로 안내만 한다. 자동 승격은 별도 회귀 시험과 명시적 릴리스 뒤에만 검토한다.

## 5. 작업 상태

```text
RECEIVED
→ PLANNING
→ RUNNING
→ VERIFYING
→ SUCCEEDED

PLANNING/RUNNING
→ WAITING_APPROVAL
→ RUNNING 또는 REJECTED/EXPIRED

모든 실행 상태
→ FAILED 또는 INTERRUPTED_UNCERTAIN
```

`INTERRUPTED_UNCERTAIN`은 자동 재시도하지 않는다. 결제, 발송, 삭제처럼 중복 실행 위험이 있는 작업은 사후 상태를 확인한 뒤 새 계획을 만든다.

## 6. 현재 실제 구현 경계

현재 존재하는 것:

- 소유자 개인 DM 제한 Telegram relay
- Qwen 일반 대화와 짧은 임시 문맥
- `/status`
- `/codex status`, `/codex help`; `/codex inspect|draft`는 실행하지 않고 Local AI 앱 승인으로 안내
- legacy Telegram 작업을 안전하게 마무리하기 위한 원자적 큐, worker lease, 결과 outbox
- Local AI 앱의 exact plan·source manifest·기기 서명 승인 뒤 OpenAI로 전송되는 허용 코드 snapshot 기반 Codex 점검·패치 초안
- Local AI 앱의 서명된 승인 기반과 안전한 웹 작업용 라이브러리·테스트

아직 연결되지 않은 것:

- 일반 자연어를 깊은 Agent 작업으로 승격하는 라우터
- Codex의 실시간 공개 웹 조사
- Telegram과 선택적 장기 기억 엔진 연결
- MomentContract를 실제 Telegram 실행 경로에 적용
- Gmail, Coupang, Home Assistant의 운영 Adapter
- Telegram 작업 진행 메시지 갱신
- Telegram 작업 생성과 iPhone 승인의 결합(의도적으로 지원하지 않음: Codex 생성은 owner 앱 전용)

따라서 Telegram `/codex`는 상태·안내 전용이며, 격리된 코드 점검·초안 worker의 새 작업은 Local AI 앱의 서명 승인 경로에서만 생성된다.

## 7. 구현 순서

1. Telegram 과잉 차단과 문맥 회귀를 수정하고 상태 응답을 사실 기반으로 고정한다.
2. durable `AgentTask` 계약과 상태 이벤트를 만든다.
3. `/agent ask|research|build|status|cancel` 수동 경로를 붙인다.
4. 공개 웹 전용 무자격증명 research worker를 격리해 연결한다.
5. 선택적 기억과 MomentContract를 읽기 경로부터 연결한다.
6. 자연어 자동 라우팅을 shadow mode로 평가한 뒤 활성화한다.
7. iPhone 승인과 작업 계획 해시를 end-to-end로 결합한다.
8. 브라우저·메일·Home Assistant Adapter를 하나씩 최소 권한으로 추가한다.

## 8. 완료 판정

- 설명 질문이 `실행`, `Telegram`, `Mac` 같은 단어만으로 차단되지 않는다.
- `이거`, `그 존재들`, `계속해`가 직전 문맥의 단일 대상을 가리키면 이어서 답한다.
- 30초가 넘는 작업은 접수와 현재 상태를 먼저 보낸다.
- 프로세스 재시작 후 작업 상태가 보존되고 중복 실행되지 않는다.
- 민감 데이터는 Telegram과 외부 Agent로 전달되지 않는다.
- 승인 화면의 계획과 실행 직전 계획 해시가 다르면 실행되지 않는다.
- 모델·웹·도구가 실패하면 성공한 척하지 않고 실패 또는 미확인 상태를 보고한다.
- 테스트 통과, staging 검증, 실제 운영 연결을 각각 따로 보고한다.

## 9. 모델 선택 원칙

로컬 모델을 사용자-facing 주력 지능으로 강제하지 않는다.

- Local Qwen: 개인정보 탐지·비식별화, 짧은 대화, 분류·요약, 오프라인 저하 모드
- Codex/GPT: 복잡한 추론, 공개 웹 조사, 고난도 코딩·검토
- 코드 정책 엔진: 허용·거부·승인 판단
- iPhone Secure App: 민감 원문과 최종 승인

로컬 모델의 품질이 요청 기준에 미달하면 반복 재시도하지 않고, 데이터 경계를 검사한 뒤 외부 고성능 모델로 승격하거나 실패를 보고한다. 외부 모델에 보낼 수 없는 민감 요청은 로컬에서 가능한 범위만 처리한다.

현재 M4 Max 48GB의 기본 운용점은 32~36B Q4 모델 한 개와 16k context다. 70B Q4 또는 100B 이상을 주력으로 삼는 대신, 7~14B 멀티모달 모델과 35B 언어 모델을 작업별로 번갈아 로드하는 구성을 우선한다.

## 10. 진행률 보고

진행률은 체감이나 코드 줄 수가 아니라 완료 게이트로 계산한다.

- 자동시험·격리 구현률
- 실제 운영 연결률
- 두 종류를 합친 전체 검증 게이트 비율
- 현재 실제 사용할 수 있는 기능
- 다음 단계와 차단점

부분 구현, 설계 문서, Mock 성공은 실제 운영 연결로 계산하지 않는다. Telegram에서 `/progress` 또는 `진행 상황`으로 같은 기준의 보고서를 요청할 수 있게 한다.
