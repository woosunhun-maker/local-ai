# iPhone–Codex E2E 및 운영 지속성 읽기 전용 감사

- 감사 시각: 2026-08-08 20:00–20:11 KST
- 범위: Mac 운영 경로, Tailscale 연결, iPhone 설치 상태, build 9 아카이브 서명·프로비저닝, Codex 최초 E2E 완료 여부
- 제한: 20:11에 현재 설치본을 한 번 실행 요청해 보안 차단 여부를 확인했다. 설치·재서명·배포·설정 변경은 하지 않았다.

## 결론

| 항목 | 판정 | 근거 |
|---|---|---|
| Mac Secure Chat/Codex 운영 경로 | **GO** | 핵심 엔드포인트 HTTP 200, LaunchAgent 3개 실행, worker lease·커널 잠금 정상 |
| Tailscale iPhone→Mac 네트워크 | **GO** | tailnet 전용 HTTPS 프록시 정상, iOS 피어 온라인·direct ping 성공 |
| iPhone 앱 설치 | **GO(설치 확인)** | 실기기에 `com.hun.localai` v1.2.0 build 9 Developer App 설치 확인 |
| iPhone 앱 실제 실행 | **NO-GO(현재)** | CoreDevice 실행 요청이 iOS 보안 정책에 거부됨. 오류는 `invalid code signature, inadequate entitlements or profile not explicitly trusted` 세 가능성을 함께 제시 |
| 최종 build 9 아카이브 | **GO(아티팩트 서명)** | arm64, Team 일치, `codesign --verify --deep --strict` 통과 |
| iPhone→Codex 전체 E2E | **미검증** | 전용 Codex 승인 키 0개, Codex 작업 0건, Face ID 승인·결과 수신 이력 없음 |
| 2026-08-12 이후 iPhone 지속 운영 | **NO-GO(갱신 전)** | Personal Team 프로필이 2026-08-12 00:30:50 KST 만료 |

기기는 페어링됐고 Developer Mode도 켜져 있지만, 20:11 KST의 직접 실행 요청은 iOS에서 보안 사유로 거부됐다. CoreDevice 오류 문구는 `invalid code signature`, `inadequate entitlements`, `profile has not been explicitly trusted`를 하나의 합성 사유로 반환하므로 원인을 하나로 단정할 수는 없다. 다만 보존 아카이브의 strict codesign·Team·entitlement·등록 기기 일치는 통과했으므로, 사용자가 iPhone에서 개발자 프로필 신뢰 상태를 먼저 확인하는 것이 가장 짧은 다음 진단이다. 그 후에야 **Codex 작업 계획 → 전송 공개 확인 → Face ID/기기 암호 승인 → 결과 수신**의 실제 E2E를 검증할 수 있다.

## 1. Mac 운영 상태

| 증거 | 관찰값 |
|---|---|
| Secure Chat | `127.0.0.1:18791/health` HTTP 200, `exposure=loopback_only`; 해당 포트는 loopback에만 listen |
| 인증 경계 | 토큰 없이 `/api/status` 호출 시 HTTP 401 `device_authentication_required` |
| Telegram 브리지 | `127.0.0.1:18789/health` HTTP 200 |
| Deep proxy | `127.0.0.1:18790/health` HTTP 200 |
| Ollama | `127.0.0.1:11434` HTTP 200; 설치 모델 3개 확인 |
| LaunchAgent | Secure Chat PID 65053, Codex Worker PID 65021, Telegram PID 65082; 모두 `running`, `runs=1`, 마지막 종료 없음 |
| Codex worker | `workerReady()=true`, lease heartbeat 정상, worker lock 실제 보유, queued/running/undelivered 모두 0 |
| 저장소·잠금 | 핵심 JSON 정상 파싱; 데이터 파일·잠금 파일 0600, 데이터/임시 디렉터리 0700 |
| 소스와 live | `src/`, `public/`, `scripts/` 실행 코드 diff 없음; 양쪽 package v1.2.0 |
| 현재 자동검증 | npm 315/315 통과. 20:20 KST iPhone 17 Pro Simulator에서 iOS 39/39 통과, `** TEST SUCCEEDED **` 확인 |

Growth monitor가 현재 미실행인 것은 6시간 주기의 정상 대기 상태다. Codex/Telegram stderr의 오류 문구는 16:44 배포 시각까지의 누적 과거 로그이며, 현재 프로세스·lease·health에는 장애 증거가 없다.

