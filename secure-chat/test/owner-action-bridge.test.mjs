import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApprovalStore } from "../src/approval-store.mjs";
import { TelegramGeneralChatService } from "../src/telegram/general-chat-service.mjs";
import { OwnerActionBridge } from "../src/telegram/owner-action-bridge.mjs";
import { OwnerActionExecutor } from "../src/telegram/owner-action-executor.mjs";
import {
  classifyOwnerAction,
  OWNER_ACTION_KIND,
} from "../src/telegram/owner-action-plan.mjs";

const OWNER = "100000001";
const OWNER_GENERATION = "a".repeat(32);

function update(text) {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      date: Math.floor(Date.now() / 1_000),
      chat: { id: Number(OWNER), type: "private" },
      from: { id: Number(OWNER) },
      text,
    },
  };
}

test("payment stays human-only and never becomes an approval plan", () => {
  const result = classifyOwnerAction("쿠팡에서 결제해줘");
  assert.equal(result.mode, "human_only");
});

test("coupang cart request becomes searchable approval plan without purchase", () => {
  const result = classifyOwnerAction("쿠팡 생수 장바구니에 넣어줘");
  assert.equal(result.mode, "approval");
  assert.equal(result.plan.action, "coupang.search");
  assert.equal(result.plan.escalateCart, true);
  assert.match(result.plan.query, /생수/);
});

test("telegram action creates approval and never calls the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-action-"));
  const approvalStore = new ApprovalStore(join(root, "approvals.json"));
  await approvalStore.initialize();
  const bridge = new OwnerActionBridge({
    approvalStore,
    notify: async () => true,
  });
  const sent = [];
  let modelCalls = 0;
  const service = new TelegramGeneralChatService({
    ownerId: OWNER,
    chatId: OWNER,
    ownerGeneration: OWNER_GENERATION,
    client: { sendText: async (...args) => sent.push(args) },
    ask: async () => {
      modelCalls += 1;
      return "unexpected";
    },
    ownerActionBridge: bridge,
  });
  const result = await service.handleUpdate(update("쿠팡에서 생수 장바구니에 넣어줘"));
  assert.equal(result.outcome, "approval_created");
  assert.equal(modelCalls, 0);
  assert.match(sent[0][1], /승인 요청/);
  const pending = await approvalStore.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, OWNER_ACTION_KIND);
});

test("approved coupang search executes once through shared chrome", async () => {
  const root = await mkdtemp(join(tmpdir(), "owner-action-exec-"));
  const approvalStore = new ApprovalStore(join(root, "approvals.json"));
  await approvalStore.initialize();
  const created = await approvalStore.createRequest({
    kind: OWNER_ACTION_KIND,
    title: "쿠팡 검색",
    summary: "생수 검색",
    payload: JSON.stringify({
      schema: "local-ai.owner-action-plan.v1",
      action: "coupang.search",
      query: "생수",
      note: "test",
      utteranceSha256: "a".repeat(64),
      escalateCart: true,
    }),
    dataCategories: ["owner_action"],
  });

  // register fake device key and approve is complex - use consumeApproved path via executor with mocked store
  const messages = [];
  const executor = new OwnerActionExecutor({
    approvalStore: {
      consumeApproved: async (id, hash) => {
        assert.equal(id, created.id);
        assert.equal(hash, created.payloadSha256);
        return {
          id,
          kind: OWNER_ACTION_KIND,
          payload: created.payload,
          payloadSha256: created.payloadSha256,
        };
      },
    },
    proactiveStore: { enqueue: async (content) => messages.push(content) },
    browser: {
      status: async () => ({ connected: true }),
      findSharedTab: async () => ({ id: "tab-1" }),
      navigateCoupangSearch: async (id, query) => {
        assert.equal(id, "tab-1");
        assert.equal(query, "생수");
        return { ok: true, url: "https://www.coupang.com/np/search?q=%EC%83%9D%EC%88%98" };
      },
    },
    audit: async () => {},
  });

  const result = await executor.executeApproved(created.id, created.payloadSha256);
  assert.equal(result.ok, true);
  assert.match(messages[0], /검색을 열었습니다/);
  assert.match(messages[0], /결제는 직접/);
});
