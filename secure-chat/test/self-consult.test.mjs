import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OPENAI_ASK_PREFIX, OPENAI_CHAT_URL } from "../src/openai-ask.mjs";
import { LessonStore } from "../src/lesson-store.mjs";
import { buildRoomSystemPrompt } from "../src/room-ask.mjs";
import { roomTurnAnswer } from "../src/room-turn.mjs";
import {
  buildSelfQuestion,
  draftLesson,
  isKnowledgeSeeking,
  isPrivateForConsult,
  isSmallTalk,
  planSelfConsult,
} from "../src/self-consult.mjs";

test("인사와 비밀은 스스로 오픈에게 보내지 않는다", () => {
  assert.equal(isSmallTalk("안녕"), true);
  assert.equal(isPrivateForConsult("내 비밀번호는 뭐였지"), true);
  assert.equal(isKnowledgeSeeking("파이썬 리스트 정렬은 어떻게 해"), true);
  assert.equal(planSelfConsult("안녕").mode, "local");
  assert.equal(planSelfConsult("내 계좌번호 알려줘").reason, "private");
  assert.equal(planSelfConsult("파이썬 리스트 정렬은 어떻게 해").mode, "self");
  assert.match(buildSelfQuestion("파이썬 리스트 정렬은 어떻게 해"), /일반 지식만/);
});

test("물어보라고 하지 않아도 일반 지식은 스스로 묻는다", () => {
  const plan = planSelfConsult("Swift에서 async let이 뭐가 다른지 설명해줘");
  assert.equal(plan.mode, "self");
  assert.equal(plan.consult, true);
  assert.doesNotMatch(plan.question, /비밀번호/);
});

test("교훈에는 비밀이 들어가지 않는다", () => {
  assert.equal(draftLesson("비밀번호 알려줘", "비밀은 1234"), null);
  const lesson = draftLesson("리스트 정렬", `${OPENAI_ASK_PREFIX}sorted 를 쓰면 됩니다. 원본은 그대로입니다.`);
  assert.equal(lesson.topic, "리스트 정렬");
  assert.match(lesson.lesson, /sorted/);
});

test("방 프롬프트는 집 교훈만 넣고 텔레그램은 안 넣는다", () => {
  const prompt = buildRoomSystemPrompt([{ lesson: "정렬은 sorted가 원본을 남긴다." }]);
  assert.match(prompt, /sorted/);
  assert.match(prompt, /일반 교훈/);
  assert.doesNotMatch(prompt, /telegram/i);
});

test("스스로 물을 때 로컬 답 뒤에 맥 오픈 답을 붙이고 교훈을 남긴다", async () => {
  const root = await mkdtemp(join(tmpdir(), "lessons-"));
  const store = await new LessonStore(join(root, "lessons.json")).initialize();
  const urls = [];
  const answer = await roomTurnAnswer(
    [{ role: "user", content: "파이썬 리스트 정렬은 어떻게 해" }],
    {
      token: "local-proxy",
      lessonStore: store,
      fetchImpl: async (url, init) => {
        urls.push(url);
        const body = JSON.parse(init.body);
        if (url.includes("11434")) {
          return {
            ok: true,
            body: (async function* () {
              yield Buffer.from(`${JSON.stringify({ message: { content: "로컬은 sorted" }})}\n`);
            })(),
          };
        }
        assert.equal(url, OPENAI_CHAT_URL);
        assert.match(body.messages.at(-1).content, /일반 지식만/);
        assert.doesNotMatch(JSON.stringify(body), /비밀번호/);
        return {
          ok: true,
          body: (async function* () {
            yield 'data: {"choices":[{"delta":{"content":"sorted() 가 안전합니다."}}]}\n';
            yield "data: [DONE]\n";
          })(),
        };
      },
    },
  );
  assert.match(answer, /로컬은 sorted/);
  assert.match(answer, /맥에 띄운 오픈/);
  assert.match(answer, /sorted\(\) 가 안전합니다/);
  const snap = await store.snapshot();
  assert.equal(snap.lessons.length, 1);
  assert.match(snap.lessons[0].lesson, /sorted/);
  await rm(root, { recursive: true, force: true });
});
