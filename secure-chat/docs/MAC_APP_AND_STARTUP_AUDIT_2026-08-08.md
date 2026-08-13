# Mac 앱·시작 항목 읽기 전용 감사

- 감사 일자: 2026-08-08 (Asia/Seoul)
- 대상: Mac Studio / 설치 앱 / 로그인 항목 / LaunchAgent / 현재 디스플레이 / LocalAI 문서
- 방식: 파일·프로세스·`launchctl`·`system_profiler`·로컬 HTTP 상태를 읽기 전용으로 확인
- 변경 여부: **삭제·종료·비활성화·설정 변경 없음**

## 결론

LocalAI 핵심 서비스는 정상 실행 중이다. 즉시 삭제해도 된다고 고신뢰로 분류한 앱은 없다. 다만 다음 두 항목은 **REMOVE-CANDIDATE**다.

1. `com.local.privateai.iphone-command`: 이전 Home Assistant to-do 폴링 브리지로, 현재 아이폰 Secure Chat 경로와 중복되며 스탈 락 때문에 무의미한 재기동 대기를 반복한다.
2. 바탕화면 `Chrome 원격 데스크톱.app`: `~/Applications/Chrome Apps.localized/` 안의 실행 아이콘과 내용이 완전히 동일한 복제본이다. 원격 호스트 자체는 별도이므로 유지해야 한다.

## KEEP — 현재 LocalAI에 필요

| 항목 | 정확한 근거 |
|---|---|
| `/Applications/ChatGPT.app` | 현재 Codex 데스크톱 앱이 이 경로에서 실행 중. `com.openai.codex`, 버전 `26.727.51351`, 내장 Codex `0.146.0-alpha.9.2`. |
| `/Users/hun/Desktop/ChatGPT.app` | 더 최신인 `26.730.61639`; **Codex Worker가 이 앱의 Codex `0.147.0-alpha.1.2`를 경로·버전까지 고정**함. 현재는 삭제하면 worker가 멈춘다. |
| `/Applications/Tailscale.app` | iPhone→Mac tailnet 전용 HTTPS 연결의 핵심. Tailscale 프로세스 실행 중. |
| `/Applications/Google Chrome.app` | 명시적으로 공유한 Chrome 탭만 사용하는 Gmail·Coupang 자동화 경계에 필요. Google Updater 관련 항목은 보안 업데이트에 사용되므로 유지. |
| `/Applications/Telegram.app` | 사용자가 원하는 일반 대화·상태 확인 채널. |
| `/Applications/UTM.app` | 현재 `Home Assistant OS` UUID `849CD3F8-A5FE-4DEF-8AC8-CAF011331609`가 UTM/QEMU로 `started`; 4 CPU, 4096 MiB. |
| `/Applications/Home Assistant.app` | 스마트홈 사용자 UI. LocalAI 자체의 핵심 서버는 아니지만 HA 운영에 필요. |
| `/Applications/Xcode.app` | iPhone LocalAI 앱 빌드·서명·실기기 설치에 필요. |
| `homebrew.mxcl.ollama` | `127.0.0.1:11434` 실행 중. Qwen 로컬 대화 모델 서버. |
| `ai.openclaw.gateway` | `127.0.0.1:18789` 실행 중. deep/agent 경로의 상류. |
| `com.local.privateai.openwebui-proxy` | `127.0.0.1:18790/health` HTTP 200. Secure Chat deep 경로가 직접 의존. |
| `com.local.privateai.openwebui` | `127.0.0.1:3000/health` HTTP 200. 현재 privacy-hardening 배포 건강 검사 구성에 포함되므로 구조 변경 전에는 유지. |
| `com.local.privateai.secure-chat` | PID 65053, `127.0.0.1:18791/health` HTTP 200. iPhone 앱 인증·대화·승인 API. |
| `com.local.privateai.telegram-general` | PID 65082, 실행 중. Telegram 소유자 DM→로컬 Qwen 릴레이. |
| `com.local.privateai.codex-worker` | PID 65021, worker lease 존재. iPhone 서명 승인에 묶인 inspect/draft 실행. |
| `com.local.privateai.growth-monitor` | 6시간 주기로 실행하는 짧은 job. 감사 시 `not running`, `last exit code=0`은 정상 대기 상태. |
| `com.local.privateai.health-monitor` | 60초 주기 건강 점검, `last exit code=0`. 상주 프로세스가 아니므로 `not running`이 정상. |
| `local.homeassistant.utm` | 2026-08-08 19:50에 추가된 현재 HA VM 자동 시작 경로. 스크립트의 UUID와 실행 중 VM UUID가 일치. |

