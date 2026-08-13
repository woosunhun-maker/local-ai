# 나의 Local AI 1.2.0 (build 9) 위협 모델

## 보호 대상

- 대화, 로컬 메모리, 첨부·음성 내용
- 등록 iPhone 토큰과 Secure Enclave 승인 키
- OpenClaw Gateway·제한 프록시·Home Assistant 인증정보
- 집 기기 제어 권한과 로컬 파일
- 외부 AI로 전송하기 전 frozen payload와 외부에서 받은 제안

## 네트워크 경계

- Secure Chat, OpenClaw, Ollama, 제한 프록시는 loopback에만 바인딩한다.
- iPhone 경로는 Tailscale Serve의 tailnet 전용 HTTPS다. Funnel은 금지한다.
- 앱에는 OpenClaw 운영자 토큰을 넣지 않는다. 제한 프록시는 `openclaw/default`만 제공한다.
- OpenClaw Telegram 채널·플러그인과 직접 cloud-agent/spawn 경로는 비활성화한다.
- 외부 기술 자문은 고정된 tool-free one-shot 모델 경로 하나만 사용한다.

## Telegram 일반대화 경계

- Telegram 봇 대화는 Telegram 서버를 통과하며 종단간 암호화가 아니다. 일반 대화 전용 편의 경로일 뿐 로컬 앱의 보안 경계를 상속하지 않는다.
- 전용 릴레이는 OpenClaw와 분리되어 고정 loopback Ollama endpoint와 승인된 로컬 모델 하나만 호출한다. 도구, 외부 AI, 파일, 메모리, 브라우저, Home Assistant 경로가 없다.
- 단일 소유자 private DM의 `from.id`와 `chat.id`가 모두 일치해야 한다. 그룹·채널·전달·첨부·외부 링크는 차단한다.
- 개인정보·로그인·메일·구매·파일·기기·홈 제어 패턴은 모델 호출 전에 차단한다. 차단 요청으로 로컬 앱 작업을 자동 생성하지 않는다.
- 메시지 원문은 기록하지 않고 문맥은 RAM에만 제한적으로 보관한다. 디스크에는 Telegram update offset 정수만 기록한다.
- 봇 토큰은 macOS Keychain에만 저장하며 설정은 owner id, bot username, mode 같은 비밀이 아닌 메타데이터만 가진다.

## Local AI 앱 승인 Codex 개발 경계

