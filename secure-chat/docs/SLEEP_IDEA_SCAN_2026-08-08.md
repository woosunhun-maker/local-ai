# 취침 중 아이디어 조사 — 2026-08-08

## 한 줄 결론

현재 가장 큰 병목은 더 큰 로컬 LLM이 아니라, 이미 구현된 **Telegram 대화·iPhone 승인·Codex Worker·선택적 기억·능동 알림**을 실제 사용자 흐름으로 연결하는 일이다.

## 현재 확인된 상태

- Secure Chat, Telegram relay, Codex Worker는 Mac에서 운영 중이다.
- iPhone용 LocalAI 1.2.0 build 9는 설치됐다.
- iPhone 첫 실행을 위해 개발자 인증서 신뢰가 한 번 필요하다.
- iPhone 서명형 Codex `inspect`·`draft` 경로는 구현됐지만 실기기 종단시험은 아직 남았다.
- 선택적 기억은 암호화·상태 전이·정책 시험은 있지만 서버 API와 iPhone 검토 화면이 없다.
- 브라우저 자동화는 계약·안전 시험까지만 있고 실제 서비스 executor는 없다.
- Home Assistant는 알림 전달만 연결됐고 센서·기기 제어 adapter는 없다.

## 추천 1안 — Secure Handoff Inbox

Telegram에서 “이건 Codex에게 넘겨”라고 하면 작업을 실행하지 않고, 5분짜리 일회용 handoff만 만든다. Telegram에는 LocalAI 앱을 여는 버튼만 보내고, 실제 요청·외부 전송 범위·권한·계획은 iPhone 앱이 Mac에서 다시 받아 표시한다. Face ID와 Secure Enclave 서명 후에만 실행한다.

### 가치

- Telegram의 편리함과 전용 앱의 보안을 동시에 유지한다.
- 복사·붙여넣기와 Mac 화면 이동을 없앤다.
- 기존 Telegram principal, AuthStore, Codex coordinator, AppRouter를 재사용한다.

### 검증 실험

1. 합성 요청 20건으로 handoff를 만든다.
2. 만료, 재사용, 다른 기기, 다른 Telegram principal을 모두 거부한다.
3. 앱이 받은 요청과 서버 해시가 다르면 승인하지 않는다.
4. Telegram 입력부터 앱 승인 화면까지 10초 이내, 잘못된 실행 0건을 성공 기준으로 둔다.

## 추천 2안 — Local AI Flight Recorder + Shadow Twin

모든 요청을 `입력 → STT → 의도 → 계획 → 승인 → 도구 → 실제 상태 재조회` 단계로 로컬 기록한다. 실패가 발생하면 개인정보를 제거한 최소 회귀시험을 자동 생성한다. 새 기능은 처음부터 실제 실행하지 않고 그림자 모드로 같은 요청을 관찰한 뒤 정확도가 쌓일 때만 승격한다.

승격 단계:

`그림자 → 초안 → 되돌릴 수 있는 실행 → 승인 필수 실행`

### 가치

- “AI가 스스로 성장한다”를 막연한 기억이 아니라 과거 실패 재발률 감소로 측정한다.
- Home Assistant, 브라우저 자동화, 음성, 장부 감사를 같은 검증 체계로 다룰 수 있다.
- 모델이 “완료했다”고 말한 것과 실제 상태가 바뀐 것을 분리한다.

### 검증 실험

1. 실제 변경 없이 7일간 shadow 기록만 만든다.
2. 실패 단계와 실제 원인을 사람이 확인한다.
3. 과거 실패에서 자동 생성된 회귀시험의 재현율을 측정한다.
4. 연속 성공 횟수와 정책 위반 0건을 만족한 기능만 다음 단계로 승격한다.

## 차선 2안 — 장부·카메라 증거 대조 감사 AI

장부 OCR, 직원 정산, 계좌·현금·재고 기록을 하나의 시간축으로 정리하고 CCTV의 입장·퇴장·술 반입·빈병 회수 이벤트와 대조한다. 시스템은 사람을 범인으로 판정하지 않고 불일치가 있는 시각, 장부 항목, 영상 근거를 묶어 사용자 검토 후보로 제시한다.

