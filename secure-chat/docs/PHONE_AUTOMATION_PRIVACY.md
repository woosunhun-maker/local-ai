# 폰 자동화 개인정보 경계

`DeviceSafetyGateway`는 ADB, Appium, WebDriverAgent 등 실제 폰 드라이버와 로컬 모델 사이에 놓는 필수 경계다. 모델에게 드라이버를 직접 노출하지 않는다.

## 보장하는 것

- 앱 allowlist는 기본이 비어 있어 모든 앱을 차단한다. 표시 이름이 아닌 안정적인 bundle/package ID만 허용 기준으로 쓴다.
- 인증, OTP, 비밀번호 관리자, 금융, 건강, 신분, 시스템 설정 앱은 allowlist에 넣어도 차단한다.
- 원본 스크린샷을 반환하지 않고 OCR 문자열에서 자격증명·주민번호·이메일·전화번호·카드번호·OTP를 가린다.
- 앱별 `privateRegions`는 OCR 전에 픽셀을 가리고, 해당 좌표에 터치하는 작업도 차단한다.
- tap, 문자 입력, 전송, 업로드, 삭제, 설치, 권한 변경은 iPhone P-256 서명 승인을 1회 소비한다.
- 결제·송금·구매는 승인으로도 풀리지 않는다.
- 승인 후 앱이 바뀌거나 작업 본문이 바뀌면 실행하지 않는다.
- audit에는 OCR, 입력문, 좌표, 대상 문구, 앱 이름을 남기지 않는다.

## 드라이버 연결

```js
const driver = {
  async getForegroundApp() { return { id: "bundle-or-package-id", name: "visible app name" }; },
  async captureMaskedOcr({ maskRegions }) { /* black out masks first, then OCR */ return "OCR text only"; },
  async perform(frozenAction) { /* map a validated action to ADB/Appium/WDA */ },
};

const policy = createDevicePrivacyPolicy({
  allowedApps: ["com.example.notes"],
  blockedApps: ["com.example.private"],
  privateRegions: {
    "com.example.notes": [
      { x: 0, y: 0, width: 1, height: 0.15, label: "account header" },
    ],
  },
});

const gateway = new DeviceSafetyGateway({ policy, approvalStore, driver, auditSink });
```

`captureMaskedOcr()`는 전달받은 구역을 검정색으로 덮은 다음에만 OCR을 실행해야 한다. 생성한 임시 스크린샷은 OCR 완료 즉시 드라이버 내부에서 삭제한다. 게이트웨이는 이미지 버퍼를 받는 API를 제공하지 않는다.

현재 저장소에는 실제 ADB/Appium/WebDriverAgent 연결이 없다. 연결을 추가할 때는 모든 `perform` 호출이 이 게이트웨이를 거치도록 하고, 원시 드라이버를 모델 도구 목록에 등록하지 않는다.
