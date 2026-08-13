import assert from "node:assert/strict";
import test from "node:test";
import { KoreanSentenceChunker } from "../src/tts/sentence-chunker.mjs";

test("chunks Korean sentences across arbitrary stream fragments", () => {
  const chunker = new KoreanSentenceChunker();
  assert.deepEqual(chunker.push("안녕하"), []);
  assert.deepEqual(chunker.push("세요. 다음은 "), ["안녕하세요."]);
  assert.deepEqual(chunker.push("버전 1.2입니다!"), ["다음은 버전 1.2입니다!"]);
  assert.deepEqual(chunker.flush(), []);
});

test("does not split a decimal when the period arrives before the next digit", () => {
  const chunker = new KoreanSentenceChunker();
  assert.deepEqual(chunker.push("현재 버전은 1."), []);
  assert.deepEqual(chunker.push("2입니다."), ["현재 버전은 1.2입니다."]);
});

test("bounds long text without waiting for punctuation", () => {
  const chunker = new KoreanSentenceChunker({ maxCharacters: 24, minimumSoftBreak: 8 });
  const chunks = [
    ...chunker.push("가".repeat(70)),
    ...chunker.flush(),
  ];
  assert.equal(chunks.join(""), "가".repeat(70));
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 24));
});

test("removes null controls and normalizes whitespace only at emitted boundaries", () => {
  const chunker = new KoreanSentenceChunker();
  assert.deepEqual(chunker.push("개인\u0000 정보는   기록하지 않습니다.  "), ["개인 정보는 기록하지 않습니다."]);
  assert.deepEqual(chunker.flush(), []);
});
