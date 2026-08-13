import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HA_URL = "http://homeassistant.local:8123";
const KEYCHAIN_SERVICE = "local.privateai.homeassistant.token";
const KEYCHAIN_ACCOUNT = "local-ai";

async function readHomeAssistantToken() {
  const result = await execFileAsync("/usr/bin/security", [
    "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
  ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  const token = result.stdout.trim();
  if (token.length < 20) throw new Error("home_assistant_token_unavailable");
  return token;
}

export async function notifyOwnerOfGrowthApproval({
  fetchImpl = fetch,
  tokenReader = readHomeAssistantToken,
} = {}) {
  let token;
  try {
    token = await tokenReader();
    const response = await fetchImpl(`${HA_URL}/api/services/notify/mobile_app_aibbon`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "Local AI 검토 요청",
        message: "개인정보 없는 기술 자문 승인 요청이 준비되었습니다. Local AI 앱에서 정확한 내용을 확인하세요.",
        data: {
          tag: "local_ai_growth_approval",
          url: "localai://growth",
          push: { "interruption-level": "time-sensitive" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("growth_notification_failed");
    return true;
  } finally {
    token = undefined;
  }
}
