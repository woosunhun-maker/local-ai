# 2026-08-08 통합 작업 보고

## 1. 결론

이번 작업에서는 Mac 사용성을 실제로 정리하고, 로컬 AI 운영 상태를 재검증하며, 전 세계 공개 구현을 바탕으로 후보 10개와 통합 방향 3개를 조사했다.

Mac 쪽은 `4K 물리 출력 + 1920×1080 논리 HiDPI + 50Hz` 상태를 유지했고, YouTube·Instagram 공식 Safari 웹앱과 새 4K 배경화면을 적용했다. BetterDisplay의 남은 로그인 항목도 제거했다.

로컬 AI의 Mac 서버·Telegram·Codex Worker는 정상이다. 반면 iPhone 앱은 설치돼 있지만 현재 iOS 보안 정책에 의해 실행이 거부되며, Personal Team 프로필도 `2026-08-12 00:30:50 KST`에 만료된다. 따라서 iPhone 실기기 Codex E2E는 아직 완료로 부를 수 없다.

## 2. Mac에 실제 적용한 내용

### 디스플레이

- 실제 출력: `3840×2160`
- 논리 해상도: `1920×1080`
- UI 배율: `200%` 상당의 2× HiDPI
- 주사율: `50Hz`
- HDR: 꺼짐
- 미러링: 꺼짐
- BetterDisplay 가상 디스플레이: 없음

macOS 기본 디스플레이 메뉴에 표시된 선택지는 `50/30/25/24Hz`뿐이었다. 4K를 유지하면서 60Hz를 선택할 수 없으므로 50Hz를 유지했다. 이 값과 프로젝터 영상 처리는 마우스가 늦게 따라오는 체감의 유력한 원인이다.

### 앱과 Dock

- `/Users/hun/Applications/YouTube.app`
- `/Users/hun/Applications/Instagram.app`

두 앱은 비공식 다운로드가 아니라 Safari의 공식 `Dock에 추가` 기능으로 각 공식 사이트에서 만들었고, 실제 실행과 도메인을 확인했다. Instagram 알림 권한은 임의로 허용하지 않았다.

두 앱을 종료한 뒤에도 아이콘이 유지되도록 Dock에 영구 고정했다. 변경 전 Dock plist는 `/Users/hun/Documents/로컬ai/mac-backups/dock-before-webapps-2026-08-08.plist`에 보관했다. Dock은 최종 재기동 후 정상 실행과 아이콘 표시를 확인했다.

### 바탕화면

- 적용 파일: `/Users/hun/Pictures/LocalAI/LocalAI-Graphite-Amber-4K-2026-08-08-upscaled.png`
- 크기: `3840×2160`
- 표시 방식: 화면 채우기
- 모든 Spaces에 표시: 켜짐
- 디자인: 저휘도 graphite/amber 기반, 글자·로고·사람 없음

### 시작 항목

- 앱이 삭제된 뒤에도 남아 있던 BetterDisplay 로그인 항목을 제거했다.
- KEF Connect, Steam, Hue Sync, XENEON ICC는 사용 여부를 확정할 수 없어 건드리지 않았다.
- 최종 바탕화면 검사에서 Chrome 원격 데스크톱 중복 아이콘은 더 이상 존재하지 않았다. Dock이 가리키는 `/Applications/Chrome 원격 데스크톱.app`, Chrome이 관리하는 사용자 앱 본, 원격 호스트 서비스는 유지된다.

## 3. Mac 앱·시작 항목 감사

### 유지

- Secure Chat, Telegram relay, Codex Worker
- Ollama, OpenClaw, 18790 proxy
- Tailscale, UTM Home Assistant, Xcode
- Chrome Remote Desktop Host, Logitech Options+
- ChatGPT 두 설치본

ChatGPT 두 설치본은 단순 중복처럼 보이지만 현재는 삭제하면 안 된다. `/Applications/ChatGPT.app`은 현재 UI가 실행 중이고, `/Users/hun/Desktop/ChatGPT.app`은 Codex Worker가 더 최신 내장 Codex 경로로 고정 사용한다.

### 다음 승인 후 정리할 후보

1. `com.local.privateai.iphone-command`
   - 이전 Home Assistant 폴링 브리지이며 새 Secure Chat 경로와 중복된다.
   - stale lock 때문에 `runs=2635`, `spawn scheduled`, `inefficient` 상태다.
   - 먼저 일시 비활성화한 뒤 Secure Chat·Telegram·iPhone E2E를 다시 시험해야 한다.
2. VirtualBox Home Assistant 복구본
   - UTM HA가 안정적으로 여러 번 부팅·백업·복원된 뒤에만 제거한다.
3. Steam/KEF 로그인 항목
   - 앱 삭제가 아니라 부팅 자동 실행만 끄는 선택이 가능하다.

## 4. 로컬 AI 실제 운영 상태

### 정상

