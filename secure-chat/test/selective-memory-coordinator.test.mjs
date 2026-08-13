import assert from "node:assert/strict";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalSha256 } from "../src/growth/canonical.mjs";
import { EncryptedMemoryStore } from "../src/trust/encrypted-memory-store.mjs";
import { MemoryCatalogStore } from "../src/trust/memory-catalog-store.mjs";
import {
  createMemoryCandidate,
  transitionMemory,
} from "../src/trust/memory-firewall.mjs";
import {
  SelectiveMemoryCoordinator,
  SELECTIVE_MEMORY_REGISTRATION_SCHEMA,
} from "../src/trust/selective-memory-coordinator.mjs";

const hash = (character) => character.repeat(64);
const VALUE = { synthetic_preference: "still-water", bundle_count: 6 };

function candidate(overrides = {}) {
  return createMemoryCandidate({
    memory_id: "memory.synthetic.water.001",
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
    ...overrides,
  });
}

function transitions(initial) {
  const confirmed = transitionMemory(initial, {
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

async function stores() {
  const root = await mkdtemp(join(tmpdir(), "selective-memory-coordinator-"));
  await chmod(root, 0o700);
  const catalogStore = new MemoryCatalogStore(join(root, "catalog", "catalog.json"));
  const payloadStore = new EncryptedMemoryStore(join(root, "payloads"), {
    keyProvider: async () => Buffer.alloc(32, 7),
    now: () => "2026-08-05T00:00:30.000Z",
  });
  return { root, catalogStore, payloadStore };
}

async function fixture(overrides = {}) {
  const base = await stores();
  const coordinator = new SelectiveMemoryCoordinator({
    catalogStore: overrides.catalogStore ?? base.catalogStore,
    payloadStore: overrides.payloadStore ?? base.payloadStore,
  });
  await coordinator.initialize();
  return { ...base, coordinator };
}

test("candidate payload stays unreadable until exact confirmed and active transitions", async () => {
  const { coordinator } = await fixture();
  const initial = candidate();
  const registration = await coordinator.registerCandidate(initial, VALUE);
  assert.equal(registration.schema, SELECTIVE_MEMORY_REGISTRATION_SCHEMA);
  assert.equal(registration.state, "candidate_ready");
  assert.equal((await coordinator.listActive(context())).length, 0);
  await assert.rejects(coordinator.read(initial.record.memory_id, context()), /memory_not_active/u);

  const { confirmed, active } = transitions(initial);
  await coordinator.appendTransition(confirmed);
  await coordinator.appendTransition(active);
  assert.equal((await coordinator.listActive(context())).length, 1);
  assert.deepEqual(await coordinator.read(initial.record.memory_id, context()), VALUE);
  await assert.rejects(coordinator.read(initial.record.memory_id, context({ channel: "telegram" })), /private_memory_channel_blocked/u);
});

test("a crash after payload creation is safely recoverable without a duplicate memory", async () => {
  const base = await stores();
  let failAfterCreate = true;
  const interruptedPayloadStore = {
    initialize: () => base.payloadStore.initialize(),
    create: async (...args) => {
      const result = await base.payloadStore.create(...args);
      if (failAfterCreate) {
        failAfterCreate = false;
        throw new Error("synthetic_interruption");
      }
      return result;
    },
    verify: (...args) => base.payloadStore.verify(...args),
    read: (...args) => base.payloadStore.read(...args),
  };
  const interrupted = new SelectiveMemoryCoordinator({
    catalogStore: base.catalogStore,
    payloadStore: interruptedPayloadStore,
  });
  await interrupted.initialize();
  const initial = candidate();
  await assert.rejects(interrupted.registerCandidate(initial, VALUE), /selective_memory_payload_unavailable/u);
  assert.equal((await base.catalogStore.latest(initial.record.memory_id)).sha256, initial.sha256);

  const recovered = new SelectiveMemoryCoordinator(base);
  await recovered.initialize();
  const registration = await recovered.registerCandidate(initial, VALUE);
  assert.equal(registration.candidate_sha256, initial.sha256);
});

test("metadata-only partial registration cannot be confirmed or activated", async () => {
  const base = await stores();
  const unavailablePayloadStore = {
    initialize: () => base.payloadStore.initialize(),
    create: async () => { throw new Error("synthetic_unavailable"); },
    verify: (...args) => base.payloadStore.verify(...args),
    read: (...args) => base.payloadStore.read(...args),
  };
  const coordinator = new SelectiveMemoryCoordinator({ catalogStore: base.catalogStore, payloadStore: unavailablePayloadStore });
  await coordinator.initialize();
  const initial = candidate();
  await assert.rejects(coordinator.registerCandidate(initial, VALUE), /selective_memory_payload_unavailable/u);
  const { confirmed } = transitions(initial);
  await assert.rejects(coordinator.appendTransition(confirmed), /selective_memory_payload_unavailable/u);
  assert.equal((await base.catalogStore.latest(initial.record.memory_id)).record.state, "candidate");
});

test("transition retries are idempotent but skipped states and identity reuse are rejected", async () => {
  const { coordinator } = await fixture();
  const initial = candidate();
  await coordinator.registerCandidate(initial, VALUE);
  const { confirmed, active } = transitions(initial);
  await assert.rejects(coordinator.appendTransition(active), /selective_memory_transition_rejected/u);
  await coordinator.appendTransition(confirmed);
  assert.equal((await coordinator.appendTransition(confirmed)).already_applied, true);

  const conflict = candidate({ value_sha256: hash("d") });
  await assert.rejects(coordinator.registerCandidate(conflict, VALUE), /selective_memory_value_mismatch|selective_memory_identity_conflict/u);
});

test("invalid values and reads of unknown ids fail without exposing store details", async () => {
  const { coordinator } = await fixture();
  await assert.rejects(coordinator.registerCandidate(candidate(), { wrong: true }), /selective_memory_value_mismatch/u);
  await assert.rejects(coordinator.read("memory.unknown", context()), /selective_memory_not_found/u);
});
