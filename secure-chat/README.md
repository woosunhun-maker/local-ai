# 나의 Local AI 1.2.0 (build 9)

iPhone과 Mac Studio를 Tailscale 사설망으로 직접 연결하는 로컬 AI 앱이다. API는 `127.0.0.1:18791`에만 바인딩되고, iPhone은 tailnet 전용 HTTPS를 통해서만 접근한다. Funnel은 사용하지 않는다.

**채널 역할:** Telegram = 일상 잡담·짧은 로컬 답. Local AI 앱/맥 웹 = 개인정보·기억 확인·아이폰/맥 연동 제어·승인. 중요 지시·개인정보·음성·승인 데이터는 Telegram·Kakao를 거치지 않는다.

Telegram은 로컬 일반 대화와 Codex 상태 조회에 쓸 수 있다. 종단간 암호화가 아니므로 Codex 실행 요청은 접수하지 않는다. Codex 점검·초안은 Local AI 앱에서 정확한 요청과 코드 스냅샷 hash, OpenAI 외부 전송 사실을 확인하고 기기 소유자 인증으로 서명한 뒤에만 실행한다.

## 1.2.0 (build 9)에 포함된 기능

- ChatGPT형 SwiftUI 대화 화면, 대화 기록·새 대화·Markdown·복사·재생·재생성
- `자동`·`빠른 대화`·`깊게 생각하기` 모드와 실제 처리 단계·경과 시간·오류·중지 표시
- 응답 스트리밍 40ms 배치, 요청 취소 전파, 대화 전환 경합 차단, 완료 전에는 가벼운 일반 텍스트 렌더링
- Siri/App Intents 음성 지시, 사용자 시작 음성 입력, 민감 본문 없는 선제 알림
- Apple 음성 전체 미리듣기와 로컬 Qwen3-TTS Sohee 추천 음성
- iPhone Secure Enclave P-256 서명 기반 중요 작업 승인
- 모델 문구가 아니라 정규화된 상품·옵션·수량·가격 계획에서 결정적으로 생성되는 장바구니 승인 preview
- 개인정보를 제외한 집계 성능 문제만 외부 AI에 질문할 수 있는 제안형 성장 파이프라인
- OpenClaw·도구·개인 메모리와 물리적으로 분리된 Telegram 일반대화 릴레이
- Local AI 앱의 서명된 1회 승인으로만 작동하는 허용 코드·알려진 식별자 검사/치환형 Codex 점검·초안 worker
- 사용자가 명시적으로 공유한 Chrome 탭만 대상으로 하는 웹 작업 기본 거부 정책
- 폰 자동화 드라이버 앞의 앱 allowlist·민감 앱 영구 차단·OCR 마스킹·서명된 1회 승인 게이트웨이
- 모델 추론을 곧바로 명령으로 승격하지 않는 intent hypothesis·shadow 평가 기반
- 의도 슬롯의 상품·옵션·수량·가격·검색 조건 hash와 실제 정규화된 웹 작업 계획을 전부 대조하는 intent-plan binding
- 원래 의도 가설·정규화된 웹 계획·MomentContract를 승인 직전 다시 재생성해 대조하는 intent-moment linkage
- 확인된 기억만 owner 앱에서 읽을 수 있는 AES-256-GCM 선택적 기억 저장과 이중 hash-chain metadata catalog 기반

## 대화 경로

- 일반 대화는 Mac의 `qwen3.6:35b`를 도구 없이 `think:false`, 16k 컨텍스트로 호출하고 10분 유휴 후 메모리에서 해제한다. 행동 계획 경로의 모델은 별도로 고정해 대화 모델 교체가 실행 권한 확대로 이어지지 않는다.
- 기기 제어·작업 요청 또는 사용자가 선택한 깊은 모드는 제한 프록시를 거쳐 `openclaw/default` 로컬 에이전트로 간다.
- 클라이언트가 연결을 끊거나 중지하면 Ollama/OpenClaw 상류 요청까지 취소된다.
- 잘린 스트림은 성공으로 표시하지 않고 재시도 가능한 오류로 끝난다.
- intent shadow는 기본 `disabled`다. 켜더라도 원문·요청 해시는 저장하지 않고 성공/실패·다음 단계·지연 집계만 남기며 실제 라우팅이나 실행 결과를 바꾸지 않는다.
- 반복 가능한 합성 Qwen 적합성 시험은 대화·모호한 장바구니·개인 메일 읽기·지원하지 않는 구매를 검사하며 원문이나 case별 결과 없이 집계만 출력한다.
- Qwen의 action 출력은 등록된 다섯 action 또는 `unregistered.*`로 JSON schema에서 제한한다. 명시적 결제·주문을 장바구니로 낮추면 host가 거부하고, 공개 검색의 query가 빠졌지만 확인된 product name이 있으면 그 값만 query hash로 정규화한다.
- 의도 가설이 준비 또는 실행 가능 판정을 받아도 실제 계획의 action과 모든 필수 parameter hash가 일치해야 다음 계약 단계로 전달된다. 상품·수량·가격 중 하나라도 바뀌면 새 의도 확인이 필요하다.
- MomentContract의 plan digest, action, parameter 전체, effect class, authorization mode와 provenance가 앞 단계 binding에 일치해야 한다. 저장된 binding만 새로 꾸민 경우도 원래 컴파일된 의도 가설로 재생성해 거부한다.
- 장바구니 승인 문구와 구조화 facts는 같은 plan에서 생성하고 MomentContract presentation 및 승인 payload에 다시 결합한다. 효과를 축소한 문구나 수량·가격이 바뀐 preview는 표시 전에 거부한다.

