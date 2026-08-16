import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConversationStore } from "../src/conversation-store.mjs";

test("대화는 맥 파일에 여러 개 남고 제목이 첫 말로 바뀐다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "conv-store-"));
  const store = await new ConversationStore(join(dir, "conversations.json"), join(dir, "images")).initialize();
  const created = await store.create();
  assert.equal(created.title, "새 대화");
  const added = await store.addUser(created.id, { text: "이 사진 제품 찾아봐" });
  assert.equal(added.conversation.title, "이 사진 제품 찾아봐");
  await store.addAssistant(created.id, "후보를 확인하는 중이다.");
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.match(listed[0].preview, /후보/);
  await rm(dir, { recursive: true, force: true });
});