- `127.0.0.1:18789/health`: HTTP 200
- `127.0.0.1:18790/health`: HTTP 200
- `127.0.0.1:18791/health`: HTTP 200
- `127.0.0.1:3000/health`: HTTP 200
- Ollama `127.0.0.1:11434`: 정상
- 서버 전체 테스트: `315/315` 통과
- iOS Simulator 전체 테스트: `39/39` 통과, `** TEST SUCCEEDED **`
- Telegram, Secure Chat, Codex Worker: 실행 중

### Home Assistant

- UTM VM: `started`
- Observer `192.168.64.2:4357`: HTTP 200, Supervisor connected/supported/healthy
- Home Assistant Core `192.168.64.2:8123`: 연결 거부

따라서 VM과 Supervisor는 살아 있지만 Home Assistant Core UI는 현재 내려가 있다. VirtualBox 복구본은 아직 제거하면 안 된다.

### iPhone LocalAI

- 기기: paired, Developer Mode enabled
- 설치 앱: `나의 Local AI 1.2.0 (9)`
- 최종 archive: strict codesign 통과
- 실제 실행: iOS 보안 정책으로 거부
- 오류 범위: invalid signature / inadequate entitlement / profile not explicitly trusted
- Codex 전용 승인키: 0
- Codex 작업·Face ID·결과 수신 이력: 0
- 프로필 만료: `2026-08-12 00:30:50 KST`

사용자가 iPhone에서 개발자 프로필 신뢰를 확인한 뒤 `inspect` 작업을 보내고 Face ID 승인과 결과 수신까지 확인해야 E2E 완료다.

## 5. 세계 공개 구현 기반 후보 10개

1. 가게 Evidence Twin Auditor
2. iPhone Secure Action Inbox
3. Telegram 편의 채널 + 민감 앱 권한 분리
4. 능동형 Home Assistant 생활 운영자
5. 선택적 기억 + Sleep-time 연구자
6. 이메일·문서 백오피스 조수
7. 웹 심부름 준비 에이전트
8. 로컬 영수증·계약·장부 금고
9. 개인·가게 재무 이상 조수
10. Local AI Flight Recorder·복구 초안

## 6. 장점만 통합한 세 구조

1. **Capability Forge**
   - 반복 실패를 재현 시험, 계약, 검증 가능한 playbook으로 바꾼다.
2. **Evidence Twin Auditor**
   - AI의 주장과 실제 장부·입금·영수증·센서·실행 결과를 같은 사건 ID와 시간축으로 대조한다.
3. **Attention Governor**
   - 모든 상태를 계속 알리지 않고, 위험·만료·증거 충돌·복구 필요처럼 사용자가 봐야 하는 것만 올린다.

세 구조는 `능력 생성 → 실제 증거 검증 → 필요한 예외만 알림 → 실패를 회귀시험으로 환류`하는 하나의 폐루프로 묶는다.

## 7. 운영 기반과 시간 절약 실험을 분리한 최종안

### 운영 기반 우선순위

1. Secure Action Inbox
2. Exception-Only Briefing
3. Memory Review & Intent Continuity

### 실제 시간 절약 실험 우선순위

1. 읽기 전용 이메일·문서 분류와 답장 초안
2. 표준 Evidence Ledger 합계·누락 필드 검사
3. 결정형 Home Assistant 반복 작업과 상태 예외

소수점 점수는 실측처럼 보이는 허위 정밀도라 제거했다. 7~14일 동안 `기존 수동시간 - 검토·승인·오류수정·재실행·유지보수시간`으로 실제 순절약시간을 측정한다.

## 8. 레드팀 출시 게이트

- Exception-Only Briefing은 최초 14일 전체 기록과 병행하는 그림자 모드로 시험한다.
- 중요 사건 누락 1건이면 자동 숨김을 중단한다.
- `UNKNOWN`, 데이터 미수신, 시계 불일치는 정상으로 처리하지 않는다.
- 가게 CCTV 감사는 개인정보·노무·고지·보유·접근에 대한 법률 검토 전 실제 영상으로 구현하지 않는다.
- CCTV 또는 별도 마이크로 고객·직원의 대화를 녹음·전사하지 않는다.
- AI는 증거 불일치만 제시하며 절도·고의·범인을 판정하지 않는다.

## 9. 자동 연장 제한

사용자는 약 7~8시간의 연속 작업을 요청했다. Codex의 기존 자동화 `7-ai`를 조회·연장하려 했지만 현재 앱 자동화 호출이 응답하지 않아 중단했다. 별도 cron/LaunchAgent를 임의 생성해 우회하지 않았다.

따라서 이 문서는 7~8시간이 흘렀다고 가장하지 않고, 이번 즉시 실행에서 실제로 완료하고 검증한 결과만 기록한다.

## 10. 다음 한 단계

1. iPhone에서 `설정 → 일반 → VPN 및 기기 관리 → 개발자 앱`의 Apple Development 프로필을 직접 확인하고 신뢰한다.
2. `나의 Local AI` 앱을 열어 `Codex 작업 → inspect`를 실행한다.
3. 계획과 외부 전송 범위를 읽고 동의할 때만 Face ID로 승인한다.
4. `succeeded`와 결과 수신을 확인한다.

그 전까지 “아이폰과 Codex가 완전히 연결됐다”고 보고하지 않는다.