- Telegram `/codex inspect|draft`는 작업을 생성하지 않고 Local AI 앱의 서명 승인 경로로 안내한다. `/codex status|help`와 일반 로컬 대화만 유지한다.
- owner 앱은 exact request, intent, owner device hash, idempotency key, 허용 코드·알려진 식별자 검사/치환 manifest SHA-256와 실행·외부 전송 계약 전체를 canonical plan으로 고정한다. iPhone의 Face ID 또는 기기 암호 확인 뒤 전용 P-256 키가 서명한 승인만 한 번 소비한다.
- 직원·장부·계좌·재고·CCTV·메일·구매·브라우저·홈 제어·연락처 등 로컬 운영자료 목적 요청과 알려진 비밀 패턴은 plan 생성 전에 거부한다. 코드 보안 점검 요청은 허용한다.
- 대기 승인과 queued 상태는 합계 3개 슬롯을 미리 예약한다. 승인된 작업은 추가 큐 경쟁 없이 queued로 전이하며 worker singleton lease·heartbeat를 적용한다.
- worker는 Telegram 토큰이나 owner 앱 인증 토큰을 읽지 않는다. owner 앱 작업에는 합성 owner identity만 사용한다.
- Codex 입력 저장소는 실제 Git 상위 폴더나 Windows 내보내기가 아니라 `/Users/Shared` 아래의 작업별 합성 Git 복제본이다. 원본의 symlink, `.git`, `.codex`, `AGENTS.md`, `.env`, 로그, DB, 첨부, 바이너리를 가져오지 않는다.
- owner id, 실제 사용자 홈 경로, 로컬 Home Assistant·tailnet 호스트와 Apple team ID를 합성값으로 치환하고, 복사 전후 전체 텍스트 DLP가 실패하면 작업을 실행하지 않는다. `docs`, `research`, 허용 루트 내부 Markdown과 임의 루트 파일도 snapshot에서 제외한다.
- 승인 시점의 scrubbed source manifest와 실행 직전 원본 수집물·복사본·모델 입력 직전 snapshot·모델 응답 직후 저장소를 정확히 대조한다. 하나라도 다르면 외부 모델 실행 또는 결과 사용을 중단한다.
- `codex exec`는 정확한 binary/version/model, ephemeral 세션, 사용자 config/rules 무시, 고정 output schema와 stdin prompt로 실행한다. 모델 도구의 shell/unified exec/shell snapshot·파일 쓰기·computer/browser·추가 network·web search·apps·plugins·MCP·hooks·memories·multi-agent를 비활성화한다.
- exact task instruction과 허용 코드·알려진 식별자 검사/치환 snapshot은 승인 후 OpenAI Codex 모델 처리로 외부 전송된다. 로컬 Codex client는 로그인 인증을 위해 기존 Codex credential을 사용하며 별도 OS process sandbox 없이 실행된다. 모델에는 Mac 원본 파일 도구가 제공되지 않지만 client 프로세스 자체의 OS 권한과 동일한 주장으로 확대 해석하지 않는다.
- 모델에는 합성 저장소 자체의 로컬 경로도 열어주지 않고, trusted worker가 다시 allowlist·DLP 검사한 최대 2 MiB JSON 소스 스냅샷만 prompt 데이터로 제공한다. 저장소 내용의 지시는 권한 없는 untrusted data다.
- inspect는 구조화 요약만 허용한다. draft의 diff는 ASCII 상대 경로, canonical unified diff, 최대 20개 텍스트 파일로 제한하고 삭제·rename/copy·binary·symlink/gitlink·mode 변경·보호 파일·malformed/duplicate hunk를 거부한다.
- trusted worker만 동일 patch bytes를 stdin으로 `git apply --check` 후 합성 저장소에 적용한다. 적용 뒤 changed path set, `git diff --check`, 전체 repository DLP·symlink·text·크기 검사를 다시 통과해야 한다.
- terminal 상태 저장 후 exact job id의 격리 작업공간만 자동 정리한다. 삭제 실패는 다음 worker 시작의 terminal-only janitor가 재시도하며, store에 없는 수동·legacy 디렉터리는 건드리지 않는다.
- owner 앱 terminal 작업과 exact `codex.execute` 승인 payload는 최대 7일·최근 100건까지만 보존한다. active 작업, Telegram 기록, 다른 approval kind는 이 retention 작업이 삭제하지 않는다.
- 로컬 도구 실행 이벤트가 모델 출력에 하나라도 나타나면 작업 전체를 실패 처리한다. 검증된 한국어 요약·변경 수·diff 초안은 작업을 승인한 동일 owner 앱에만 반환한다. Telegram에는 Codex 상세 결과·원시 모델 이벤트·명령 출력·diff·절대 경로를 보내지 않는다.
- 실제 소스 반영, 배포, 설치, 재시작과 모든 운영 개인정보 작업은 이 경계 밖이다. OpenAI 외부 전송은 위 canonical payload에 명시되고 owner 앱의 정확한 서명 승인 없이는 실행하지 않는다.

## 로그인된 브라우저 경계

