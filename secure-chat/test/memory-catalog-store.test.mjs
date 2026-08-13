import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalSha256,
  canonicalizeJson,
} from "../src/growth/canonical.mjs";
import { MemoryCatalogStore } from "../src/trust/memory-catalog-store.mjs";
import {
  createMemoryCandidate,
  transitionMemory,
} from "../src/trust/memory-firewall.mjs";

const hash = (character) => character.repeat(64);

function candidate(overrides = {}) {
  return createMemoryCandidate({
    memory_id: "memory.shopping.water.001",
    namespace: "memory.owner",
    subject_id: "user.owner",
    category: "preference",
    scope: "shopping",
    purpose: "product_selection",
    value_sha256: hash("a"),
    source: { kind: "model_inference", source_sha256: hash("b") },
    confidence_bps: 8_000,
    created_at: "2026-08-05T00:00:00.000Z",
    expires_at: "2026-09-05T00:00:00.000Z",
    ...overrides,
  });
}

function activate(value = candidate()) {
  const confirmed = transitionMemory(value, {
    to: "confirmed",
    at: "2026-08-05T00:01:00.000Z",
    consent_ref: hash("c"),
  });
  return {
    confirmed,
    active: transitionMemory(confirmed, {
      to: "active",
      at: "2026-08-05T00:01:01.000Z",
      consent_ref: hash("c"),
    }),
  };
}

function context(overrides = {}) {
  return {
    now: "2026-08-05T00:02:00.000Z",
    namespace: "memory.owner",
    subject_id: "user.owner",
    scope: "shopping",
    purpose: "product_selection",
    channel: "local_owner_app",
    owner_authenticated: true,
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memory-catalog-"));
  await chmod(root, 0o700);
  const path = join(root, "catalog.json");
  const store = new MemoryCatalogStore(path);
  await store.initialize();
  return { root, path, store };
}

test("catalog persists metadata hashes but no memory plaintext", async () => {
  const { path, store } = await fixture();
  const initial = candidate();
  const added = await store.addCandidate(initial);
  const persisted = await readFile(path, "utf8");

  assert.equal(added.sequence, 1);
  assert.match(persisted, /memory\.shopping\.water\.001/u);
  assert.doesNotMatch(persisted, /sparkling water|탄산수/u);
  assert.equal((await store.latest(initial.record.memory_id)).sha256, initial.sha256);
});

test("only exact active owner-app memories are discoverable", async () => {
  const { store } = await fixture();
  const initial = candidate();
  const { confirmed, active } = activate(initial);
  await store.addCandidate(initial);
  await store.appendTransition(confirmed);
  await store.appendTransition(active);

  const visible = await store.listActive(context());
  assert.equal(visible.length, 1);
  assert.deepEqual(Object.keys(visible[0]).sort(), [
    "category", "confidence_bps", "expires_at", "memory_id", "purpose", "record_sha256", "scope", "source_kind",
  ]);
  assert.equal((await store.listActive(context({ purpose: "marketing" }))).length, 0);
  await assert.rejects(store.listActive(context({ channel: "telegram" })), /private_memory_channel_blocked/u);
  await assert.rejects(store.listActive(context({ owner_authenticated: false })), /memory_owner_not_authenticated/u);
});

test("a forged candidate-to-active jump is rejected even with valid record hashes", async () => {
  const { store } = await fixture();
  const initial = candidate();
  await store.addCandidate(initial);

  const record = {
    ...initial.record,
    state: "active",
    consent_ref: hash("c"),
    updated_at: "2026-08-05T00:01:01.000Z",
    previous_record_sha256: initial.sha256,
  };
  const forged = {
    record,
    canonical: canonicalizeJson(record),
    sha256: canonicalSha256(record),
  };
  await assert.rejects(store.appendTransition(forged), /invalid_memory_catalog_transition/u);
});

test("global entry-chain tampering is detected on the next read", async () => {
  const { path, store } = await fixture();
  const first = candidate();
  const second = candidate({ memory_id: "memory.shopping.quantity.002", value_sha256: hash("d") });
  await store.addCandidate(first);
  await store.addCandidate(second);

  const catalog = JSON.parse(await readFile(path, "utf8"));
  catalog.entries[1].previous_entry_sha256 = hash("f");
  await writeFile(path, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });
  await assert.rejects(store.latest(first.record.memory_id), /memory_catalog_chain_broken/u);
});

test("duplicate ids and missing candidate histories fail closed", async () => {
  const { store } = await fixture();
  const initial = candidate();
  await store.addCandidate(initial);
  await assert.rejects(store.addCandidate(initial), /memory_catalog_identity_exists/u);

  const unrelated = candidate({ memory_id: "memory.other.003" });
  const { confirmed } = activate(unrelated);
  await assert.rejects(store.appendTransition(confirmed), /memory_catalog_candidate_missing/u);
});

test("serialized concurrent appends preserve a single global sequence", async () => {
  const { path, store } = await fixture();
  const memories = Array.from({ length: 12 }, (_, index) => candidate({
    memory_id: `memory.concurrent.${index}`,
    value_sha256: index.toString(16).padStart(64, "0"),
  }));
  await Promise.all(memories.map((memory) => store.addCandidate(memory)));

  const catalog = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(catalog.entries.map((entry) => entry.sequence), Array.from({ length: 12 }, (_, index) => index + 1));
  for (const memory of memories) assert.equal((await store.latest(memory.record.memory_id)).sha256, memory.sha256);
});

test("catalog refuses files with relaxed permissions", async () => {
  const { path, store } = await fixture();
  await chmod(path, 0o644);
  await assert.rejects(store.listActive(context()), /insecure_memory_catalog_permissions/u);
});

test("an empty catalog still validates the complete read boundary", async () => {
  const { store } = await fixture();
  await assert.rejects(store.listActive(context({ now: "not-a-time" })), /invalid_memory_catalog_read_context/u);
  await assert.rejects(store.listActive({ ...context(), extra: true }), /invalid_memory_catalog_read_context/u);
});