## KEEP — LocalAI는 아니지만 현재 사용 근거가 있음

| 항목 | 근거 |
|---|---|
| Chrome Remote Desktop Host / `org.chromium.chromoting*` | system broker PID 355, user host PID 652로 실제 원격 호스트가 실행 중. 원격 Mac 접속을 사용한다면 유지. |
| `/Applications/logioptionsplus.app` + Logitech LaunchAgent/Daemon | 입력 장치 설정 앱. agent·updater가 실행 중이며 마우스 사용성과 직접 관련. |
| Rectangle, Stats, GrandPerspective | [Mac 개선 기록](/Users/hun/Documents/로컬ai/mac-improvement-report-2026-08-08.md)에 2026-08-08 의도적 설치로 기록됨. 자동 삭제 근거 없음. |
| YouTube·Instagram 웹앱 | [Mac 사용성 보고서](/Users/hun/Documents/로컬ai/secure-chat/docs/MAC_USABILITY_SETUP_2026-08-08.md)에 Safari 공식 웹앱으로 의도적 설치·실행 확인됨. |

## REVIEW — 사용자 용도 확인 전에 제거 금지

| 항목 | 정확한 상태 | 검토 조건 |
|---|---|---|
| VirtualBox 7.2.14 + `Home Assistant` VM | UTM으로 이전했지만 VirtualBox VM과 스냅샷을 복구용으로 의도적 보존했다는 문서 증거가 있음. `VBoxManage list runningvms`는 비어 있고 `local.privateai.homeassistant-vm` 레이블은 disabled. | UTM HA의 연속 부팅·백업·복원 검증 후 VirtualBox VM·앱·시작 plist를 한 번에 정리. |
| `org.virtualbox.vboxwebsrv.plist` | plist 자체에 `Disabled=true`; 현재 로드되지 않음. 성능 부담은 없음. | VirtualBox 복구용 보존 종료 시 함께 정리. |
| `/Applications/Hue Sync.app` | LocalAI 필수 앱은 아님. 조명 동기화 장비 사용 여부를 현재 정보로 판단할 수 없음. | Hue 화면 동기화를 사용하지 않는다면 제거 후보. |
| `/Applications/KEF Connect.app` + KEF Connect 로그인 항목 | iOS 워핑 형식의 71 MB 앱이고 로그인 시 열림. LocalAI 필수는 아님. | KEF 스피커 관리를 Mac에서 사용하는지 확인. 앱은 유지하더라도 로그인 자동 실행만 끌 수 있음. |
| Steam 로그인 항목 + `com.valvesoftware.steamclean` | 로그인 항목은 `Steam`; steamclean은 현재 종료 상태, last exit 0. | 부팅 즉시 Steam을 쓰지 않는다면 로그인 항목만 비활성화 후보. 게임·설치 데이터는 제거하지 말 것. |
| `/Applications/Asphalt.app` | LocalAI와 무관한 게임. 사용 이력·사용자 의사 없이 삭제할 근거 없음. | 더 이상 플레이하지 않는 경우만 제거. |
| XENEON EDGE ICC 2개 | `/Library/ColorSync/Profiles/Displays/XENEON EDGE HiDPI 32x9-...icc`, `XENEON EDGE-...icc` 존재. BetterDisplay 앱·프로세스·LaunchAgent는 없고 현재 활성 디스플레이는 `LG ULTRAGEAR`. | XENEON EDGE를 Mac에 다시 연결할 계획이 없는지 확인한 뒤에만 제거. 현재 성능 부담은 없음. |
| `/Applications/ChatGPT.app` / `/Users/hun/Desktop/ChatGPT.app` 이중 설치 | 번들 ID는 같지만 버전이 다름. 앞의 것은 현재 UI, 뒤의 것은 현재 Codex Worker의 고정 런타임. 합계 약 2.8 GB. | Worker 경로·기대 버전을 하나의 `/Applications/ChatGPT.app`으로 이전하고 315개 시험·실제 작업까지 통과한 뒤에만 바탕화면 본을 정리. **현재는 둘 다 KEEP.** |
| UTM Home Assistant 연결 | VM 프로세스는 started이지만 감사 시 `http://homeassistant.local:8123` 응답은 HTTP 000. 이전 보고서는 HTTP 200을 기록. | 삭제 문제가 아니라 부팅·mDNS·네트워크 상태 재점검 필요. HA가 200으로 안정화되기 전 VirtualBox 백업 제거 금지. |

