import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PairPinStore } from "../src/pair-pin.mjs";

test("숫자 4자리는 한 번만 쓸 수 있고 만료되면 버린다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pair-pin-"));
  const store = await new PairPinStore(join(dir, "pins.json")).initialize();
  const pin = await store.issue("pairing-secret", 60_000);
  assert.match(pin, /^\d{4}$/);
  assert.equal(await store.take(pin), "pairing-secret");
  assert.equal(await store.take(pin), null);
  const expired = await store.issue("old-secret", 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(await store.take(expired), null);
  await rm(dir, { recursive: true, force: true });
});
