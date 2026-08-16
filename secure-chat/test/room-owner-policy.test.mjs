import assert from "node:assert/strict";
import test from "node:test";

import { inspectRoomOwnerCommand, ROOM_DENY_REPLY, ROOM_POLICY_REPLY } from "../src/room-owner-policy.mjs";
import { planSelfConsult } from "../src/self-consult.mjs";
import { roomTurnAnswer } from "../src/room-turn.mjs";

test("시킨 일반 일과 지식은 허용한다", () => {
  assert.equal(inspectRoomOwnerCommand("그거보면서 지시해서 진행하고 나한테 보고좀").allow, true);
  assert.equal(inspectRoomOwnerCommand("파이썬 리스트 정렬은 어떻게 해").allow, true);
  assert.equal(inspectRoomOwnerCommand("결제가 카드랑 뭐가 달라").allow, true);
});

test("허용하지 않은 결제·문자·전화·외부 전송은 막는다", () => {
  assert.equal(inspectRoomOwnerCommand("이걸로 결제해줘").reason, "payment");
  assert.equal(inspectRoomOwnerCommand("문자 보내").reason, "message");
  assert.equal(inspectRoomOwnerCommand("지금 전화 걸어줘").reason, "message");
  assert.equal(inspectRoomOwnerCommand("이 대화를 텔레그램으로 보내").reason, "leak");
  assert.equal(planSelfConsult("카드로 결제해라").mode, "deny");
});

test("금지 질문이 승인 칸을 열지 않고 바로 답한다", async () => {
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "절대 금지사항은 뭔지 얘기해봐" }],
    {
      fetchImpl: async () => {
        throw new Error("should_not_fetch");
      },
    },
  );
  assert.equal(answer, ROOM_POLICY_REPLY);
  assert.doesNotMatch(answer, /승인해 주세요|불가능/);
});

test("막힌 일은 모델과 오픈을 부르지 않고 거절만 한다", async () => {
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "계좌로 송금해줘" }],
    {
      fetchImpl: async () => {
        throw new Error("should_not_fetch");
      },
    },
  );
  assert.equal(answer, ROOM_DENY_REPLY);
  assert.doesNotMatch(answer, /telegram|sk-|password/i);
});
