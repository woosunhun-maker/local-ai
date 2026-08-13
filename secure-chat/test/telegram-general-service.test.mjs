import assert from "node:assert/strict";
import test from "node:test";
import { TelegramGeneralChatService } from "../src/telegram/general-chat-service.mjs";

const OWNER = "100000001";
const OWNER_GENERATION = "a".repeat(32);
const SERVICE_PRINCIPAL = Object.freeze({
  ownerId: OWNER,
  chatId: OWNER,
  ownerGeneration: OWNER_GENERATION,
});

function update(text, extra = {}) {
  return { update_id: 1, message: { message_id: 10, date: Math.floor(Date.now() / 1_000), chat: { id: Number(OWNER), type: "private" }, from: { id: Number(OWNER) }, text, ...extra } };
}

test("blocked private work never reaches the local model", async () => {
  const sent = [];
  let modelCalls = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async (...args) => sent.push(args) },
    ask: async () => { modelCalls += 1; return "unexpected"; },
  });
  const result = await service.handleUpdate(update("쿠팡에서 장바구니에 넣어놔"));
  assert.equal(result.outcome, "blocked");
  assert.equal(modelCalls, 0);
  assert.equal(sent.length, 1);
});

test("ordinary chat uses only ephemeral context and the direct local model callback", async () => {
  const prompts = [];
  const sent = [];
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async (...args) => sent.push(args) },
    ask: async (messages) => { prompts.push(messages); return `답변 ${prompts.length}`; },
  });
  await service.handleUpdate(update("안녕"));
  await service.handleUpdate(update("아까 뭐라고 했지?"));
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[1].map((entry) => entry.role), ["user", "assistant", "user"]);
  assert.equal(sent.length, 2);
});

test("status command returns bounded runtime health and never reaches Ollama chat", async () => {
  const sent = [];
  let modelCalls = 0;
  let statusCalls = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async (...args) => sent.push(args) },
    ask: async () => { modelCalls += 1; return "unexpected"; },
    runtimeStatus: async ({ codexTasks }) => {
      statusCalls += 1;
      assert.ok(codexTasks);
      return {
        schema: "local-ai.telegram-runtime-status.v1",
        secureChatReady: true,
        localModelReady: true,
        codex: { queued: 2, running: 1, undelivered: 0 },
        telegramMode: "general_chat_and_codex_status",
        privilegedIngress: "local_owner_app_only",
      };
    },
    codexTasks: {
      enqueue: async () => {},
      summary: async () => ({ queued: 2, running: 1, undelivered: 0, recent: null }),
    },
  });
  const result = await service.handleUpdate(update("/status"));
  assert.equal(result.reason, "runtime_status");
  assert.equal(statusCalls, 1);
  assert.equal(modelCalls, 0);
  assert.match(sent[0][1], /Mac 보안 서버: 정상/);
  assert.match(sent[0][1], /대기 2 · 실행 1/);
  assert.doesNotMatch(sent[0][1], /token|path|secret/iu);
});

test("models command returns code-owned inventory and never asks the model to guess", async () => {
  const sent = [];
  let modelCalls = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async (...args) => sent.push(args) },
    ask: async () => { modelCalls += 1; return "unexpected"; },
    codexTasks: { enqueue: async () => {}, summary: async () => ({ queued: 0, running: 0, undelivered: 0 }) },
  });
  const result = await service.handleUpdate(update("/models"));
  assert.equal(result.reason, "runtime_models");
  assert.equal(modelCalls, 0);
  assert.match(sent[0][1], /qwen3\.6:35b/u);
  assert.match(sent[0][1], /gpt-5\.6-sol/u);
  assert.doesNotMatch(sent[0][1], /GPT-4o|Claude 3|Gemini 1\.5/u);
});

test("progress query returns gate percentages and live capabilities without asking the model", async () => {
  const sent = [];
  let modelCalls = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async (...args) => sent.push(args) },
    ask: async () => { modelCalls += 1; return "unexpected"; },
  });
  const result = await service.handleUpdate(update("진행 상황"));
  assert.equal(result.reason, "project_progress");
  assert.equal(modelCalls, 0);
  assert.match(sent[0][1], /전체 검증 게이트: 64%/u);
  assert.match(sent[0][1], /실제 운영 연결: 34%/u);
  assert.match(sent[0][1], /현재 실제 가능한 기능/u);
});

