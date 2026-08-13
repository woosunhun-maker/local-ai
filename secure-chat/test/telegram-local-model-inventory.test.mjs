import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalModelInventory } from "../src/telegram/local-model-inventory.mjs";

test("model inventory reports configured roles without claiming live readiness", () => {
  const active = formatLocalModelInventory({ codexReady: true });
  assert.match(active, /현재 구성된 모델/u);
  assert.match(active, /qwen3\.6:35b/u);
  assert.match(active, /qwen3-128k:latest/u);
  assert.match(active, /Qwen3-TTS/u);
  assert.match(active, /gpt-5\.6-sol/u);
  assert.match(active, /실시간 공개 웹 검색: 아직 연결 안 됨/u);
  assert.match(active, /구성값이며.*\/status/u);
  assert.doesNotMatch(active, /GPT-4o|Claude 3|Gemini 1\.5/u);

  const disabled = formatLocalModelInventory({ codexReady: false });
  assert.match(disabled, /격리 개발 검토: 비활성/u);
});
