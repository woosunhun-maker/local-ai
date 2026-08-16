import assert from "node:assert/strict";
import test from "node:test";

import { formatHouseSecurity, isMacDoCommand } from "../src/room-mac-do.mjs";
import { isMacWorkCommand } from "../src/room-mac-work.mjs";
import { planSelfConsult } from "../src/self-consult.mjs";
import { roomTurnAnswer } from "../src/room-turn.mjs";

test("방화벽·포트 부탁은 맥이 할 일이다", () => {
  const text = "너가 방화벽 활성화 하고 포트점검하고 계정 분리하고 백업하고 모니터링도구 만들으라고";
  assert.equal(isMacDoCommand(text), true);
  assert.equal(isMacWorkCommand(text), true);
  assert.equal(planSelfConsult(text).mode, "mac_work");
});

test("점검 보고에는 sudo 가이드와 텔레그램이 없다", () => {
  const text = formatHouseSecurity({
    firewall: "켜짐",
    firewallChanged: true,
    firewallNeedAdmin: false,
    listen: ["node 127.0.0.1:18791"],
    people: ["hun"],
    guest: "손님 계정 꺼짐 또는 확인함",
    backup: "타임머신 상태 확인함",
    monitor: "집 감시 켜짐",
  });
  assert.match(text, /맥이 직접 했습니다/);
  assert.match(text, /방화벽: 켜짐/);
  assert.doesNotMatch(text, /sudo |따라 하|telegram/i);
});

test("방 턴은 방화벽 부탁에 모델을 부르지 않고 실행 보고만 한다", async () => {
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "방화벽 활성화 하고 포트점검하고 백업하라고" }],
    {
      fetchImpl: async (url) => {
        if (String(url).includes("11434")) throw new Error("should_not_call_ollama");
        return { ok: true, status: 200 };
      },
      execFileImpl: async (file, args) => {
        if (String(file).includes("socketfilterfw") && args.includes("--getglobalstate")) {
          return { stdout: "Firewall is enabled. (State = 1)\n" };
        }
        if (String(file).includes("lsof")) return { stdout: "COMMAND 1 hun TCP 127.0.0.1:18791 (LISTEN)\n" };
        if (String(file).includes("dscl")) return { stdout: "hun\nroot\n_www\n" };
        if (String(args).includes("GuestEnabled")) return { stdout: "0\n" };
        if (String(file).includes("tmutil")) return { stdout: "Running = 0\n" };
        if (String(file).includes("launchctl")) return { stdout: "state = running\npid = 1\n" };
        return { stdout: "" };
      },
    },
  );
  assert.match(answer, /맥이 직접 했습니다/);
  assert.match(answer, /방화벽: 켜짐/);
  assert.doesNotMatch(answer, /텍스트 기반|sudo \/usr\/libexec/);
});
