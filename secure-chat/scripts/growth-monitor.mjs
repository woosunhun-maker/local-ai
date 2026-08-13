#!/opt/homebrew/bin/node

import { createHash } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { ApprovalStore } from "../src/approval-store.mjs";
import { canonicalizeJson } from "../src/growth/canonical.mjs";
import { GrowthCoordinator } from "../src/growth/coordinator.mjs";
import { detectPerformanceIssue } from "../src/growth/issue-detector.mjs";
import { notifyOwnerOfGrowthApproval } from "../src/growth/owner-notification.mjs";
import { GrowthProposalStore } from "../src/growth/proposal-store.mjs";

const ROOT = "/Users/hun/PrivateAI";
const CHAT_LOGS = `${ROOT}/logs/secure-chat`;
const GROWTH_ROOT = `${ROOT}/data/growth`;
const STATE_PATH = `${GROWTH_ROOT}/monitor-state.json`;
const COOLDOWN_MS = 24 * 60 * 60_000;

async function recentEvents() {
  let directoryEntries;
  try {
    directoryEntries = await readdir(CHAT_LOGS);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const filenames = directoryEntries.filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().slice(-7);
  const events = [];
  for (const filename of filenames) {
    const lines = (await readFile(`${CHAT_LOGS}/${filename}`, "utf8")).split("\n").filter(Boolean).slice(-2_000);
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        events.push({ event: value.event, durationMs: value.durationMs });
      } catch {
        // A malformed local audit line is ignored and never sent externally.
      }
    }
  }
  return events;
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, lastPreparedAt: 0, fingerprint: null };
    throw error;
  }
}

async function writeState(value) {
  const temporary = `${STATE_PATH}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, STATE_PATH);
}

async function main() {
  const now = Date.now();
  const state = await readState();
  if (now - Number(state.lastPreparedAt ?? 0) < COOLDOWN_MS) {
    console.log(JSON.stringify({ outcome: "cooldown" }));
    return;
  }
  const draft = detectPerformanceIssue(await recentEvents());
  if (!draft) {
    console.log(JSON.stringify({ outcome: "no_material_issue" }));
    return;
  }
  const fingerprint = createHash("sha256").update(canonicalizeJson(draft)).digest("hex");
  if (fingerprint === state.fingerprint && now - Number(state.lastPreparedAt ?? 0) < 7 * COOLDOWN_MS) {
    console.log(JSON.stringify({ outcome: "duplicate_suppressed" }));
    return;
  }

  const approvals = new ApprovalStore(`${ROOT}/data/secure-chat/approvals.json`);
  const proposals = new GrowthProposalStore(`${GROWTH_ROOT}/proposals`);
  const coordinator = new GrowthCoordinator({ rootPath: GROWTH_ROOT, approvalStore: approvals, proposalStore: proposals });
  await approvals.initialize();
  await coordinator.initialize();
  const request = await coordinator.prepareConsultation(draft, {
    title: "Local AI 성능 개선 자문",
    summary: "본문 없이 집계 성능 수치와 일반 오류 코드만 전송",
  });
  await writeState({ version: 1, lastPreparedAt: now, fingerprint });
  const notified = await notifyOwnerOfGrowthApproval().then(() => true, () => false);
  console.log(JSON.stringify({ outcome: "approval_prepared", requestId: request.requestId, expiresAt: request.expiresAt, notified }));
}

main().catch((error) => {
  console.error(JSON.stringify({ outcome: "error", errorClass: error?.name ?? "Error" }));
  process.exitCode = 1;
});
