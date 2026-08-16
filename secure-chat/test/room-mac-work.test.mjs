import assert from "node:assert/strict";
import test from "node:test";

import { formatMacWorkReport, isContinueCommand, isMacWorkCommand, reportMacWork } from "../src/room-mac-work.mjs";
import { roomTurnAnswer } from "../src/room-turn.mjs";

test("아이폰에서 보고·진행 부탁은 맥 일 명령이다", () => {
  assert.equal(isMacWorkCommand("그거보면서 지시해서 진행하고 나한테 보고좀"), true);
  assert.equal(isMacWorkCommand("파이썬 리스트 정렬은 어떻게 해"), false);
  assert.equal(isContinueCommand("방금시킨거 진해ㅇ ㄱ"), true);
  assert.equal(isMacWorkCommand("방금시킨거 진행해"), true);
});

test("집 보고에는 비밀과 텔레그램이 없다", () => {
  const text = formatMacWorkReport({
    branch: "cursor/openai-mac-ask-201a",
    recent: ["2390b3c 아이폰 방은 Cursor 화면을 보지 않고"],
    dirty: ["## cursor/openai-mac-ask-201a"],
    room: true,
    ollama: true,
    openProxy: true,
    openGw: false,
  });
  assert.match(text, /시킨 대로 이어서/);
  assert.match(text, /가지: cursor\/openai-mac-ask-201a/);
  assert.match(text, /오픈 게이트 꺼짐/);
  assert.doesNotMatch(text, /telegram|password|token/i);
});

test("방 턴은 맥 일 명령에 집 보고만 하고 모델을 부르지 않는다", async () => {
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "커서 보면서 진행하고 보고좀" }],
    {
      fetchImpl: async (url) => {
        if (String(url).includes("11434")) throw new Error("should_not_call_ollama");
        if (String(url).includes("18790")) throw new Error("should_not_call_open");
        return { ok: true, status: 200 };
      },
      execFileImpl: async () => ({ stdout: "" }),
    },
  );
  assert.match(answer, /시킨 대로 이어서/);
  assert.doesNotMatch(answer, /127\.0\.0\.1:18790/);
});

test("진행하라는 오타는 모델 거절 없이 집 보고만 한다", async () => {
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "방금시킨거 진해ㅇ ㄱ" }],
    {
      fetchImpl: async (url) => {
        if (String(url).includes("11434")) throw new Error("should_not_call_ollama");
        if (String(url).includes("18790")) throw new Error("should_not_call_open");
        return { ok: true, status: 200 };
      },
      execFileImpl: async () => ({ stdout: "cursor/openai-mac-ask-201a\n" }),
    },
  );
  assert.match(answer, /시킨 대로 이어서/);
  assert.doesNotMatch(answer, /통제할 수 없|127\.0\.0\.1:18790/);
});

test("진행해는 대기 중인 Face ID가 있으면 다시 실행하지 않는다", async () => {
  const answer = await roomTurnAnswer(
    [
      { role: "user", content: "방화벽 활성화 하고 백업하라" },
      { role: "assistant", content: "아이폰에서 Face ID 또는 암호로 한 번 승인해 주세요." },
      { role: "user", content: "진행해" },
    ],
    {
      approvalStore: {
        listPending: async () => [{
          kind: "room.house-do.v1",
          summary: "방화벽·포트·계정·백업·감시만 맥이 확인하고, 결제·문자·전화는 하지 않습니다.",
        }],
      },
      fetchImpl: async (url) => {
        if (String(url).includes("11434")) throw new Error("should_not_call_ollama");
        return { ok: true, status: 200 };
      },
      execFileImpl: async () => {
        throw new Error("should_not_run_until_faceid");
      },
    },
  );
  assert.match(answer, /Face ID 또는 암호/);
  assert.doesNotMatch(answer, /맥이 직접 했습니다|시킨 대로 이어서/);
});

test("보고는 exec와 probe 결과를 그대로 쓴다", async () => {
  const text = await reportMacWork({
    execFileImpl: async (_file, args) => {
      if (args.includes("rev-parse")) return { stdout: "cursor/openai-mac-ask-201a\n" };
      if (args.includes("log")) return { stdout: "abc123 집 보고를 붙인다\n" };
      if (args.includes("status")) return { stdout: "## cursor/openai-mac-ask-201a\n" };
      return { stdout: "" };
    },
    fetchImpl: async (url) => ({ ok: String(url).includes("18791") || String(url).includes("11434"), status: 200 }),
  });
  assert.match(text, /가지: cursor\/openai-mac-ask-201a/);
  assert.match(text, /집 보고를 붙인다/);
  assert.match(text, /방 켜짐/);
});
