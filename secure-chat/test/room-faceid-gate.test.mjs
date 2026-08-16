import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ApprovalStore, approvalSigningPayload } from "../src/approval-store.mjs";
import {
  executeApprovedHouseDo,
  FACEID_GATE_REPLY,
  formatFaceIdWait,
  houseDoRequest,
  isFaceIdGateCommand,
  requestHouseDoApproval,
  ROOM_HOUSE_DO_KIND,
} from "../src/room-faceid-gate.mjs";
import { inspectRoomOwnerCommand } from "../src/room-owner-policy.mjs";
import { planSelfConsult } from "../src/self-consult.mjs";
import { roomTurnAnswer } from "../src/room-turn.mjs";

function deviceKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    privateKey,
    publicKeyDER: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
  };
}

test("Face ID 게이트 말은 모델이 불가능하다고 자르지 않는다", () => {
  const text = "내가 지시했을때 1회성으로 작업수행 할수있도록 해라 그리고 faceid로 승인 받아야 가능한구조로";
  assert.equal(isFaceIdGateCommand(text), true);
  assert.equal(planSelfConsult(text).mode, "faceid_gate");
  assert.equal(inspectRoomOwnerCommand(text).allow, true);
});

test("결제 지시는 Face ID를 붙여도 막는다", () => {
  assert.equal(inspectRoomOwnerCommand("카드로 결제해 faceid로 승인받게").allow, false);
  assert.equal(planSelfConsult("카드로 결제해 faceid로 승인받게").mode, "deny");
});

test("방 턴은 Face ID 구조 부탁에 불가능 답을 쓰지 않는다", async () => {
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "지시하면 1회 실행하고 faceid로 승인 받아야 해" }],
    {
      fetchImpl: async () => {
        throw new Error("should_not_call_model");
      },
    },
  );
  assert.equal(answer, FACEID_GATE_REPLY);
  assert.doesNotMatch(answer, /불가능|외부 AI|Apple Pay/);
});

test("집 점검은 바로 실행하지 않고 Face ID 승인을 기다린다", async () => {
  const root = await mkdtemp(join(tmpdir(), "faceid-wait-"));
  const approvalStore = new ApprovalStore(join(root, "approvals.json"));
  await approvalStore.initialize();
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "방화벽 활성화 하고 포트점검하고 백업하라고" }],
    {
      approvalStore,
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
  assert.doesNotMatch(answer, /맥이 직접 했습니다|불가능/);
  const pending = await approvalStore.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, ROOM_HOUSE_DO_KIND);
  await rm(root, { recursive: true, force: true });
});

test("승인 소비 후에만 집 점검을 한 번 실행한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "faceid-do-"));
  const approvalStore = new ApprovalStore(join(root, "approvals.json"));
  await approvalStore.initialize();
  const key = deviceKey();
  await approvalStore.registerDeviceKey("iphone-1", key.publicKeyDER);
  const created = await approvalStore.createRequest(houseDoRequest("방화벽 켜고 백업하라"), 60_000);
  const signatureDER = sign("sha256", approvalSigningPayload(created, "approved"), key.privateKey).toString("base64");
  await approvalStore.decide({
    id: created.id,
    deviceId: "iphone-1",
    decision: "approved",
    signatureDER,
  });
  const report = await executeApprovedHouseDo({
    approvalStore,
    approvalId: created.id,
    payloadSha256: created.payloadSha256,
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
  });
  assert.match(report, /맥이 직접 했습니다/);
  assert.match(report, /방화벽: 켜짐/);
  assert.equal((await approvalStore.get(created.id)).status, "consumed");
  await assert.rejects(
    executeApprovedHouseDo({
      approvalStore,
      approvalId: created.id,
      payloadSha256: created.payloadSha256,
    }),
    /house_do_approval_invalid/,
  );
  await rm(root, { recursive: true, force: true });
});

test("같은 점검 부탁은 대기 중인 승인을 다시 쓴다", async () => {
  const root = await mkdtemp(join(tmpdir(), "faceid-reuse-"));
  const approvalStore = new ApprovalStore(join(root, "approvals.json"));
  await approvalStore.initialize();
  const text = "방화벽 활성화 하고 백업하라";
  const first = await requestHouseDoApproval(text, { approvalStore });
  const second = await requestHouseDoApproval(text, { approvalStore });
  assert.equal(first, second);
  assert.equal((await approvalStore.listPending()).length, 1);
  assert.match(formatFaceIdWait(houseDoRequest(text)), /Face ID/);
  await rm(root, { recursive: true, force: true });
});