## 선택적 개인 기억

- 모델 추론은 먼저 unreadable candidate가 된다. 사용자 확인과 활성화 전에는 대화 context에 넣지 않는다.
- 기억 metadata는 namespace·subject·scope·purpose·expiry·source digest에 결합한다. 개별 기억의 상태 전이와 전체 catalog append 순서를 각각 hash chain으로 검증해 candidate→active 건너뛰기와 과거 항목 변조를 거부한다.
- 실제 값은 AES-256-GCM으로 암호화하며 metadata binding을 AAD로 사용한다. 키는 파일이나 환경변수에 두지 않고 고정 macOS Keychain item에서만 읽도록 어댑터를 분리했다.
- catalog 검색 결과는 활성 기억의 제한된 metadata만 반환하며 실제 값과 value digest를 노출하지 않는다. 파일과 디렉터리는 owner-only 권한을 강제한다.
- coordinator는 catalog candidate를 먼저 기록한 뒤 암호문을 검증하고, 둘 중 하나만 완료된 장애를 재시도 가능하게 유지한다. payload가 없거나 인증되지 않으면 confirmed·active로 전이하지 않는다.
- private durable memory는 인증된 owner 로컬 앱에서 정확한 purpose로 요청한 경우만 복호화한다. Telegram과 직접 voice channel은 차단한다.
- **라이브(확인형 공통 기억):** `ConfirmedMemoryStore`가 Mac 원본 JSON을 쓰고, owner 앱의 `/api/memory*`와 빠른 대화 경로에 on-demand로 주입한다. 맥 웹(`ai-council`)과 같은 파일을 공유한다.
- AES-256-GCM + Keychain 기반 encrypted memory는 release candidate로 남아 있으며, 확인형 저장소의 다음 승격 단계다.

## Telegram 일반 대화

- OpenClaw의 Telegram 플러그인은 계속 꺼 둔다.
- 전용 릴레이가 `127.0.0.1`의 Ollama/Qwen에 직접 연결한다. OpenAI, OpenClaw, Home Assistant, 브라우저, 파일 도구를 제공하지 않는다.
- 소유자 개인 DM만 허용하고 그룹·전달·첨부·숨은 링크를 거부한다.
- 대화 문맥은 RAM에서만 최대 12개 메시지·15분간 유지하고 재시작 시 사라진다. 디스크에는 다음 update id 정수만 저장한다.
- 봇 토큰은 앱에서 받아 macOS Keychain에만 저장한다. argv, 환경 변수, 설정 파일, 로그에는 넣지 않는다.
- 비밀번호·OTP·계정·주소·금융·메일·구매·파일·홈 제어 **실행형** 요청은 로컬 모델로 보내지 않는다.
- 그중 **결제·민감 조회**는 사람 직접 처리로만 안내한다.
- 그 외 실행형 요청(예: 쿠팡 검색/장바구니 준비)은 `owner.action.v1` 승인 요청을 만들고, 나의 Local AI 앱에서 Face ID/암호로 승인한 뒤에만 Mac이 안전 단계(공개 검색 등)를 실행한다. 결제·주문 확정은 실행하지 않는다.
- 소유자 개인 DM의 `/status`는 모델을 호출하지 않고 loopback 보안 서버·Ollama·격리 Codex 대기열의 비민감 상태만 결정적으로 보고한다. `/models`는 모델에게 추측시키지 않고 코드에 고정된 실제 역할·모델과 아직 연결되지 않은 기능을 표시한다. `/progress` 또는 `진행 상황`은 명시된 시험·운영 게이트로 계산한 진행률과 현재 실제 가능한 기능을 표시한다.
- Telegram의 `/codex status|help`는 비민감 상태와 Local AI 앱 승인 안내만 제공한다. `/codex inspect|draft`는 큐에 넣지 않는다.

