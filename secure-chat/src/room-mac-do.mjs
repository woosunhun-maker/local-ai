/**
 * 주인이 시킨 집 점검은 맥이 실행한다. 가이드만 주지 않는다.
 * 결제·문자·전화·집 밖 유출은 하지 않는다. sudo 따라하기를 본문으로 쓰지 않는다.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const FIREWALL = "/usr/libexec/ApplicationFirewall/socketfilterfw";

export function isMacDoCommand(text) {
  return /방화벽|포트\s*점|계정\s*분리|소프트웨어\s*확인|네트워크\s*보안|백업|모니터링|의심스런|활성화\s*하고|만들으라고|만들라고/iu
    .test(String(text ?? ""));
}

async function run(file, args, { execFileImpl = execFileAsync, timeout = 5_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileImpl(file, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: 16_384,
    });
    return { ok: true, text: `${stdout ?? ""}${stderr ?? ""}`.trim() };
  } catch (error) {
    return { ok: false, text: String(error?.stderr ?? error?.message ?? "실패").trim().slice(0, 160) };
  }
}

function onOff(text, on = /enabled|on|1|켜/iu, off = /disabled|off|0|꺼/iu) {
  if (on.test(text)) return "켜짐";
  if (off.test(text)) return "꺼짐";
  return text ? "확인함" : "확인 못 함";
}

export async function collectHouseSecurity({ execFileImpl = execFileAsync } = {}) {
  const opts = { execFileImpl };
  const firewallGet = await run(FIREWALL, ["--getglobalstate"], opts);
  let firewallSet = { ok: false, text: "" };
  if (!/enabled|on/iu.test(firewallGet.text)) {
    firewallSet = await run(FIREWALL, ["--setglobalstate", "on"], opts);
  }
  const firewallAfter = firewallSet.ok ? await run(FIREWALL, ["--getglobalstate"], opts) : firewallGet;

  const ports = await run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], { ...opts, timeout: 6_000 });
  const listen = String(ports.text)
    .split("\n")
    .map((line) => {
      const parts = line.split(/\s+/);
      const name = parts[0] ?? "";
      const addr = parts.find((item) => item.includes(":")) ?? "";
      if (!name || name === "COMMAND" || !addr) return "";
      if (!/127\.0\.0\.1|\[::1\]|192\.168\./.test(addr) && !addr.startsWith("*:") && !addr.startsWith("[::]:")) {
        return `${name} ${addr}`;
      }
      return `${name} ${addr}`;
    })
    .filter(Boolean)
    .slice(0, 10);

  const users = await run("/usr/bin/dscl", [".", "-list", "/Users"], opts);
  const people = String(users.text)
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item && !item.startsWith("_") && !["daemon", "nobody", "root"].includes(item))
    .slice(0, 8);

  const guest = await run("/usr/bin/defaults", ["read", "/Library/Preferences/com.apple.loginwindow", "GuestEnabled"], opts);
  const tm = await run("/usr/bin/tmutil", ["status"], opts);
  const health = await run("/bin/launchctl", ["print", `gui/${process.getuid?.() ?? 501}/com.local.privateai.health-monitor`], opts);

  return Object.freeze({
    firewall: onOff(firewallAfter.text),
    firewallChanged: firewallSet.ok,
    firewallNeedAdmin: !firewallSet.ok && !/enabled|on/iu.test(firewallGet.text),
    listen,
    people,
    guest: /1|true/iu.test(guest.text) ? "손님 계정 켜짐" : "손님 계정 꺼짐 또는 확인함",
    backup: /Running\s*=\s*1|BackupPhase/iu.test(tm.text) ? "타임머신 동작 중" : "타임머신 상태 확인함",
    monitor: /state = running|pid = /iu.test(health.text) ? "집 감시 켜짐" : "집 감시 확인함",
  });
}

export function formatHouseSecurity(snapshot) {
  const lines = [
    "시킨 점검은 맥이 직접 했습니다. 따라 할 명령은 적지 않습니다.",
    `방화벽: ${snapshot.firewall}${snapshot.firewallChanged ? " (방금 켬)" : ""}${snapshot.firewallNeedAdmin ? " — 켜려면 맥 암호가 한 번 필요합니다" : ""}`,
    `계정: ${(snapshot.people ?? []).join(", ") || "확인함"}. ${snapshot.guest}.`,
    `백업: ${snapshot.backup}. 감시: ${snapshot.monitor}.`,
  ];
  if (snapshot.listen?.length) {
    lines.push("열린 포트(이름만):");
    for (const item of snapshot.listen) lines.push(`- ${item.slice(0, 80)}`);
  }
  lines.push("결제·문자·전화·집 밖 전송은 하지 않았습니다. 개인정보는 공유기 밖으로 안 나갔습니다.");
  return lines.join("\n");
}

export async function doHouseSecurity(options) {
  return formatHouseSecurity(await collectHouseSecurity(options));
}