- `user` 프로필이나 전체 Chrome 디버깅 포트를 사용하지 않는다. 확장이 만든 OpenClaw tab group에서 사용자가 명시적으로 공유한 탭만 사용한다.
- 허용 origin은 쿠팡과 Gmail로 고정한다. arbitrary URL, cookies, local/session storage, request/response body, evaluate, upload, download, PDF API는 작업 실행기에 노출하지 않는다.
- 페이지 snapshot은 신뢰하지 않는 입력이며 디스크·감사 로그에 보관하지 않는다. 해석이 필요하면 외부 전송 없이 로컬 모델만 사용한다.
- 메일 읽기는 owner 앱 ingress에서만 허용하고 본문은 앱 응답으로만 반환한다. 결과 저장소에는 상태 코드와 항목 수만 남긴다.
- 장바구니 변경은 상품 URL·이름·옵션·수량·예상 단가·최대 총액의 canonical payload에 대한 Secure Enclave 승인과 결합한다. live 가격·옵션이 다르면 중단한다.
- checkout·purchase·payment와 메일 send/reply/forward/delete/archive/mark-read는 기본 거부한다.
- 승인 후 브라우저 결과가 불확실하면 자동 재시도하지 않는다. 로그인, OTP, 2FA, CAPTCHA는 사용자가 수행한다.

## 기기 인증과 승인

- 페어링 비밀은 256비트 무작위 값이며 5분 만료·1회 사용이다.
- 서버는 기기 토큰 원문 대신 SHA-256 해시를 저장한다. iOS 원문은 `ThisDeviceOnly` Keychain에 저장한다.
- 기존 기기는 안전 마이그레이션 시 모두 `member`가 된다. `owner` QR로 연결한 기기만 승인 API를 사용할 수 있다.
- 실기기는 software signing fallback 없이 Secure Enclave P-256 키만 사용한다.
- iPhone은 화면에 표시한 UTF-8 payload의 SHA-256을 직접 계산한다. 서버가 제시한 해시와 다르면 승인할 수 없다.
- 서명은 request id, payload hash, nonce, expiry, decision 여섯 줄에 묶인다.
- 저장된 승인 proof를 읽을 때마다 공개키·서명·payload·frozen request digest를 다시 검증한다.
- 승인됐더라도 소비 순간 만료를 원자적으로 다시 확인하고 한 번만 소비한다.

## 의도·기억·효과 검증 경계

- 로컬 모델의 의도 해석은 실행 명령이 아니라 `untrusted hypothesis`다. 알려진 작업의 효과 등급과 필수 정보는 모델이 아니라 코드 소유 profile이 결정한다.
- 모델이 장바구니 변경을 단순 대화나 읽기로 낮출 수 없다. 상품·옵션·수량·단가·총액 한도처럼 결과를 바꾸는 정보가 빠지면 정확한 승인 단계로 진행하지 않는다.
- 불확실성을 줄이기 위한 자동 준비는 계정 변경 없는 공개 읽기로만 제한한다. 등록되지 않은 작업은 토론 상태에 머문다.
- 대화 모델과 효과 계획 모델을 분리한다. `qwen3.6:35b`는 도구 없는 대화·의도 가설에만 사용하고, 모델 교체가 실행 권한 확대로 이어지지 않게 한다.
- 추론한 기억은 즉시 사용하지 않고 candidate로 격리한다. 정확한 사용자 확인 뒤에만 active가 되며 namespace·subject·scope·purpose·expiry가 모두 맞아야 읽을 수 있다.
- durable private memory는 owner 로컬 앱에만 반환한다. Telegram과 직접 voice channel에는 제공하지 않으며 credential category는 스키마 자체가 받지 않는다.
- 기억 payload는 AES-256-GCM으로 암호화하고 immutable metadata binding을 AAD로 인증한다. 파일은 0600 단일 링크 regular file만 허용하며 key id는 고정한다.
- 256-bit 기억 키는 macOS Keychain의 고정 service/account에서만 읽는다. subprocess 오류·stdout은 로그나 API 오류에 포함하지 않고 RAM cache는 명시적으로 지울 수 있다.
- intent shadow는 기본 비활성이다. 활성화해도 원문·질문 digest·모델 summary를 저장하지 않고 outcome count와 bounded latency 정수만 저장하며 실제 행동은 바꾸지 않는다.
- 외부 효과의 성공은 실행 모델의 자기 보고로 확정하지 않는다. 공급자 영수증과 독립 read-only reconciliation을 함께 요구하고, 이벤트 로그를 재시작 후 읽을 때도 동일한 증거를 다시 검증한다.
- 효과 이벤트별 detail field는 닫힌 스키마다. 숨은 자유문 payload, 미래 시각 증거, 다른 검증자·계정·principal에 묶인 증거를 거부한다.