새 토큰은 BotFather에서 발급 또는 재발급한 뒤 iPhone 앱의 `설정 → 통신 및 웹 작업`에서만 붙여넣는다. 토큰을 이 채팅이나 Telegram에 붙여넣지 않는다. 아직 토큰을 등록하지 않았다면 릴레이는 안전하게 비활성 종료된다.

## Local AI 앱 → 승인 → OpenAI Codex

Telegram 일반 문장은 계속 로컬 Ollama로만 간다. Telegram의 `/codex inspect|draft`는 실행되지 않으며 Local AI 앱 승인 화면으로 안내한다. 앱은 다음 실행 계약 전체를 canonical plan으로 표시하고 서명한다.

- `inspect`와 `draft`의 정확한 요청 및 허용 코드에서 알려진 식별자를 검사·치환한 snapshot은 승인 후 OpenAI Codex로 외부 전송된다. Markdown 운영문서, `docs`, `research`, 로그, DB, 첨부와 임의 루트 파일은 포함하지 않는다.
- source manifest SHA-256을 승인 plan에 고정한다. 승인 이후 허용 소스가 바뀌면 worker가 실행 전에 실패 처리하며 새 승인을 요구한다.
- Codex 모델에는 shell·파일·브라우저·컴퓨터 제어 도구를 제공하지 않고 도구의 추가 네트워크도 끈다. 다만 로컬 Codex 클라이언트 자체는 OpenAI 모델 처리와 로그인 인증을 위해 네트워크와 기존 Codex 인증을 사용하며 별도 OS process sandbox 안에서 실행되지는 않는다.
- `draft`가 반환한 unified diff는 좁은 canonical 문법, 경로 allowlist, DLP, `git apply --check`, 사후 전체 저장소 검사를 모두 통과한 경우에만 `/Users/Shared/LocalAI-Codex-Workspace` 아래의 작업별 폐기 가능한 복제본에 trusted worker가 반영한다.
- 실제 소스, 실행 중인 서비스, iPhone 앱, Git 원격 저장소에는 자동 반영하지 않는다.
- 복제 전에 symlink·바이너리·DB·로그·`.env`·`.codex`·`AGENTS.md`를 제외하고, 소유자 ID·사용자 홈 경로·로컬 Home Assistant·tailnet 호스트·Apple team ID를 합성값으로 바꾼다. 알려진 비밀 패턴이 하나라도 남으면 실행하지 않는다. 이 검사는 모든 개인정보 제거를 보장하지 않으므로 운영자료 목적의 요청도 별도로 차단한다.
- Codex 버전과 모델을 고정하고 shell/unified exec·앱·플러그인·MCP·웹 검색·컴퓨터 제어·브라우저·모델 도구 네트워크를 끈다. 모델은 bounded JSON snapshot만 입력으로 받으며 Mac 원본 파일 도구는 제공받지 않는다.
- 패치 validator는 절대·상위·quoted 경로, `.git`·`.codex`·`.env`·`AGENTS`·Git 메타 파일, 삭제·rename·binary·symlink·실행 모드 변경, 중복 section과 malformed hunk를 거부한다. 최대 20개 텍스트 파일만 허용한다.
- 앱 접수는 owner device hash와 idempotency key, 요청, intent, source manifest에 결합한다. 대기+큐는 합계 3개로 예약하고 worker lease로 한 번에 한 worker와 한 작업만 실행하며 중단 결과는 자동 재실행하지 않는다.
- 앱에는 구조화·DLP 검사를 통과한 요약·변경 파일 수와, `draft`일 때만 검증된 diff·SHA-256·정렬된 상대 경로를 반환한다. 원시 stdout/stderr, 절대 경로, 비밀 탐지 내용은 반환하지 않는다.
- owner 앱의 검증된 `draft` diff는 실제 소스에 자동 반영하지 않고 사용자가 검토할 결과로만 반환한다. 검증을 위해 격리 복사본에 임시 적용한 작업공간은 terminal 기록 직후 자동 정리하고, 실패하면 다음 worker 시작 때 terminal job id만 대상으로 다시 시도한다.
- owner 앱 terminal 작업과 연결된 `codex.execute` 승인은 최대 7일·최근 100건 중 먼저 도달하는 경계까지만 보존한다. 대기·queued·running 작업과 Telegram/다른 승인 종류는 이 정리 대상이 아니다.
- 실제 반영·테스트 배포·설치·재시작과 운영 개인정보 작업은 이 Codex 경계 밖이다. Telegram의 “승인” 문장은 승인으로 인정하지 않는다.

## 로그인된 웹 작업 경계

웹 작업은 일반 Chrome 전체 프로필이 아니라 OpenClaw 확장으로 사용자가 공유한 탭만 본다. 현재 준비된 계약은 다음 네 가지다.