test("unauthorized updates neither call the model nor send a response", async () => {
  let modelCalls = 0;
  let sends = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async () => { sends += 1; } },
    ask: async () => { modelCalls += 1; return "unexpected"; },
  });
  const result = await service.handleUpdate({ ...update("안녕"), message: { ...update("안녕").message, from: { id: 123456 } } });
  assert.deepEqual(result, { outcome: "blocked", reason: "unauthorized_sender" });
  assert.equal(modelCalls, 0);
  assert.equal(sends, 0);
});

test("invalid model output is not persisted in context or sent", async () => {
  let sends = 0;
  const context = {
    appended: [],
    get: () => [],
    append(...args) { this.appended.push(args); },
    clear() {},
  };
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async () => { sends += 1; } },
    context,
    ask: async () => "",
  });
  await assert.rejects(service.handleUpdate(update("안녕")), /invalid_local_model_response/);
  assert.equal(sends, 0);
  assert.deepEqual(context.appended, []);
});

test("Telegram Codex execution is disabled and directs work to signed owner-app approval", async () => {
  const sent = [];
  const enqueued = [];
  let modelCalls = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async (...args) => sent.push(args) },
    ask: async () => { modelCalls += 1; return "unexpected"; },
    codexTasks: {
      enqueue: async (value) => {
        enqueued.push(value);
        return { created: true, job: { id: "job_123456789" } };
      },
      summary: async () => ({ queued: 0, running: 0, undelivered: 0, recent: null }),
    },
  });
  const result = await service.handleUpdate(update("/codex inspect 테스트 구조만 점검해"));
  assert.deepEqual(enqueued, []);
  assert.equal(modelCalls, 0);
  assert.deepEqual(result, { outcome: "blocked", reason: "owner_app_approval_required" });
  assert.match(sent[0][1], /OpenAI 외부 전송 계획/);
  assert.match(sent[0][1], /Face ID 또는 기기 암호/);
});

test("Telegram never enqueues local operational data as a Codex task", async () => {
  const sent = [];
  let enqueues = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async (...args) => sent.push(args) },
    codexTasks: {
      enqueue: async () => { enqueues += 1; },
      summary: async () => ({ queued: 0, running: 0, undelivered: 0, recent: null }),
    },
  });
  for (const text of [
    "/codex inspect 합성 직원 장부와 계좌 원문을 분석해줘",
    "/codex inspect 합성 가게 매출과 재고 기록을 비교해줘",
  ]) {
    const result = await service.handleUpdate(update(text));
    assert.equal(result.outcome, "blocked");
  }
  assert.equal(enqueues, 0);
  assert.equal(sent.every((entry) => /Local AI 앱/u.test(entry[1])), true);
});

test("codex status and policy rejection never reach Ollama", async () => {
  const sent = [];
  let modelCalls = 0;
  let enqueueCalls = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async (...args) => sent.push(args) },
    ask: async () => { modelCalls += 1; return "unexpected"; },
    codexTasks: {
      enqueue: async () => { enqueueCalls += 1; },
      summary: async () => ({ queued: 1, running: 1, undelivered: 0, recent: { id: "job_abcdefgh", status: "running" } }),
    },
  });
  await service.handleUpdate(update("/codex status"));
  const blocked = await service.handleUpdate(update("/codex draft 프로덕션에 배포해"));
  assert.equal(modelCalls, 0);
  assert.equal(enqueueCalls, 0);
  assert.equal(blocked.outcome, "blocked");
  assert.match(sent[0][1], /대기 1/);
  assert.match(sent[1][1], /Local AI 앱/);
});

test("unauthorized codex commands receive no reply and create no task", async () => {
  let sends = 0;
  let enqueues = 0;
  const service = new TelegramGeneralChatService({
    ...SERVICE_PRINCIPAL,
    client: { sendText: async () => { sends += 1; } },
    codexTasks: {
      enqueue: async () => { enqueues += 1; },
      summary: async () => ({ queued: 0, running: 0, undelivered: 0, recent: null }),
    },
  });
  const forged = update("/codex inspect 코드 점검", { from: { id: 123456 } });
  const result = await service.handleUpdate(forged);
  assert.equal(result.reason, "unauthorized_sender");
  assert.equal(sends, 0);
  assert.equal(enqueues, 0);
});
