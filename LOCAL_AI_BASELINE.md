# Local AI baseline

이 문서는 `/Users/hun/Documents/로컬ai` 저장소의 첫 Git baseline 범위를 고정한다.

## 포함

- `secure-chat/` — 로컬AI 서버, Telegram 릴레이, iOS 앱 소스
- `ai-council/` — 맥 웹 UI·확인형 기억 실험
- 루트 `.gitignore`, 본 문서

## 제외 (의도적)

- `diol-os/` — 별도 Git 저장소
- `home-assistant/`, `.private/`, `seonghun-secret-space/`, `mac-backups/`, `tmp/`, `output/`
- 런타임 데이터·토큰·로그 (`/Users/hun/PrivateAI`는 Git 밖)

## 실행 위치

소스는 Documents, 상시 실행은 `/Users/hun/PrivateAI` + launchd KeepAlive다.
배포는 `secure-chat/scripts/deploy-runtime.sh`를 사용한다.