- `coupang.search`: 공개 상품 검색
- `coupang.cart.add`: 상품 URL·옵션·수량·예상 단가·최대 총액 전체를 iPhone에서 승인한 뒤 한 번만 시도
- `mail.important.list`: 로컬 앱에서만 요청·표시하는 Gmail 중요 메일 목록 읽기
- `mail.message.read`: 사용자가 고른 메일 한 건 읽기

결제·주문 확정·구매, 메일 발송·회신·전달·삭제·보관·읽음 변경, cookies/storage/evaluate/upload/download/response body 같은 원시 브라우저 기능은 기본 차단한다. 메일 본문과 브라우저 snapshot은 결과 저장소에 기록하지 않는다. 페이지 내용은 신뢰하지 않는 입력으로 취급하며 로컬 모델만 사용할 수 있다.

Chrome 확장과 쿠팡/Gmail 탭을 처음 공유한 다음에는 현재 사이트 UI를 직접 검사해 live selector를 검증해야 한다. 그 전에는 웹 변경을 완료했다고 표시하지 않는다. 로그인·2FA·OTP·CAPTCHA는 사용자가 직접 처리한다.

## 폰 미러링·자동화 경계

폰 드라이버를 로컬 모델에 직접 주지 않고 `DeviceSafetyGateway`를 사이에 둔다. 인증·비밀번호·금융·건강·신분·시스템 설정 앱은 항상 차단하고, 앱별 개인정보 영역을 OCR 전에 가린 뒤 마스킹된 텍스트만 모델에 전달한다. 터치·입력·전송·삭제·권한 변경은 기존 iPhone Secure Enclave 승인에 작업 본문을 결합하고 한 번만 소비한다. 결제·송금·구매는 영구 차단한다. 연결 계약과 주의사항은 [폰 자동화 개인정보 경계](docs/PHONE_AUTOMATION_PRIVACY.md)를 참조한다.

## 고품질 로컬 음성

Qwen3-TTS 1.7B 6-bit 모델과 MLX Audio 소스는 정확한 revision으로 설치한다. 모델·전체 Python venv·worker·sandbox profile을 파일별 SHA-256으로 검증한다. 음성 worker는 macOS sandbox 안에서 실행되어 네트워크, 사용자 홈 읽기, 전용 비동기화 임시 폴더 밖 쓰기가 차단된다.

설치 전에는 Qwen을 `사용 불가`로 정확히 표시하고 iPhone Apple 음성으로 폴백한다. 설치 후 모델은 백그라운드에서 미리 준비되며 첫 문장이 완성되는 즉시 재생을 시작한다. PCM 일부를 재생한 뒤 오류가 나면 같은 문장을 Apple 음성으로 중복 재생하지 않는다.

## 개인정보 보호형 성장

성장 모니터는 대화 본문을 읽어 질문으로 바꾸지 않는다. 허용 입력은 다음 네 정수뿐이다.

- 표본 수
- 중앙 지연
- p95 지연
- 일반 실패 수

이 값은 고정 템플릿으로만 질문이 되며, 자유문·대화·메모리·연락처·메시지·캘린더·위치·집 보안·건강·금융·사진·음성·파일·인증정보는 스키마상 넣을 수 없다.

외부 전송 순서는 다음과 같다.

1. Mac이 exact canonical JSON, SHA-256, nonce, 만료 시간을 고정한다.
2. iPhone이 표시 본문을 직접 다시 해시하고 Secure Enclave로 승인 또는 거부를 서명한다.
3. Mac은 동일한 frozen payload만 한 번 소비한다. 만료 후 소비와 불확실한 네트워크 결과의 자동 재전송은 금지한다.
4. 외부 답변은 명령·코드·도구 권한 없는 `untrusted_external_advice` 제안으로 격리한다.
5. 자동 적용은 꺼져 있다. 합성 시험과 rollback checkpoint 없이 실제 파일을 바꾸지 않는다.

외부 transport는 기본값이 `disabled`다. 라이브에서 `LOCAL_AI_GROWTH_TRANSPORT=openclaw`를 명시한 경우에도 위 exact-payload iPhone 승인 없이는 호출되지 않는다.

## 소유자 페어링

기존 0.x 기기는 1.0 배포 시 자동으로 `member`가 되어 대화만 가능하다. 승인 권한은 자동 승격되지 않는다. 소유자 iPhone은 새 5분·1회용 QR로 명시적으로 다시 연결한다.

```sh
LOCAL_AI_CHAT_PUBLIC_URL="https://macstudio.tail4ad006.ts.net/" \
  scripts/create-pairing-qr.sh --owner
```

QR 원문은 비밀이다. 채팅이나 로그에 붙이지 않는다.

## 개발 검증

```sh
npm test
npm start
```

네이티브 앱은 `ios/LocalAI.xcodeproj`에 있다. Release 실기기 빌드를 사용하며 현재 소스 버전은 1.2.0(build 9)이다.

데이터와 위협 경계는 [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)를 참조한다.
