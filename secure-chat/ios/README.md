# Local AI for iPhone

네이티브 SwiftUI 클라이언트다. 대화 본문은 Tailscale HTTPS를 통해 Mac으로 직접 전송한다.

## 포함 기능

- 일회용 QR 페어링과 iPhone 전용 Keychain 토큰
- SwiftUI 채팅, 탭해서 말하기, 응답 음성 읽기
- Siri/App Shortcuts: `로컬 AI에게 묻기`, `로컬 AI 소식 확인`
- Siri/App Shortcuts와 앱의 `Codex 작업`: 계획 원문 확인 → 전용 기기 키와 Face ID 또는 iPhone 암호 승인 → 격리 점검/초안 → 상태·결과 확인
- Codex 작업문과 허용 목록 코드에서 알려진 식별자를 검사·치환한 복사본은 승인 후 OpenAI Codex로 외부 전송
- 모델에는 추가 인터넷 도구와 Mac 원본 파일 도구를 제공하지 않으며, Mac 원본 소스는 읽기 전용·변경 없음으로 고정
- 초안은 trusted worker가 격리 복사본에만 임시 적용해 검증하고 완료 후 자동 정리하며, 실패 시 worker 시작 때 정리를 재시도
- 검증된 초안은 앱에서 검토·복사만 가능하고 Mac 원본 소스에 자동 적용하지 않음
- 종료된 Codex 작업과 검증 초안은 로컬 Mac에 7일 또는 최근 100개 중 먼저 도달한 한도까지 보존하며 진행 중 작업은 정리하지 않음
- 로컬 Codex 클라이언트는 기존 Codex 로그인 인증을 사용하며, 별도 OS 프로세스 샌드박스는 현재 없음
- 선제 알림은 일반 문구만 APNs 경로에 보내고 실제 본문은 앱이 Mac에서 직접 가져옴
- 백그라운드 상시 마이크는 사용하지 않음

## 빌드 전제

전체 Xcode와 Apple 개발 서명이 필요하다. Xcode 설치 후 `xcodegen generate`로 프로젝트를 생성하고 실제 iPhone을 실행 대상으로 선택한다.