## 2. 네트워크 및 기기 상태

- Tailscale backend와 Mac은 온라인이다.
- 서비스는 `https://macstudio.tail4ad006.ts.net`의 **tailnet 전용** HTTPS이며 public Funnel은 열려 있지 않다.
- 해당 URL의 `/health`는 TLS 검증 성공과 함께 HTTP/2 200을 반환했다.
- iOS 피어 1대가 온라인이고 Mac에서 direct ping에 성공했다.
- 실기기는 페어링 완료, Developer Mode 활성화, iOS 26.5.2, Xcode destination 인식 상태다.
- 전역 `xcode-select`는 Command Line Tools를 가리키지만, `/Applications/Xcode.app`의 개발자 경로를 명시하면 Xcode 26.6의 CoreDevice 검사가 정상 동작한다. 이는 현재 실행 장애가 아니라 **향후 갱신 명령에서 주의할 환경 조건**이다.

## 3. build 9 및 프로비저닝 증거

검사 아카이브: `/tmp/localai-ios-v120b9-v3-final.nMnBb3/LocalAI.xcarchive`

| 항목 | 확인값 |
|---|---|
| 생성 시각 | 2026-08-08 15:44:18 KST |
| 앱 | `com.hun.localai`, v1.2.0, build 9 |
| 아키텍처/최소 OS | arm64 / iOS 17.0 |
| 서명 | Apple Development, Team `8UUD85JPJ2`; strict/deep 검증 통과 |
| entitlement | application identifier와 Team 일치, `get-task-allow=true`인 개발 빌드 |
| 프로필 | Xcode 관리형 Personal Team, Local Provision, TTL 7일 |
| 프로필 생성 | 2026-08-05 00:30:50 KST |
| **프로필 만료** | **2026-08-12 00:30:50 KST** |
| 기기 포함 | 프로필 등록 기기 1대가 현재 실기기와 일치함(식별자는 비공개) |
| 인증서 만료 | 2027-08-05 00:20:47 KST; 더 이른 프로필 만료가 실제 제한 요소 |

20:00:43 KST 감사 시점의 프로필 잔여 시간은 정확히 **3일 4시간 30분 7초**였다.

CoreDevice는 실기기에 v1.2.0 build 9가 설치됐다는 사실은 보여 주지만, 설치본의 embedded profile/CDHash를 읽어 주지 않는다. 따라서 **설치본과 위 최종 아카이브가 바이트 단위로 동일하다고 단정할 수 없다.** 로컬 build 9 아카이브들이 같은 프로필을 사용하므로 동일 만료일일 가능성은 높지만 추론이다. 앱은 감사 시점에 실행 중이지 않았고, 과거 SplashBoard 스냅샷은 실행 시도 정황일 뿐 성공 실행 증명이 아니다.

또한 최종 아카이브가 `/tmp` 아래 있으므로 장기 보존 아티팩트로 간주하면 안 된다. 갱신은 보존된 소스 프로젝트에서 새 프로필로 다시 빌드·설치해야 한다. 오래된 DerivedData의 build 7/8은 설치 대상으로 사용하지 않는다.

## 4. 남은 iPhone→Codex E2E 차단점

서버에는 활성 owner 기기 1대와 기존 일반 승인용 P-256 키 1개가 있다. 그러나 다음 증거로 **Codex 전용 연결은 아직 완료되지 않았다.**

- 활성 owner의 전용 Codex 승인 키: 0개
- Codex 작업: queued 0, running 0, recent result 없음
- `codex.execute` 승인 이력: 없음
- 기존 승인 이력은 일반 GPT 상담 종류뿐임

iOS 클라이언트는 첫 Codex 작업 생성 전에 Secure Enclave 기반 Codex 공개키를 등록한다. 계획 생성까지는 로컬 처리이며, 사용자가 canonical plan과 외부 전송 공개 내용을 확인하고 승인하기 전에는 OpenAI로 코드가 전송되지 않는다. 실제 Face ID/기기 암호 승인이 있어야 공개된 범위의 코드가 Codex 작업으로 넘어간다.

## 5. 만료 후 무엇이 중단되는가

