# 전 세계 개인 AI 활용 아이디어 TOP 10과 실행 TOP 3

- 기준일: 2026-08-08 (Asia/Seoul)
- 목적: 공개 구현·연구·현재 로컬 AI 자산을 함께 비교해, **다시 만들 가치가 있는 것과 이미 가진 것을 연결할 일**을 구분한다.
- 상태: 조사·평가 보고서. **구현 승인 문서가 아니며, 사용자 검토 전에는 코딩하지 않는다.**

## 1. 결론부터

현재 가장 좋은 방향은 더 큰 로컬 LLM이나 새 채팅 UI를 만드는 것이 아니다. 이미 존재하는 `iPhone 승인 → Mac 정책 → 격리 실행 → 결과 반환`, Telegram 일반대화, 선택적 기억, 능동 알림의 기반을 하나의 검증 루프로 묶는 것이다.

권장 운영 TOP 3는 다음과 같다.

1. **Secure Action Inbox — 운영 기반 A**  
   iPhone에서 실제 실행 내용·외부 전송 범위·만료를 확인하고 서명하는 단일 작업함이다.
2. **Exception-Only Briefing — 검증 실험 A**  
   AI가 정상 상태를 계속 말하지 않고, 증거가 충돌하거나 승인이 만료되기 직전인 예외만 정해진 시각에 묶어 보여준다.
3. **Memory Review & Intent Continuity — 개인정보·연속성 기반 B**  
   대화를 전부 기억하지 않고, 근거·목적·만료가 있는 기억 후보만 iPhone에서 검토해 활성화한다.

이를 떠받치는 세 가지 연구 구조는 별도 제품이 아니라 하나의 폐루프다.

> **Capability Forge가 능력을 만든다 → Evidence Twin Auditor가 실제 결과를 검증한다 → Attention Governor가 필요한 예외만 사용자에게 올린다 → 실패는 Forge의 회귀시험이 된다.**

첫 실행 순서는 `iPhone 종단시험 → 표준 증거장부 → OCR/시간축 MVP → 상태·오류 알림 → Telegram/민감 앱 분리 완결`이다.

### 레드팀 정정

- 위 세 항목은 **운영 기반 우선순위**이지, 시간 절약 효과가 검증된 순위가 아니다.
- 실제 시간 절약 실험 TOP 3는 `읽기 전용 이메일·문서 분류/초안`, `표준 Evidence Ledger 합계·누락 검사`, `결정형 Home Assistant 반복작업/상태 예외`로 별도 관리한다.
- `Exception-Only Briefing`은 최초 14일 동안 전체 기록과 나란히 보여주는 그림자 모드로 시험하고, 중요 사건 누락이 1건이라도 발생하면 자동 숨김을 중단한다.
- 가게 CCTV 감사는 개인정보·노무·고지·보유·접근에 대한 한국 법률 검토 전 실제 영상으로 구현하지 않는다. CCTV 또는 별도 마이크를 통한 고객·직원 대화 녹음·전사는 기능 후보에서도 제외한다.
- 상세 반론과 출시 게이트는 [레드팀 보고서](GLOBAL_IDEAS_RED_TEAM_2026-08-08.md)에 기록했다. 현재 종합 판정은 **CONDITIONAL PASS**다.

## 2. 이 문서에서 사실과 추론을 구분하는 법

| 표시 | 의미 |
|---|---|
| **출처 원문 확인** | 공식 문서·공식 연구·원 논문이 직접 기재한 내용. 독립 재현을 뜻하지는 않음 |
| **로컬 문서/코드 확인** | 현재 저장소의 README·소스·시험 파일로 확인한 구현 상태 |
| **추론** | 공개 근거와 현재 자산을 결합한 설계 판단. 아직 사용자 환경에서 효과가 검증되지 않음 |
| **측정 목표** | 실험 성공 기준. 예상 절약량이나 보장된 성능이 아님 |

### 중요한 해석 제한

- GitHub 별 수는 **개발자 생태계의 관심과 재사용 가능성을 보여주는 지표**일 뿐, 실제 사용자 수·품질·보안·사업 효과의 증거가 아니다.
- 논문의 계산량 감소는 곧바로 사용자의 시간 절약을 뜻하지 않는다.
- 다른 조직의 생산성 수치를 개인 환경에 그대로 적용하지 않는다.
- 현재 실행 중인 서비스의 실시간 상태는 이 보고서에서 다시 점검하지 않았다. 따라서 로컬 상태는 문서·코드 기준이며, 운영 여부는 배포 전 별도 확인이 필요하다.

