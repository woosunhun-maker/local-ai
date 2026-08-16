import assert from "node:assert/strict";
import test from "node:test";

import { formatMacWorkReport, isMacWorkCommand, reportMacWork } from "../src/room-mac-work.mjs";
import { roomTurnAnswer } from "../src/room-turn.mjs";

test("아이폰에서 보고·진행 부탁은 맥 일 명령이다", () => {
  assert.equal(isMacWorkCommand("그거보면서 지시해서 진행하고 나한테 보고좀"), true);
  assert.equal(isMacWorkCommand("파이썬 리스트 정렬은 어떻게 해"), false);
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
  assert.match(text, /아이폰에서 시킨 대로/);
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
  assert.match(answer, /아이폰에서 시킨 대로/);
  assert.doesNotMatch(answer, /127\.0\.0\.1:18790/);
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
