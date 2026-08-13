import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalSha256, sha256Hex } from "../src/growth/canonical.mjs";
import { EncryptedMemoryStore } from "../src/trust/encrypted-memory-store.mjs";
import { createMemoryCandidate, transitionMemory } from "../src/trust/memory-firewall.mjs";

const hash = (character) => character.repeat(64);
const VALUE = { brand: "synthetic-water", capacity_ml: 2000, bundle_count: 6 };

function candidate() {
  return createMemoryCandidate({
    memory_id: "memory.shopping.water.encrypted.001",
    namespace: "memory.owner",
    subject_id: "user.owner",
    category: "preference",
    scope: "shopping",
    purpose: "product_selection",
    value_sha256: canonicalSha256(VALUE),
    source: { kind: "user_explicit", source_sha256: hash("b") },
    confidence_bps: 10_000,
    created_at: "2026-08-05T00:00:00.000Z",
    expires_at: "2026-09-05T00:00:00.000Z",
  });
}

function activate(initial = candidate()) {
  const confirmed = transitionMemory(initial, {
    to: "confirmed",
    at: "2026-08-05T00:01:00.000Z",
    consent_ref: hash("c"),
  });
  return transitionMemory(confirmed, {
    to: "active",
    at: "2026-08-05T00:01:01.000Z",
    consent_ref: hash("c"),
  });
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
  const root = await mkdtemp(join(tmpdir(), "local-ai-encrypted-memory-"));
  await chmod(root, 0o700);
  const key = Buffer.alloc(32, 7);
  const store = new EncryptedMemoryStore(root, {
    keyProvider: async () => Buffer.from(key),
    now: () => "2026-08-05T00:00:30.000Z",
  });
  await store.initialize();
  return { root, key, store };
}

test("encrypts a candidate payload at rest and releases it only after activation", async () => {
  const { store } = await fixture();
  const initial = candidate();
  await store.create(initial, VALUE);
  const path = join(store.rootPath, `${sha256Hex(initial.record.memory_id)}.json`);
  const stored = await readFile(path, "utf8");
  assert.equal(stored.includes("synthetic-water"), false);
  assert.equal(stored.includes("capacity_ml"), false);
  assert.deepEqual(await store.verify(initial), {
    memory_id: initial.record.memory_id,
    value_sha256: initial.record.value_sha256,
    binding_sha256: canonicalSha256({
      schema: "local-ai.memory-payload-binding.v1",
      memory_id: initial.record.memory_id,
      namespace: initial.record.namespace,
      subject_id: initial.record.subject_id,
      category: initial.record.category,
      scope: initial.record.scope,
      purpose: initial.record.purpose,
      value_sha256: initial.record.value_sha256,
      source_sha256: initial.record.source.source_sha256,
      created_at: initial.record.created_at,
      expires_at: initial.record.expires_at,
    }),
  });
  await assert.rejects(store.read(initial, context()), /memory_not_active/u);
  assert.deepEqual(await store.read(activate(initial), context()), VALUE);
});

test("payload bytes are bound to metadata, owner app channel, and purpose", async () => {
  const { store } = await fixture();
  const initial = candidate();
  await store.create(initial, VALUE);
  const active = activate(initial);
  await assert.rejects(store.read(active, context({ channel: "telegram" })), /private_memory_channel_blocked/u);
  await assert.rejects(store.read(active, context({ purpose: "marketing" })), /memory_purpose_mismatch/u);
  const changedMetadata = structuredClone(candidate());
  changedMetadata.record.value_sha256 = hash("a");
  await assert.rejects(store.read(changedMetadata, context()), /compiled_memory_tampered/u);
});

test("wrong plaintext, duplicate writes, wrong keys, and ciphertext tampering fail closed", async () => {
  const { root, store } = await fixture();
  const initial = candidate();
  await assert.rejects(store.create(initial, { different: true }), /memory_payload_digest_mismatch/u);
  await store.create(initial, VALUE);
  await assert.rejects(store.create(initial, VALUE), /memory_payload_already_exists/u);

  const wrongKeyStore = new EncryptedMemoryStore(root, { keyProvider: async () => Buffer.alloc(32, 9) });
  await wrongKeyStore.initialize();
  await assert.rejects(wrongKeyStore.read(activate(initial), context()), /memory_payload_authentication_failed/u);

  const path = join(store.rootPath, `${sha256Hex(initial.record.memory_id)}.json`);
  const envelope = JSON.parse(await readFile(path, "utf8"));
  envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}`;
  await writeFile(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  await assert.rejects(store.read(activate(initial), context()), /memory_payload_authentication_failed|invalid_encrypted_memory_ciphertext/u);
});

test("requires a 256-bit injected key and a private canonical root", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ai-encrypted-memory-key-"));
  await chmod(root, 0o700);
  const store = new EncryptedMemoryStore(root, { keyProvider: async () => Buffer.alloc(16) });
  await store.initialize();
  await assert.rejects(store.create(candidate(), VALUE), /invalid_memory_encryption_key/u);
});

test("missing payloads and relaxed file permissions fail without reading data", async () => {
  const { store } = await fixture();
  const active = activate();
  await assert.rejects(store.read(active, context()), /memory_payload_not_found/u);

  const initial = candidate();
  await store.create(initial, VALUE);
  const path = join(store.rootPath, `${sha256Hex(initial.record.memory_id)}.json`);
  await chmod(path, 0o644);
  await assert.rejects(store.read(activate(initial), context()), /insecure_encrypted_memory_permissions/u);
});
