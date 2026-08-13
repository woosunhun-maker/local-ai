#!/opt/homebrew/bin/node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProactiveStore } from "../src/proactive-store.mjs";

const execFileAsync = promisify(execFile);
const ROOT = "/Users/hun/PrivateAI";
const STORE_PATH = `${ROOT}/data/secure-chat/proactive.json`;
const KEYCHAIN_SERVICE = "local.privateai.homeassistant.token";
const KEYCHAIN_ACCOUNT = "local-ai";
const HOME_ASSISTANT_URL = "http://homeassistant.local:8123";

async function readStdin() {
  if (process.stdin.isTTY) throw new Error("메시지는 표준 입력으로만 전달해야 합니다.");
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 16_384) throw new Error("메시지가 너무 큽니다.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function homeAssistantToken() {
  const { stdout } = await execFileAsync("/usr/bin/security", [
    "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w",
  ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  return stdout.trim();
}

async function sendGenericNotification() {
  let token = await homeAssistantToken();
  try {
    const response = await fetch(`${HOME_ASSISTANT_URL}/api/services/notify/mobile_app_aibbon`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: "로컬AI",
        message: "로컬AI가 먼저 말을 걸었습니다. 탭해서 안전하게 내용을 확인하세요.",
        data: {
          url: "localai://inbox",
          push: { sound: "default" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`아이폰 알림 전송 실패(HTTP ${response.status})`);
  } finally {
    token = undefined;
  }
}

async function main() {
  if (process.argv.length !== 2) throw new Error("명령줄 인수로 메시지를 전달할 수 없습니다.");
  const content = await readStdin();
  const store = new ProactiveStore(STORE_PATH);
  await store.initialize();
  const queued = await store.enqueue(content);
  await sendGenericNotification();
  console.log(JSON.stringify({ queued: true, notification: "generic_only", id: queued.id }));
}

main().catch((error) => {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
});
