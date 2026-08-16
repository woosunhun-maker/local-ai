/**
 * Face ID로 한 번 승인된 시킨 일만 맥이 실행한다.
 * 결제·문자·전화·집 밖 유출은 하지 않는다. 임의 셸은 돌리지 않는다.
 */
import { doHouseSecurity, isMacDoCommand } from "./room-mac-do.mjs";
import { reportMacWork } from "./room-mac-work.mjs";

const SECURITY = /점검|보완|하라고|해바라|보안|방화벽|백업|포트|계정|모니터|소프트웨어|네트워크|활성화/iu;
const REPORT = /커서|보고|진행|깃|저장소/iu;

export function parseHouseDoPayload(raw) {
  try {
    const value = JSON.parse(String(raw ?? ""));
    if (value && typeof value.text === "string") return value.text;
  } catch {
    // 예전 승인 문도 그대로 실행한다
  }
  return String(raw ?? "");
}

export async function runHouseTask(text, options = {}) {
  const value = String(text ?? "");
  const security = isMacDoCommand(value) || SECURITY.test(value);
  const report = REPORT.test(value) && !security;
  if (report) return reportMacWork(options);
  if (security) return doHouseSecurity(options);
  const [house, work] = await Promise.all([
    doHouseSecurity(options),
    reportMacWork(options),
  ]);
  return [
    house,
    work,
    "시킨 말은 맥이 받았습니다. 결제·문자·전화는 하지 않았습니다. 이어서 고칠 말을 이 방에 주시면 그다음을 합니다.",
  ].join("\n\n");
}
