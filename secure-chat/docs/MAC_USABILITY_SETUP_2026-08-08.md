# Mac 사용성·바탕화면 정리 보고서

- 작업일: 2026-08-08 (Asia/Seoul)
- 대상: Mac Studio / macOS 26.6 (25G72)
- 원칙: 공식 앱·공식 웹사이트만 사용하고, 로그인·암호·개인정보·보안 권한은 변경하지 않는다.

## 적용 완료

1. **4K 출력 유지 확인**
   - 물리 출력: `3840 × 2160`
   - macOS 논리 해상도: `1920 × 1080`
   - HDR: 꺼짐
   - 현재 주사율: `50Hz`
   - BetterDisplay를 다시 설치하거나 가상 디스플레이를 만들지 않았다.

2. **새 배경화면 생성·적용**
   - 원본 생성물: `1672 × 941 PNG`
   - 적용본: `3840 × 2160 PNG`
   - 적용 파일: `/Users/hun/Pictures/LocalAI/LocalAI-Graphite-Amber-4K-2026-08-08-upscaled.png`
   - 스타일: 저휘도 흑연색, 앰버 골드, 소량의 딥 레드, 글자·로고·인물 없음
   - 표시 방식: 화면 채우기
   - 모든 Spaces에 동일 적용: 켜짐

3. **YouTube 공식 웹앱 설치**
   - 위치: `/Users/hun/Applications/YouTube.app`
   - 원본: `https://www.youtube.com/`
   - Safari의 공식 `Dock에 추가` 기능으로 생성했다.
   - 실제 실행 후 `youtube.com` 홈이 열리는 것을 확인했다.
   - 앱을 종료한 뒤에도 찾기 쉽도록 Dock에 영구 고정했다.

4. **Instagram 공식 웹앱 설치**
   - 위치: `/Users/hun/Applications/Instagram.app`
   - 원본: `https://www.instagram.com/`
   - Safari의 공식 `Dock에 추가` 기능으로 생성했다.
   - 실제 실행 후 `instagram.com` 홈이 열리는 것을 확인했다.
   - 처음 뜬 알림 권한 요청은 임의 허용하지 않고 `나중에 하기`로 보류했다.
   - 앱을 종료한 뒤에도 찾기 쉽도록 Dock에 영구 고정했다.

6. **Dock 변경 복구점 생성**
   - 변경 전 Dock 설정: `/Users/hun/Documents/로컬ai/mac-backups/dock-before-webapps-2026-08-08.plist`
   - Dock 프로세스가 첫 자동 재시작에서 종료 코드 1로 멈춰, plist 무결성 `OK`를 확인한 뒤 `launchctl kickstart`로 재기동했다.
   - 최종 상태: Dock 실행 중, YouTube와 Instagram 고정 아이콘 표시 확인.

5. **BetterDisplay 잔여 정리**
   - 앱은 이미 삭제돼 있었지만 `로그인 시 열기`에 남아 있던 BetterDisplay 항목을 제거했다.
   - KEF Connect와 Steam 로그인 항목, Local AI 관련 백그라운드 항목은 임의로 제거하지 않았다.

## 의도적으로 바꾸지 않은 것

- Dock 자동 가리기: 꺼짐 유지. Mac에 익숙하지 않은 사용자에게는 항상 보이는 편이 더 빠르다.
- Dock 최근 앱 표시: 꺼짐 유지. 아이콘 위치가 흔들리지 않아 찾기 쉽다.
- 바탕화면 파일: 이동·삭제하지 않았다.
- 기존 앱·브라우저 로그인 상태: 변경하지 않았다.
- 디스플레이 해상도·색상 프로필·HDR: 변경하지 않았다.
- macOS 업데이트: 사용자 승인 없이 설치하지 않았다.

## 50Hz 확인 결과

macOS 기본 디스플레이 메뉴에서 현재 선택 가능한 재생률은 다음 네 개뿐이었다.

- 50Hz
- 30Hz
- 25Hz
- 24Hz

따라서 소프트웨어 메뉴만으로 60Hz로 올릴 수 없었다. 4K를 유지하는 현재 조건에서는 50Hz가 최댓값으로 협상되고 있으며, 이 값은 마우스가 약간 늦게 따라오는 느낌의 한 원인이 될 수 있다. 정확한 원인은 다음 자료가 있어야 구분할 수 있다.

- 실제 LG 프로젝터 정확한 모델명
- 사용 중 HDMI 포트 번호
- HDMI 케이블 규격 또는 제품명
- 프로젝터 입력 정보 화면의 `3840×2160 / Hz` 표시
- 프로젝터의 게임 모드 또는 저지연 모드 여부

## 설치 방식의 근거

Apple은 macOS Sonoma 14 이상에서 Safari 웹페이지를 독립 웹앱으로 저장해 Dock과 Spotlight에서 사용할 수 있다고 안내한다. 웹앱은 Safari와 별도로 동작하고, 자체 저장 공간과 알림 설정을 가진다.

- Apple 지원: <https://support.apple.com/en-mide/104996>
- Apple Silicon의 iPhone/iPad 앱은 개발자가 Mac 배포를 허용한 앱만 Mac App Store에 표시된다: <https://support.apple.com/guide/app-store/iphone-ipad-apps-mac-apple-silicon-fird2c7092da/mac>

## 다음에 사용자 선택이 필요한 항목

- 추가로 Dock에 넣을 공식 서비스 목록: 예) Coupang, Gmail, Netflix, Spotify, NAVER
- 50Hz 원인 점검용 LG 프로젝터 모델명과 케이블 정보
- `Steam.app` 로그인 항목이 실제로 필요한지
- macOS 소프트웨어 업데이트 적용 시점

## 작업 후 안전 점검

- Secure Chat `127.0.0.1:18791/health`: HTTP 200
- Deep relay `127.0.0.1:18790/health`: HTTP 200
- Local relay `127.0.0.1:18789/health`: HTTP 200
- Local web service `127.0.0.1:3000/health`: HTTP 200
- Ollama `127.0.0.1:11434/api/tags`: HTTP 200
- 서버 전체 테스트: `315/315` 통과
- iOS Simulator 테스트: `39/39` 통과 (`** TEST SUCCEEDED **`)
- Telegram, Secure Chat, Codex Worker LaunchAgent는 실행 중이며 종료 코드 0 상태였다.
