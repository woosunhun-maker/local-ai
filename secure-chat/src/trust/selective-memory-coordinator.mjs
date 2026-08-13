import { canonicalSha256, deepFreeze } from "../growth/canonical.mjs";
import { validateCompiledMemory } from "./memory-firewall.mjs";

export const SELECTIVE_MEMORY_REGISTRATION_SCHEMA = "local-ai.selective-memory-registration.v1";

export class SelectiveMemoryCoordinatorError extends Error {
  constructor(code) {
    super(code);
    this.name = "SelectiveMemoryCoordinatorError";
    this.code = code;
  }
}

function fail(code) {
  throw new SelectiveMemoryCoordinatorError(code);
}

function exactCompiled(value) {
  try {
    return validateCompiledMemory(value);
  } catch {
    fail("invalid_selective_memory_record");
  }
}

function sameCompiled(left, right) {
  return left.sha256 === right.sha256 && left.canonical === right.canonical;
}

function requireStore(store, methods, code) {
  if (!store || methods.some((method) => typeof store[method] !== "function")) fail(code);
  return store;
}

export class SelectiveMemoryCoordinator {
  constructor({ catalogStore, payloadStore }) {
    this.catalogStore = requireStore(catalogStore, ["initialize", "addCandidate", "appendTransition", "latest", "listActive"], "invalid_memory_catalog_store");
    this.payloadStore = requireStore(payloadStore, ["initialize", "create", "verify", "read"], "invalid_memory_payload_store");
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    await this.catalogStore.initialize();
    await this.payloadStore.initialize();
    this.initialized = true;
  }

  async registerCandidate(compiledValue, value) {
    return this.#serialized(async () => {
      const compiled = this.#readyCompiled(compiledValue);
      if (compiled.record.state !== "candidate" || compiled.record.previous_record_sha256 !== null) {
        fail("selective_memory_candidate_required");
      }
      let valueSha256;
      try {
        valueSha256 = canonicalSha256(value);
      } catch {
        fail("invalid_selective_memory_value");
      }
      if (valueSha256 !== compiled.record.value_sha256) fail("selective_memory_value_mismatch");

      const latest = await this.catalogStore.latest(compiled.record.memory_id);
      if (latest && !sameCompiled(latest, compiled)) fail("selective_memory_identity_conflict");
      if (!latest) await this.catalogStore.addCandidate(compiled);

      try {
        await this.payloadStore.create(compiled, value);
      } catch (error) {
        if (error?.code !== "memory_payload_already_exists") fail("selective_memory_payload_unavailable");
      }
      try {
        await this.payloadStore.verify(compiled);
      } catch {
        fail("selective_memory_payload_unavailable");
      }

      const base = {
        schema: SELECTIVE_MEMORY_REGISTRATION_SCHEMA,
        memory_id: compiled.record.memory_id,
        candidate_sha256: compiled.sha256,
        value_sha256: compiled.record.value_sha256,
        state: "candidate_ready",
      };
      return deepFreeze({ ...base, registration_sha256: canonicalSha256(base) });
    });
  }

  async appendTransition(compiledValue) {
    return this.#serialized(async () => {
      const compiled = this.#readyCompiled(compiledValue);
      if (compiled.record.state === "candidate") fail("selective_memory_transition_required");
      const latest = await this.catalogStore.latest(compiled.record.memory_id);
      if (!latest) fail("selective_memory_candidate_missing");
      if (sameCompiled(latest, compiled)) {
        return Object.freeze({ memory_id: compiled.record.memory_id, record_sha256: compiled.sha256, already_applied: true });
      }
      if (["confirmed", "active"].includes(compiled.record.state)) {
        try {
          await this.payloadStore.verify(compiled);
        } catch {
          fail("selective_memory_payload_unavailable");
        }
      }
      try {
        await this.catalogStore.appendTransition(compiled);
      } catch {
        fail("selective_memory_transition_rejected");
      }
      return Object.freeze({ memory_id: compiled.record.memory_id, record_sha256: compiled.sha256, already_applied: false });
    });
  }

  async listActive(context) {
    if (!this.initialized) fail("selective_memory_coordinator_not_initialized");
    return this.catalogStore.listActive(context);
  }

  async read(memoryId, context) {
    if (!this.initialized) fail("selective_memory_coordinator_not_initialized");
    const latest = await this.catalogStore.latest(memoryId);
    if (!latest) fail("selective_memory_not_found");
    try {
      return await this.payloadStore.read(latest, context);
    } catch (error) {
      if (["memory_owner_not_authenticated", "private_memory_channel_blocked", "memory_not_active", "memory_expired", "memory_principal_mismatch", "memory_purpose_mismatch"].includes(error?.code)) {
        fail(error.code);
      }
      fail("selective_memory_payload_unavailable");
    }
  }

  #readyCompiled(value) {
    if (!this.initialized) fail("selective_memory_coordinator_not_initialized");
    return exactCompiled(value);
  }

  #serialized(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
