/**
 * 아이폰은 문, 맥이 집을 보고 방에 보고한다.
 * 화면 픽셀·마우스·키보드는 쓰지 않는다. 깃과 loopback 서비스만 본다.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { doHouseSecurity, isMacDoCommand } from "./room-mac-do.mjs";

const execFileAsync = promisify(execFile);
const HOUSE_REPO = "/Users/hun/Documents/로컬ai";

export function isContinueCommand(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!value || value.length > 40) return false;
  return /방금\s*시킨|이어서|계속\s*해|진행\s*해|진행해|진해|ㄱㄱ/iu.test(value);
}

export function isMacWorkCommand(text) {
  const value = String(text ?? "");
  if (isContinueCommand(value) || isMacDoCommand(value)) return true;
  return /커서|cursor\s*ide|화면\s*보|그거\s*보|보면서\s*지시|지시해서\s*진행|나한테\s*보고|보고\s*좀|창을\s*보|맥\s*화면|모니터를\s*보/iu
    .test(value);
}

export function previousUserText(messages, current) {
  if (!Array.isArray(messages)) return "";
  const users = messages.filter((item) => item?.role === "user" && typeof item.content === "string");
  const last = users.at(-1)?.content ?? "";
  if (current && last === current) return users.at(-2)?.content ?? "";
  return last;
}

export async function runMacOwnerWork(text, options = {}) {
  const prior = previousUserText(options.messages, text);
  if (isMacDoCommand(text) || (isContinueCommand(text) && isMacDoCommand(prior))) {
    return doHouseSecurity(options);
  }
  return reportMacWork(options);
}

async function gitLine(args, { execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl("/usr/bin/git", ["-C", HOUSE_REPO, ...args], {
      encoding: "utf8",
      timeout: 4_000,
      maxBuffer: 8_192,
    });
    return String(stdout ?? "").trim().split("\n").filter(Boolean).slice(0, 4);
  } catch {
    return [];
  }
}

async function probe(url, { fetchImpl = fetch, timeoutMs = 250 } = {}) {
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response?.ok === true || (response?.status ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function collectMacWorkSnapshot({
  execFileImpl = execFileAsync,
  fetchImpl = fetch,
} = {}) {
  const [branch, recent, dirty, room, ollama, openProxy, openGw] = await Promise.all([
    gitLine(["rev-parse", "--abbrev-ref", "HEAD"], { execFileImpl }),
    gitLine(["log", "-3", "--oneline"], { execFileImpl }),
    gitLine(["status", "-sb"], { execFileImpl }),
    probe("http://127.0.0.1:18791/", { fetchImpl }),
    probe("http://127.0.0.1:11434/api/tags", { fetchImpl }),
    probe("http://127.0.0.1:18790/health", { fetchImpl }),
    probe("http://127.0.0.1:18789/health", { fetchImpl }),
  ]);
  return Object.freeze({
    branch: branch[0] ?? "",
    recent,
    dirty,
    room,
    ollama,
    openProxy,
    openGw,
  });
}

export function formatMacWorkReport(snapshot) {
  const lines = [
    "시킨 대로 이어서 했습니다. 맥이 집을 봤습니다. 화면 픽셀은 안 보고 같은 저장소와 서비스만 봤습니다.",
  ];
  if (snapshot.branch) lines.push(`가지: ${snapshot.branch}`);
  if (snapshot.recent?.length) {
    lines.push("최근 일:");
    for (const item of snapshot.recent) lines.push(`- ${item.slice(0, 80)}`);
  }
  if (snapshot.dirty?.[0]) lines.push(`작업 칸: ${snapshot.dirty[0].slice(0, 80)}`);
  lines.push(
    `방 ${snapshot.room ? "켜짐" : "꺼짐"}, 로컬 모델 ${snapshot.ollama ? "켜짐" : "꺼짐"}, 오픈 프록시 ${snapshot.openProxy ? "켜짐" : "꺼짐"}, 오픈 게이트 ${snapshot.openGw ? "켜짐" : "꺼짐"}.`,
  );
  if (!snapshot.openGw) {
    lines.push("오픈 게이트가 꺼져 있어서 일반 지식 상담은 건너뛰고, 로컬 답과 집 보고만 합니다.");
  }
  lines.push("코드 자동 합치기·배포는 하지 않았습니다. 다음 고칠 말을 이 방에 주시면 맥이 이어서 합니다.");
  return lines.join("\n");
}

export async function reportMacWork(options) {
  return formatMacWorkReport(await collectMacWorkSnapshot(options));
}