## REMOVE-CANDIDATE — 고신뢰 중복·스타일 항목

> 아래 항목도 이 감사에서는 변경하지 않았다. 실제 비활성화·이동·삭제는 사용자 승인 후 해야 한다.

### 1. `com.local.privateai.iphone-command`

- plist: `/Users/hun/Library/LaunchAgents/com.local.privateai.iphone-command.plist`
- 이전 역할: Home Assistant `todo.local_ai_commands`를 폴링해 OpenClaw에 전달하는 구형 iPhone 명령 경로.
- 현재 대체 경로: Secure Chat `18791` + 네이티브 iPhone 앱 + Secure Enclave 승인 + 전용 Codex Worker.
- 자체 README에는 “전용 엔티티와 실제 왕복 시험 성공 전에는 로드하지 않는다”고 기록됐지만 현재 `KeepAlive=true`, `RunAtLoad=true`.
- `launchctl` 증거: `state=spawn scheduled`, `active count=0`, `runs=2635`, `pended nondemand spawn=inefficient`, `last exit code=0`.
- 원인: `/Users/hun/PrivateAI/data/iphone-command-bridge.lock` 파일이 2026-08-06부터 남아 있어 신규 프로세스가 즉시 종료하고 launchd가 다시 기동하는 상태.
- 로그: 2026-08-05 로그에 `poll_failed`가 반복되며 최신 성공 결과 파일은 없음.
- Secure Chat 소스·배포본에서 `iphone-command` 참조를 찾을 수 없음.
- 권장: 먼저 LaunchAgent를 unload/disable하고 Secure Chat·Telegram·Codex·iPhone inbox를 재검증. 문제가 없으면 plist·앱 코드·stale lock을 복구 가능한 정리 대기 위치로 이동. 즉시 영구 삭제는 권장하지 않음.

### 2. 바탕화면 Chrome 원격 데스크톱 실행 아이콘

- 복제본: `/Users/hun/Desktop/Chrome 원격 데스크톱.app`
- 표준 본: `/Users/hun/Applications/Chrome Apps.localized/Chrome 원격 데스크톱.app`
- 둘 다 번들 ID `com.google.Chrome.app.cmkncekebbebpfilplodngbpllndjkfo`, 빌드 `7922.72`, 크기 약 2.1 MB.
- `diff -qr` 결과 exit 0: 번들 내용이 완전히 동일.
- `/Library/PrivilegedHelperTools/ChromeRemoteDesktopHost.app` 및 `org.chromium.chromoting*` 호스트는 별도로 실행하므로, 바탕화면 아이콘 하나를 제거해도 원격 호스트 서비스는 삭제되지 않음.
- 권장: 바탕화면 복제본만 휴지통으로 이동하고 `~/Applications/Chrome Apps.localized/` 본과 원격 호스트는 유지.

## 디스플레이 상태

- 활성 디스플레이 1대: `LG ULTRAGEAR`
- 물리 픽셀: `3840 × 2160`
- macOS 논리 해상도: `1920 × 1080`
- 재생률: `50.00Hz`
- 미러링: 꺼짐
- BetterDisplay 앱·프로세스·시작 항목: 없음
- 판정: macOS 기본 4K HiDPI(`1920×1080 looks like`) 상태로 보이며 BetterDisplay 가상 디스플레이 개입 증거는 없음. 50Hz는 마우스 지연 체감의 한 원인이 될 수 있음.

## 부팅 후 필수 경로 요약

```text
Ollama 11434 ─┐
OpenClaw 18789 ─┼→ proxy 18790 → Secure Chat 18791 → Tailscale → iPhone
Codex Worker ───┘                     ↘ Telegram relay
UTM Home Assistant → 일반 push/LocalAI 알림
```

## 안전한 후속 순서

1. Home Assistant가 다시 HTTP 200으로 안정화되는지 확인.
2. `com.local.privateai.iphone-command`만 일시 비활성화하고 Secure Chat·Telegram·Codex·iPhone inbox 통합 검증.
3. 바탕화면 Chrome 원격 데스크톱 복제본만 복구 가능하게 휴지통으로 이동.
4. UTM HA를 여러 번 재부팅·백업·복원한 후에만 VirtualBox 복구본 정리를 별도 승인.
5. ChatGPT 이중 설치는 Codex Worker 고정 경로를 이전한 뒤 315개 서버 시험·실제 Codex 작업 검증과 함께 정리.