## 외부 AI 데이터 경계

- 허용 입력은 고정 performance template의 bounded integer 네 개뿐이다.
- 사용자나 로컬 LLM이 만든 자유문을 outbound draft로 받을 수 없다.
- raw conversation, memory, contact, message, calendar, location, home security, health, finance, legal, biometric, photo, audio, private source, credentials, unknown fields는 모두 deny다.
- 외부 호출에는 도구·메모리·첨부가 없으며 응답은 네 문자열의 고정 JSON contract만 허용한다.
- 응답은 실행 가능한 필드가 없는 untrusted proposal로 격리한다. 실제 자동 적용 endpoint와 임의 명령 runner는 없다.
- 승인 후 전송 결과가 불확실하면 중복 전송을 막기 위해 자동 retry하지 않는다.
- 외부 제공자는 기술 payload를 자체 정책에 따라 처리할 수 있으므로, 개인정보가 outbound schema에 도달하지 않는 것을 1차 안전 경계로 둔다.

## 음성 경계

- Qwen 모델 revision, MLX Audio commit, Python 버전, 전체 venv, worker, sandbox profile을 해시로 고정한다.
- TTS worker는 `sandbox-exec` 안에서 network가 거부된다.
- 사용자 홈 읽기를 거부하고, 검증된 runtime·model·전용 private tmp만 읽을 수 있다.
- 전용 private tmp 밖 파일 쓰기를 거부한다. 음성 텍스트와 PCM은 임시 파일 없이 stdin/stdout으로 전달한다.
- 느린 iPhone에는 HTTP drain backpressure를 적용하고 연결 종료·취소를 worker까지 전파한다.
- worker crash는 최대 1회만 재시작하고 catalog에 실제 health를 표시한다.

## 로컬 저장과 로그

- 대화 파일은 iOS complete file protection을 적용하고 iCloud backup에서 제외한다.
- Mac의 auth, approvals, web-task plan metadata, proposals, runtime manifest는 private directory와 0600 파일을 사용한다.
- 감사 로그에는 대화·음성·voice id·토큰 원문을 기록하지 않는다.
- 선제 APNs/HA 알림에는 실제 본문을 넣지 않는다. 앱이 인증 후 Mac에서 가져온다.
- 서비스 워커는 `/api/` 응답을 캐시하지 않는다.

## 남은 위험

- 탈옥 iPhone, 악성 프로필, macOS 사용자 계정 탈취, Tailscale 계정 탈취는 이 경계를 우회할 수 있다.
- App Attest와 별도 MDM은 아직 적용하지 않았다.
- iOS는 제3자 앱의 상시 백그라운드 마이크나 임의 자동 음성 재생을 허용하지 않는다. 알림 탭·Siri·앱 실행 뒤에만 실제 내용을 읽는다.
- 이전 Telegram bot token은 로컬에서 비활성화·삭제해도 Telegram 측 토큰 자체는 BotFather에서 별도로 폐기해야 한다. 새 봇 토큰도 Telegram 서비스 운영상 Telegram이 보유한다.
- 공유한 브라우저 탭에는 페이지 자체의 보안·피싱·세션 탈취 위험이 남는다. 사용자는 확장에서 탭 공유를 해제해 즉시 권한을 회수할 수 있다.
- 고정 upstream commit과 모델 revision을 사용하지만 최초 다운로드 공급망을 완전히 자체 서명하는 단계는 아니다. 설치 후 실행물은 전체 해시와 sandbox로 다시 제한한다.
- 의도 협상, 선택적 기억, 효과 원장 코드는 현재 release candidate에서 검증 중이며 실행 중인 1.2.0 (build 9) runtime에는 아직 연결하지 않았다. 암호화 payload store와 Keychain reader는 합성 시험만 통과했으며 실제 key 생성·기억 수집·브라우저 verifier adapter 연결은 하지 않았다.
