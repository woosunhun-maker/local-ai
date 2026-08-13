import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  getIosAppReleaseInfo,
  isIosBuildBehind,
  IOS_APP_RELEASE,
} from "../src/ios-app-release.mjs";

describe("ios-app-release", () => {
  test("exposes xcode_reinstall policy without OTA", () => {
    const info = getIosAppReleaseInfo();
    assert.equal(info.marketing_version, IOS_APP_RELEASE.marketing_version);
    assert.equal(info.build, IOS_APP_RELEASE.build);
    assert.equal(info.update_policy, "xcode_reinstall");
    assert.match(info.note, /IPA|설치/u);
  });

  test("detects behind numeric builds", () => {
    assert.equal(isIosBuildBehind("11", "12"), true);
    assert.equal(isIosBuildBehind("12", "12"), false);
    assert.equal(isIosBuildBehind("13", "12"), false);
  });
});