Apple은 Personal Team 프로비저닝 프로필이 발급 7일 뒤 만료되며, 만료 후 앱을 다시 빌드해 기기에 재설치해야 한다고 명시한다. 개발 프로필은 등록 기기에서 서명 앱의 실행을 허용하는 구성 요소다. [Apple Developer 계정 안내](https://developer.apple.com/help/account/basics/about-your-developer-account), [Development provisioning profile](https://developer.apple.com/help/glossary/development-provisioning-profile/), [만료 프로필 재생성·재서명 안내](https://developer.apple.com/help/account/provisioning-profiles/edit-download-or-delete-profiles/)

| 대상 | 2026-08-12 00:30:50 KST 이후 예상 |
|---|---|
| iPhone 앱 실행 | 현재 개발 서명 설치본의 계속 실행을 보장할 수 없으며, Apple 안내상 재빌드·재설치 필요 |
| Siri/App Shortcut | 앱 실행 경로가 유효하지 않으면 사용 불가 |
| 계획 확인·Face ID 승인 | 앱을 다시 유효하게 설치할 때까지 사용 불가 |
| 결과 보기 | Mac에 결과가 남아도 owner 앱에서 확인할 수 없음 |
| Mac Secure Chat/Tailscale/Telegram/Codex worker | iPhone 서명 만료와 무관하게 계속 운영 가능 |
| 이미 실행 중인 Mac 작업 | 계속 완료될 수 있고 결과는 로컬에 남음 |
| 승인 대기 작업 | iPhone 승인 불가 동안 자체 만료될 수 있음 |
| Mac의 auth/task 데이터 | 프로필 만료만으로 삭제되지 않음 |

동일 Team과 bundle ID로 재설치하면 기존 앱 정체성·Keychain 접근이 유지될 것으로 예상되지만 반드시 재확인해야 한다. Team 또는 bundle ID를 바꾸면 재페어링과 승인 키 재등록이 필요해질 수 있다.

## 6. 사용자가 지금 할 정확한 행동

1. iPhone에서 **`나의 Local AI` 앱을 직접 연다.** 현재 자동 실행 시험은 보안 정책에 거부됐다.
2. 앱이 열리지 않고 개발자 신뢰 안내가 나타나면, iPhone의 `설정 → 일반 → VPN 및 기기 관리 → 개발자 앱`에서 표시된 Apple Development 프로필을 사용자가 직접 확인하고 신뢰한다. 이 보안 결정은 Mac이 대신할 수 없다.
3. 정상적으로 열리면 **`Codex 작업` → `inspect`**를 선택한다.
4. 안전한 첫 점검 문구로 다음을 입력한다.

   `서버 코드의 오류 처리 경계를 읽기 전용으로 점검해줘`

5. 생성된 정확한 계획과 “외부로 전송되는 코드 범위”를 읽는다. 이 단계에서 원치 않으면 중단해도 된다.
6. 전송에 동의할 때만 Face ID 또는 기기 암호로 승인한다.
7. 작업 상태가 `succeeded`가 되고 결과가 owner 앱에 표시되는지 확인한다.

지속 사용을 위해서는 **2026-08-12 00:30:50 KST 전에** 선택해야 한다.

- 단기 무료 유지: 현재 Team·bundle ID를 유지하고 Xcode 자동 서명으로 새 프로필을 발급받아 재빌드·재설치한다. 명령형 작업에는 `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`를 사용한다.
- 권장 장기 유지: Apple Developer Program에 등록한 뒤 사용 목적에 맞는 지속 배포 방식(TestFlight/App Store 또는 등록 기기 배포)을 사용해 Personal Team의 7일 반복 만료를 제거한다.

## 7. 비핵심 발견과 감사 한계

- 별도 구형 Home Assistant `iphone-command` 브리지는 죽은 PID의 stale lock 때문에 비운영 상태다. 이는 이번 native Secure Chat/Tailscale/Codex 경로와 분리돼 있어 현재 핵심 연결에는 영향이 없다.
- 2026-08-05 생성된 오래된 LaunchAgent staging 폴더 1개가 남아 있으나 active 배포·rollback 프로세스는 없다.
- 기기 UDID, serial, ECID, 인증서 이메일·fingerprint, 토큰 hash 등 민감 식별자는 보고서에서 제거했다.
- 이번 판정은 2026-08-08 20:00–20:11 KST의 시점 감사다. 앱 실행은 보안 정책에 거부됐고, Face ID 승인과 설치본-아카이브 바이트 동일성은 증명하지 않았다.
- 감사 중 현재 설치본 실행 요청 1회를 제외하고 설치, 서명, 배포, LaunchAgent 재시작, 설정 변경을 하지 않았다.