## 3. 공개 근거에서 확인되는 큰 흐름

### 3.1 사람들이 AI에 실제로 맡기는 일

- OpenAI의 150만 개 대화 표본 연구에서는 조사 당시 약 7억 주간 활성 이용자가 있었고, 대화의 약 70%가 비업무 용도였다. 대화 의도는 `질문/조언 49%`, `작업 수행 40%`, `표현 11%`로 분류됐다. 즉 개인 AI의 중심은 거대한 자율 에이전트보다 **조언·정보·글쓰기·일상 작업의 반복 마찰 제거**에 가깝다. **출처 원문 확인.** [OpenAI 연구](https://openai.com/index/how-people-are-using-chatgpt/)
- OpenAI Signals는 조사 대상 장기 이용자 집단에서 가입 6개월 뒤 하루 메시지가 50% 늘고 사용 작업 종류가 두 배가 됐다고 보고했다. 이는 사용 깊이와 범위가 증가한 관찰이며, 그 원인이 신뢰 축적인지는 이 자료만으로 확인할 수 없다. **출처 원문 확인.** [OpenAI Signals](https://openai.com/index/how-chatgpt-adoption-has-expanded/)

### 3.2 시간 절약이 실제로 확인된 영역

- Microsoft의 약 6,000명 현장 실험에서 생성형 AI 이용자는 주당 이메일 시간이 약 3시간, 비율로는 25% 줄었다. 무작위 배정 기준 효과는 1.4시간이었다. 따라서 이메일 요약·분류·초안은 현재 공개 근거가 가장 강한 자동화 후보 중 하나다. **출처 원문 확인.** [Microsoft Research](https://www.microsoft.com/en-us/research/publication/shifting-work-patterns-with-generative-ai/)
- Microsoft의 4,867명 개발자 현장 실험에서는 완료 작업이 26.08% 늘었다. GitHub의 95명 통제 실험에서는 Copilot 사용 그룹이 과제를 55% 빠르게 끝냈다. 이는 **격리된 코드 초안·검토·시험 생성**의 가치 근거이지, AI가 운영 코드를 자동 배포해도 된다는 근거가 아니다. **출처 원문 확인.** [Microsoft Research](https://www.microsoft.com/en-us/research/publication/the-effects-of-generative-ai-on-high-skilled-work-evidence-from-three-field-experiments-with-software-developers/) · [GitHub Research](https://github.blog/news-insights/research/research-quantifying-github-copilots-impact-on-developer-productivity-and-happiness/)
- Microsoft의 2026 Work Trend Index에서는 AI 이용자의 66%가 고가치 업무에 더 많은 시간을 쓴다고 답했고, 58%는 1년 전에는 만들 수 없던 결과물을 만든다고 답했다. 이는 자기보고이므로 인과효과가 아닌 **사용자 체감 지표**로만 해석한다. [Microsoft WorkLab](https://www.microsoft.com/en-us/worklab/work-trend-index/agents-human-agency-and-the-opportunity-for-every-organization)

### 3.3 로컬·개인 에이전트의 공개 기반

- Home Assistant는 2025년에 200만 활성 설치를 발표했고, 현재 공개 분석 페이지는 참여 동의 기반 설치 통계를 제공한다. 이는 개인 공간 자동화가 대규모로 실제 운영되는 영역임을 보여준다. [Home Assistant 발표](https://www.home-assistant.io/blog/2025/05/07/release-20255) · [공개 분석](https://analytics.home-assistant.io/)
- Home Assistant의 공식 Voice Pipeline과 Actionable Notifications는 음성 입력과 알림 버튼을 지원한다. 다만 고위험 승인에 필요한 계획 고정·전자서명을 대신하지는 않는다. [Voice Pipeline](https://developers.home-assistant.io/docs/voice/pipelines/) · [Actionable Notifications](https://companion.home-assistant.io/docs/notifications/actionable-notifications/)
- OpenAI Agents SDK는 중단 가능한 human-in-the-loop 흐름을, Apple은 Secure Enclave P-256 서명과 Face ID/Touch ID 인증 API를 제공한다. 이 조합은 iPhone 서명 승인 설계의 공식 기반이 된다. [OpenAI HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/) · [Apple Secure Enclave](https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey) · [Apple LocalAuthentication](https://developer.apple.com/documentation/localauthentication/logging-a-user-into-your-app-with-face-id-or-touch-id)
- MCP 2025-11-25 사양은 사용자 동의, 도구 안전, OAuth 리소스 결속과 최소 권한을 강조한다. 채널마다 권한을 분리하는 현재 방향과 일치한다. [MCP 사양](https://modelcontextprotocol.io/specification/2025-11-25) · [보안 모범 사례](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

## 4. 현재 로컬 AI와의 겹침·공백

### 로컬 문서/코드로 확인된 기반

- iPhone LocalAI `1.2.0 (build 9)`의 SwiftUI 대화, 처리 상태, Siri/App Intents, Secure Enclave 승인 모델이 존재한다.
- Telegram은 소유자 개인 DM의 일반대화·상태 조회로 제한하고, 중요한 Codex 실행은 받지 않는 경계가 문서화돼 있다.
- Codex `inspect/draft`는 제한 소스·DLP·격리 복사본·검증된 diff 흐름을 갖는다.
- MomentContract, intent binding, approval preview, selective memory, encrypted store, memory firewall 관련 소스와 시험이 존재한다.
- 웹 작업은 계약과 정책이 중심이며 실제 쿠팡/Gmail UI executor 검증은 남아 있다.
- 가게 통제 기준안과 장부·카메라 감사 목표는 있으나, 실제 OCR·영상 사건 추출·증거 시간축 엔진은 아직 없다.

### 가장 큰 공백

1. iPhone 승인 경로의 실기기 종단 검증
2. 기능별 계약을 묶는 공통 효과 장부와 독립 검증자
3. 장부·계좌·영수증·재고·CCTV의 표준 사건 ID와 시간축
4. 정상 상태는 숨기고 예외만 올리는 주의력 정책
5. 선택적 기억의 실제 서버 API와 iPhone 검토 화면
6. 실패를 재현 시험으로 바꾸고 능력을 승격·강등하는 운영 규칙

이 판단은 2026-08-05 재사용·공백 지도와 현재 저장소를 바탕으로 한 **로컬 문서/코드 확인 + 추론**이다.

로컬 근거: [현재 기능 README](../README.md) · [재사용·공백 지도](../../research/EXISTING_ASSET_REUSE_AND_GAP_MAP_2026-08-05.md) · [가게 운영 통제 기준안](STORE_CONTROL_BASELINE_v0.1.md) · [취침 중 아이디어 조사](SLEEP_IDEA_SCAN_2026-08-08.md)

## 5. 전 세계 공개 구현을 반영한 후보 TOP 10

시간 절약 항목의 숫자는 외부 연구가 직접 존재하는 경우만 사실로 표기했다. 나머지는 실제 사용 전 측정해야 하는 목표다.

| 순위 | 후보 | 해결할 문제 | 공개 구현·근거 | 현재 자산과의 겹침 | 기대효과와 한계 |
|---:|---|---|---|---|---|
| 1 | **가게 Evidence Twin Auditor** | 장부·입금·영수증·직원 정산·재고·CCTV가 서로 분리돼 누락 원인을 찾기 어렵다. | Frigate는 로컬 NVR, 객체 감지, MQTT, Home Assistant 연동을 제공한다. [Frigate](https://github.com/blakeblackshear/frigate) · [HA 연동](https://docs.frigate.video/integrations/home-assistant/) | 가게 규칙·기호·위험 시점·통제 기준은 있음. 표준 사건 장부, OCR, 영상 사건 추출, 시간 동기화가 공백. | 가장 차별화되고 실제 손실과 연결된다. 단, 시스템은 **불일치와 증거 묶음만** 제시하고 절도·고의·범인을 판정하면 안 된다. 오탐 피해가 크므로 그림자 운영부터 시작한다. |
| 2 | **iPhone Secure Action Inbox** | Mac 화면을 보지 않고도 중요한 작업 내용을 정확히 확인·승인해야 한다. | OpenAI HITL, Apple Secure Enclave·LocalAuthentication은 각각 중단형 승인과 기기 서명 기반을 제공한다. | 승인 스키마·서명 모델·Codex 작업 화면이 이미 있다. 실기기 E2E, 만료·재사용·다른 기기 거부 검증이 우선. | 화면 전환과 승인 혼란을 줄일 핵심 연결고리다. 절약량은 아직 미측정. Face ID 성공 자체가 계획 내용을 이해했다는 뜻은 아니다. |
| 3 | **Telegram 편의 채널 + 민감 앱 권한 분리** | Telegram은 편하지만 종단간 암호화·세밀한 승인 채널로 쓰기 어렵다. | NanoClaw는 여러 채널과 컨테이너 격리를 공개 구현했다. MCP는 최소 권한·사용자 동의를 명시한다. [NanoClaw](https://github.com/nanocoai/nanoclaw) · [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | Telegram 일반대화와 LocalAI 중요 작업 분리는 이미 강한 기반. 안전한 handoff와 일회용 앱 열기 흐름이 공백. | 익숙한 대화 UX를 유지하면서 중요정보 노출을 줄인다. 채널 간 문맥을 자동 공유하면 경계가 무너지므로 요청 원문 대신 일회용 참조만 전달해야 한다. |
| 4 | **능동형 Home Assistant 생활 운영자** | 사용자가 먼저 묻지 않으면 AI가 필요한 순간을 놓친다. | HA는 200만 활성 설치 발표, Voice Pipeline, actionable notification을 제공한다. | 알림 기반은 있으나 센서·기기 adapter와 위험별 제어 정책은 부족하다. | 보안·누수·공기질·기기 이상 등 실제 생활 마찰을 줄일 수 있다. 모든 엔티티를 LLM에 넣지 말고 결정적 규칙이 후보를 만든 뒤 AI가 설명하게 해야 한다. |
| 5 | **선택적 기억 + Sleep-time 연구자** | 전 대화를 저장하면 오류·민감정보·낡은 취향이 누적되고, 저장하지 않으면 연속성이 사라진다. | MemGPT는 계층형 기억, Letta는 상태형 에이전트 구현, Sleep-time 연구는 같은 정확도에서 시험 시 계산량 약 5배 감소를 보고했다. [MemGPT](https://arxiv.org/abs/2310.08560) · [Letta Code](https://github.com/letta-ai/letta-code) · [Sleep-time Compute](https://arxiv.org/abs/2504.13171) | 암호화 후보·상태 전이·목적 제한·방화벽이 있다. 실제 API와 iPhone 검토 UI가 없다. | 장기 개인화의 핵심이다. 논문의 계산 절약은 인간 시간 절약이 아니며, AI 추론 기억은 사용자 확인 전 활성화하면 안 된다. |
| 6 | **이메일·문서 백오피스 조수** | 중요 메일 찾기, 요약, 답장 초안, 영수증·계약서 분류가 반복 시간을 잡아먹는다. | 이메일 현장 실험에서 이용자는 주당 약 3시간·25%를 덜 썼고 ITT 효과는 1.4시간이었다. n8n은 다수 통합·템플릿의 공개 자동화 생태계를 보유한다. [Microsoft](https://www.microsoft.com/en-us/research/publication/shifting-work-patterns-with-generative-ai/) · [n8n](https://github.com/n8n-io/n8n) | Gmail 읽기 계약은 있으나 실제 연결 검증이 남았다. 문서 vault·출처 인덱스는 없음. | 공개 근거상 시간 절약 가능성이 가장 강하다. 메일 본문은 프롬프트 인젝션 입력이며, 발송·삭제·읽음 변경은 별도 승인 없이는 금지해야 한다. |
| 7 | **웹 심부름 준비 에이전트** | 쇼핑·예약·조회는 비교와 입력이 번거롭지만 결제까지 자동화하면 위험하다. | Browser Use는 공개 브라우저 에이전트 구현을 제공한다. [Browser Use](https://github.com/browser-use/browser-use) | 공유 Chrome 탭, 쿠팡 검색·장바구니 계약, intent-plan binding이 있다. 라이브 selector와 실제 상태 재조회가 공백. | 검색·후보 비교·폼 초안은 자동화하고, 장바구니 변경은 정확한 계획 승인, 주문·결제는 별도 강한 승인으로 분리한다. DOM 변경·CAPTCHA·로그인 만료 때문에 무인 성공률을 과장하면 안 된다. |
| 8 | **로컬 영수증·계약·장부 금고** | 사진과 문서가 흩어져 감사·검색·근거 연결에 시간이 든다. | Paperless-ngx는 OCR·태깅·검색을 제공하는 공개 문서 관리 생태계다. 프로젝트 문서는 문서가 평문 저장될 수 있어 신뢰된 로컬 호스트가 필요하다고 경고한다. [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx) | 암호화 기억은 있으나 원본 문서 보관·OCR·증거 해시·보존 정책은 별도 설계가 필요하다. | Evidence Twin의 자료층이 된다. 모든 문서를 일반 대화 기억으로 넣지 말고 원본·검색 메타데이터·접근 정책을 분리한다. |
| 9 | **개인·가게 재무 이상 조수** | 현금·계좌·카드·직원 지급·재고 차이를 사람이 매일 대조하기 어렵다. | Actual Budget는 local-first 재무 관리의 공개 구현 사례다. [Actual Budget](https://github.com/actualbudget/actual) | 가게 결제 기호와 정산 규칙은 수집됐지만 계좌 원장·현금 계수·영수증과 연결된 표준 ledger가 없다. | 금액 불일치·중복·근거 없는 지급을 빠르게 찾을 수 있다. 이상 점수는 횡령 판정이 아니며, 개인 계좌 데이터 최소수집과 접근권한 분리가 선행돼야 한다. |
| 10 | **Local AI Flight Recorder·복구 초안** | AI가 생각 중인지, 실패했는지, 실제 실행됐는지 알기 어렵고 같은 오류를 반복한다. | Uptime Kuma는 자체 호스팅 상태 감시, OpenHands는 격리형 소프트웨어 에이전트 구현을 공개한다. [Uptime Kuma](https://github.com/louislam/uptime-kuma) · [OpenHands](https://github.com/All-Hands-AI/OpenHands) | 요청 수명주기·상태·시험·격리 worker는 있으나 전체 서비스의 공통 사건 기록·회귀 생성·통합 상태판은 없다. | 실패 위치와 평균 복구시간(MTTR)을 줄이는 기반이다. 자동 복구는 되돌릴 수 있는 정해진 조치만 허용하고, 권한 확대·무한 재시도는 금지한다. |

### GitHub 생태계 지표 스냅샷

2026-08-08 조사 시점의 대략적인 별 수는 n8n `197k`, Browser Use `95.9k`, Uptime Kuma `87.3k`, OpenHands `75k`, Paperless-ngx `43.7k`, Frigate `34.9k`, NanoClaw `30.5k`, Actual Budget `26.7k`, OpenAI Agents Python `28.5k`, Letta Code `3.0k`였다. **이는 설치 수나 성공률이 아니라 공개 생태계 관심도의 스냅샷**이며 수시로 변한다.

## 6. 세 가지 핵심 구조

### 6.1 Capability Forge — 실패를 재사용 가능한 능력으로 바꾸는 공장

처음 들어온 어려운 요청을 곧바로 운영 자동화로 만들지 않는다.

`첫 고난도 요청 → 개인정보 제거 후 외부 전문가 제안 → 격리 shadow 실행 → 사용자 검토 → 서명된 재사용 로컬 playbook → 자동 회귀시험·강등`

#### 핵심 규칙

- 외부 AI 답은 제안일 뿐이며 운영 권한이 없다.
- 실제 입력 대신 합성 최소 재현 사례로 시험한다.
- playbook에는 입력 schema, 전제조건, 허용 도구, 부작용, 성공 증거, 롤백, 버전, 만료를 고정한다.
- 모델·API·UI가 바뀌면 자동 재시험한다.
- 실패하거나 환경이 변하면 `자동 → 승인 실행 → 초안 → 그림자` 순으로 강등한다.

#### 측정 지표

- 외부 AI 재질의율
- playbook 재사용률
- 무인 성공률
- 회귀 실패 수
- 작업당 절약 시간
- 평균 복구시간(MTTR)

#### 현재 겹침과 공백

Codex 격리 workspace, growth DLP, proposal store, 테스트 기반은 재사용할 수 있다. 그러나 공통 capability card, 승격·강등 정책, 환경 변화 재보정은 공백이다.

### 6.2 Evidence Twin Auditor — 주장과 실제를 한 시간축에서 대조

장부, 가게계좌, 카드·현금, 영수증, 직원 일정·정산, 재고, CCTV, Home Assistant 사건을 하나의 증거 시간축에 올린다.

출력은 다음 세 가지뿐이어야 한다.

1. 서로 일치한 사실
2. 서로 충돌한 사실과 정확한 시각·금액·수량
3. 판단에 필요한데 없는 증거

시스템은 사람을 `범인`, `횡령`, `거짓말`로 분류하지 않는다. **사실 충돌과 원본 증거 묶음**만 사용자에게 제시한다.

#### 측정 지표

- 알려진 누락 사례 재현율
- 오탐률
- 사건당 조사 시간
- `UNKNOWN` 항목 감소율

#### 현재 겹침과 공백

가게 운영 통제 기준과 위험 시점은 정리돼 있다. 먼저 종이 장부를 새 표준 사건 ID로 바꾸고 카메라 시간 오차를 측정해야 한다. 얼굴 인식·고의 판단·전면 실시간 감시는 첫 단계가 아니다.

### 6.3 Attention Governor — 사용자의 주의력을 시스템 자원으로 관리

승인 횟수를 줄이는 것이 아니라 **잘못된 순간의 방해와 습관적 승인을 줄이는 것**이 목표다.

| 전달 시점 | 대상 |
|---|---|
| 즉시 | 보안 침해, 금전 손실 임박, 물리적 위험 |
| 다음 iPhone 확인 때 | 곧 만료될 승인, 짧은 선택이 필요한 작업 |
| 하루 묶음 | 비긴급 불일치, 기억 후보, 개선 제안 |
| 무음 기록 | 되돌릴 수 있는 저위험 성공, 정상 상태 |

#### 측정 지표

- 하루 중단 횟수와 총 판단 시간
- 만료 승인율
- 알림 후 실제 행동률
- 반복·중복 알림률
- 사용자가 나중에 되돌린 승인 비율

#### 현재 겹침과 공백

능동 알림·승인 queue·rate limit은 재사용할 수 있다. 다만 위험·만료·사용자 확인 시점에 따른 배치 정책과 `새 증거 없는 반복 알림 금지`가 필요하다.

## 7. 로컬 공백 지도 기반 가중 평가

평가 가중치는 다음과 같다.

| 기준 | 가중치 |
|---|---:|
| 실제 시간 절약 | 25 |
| 기존 자산 재사용 | 15 |
| 개인정보 보호 적합성 | 15 |
| 승인 피로 감소 | 10 |
| 유지보수 가능성 | 10 |
| 현재 장비 구현 가능성 | 10 |
| 차별성 | 8 |
| 오탐 피해 통제 | 7 |
| **합계** | **100** |

### 실행 TOP 3 예비 등급

| 우선 | 운영 기능 | 예비 등급 | 선택 이유 | 주요 결격 조건 |
|---:|---|---:|---|---|
| 1 | **Secure Action Inbox** | **A — 기반 선행** | 기존 iPhone·서명·Codex 경계를 가장 많이 재사용하며, 현재 사용자가 겪는 Mac 화면·승인 불편을 직접 줄인다. | 실기기 E2E, 계획-표시-실행 동일성, 만료·재사용 거부가 통과하지 않으면 운영 금지 |
| 2 | **Exception-Only Briefing** | **A — 그림자 시험** | Attention Governor를 실제 UX로 바꿔 승인 피로와 상태 불투명성을 동시에 줄인다. Evidence Twin과 Flight Recorder의 공통 출력면이 된다. | 14일 그림자 시험에서 중요 사건 누락이 1건이라도 있으면 자동 숨김 금지 |
| 3 | **Memory Review & Intent Continuity** | **B — 개인정보 기반** | 이미 만든 선택적 기억 기반을 살리면서 “이전 대화가 사라짐”과 “한 번 한 말이 문신처럼 남음”을 함께 해결한다. | 추론을 사실로 활성화하거나 Telegram에 민감 기억을 노출하면 실패 |

등급은 객관적 측정 결과가 아니라 현재 자산과 결격 조건을 반영한 **의사결정용 추론**이다. 실제 7~14일 그림자 실험에서 순절약시간·오탐 검토시간·중요 사건 누락을 측정해 다시 판정한다.

## 8. 냉정한 실행 순서

### 1단계 — iPhone E2E 완결

- 실제 iPhone에서 요청 수신, 표시 본문 재해시, Face ID/서명, Mac 검증, 1회 소비, 결과 수신을 시험한다.
- 만료·재사용·다른 기기·다른 사용자·승인 후 코드 변경을 모두 거부한다.
- 이 단계가 통과해야 Secure Action Inbox를 “연결됨”이라고 말할 수 있다.

### 2단계 — 표준 Evidence Ledger

- 가게 영업일, ROOM-EVENT-ID, 작성자, 수정자, 결제수단, 병 수, 직원 입퇴실, 지급 근거를 한 schema로 정한다.
- 화이트로 지우기와 중복 기호를 없애고, 모든 수정에 원래 값·이유·사람·시각을 남긴다.
- 영상 AI보다 먼저 해야 한다. 원장 자체가 불명확하면 카메라도 정답을 만들 수 없다.

### 3단계 — OCR·시간축 MVP

- 얼굴 인식 없이 `장부 사진 OCR → 사람이 확인 → 카메라 시간 오차 적용 → 술 반입·회수·퇴실 후보 시각 연결`까지만 한다.
- 정상 표본과 이미 알려진 누락 표본을 분리해 recall과 오탐을 측정한다.
- 범죄 라벨 없이 충돌·미확인 증거만 출력한다.

### 4단계 — 상태·오류·Exception Briefing

- 요청의 `접수/분석/승인 대기/실행/검증/실패/복구 필요` 상태를 같은 사건 ID로 표시한다.
- 즉시·다음 확인·하루 묶음·무음 기록으로 알림을 분류한다.
- 1분 이상 사용자 응답이 없을 때 작업을 막고 기다리는 대신, 안전한 다른 준비를 계속하고 다음 briefing에 묶는다.
- 최초 14일은 전체 기록과 예외 브리핑을 함께 보여준다.
- `UNKNOWN`, 데이터 미수신, 시계 불일치는 정상으로 숨기지 않고 최상위 검토 큐에 둔다.
- 중요 사건 false negative가 1건이라도 발생하면 자동 요약·숨김 기능을 중단한다.

### 5단계 — Telegram과 민감 앱 분리 완결

- Telegram은 일반대화·비민감 상태·일회용 handoff만 담당한다.
- 개인정보, 기억 원문, 메일 원문, 실제 승인과 고위험 실행은 iPhone LocalAI에만 둔다.
- 두 채널의 세션·기억·권한을 자동 병합하지 않는다.

## 9. 당장 하지 않을 것

- 대형 LLM을 처음부터 학습하거나 범용 챗봇 UI를 다시 만드는 일
- 모델 자연어를 Shell·SQL·브라우저·Home Assistant 명령으로 직접 실행하는 일
- Telegram을 민감 승인 채널로 승격하는 일
- 카메라 영상만으로 사람의 고의·절도·신뢰도를 판정하는 일
- 법률 검토 전 실제 가게 영상으로 AI 감사·직원별 프로파일을 만드는 일
- CCTV 또는 별도 마이크로 고객·직원의 대화를 녹음·전사하는 일
- 이메일·웹페이지 내용을 자동 장기기억으로 넣는 일
- 결제·주문·메일 발송·삭제를 무인 자동화하는 일
- GitHub 별 수를 근거로 프로젝트를 그대로 복제하는 일

## 10. 사용자 검토가 필요한 결정

코딩 전에 다음 네 가지만 합의한다.

1. 첫 2주 실험의 1순위를 `Secure Action Inbox`로 확정할지
2. 가게 감사 MVP를 **증거 충돌 탐지**로 한정하고 사람 판정은 금지할지
3. 즉시 알림을 `보안·금전 손실 임박·물리 위험` 세 범주로 제한할지
4. 기억 후보와 비긴급 불일치를 하루 몇 시에 한 번 묶어 받을지

## 11. 최종 판정

이 프로젝트의 강점은 “가장 똑똑한 로컬 모델”이 아니다. 강점은 다음 조합이다.

- Telegram의 편리함과 iPhone 서명의 민감 권한 분리
- 사용자의 말과 실제 실행을 MomentContract로 결속
- 장부·계좌·재고·CCTV의 독립 증거 대조
- 실패를 재사용 가능한 playbook과 회귀시험으로 전환
- 정상은 조용히 처리하고 예외만 올리는 주의력 통제

따라서 다음 행동은 새 기능 코딩이 아니라 **사용자가 이 우선순위와 경계를 검토하는 것**이다. 검토 전에는 운영 변경, 신규 adapter, 외부 서비스 연결, 카메라 분석 구현을 시작하지 않는다.