### 차별점

일반적인 로컬 CCTV 감지와 달리 `장부 병 수 ↔ 영상 반입 ↔ 회수 ↔ 입금`을 한 거래 단위로 묶는다. 실제 사업 손실과 연결되므로 장기적인 투자 가치가 크다.

### 선행 조건

- 카메라별 위치와 시간 오차 측정
- 새 표준 장부와 수정 이력 규칙
- 정상 거래 표본과 의심 거래 표본
- 직원·손님 영상 처리에 대한 법률·고지 검토
- AI 판정이 아닌 증거 후보·신뢰도 표시 원칙

## 공통 실패 패턴

1. 자연어 응답을 실행 성공으로 착각한다.
2. 모든 Home Assistant 엔티티를 모델에 넣어 느리고 부정확해진다.
3. 단순 명령과 복잡한 대화를 같은 LLM 경로로 처리한다.
4. 원문 대화를 모두 기억해 잡음과 잘못된 믿음이 누적된다.
5. 웹·메일 내용을 자동 기억해 프롬프트 인젝션이 세션을 넘어 남는다.
6. 브라우저 DOM 변경, CAPTCHA, 로그인 만료를 무한 재시도한다.
7. Telegram을 민감 승인 채널로 사용한다.
8. 요청 ID·계획 해시·멱등성 없이 중복 실행한다.
9. 채널 간 세션과 기억을 공유해 문맥이 엉뚱한 곳으로 샌다.
10. 음성 파이프라인 전체를 하나의 오류로 취급해 원인을 찾지 못한다.

## 설계 원칙

- 더 큰 모델보다 결정적 정책·검증·증거를 우선한다.
- 모델 출력은 도구 호출이 아니라 검증 대상 입력이다.
- Telegram, iPhone 앱, 음성, 브라우저의 세션·기억·권한을 분리한다.
- 외부 문서와 웹페이지는 자동 기억으로 승격하지 않는다.
- 실행 성공은 실제 상태 재조회와 영수증으로 증명한다.
- 새 기능은 shadow에서 시작하고 실패하면 자동 강등한다.
- 중요한 변경은 iPhone에 표시된 정확한 계획과 실행 계획을 암호학적으로 묶는다.

## 공개 근거

- Home Assistant Ollama 통합: https://www.home-assistant.io/integrations/ollama/
- Home Assistant Voice Pipeline: https://developers.home-assistant.io/docs/voice/overview/
- Home Assistant Actionable Notifications: https://companion.home-assistant.io/docs/notifications/actionable-notifications/
- OpenAI Agents SDK Human-in-the-loop: https://openai.github.io/openai-agents-python/human_in_the_loop/
- Apple Secure Enclave P-256: https://developer.apple.com/documentation/cryptokit/secureenclave/p256/signing/privatekey
- Apple Face ID/Touch ID: https://developer.apple.com/documentation/localauthentication/logging-a-user-into-your-app-with-face-id-or-touch-id
- Frigate: https://github.com/blakeblackshear/frigate
- MCP Authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- OWASP Prompt Injection Prevention: https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html
- MemGPT: https://arxiv.org/abs/2310.08560
- Sleep-time Compute: https://arxiv.org/abs/2504.13171
- Letta Code: https://github.com/letta-ai/letta-code
- Playwright authentication security: https://playwright.dev/docs/auth

## 깨어난 뒤 결정할 것

1. iPhone에서 개발자 앱 신뢰 후 build 9 종단시험을 끝낸다.
2. 추천 1안인 Secure Handoff Inbox의 UX만 먼저 논의한다.
3. 구현 승인 전 Flight Recorder의 기록 범위와 보존 기간을 합의한다.
4. 장부·카메라 감사는 정상 표본과 시간 동기화 자료부터 수집한다.

현재 단계에서는 아이디어 검토만 수행하며 운영 변경이나 신규 기능 구현은 하지 않는다.
