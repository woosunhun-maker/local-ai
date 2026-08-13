#!/opt/homebrew/bin/node
/**
 * Local AI 주기 health 스냅샷.
 * launchd StartInterval로 실행되며, 종료(exit 0)가 정상이다.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = "/Users/hun/PrivateAI";
const DATA_DIR = `${ROOT}/data/health`;
const LOG_DIR = `${ROOT}/logs/health`;
const STATUS_PATH = `${DATA_DIR}/current.json`;

async function httpCheck(name, url) {
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return { name, available: response.ok, status: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { name, available: false, status: null, latencyMs: Date.now() - started, errorClass: error?.name ?? "Error" };
  }
}

async function tcpCheck(name, host, port) {
  const started = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (available, errorClass) => {
      socket.destroy();
      resolve({
        name,
        available,
        status: available ? "tcp_open" : null,
        latencyMs: Date.now() - started,
        ...(errorClass ? { errorClass } : {}),
      });
    };
    socket.setTimeout(5_000, () => finish(false, "TimeoutError"));
    socket.once("connect", () => finish(true));
    socket.once("error", (error) => finish(false, error?.name ?? "Error"));
  });
}

async function launchdRunning(name, label) {
  const started = Date.now();
  const domain = `gui/${process.getuid?.() ?? 501}`;
  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["print", `${domain}/${label}`], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 64_000,
    });
    const running = /^\s*state = running$/m.test(stdout);
    return { name, available: running, status: running ? "running" : "not_running", latencyMs: Date.now() - started };
  } catch {
    return { name, available: false, status: "not_loaded", latencyMs: Date.now() - started, errorClass: "LaunchctlError" };
  }
}

async function resolveHomeAssistantUrl() {
  try {
    const moduleUrl = pathToFileURL(`${ROOT}/app/home-assistant/resolve-local-url.mjs`).href;
    const { resolveHomeAssistantBaseUrl } = await import(moduleUrl);
    return await resolveHomeAssistantBaseUrl("http://homeassistant.local");
  } catch {
    return null;
  }
}

async function previousAvailability() {
  try {
    const parsed = JSON.parse(await readFile(STATUS_PATH, "utf8"));
    return Object.fromEntries((parsed.services ?? []).map((entry) => [entry.name, entry.available]));
  } catch {
    return {};
  }
}

async function main() {
  await Promise.all([
    mkdir(DATA_DIR, { recursive: true, mode: 0o700 }),
    mkdir(LOG_DIR, { recursive: true, mode: 0o700 }),
  ]);

  const previous = await previousAvailability();
  const homeAssistantUrl = await resolveHomeAssistantUrl();
  const checks = [
    httpCheck("ollama", "http://127.0.0.1:11434/api/tags"),
    tcpCheck("openclaw-gateway", "127.0.0.1", 18789),
    httpCheck("openwebui-proxy", "http://127.0.0.1:18790/health"),
    httpCheck("open-webui", "http://127.0.0.1:3000/health"),
    httpCheck("secure-chat", "http://127.0.0.1:18791/health"),
    httpCheck("ai-council-web", "http://127.0.0.1:18792/health"),
    launchdRunning("telegram-general", "com.local.privateai.telegram-general"),
    launchdRunning("codex-worker", "com.local.privateai.codex-worker"),
  ];
  if (homeAssistantUrl) {
    checks.push(httpCheck("home-assistant", `${homeAssistantUrl}/`));
  }

  const services = await Promise.all(checks);
  const required = new Set(["ollama", "secure-chat", "telegram-general"]);
  const status = {
    version: 1,
    checkedAt: new Date().toISOString(),
    healthy: services.filter((entry) => required.has(entry.name)).every((entry) => entry.available),
    services,
  };
  const temporary = `${STATUS_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(status, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, STATUS_PATH);

  const transitions = services.filter(
    (entry) => previous[entry.name] !== undefined && previous[entry.name] !== entry.available,
  );
  if (transitions.length) {
    const path = `${LOG_DIR}/${new Date().toISOString().slice(0, 10)}.jsonl`;
    for (const entry of transitions) {
      await appendFile(
        path,
        `${JSON.stringify({
          timestamp: status.checkedAt,
          event: "availability_changed",
          name: entry.name,
          available: entry.available,
        })}\n`,
        { mode: 0o600 },
      );
    }
  }
}

main().catch((error) => {
  console.error(`상태 점검 오류: ${error?.name ?? "Error"}`);
  process.exitCode = 1;
});
