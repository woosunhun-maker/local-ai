import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { verifyOpenAIEventStream } from "../src/openai-stream.mjs";

async function consume(source) {
  const chunks = [];
  for await (const chunk of verifyOpenAIEventStream(source)) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("accepts an OpenAI stream whose completion marker crosses chunks", async () => {
  const source = Readable.from([
    Buffer.from('data: {"choices":[]}\n\ndata: [DO'),
    Buffer.from('NE]\n\n'),
  ]);

  assert.match(await consume(source), /\[DONE\]/);
});

test("rejects an upstream stream that closes without a completion marker", async () => {
  const source = Readable.from([Buffer.from('data: {"choices":[]}\n\n')]);

  await assert.rejects(() => consume(source), /openai_stream_interrupted/);
});
