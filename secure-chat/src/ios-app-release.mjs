/**
 * iPhone 앱 권장 버전 — Personal Team은 앱 내 IPA OTA가 불가하므로
 * Mac이 권장 build를 알리고, 설치는 Xcode/devicectl로만 한다.
 */
export const IOS_APP_RELEASE = Object.freeze({
  marketing_version: "2.0.0",
  build: "1",
  update_policy: "xcode_reinstall",
  note: "H 2.0은 맥 대화 문만 남긴 새 얼굴입니다. Mac에서 Xcode로 설치합니다.",
});

export function getIosAppReleaseInfo() {
  return Object.freeze({
    marketing_version: IOS_APP_RELEASE.marketing_version,
    build: IOS_APP_RELEASE.build,
    update_policy: IOS_APP_RELEASE.update_policy,
    note: IOS_APP_RELEASE.note,
  });
}

/** 클라이언트가 권장 build보다 낮은지 (숫자 비교, 비숫자면 문자열 비교) */
export function isIosBuildBehind(clientBuild, recommendedBuild = IOS_APP_RELEASE.build) {
  const client = String(clientBuild ?? "").trim();
  const recommended = String(recommendedBuild ?? "").trim();
  if (!client || !recommended) return false;
  const clientNum = Number(client);
  const recommendedNum = Number(recommended);
  if (Number.isFinite(clientNum) && Number.isFinite(recommendedNum)) {
    return clientNum < recommendedNum;
  }
  return client !== recommended && client < recommended;
}
