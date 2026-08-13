import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfirmedMemoryStore } from "../src/confirmed-memory-store.mjs";
import { DecisionMemoryStore } from "../src/memory/decision-memory-store.mjs";
import { DiscussionContextStore } from "../src/memory/discussion-context-store.mjs";
import { createMemoryContextFacade } from "../src/memory/context-facade.mjs";

test("confirmed user memory still propose→confirm→inject and stays on its own file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "memory-layers-"));
  try {
    const userPath = join(dir, "confirmed.json");
    const decisionPath = join(dir, "decisions.json");
    const discussionPath = join(dir, "discussions.json");
    const confirmed = await new ConfirmedMemoryStore(userPath).initialize();
    const decisions = await new DecisionMemoryStore(decisionPath).initialize();
    const discussions = await new DiscussionContextStore(discussionPath).initialize();
    const facade = createMemoryContextFacade({
      confirmedMemory: confirmed,
      decisionStore: decisions,
      discussionStore: discussions,
    });

    const proposed = await confirmed.propose("커피는 아이스로");
    await confirmed.confirm(proposed.id);
    const block = await facade.chatUserMemoryBlock("커피");
    assert.match(block, /확인된 기억/);
    assert.match(block, /아이스로/);

    await decisions.propose({ decision: "Telegram은 도구 금지 유지", reason: "프라이버시" });
    await discussions.open({ topic: "PHASE3 Memory 설계", openQuestions: ["주입 범위?"] });

    const userFile = JSON.parse(await readFile(userPath, "utf8"));
    assert.equal(userFile.items.length, 1);
    assert.equal(userFile.items[0].text, "커피는 아이스로");
    assert.equal(userFile.items[0].status, "active");

    const decisionFile = JSON.parse(await readFile(decisionPath, "utf8"));
    const discussionFile = JSON.parse(await readFile(discussionPath, "utf8"));
    assert.equal(decisionFile.items[0].decision.includes("Telegram"), true);
    assert.equal(discussionFile.items[0].topic.includes("PHASE3"), true);

    const snapshot = await facade.snapshot({ query: "커피" });
    assert.equal(snapshot.layers.user_memory.store, "ConfirmedMemoryStore");
    assert.equal(snapshot.layers.user_memory.chat_injection, "on_demand_active_only");
    assert.equal(snapshot.layers.decision_memory.chat_injection, "owner_context_api_only");
    assert.equal(snapshot.layers.active_discussion.auto_promote_to_user_memory, false);
    assert.equal(snapshot.layers.project_context.confirmation_required, false);
    assert.doesNotMatch(JSON.stringify(userFile), /PHASE3|Telegram은 도구/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("decision requires confirm before active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decision-"));
  try {
    const store = await new DecisionMemoryStore(join(dir, "d.json")).initialize();
    const item = await store.propose({ decision: "Executor는 PHASE4", reason: "범위 분리" });
    assert.equal(item.status, "candidate");
    assert.equal((await store.listActive()).length, 0);
    await store.confirm(item.id);
    assert.equal((await store.listActive()).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
