import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { ollamaStreamToSSE, toOpenAICompletion } from "../src/ollama-protocol.mjs";

test("converts a non-streaming Ollama reply to OpenAI chat format", () => {
  const result = toOpenAICompletion({ message: { role: "assistant", content: "안녕하세요" } }, "qwen3-fast");
  assert.equal(result.model, "qwen3-fast");
  assert.equal(result.choices[0].message.content, "안녕하세요");
});

test("converts split Ollama NDJSON chunks to SSE", async () => {
  const source = Readable.from([
    Buffer.from('{"message":{"content":"안녕"},"done":false}\n{"message":{"cont'),
    Buffer.from('ent":"하세요"},"done":false}\n{"message":{"content":""},"done":true}\n'),
  ]);
  let output = "";
  for await (const chunk of ollamaStreamToSSE(source)) output += chunk;
  assert.match(output, /"content":"안녕"/);
  assert.match(output, /"content":"하세요"/);
  assert.equal(output.match(/event: delta/g)?.length, 2);
  assert.doesNotMatch(output, /data: \[DONE\]/);
});

test("rejects malformed non-streaming replies", () => {
  assert.throws(() => toOpenAICompletion({ done: true }, "qwen3-fast"), /malformed_ollama_response/);
});

test("does not report a truncated Ollama stream as successfully finished", async () => {
  const source = Readable.from([
    Buffer.from('{"message":{"content":"부분 응답"},"done":false}\n'),
  ]);

  await assert.rejects(async () => {
    for await (const _chunk of ollamaStreamToSSE(source)) {
      // Consume the full generator so its completion invariant is checked.
    }
  }, /ollama_stream_interrupted/);
});
