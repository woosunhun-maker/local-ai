import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  canonicalSha256,
  isSha256,
} from "../growth/canonical.mjs";
import {
  evaluateMemoryRead,
  transitionMemory,
  validateCompiledMemory,
  validateMemoryReadContext,
} from "./memory-firewall.mjs";

export const MEMORY_CATALOG_SCHEMA = "local-ai.memory-catalog.v1";
export const MEMORY_CATALOG_ENTRY_SCHEMA = "local-ai.memory-catalog-entry.v1";

const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;

export class MemoryCatalogStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "MemoryCatalogStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new MemoryCatalogStoreError(code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(code);
}

function entryBase(sequence, compiled, previousEntrySha256) {
  return {
    schema: MEMORY_CATALOG_ENTRY_SCHEMA,
    sequence,
    memory_id: compiled.record.memory_id,
    compiled,
    previous_entry_sha256: previousEntrySha256,
  };
}

function createEntry(sequence, compiled, previousEntrySha256) {
  const base = entryBase(sequence, compiled, previousEntrySha256);
  return { ...base, entry_sha256: canonicalSha256(base) };
}

function sameCompiled(left, right) {
  return left.sha256 === right.sha256 && left.canonical === right.canonical;
}

function validateCatalog(value) {
  const input = plain(value, "invalid_memory_catalog");
  exactKeys(input, ["schema", "entries"], "invalid_memory_catalog_fields");
  if (input.schema !== MEMORY_CATALOG_SCHEMA || !Array.isArray(input.entries)) fail("unsupported_memory_catalog");
  if (input.entries.length > MAX_ENTRIES) fail("memory_catalog_capacity_exceeded");

  const entries = [];
  const latestByMemory = new Map();
  let previousEntrySha256 = null;

  for (let index = 0; index < input.entries.length; index += 1) {
    const raw = plain(input.entries[index], "invalid_memory_catalog_entry");
    exactKeys(raw, [
      "schema", "sequence", "memory_id", "compiled", "previous_entry_sha256", "entry_sha256",
    ], "invalid_memory_catalog_entry_fields");
    if (raw.schema !== MEMORY_CATALOG_ENTRY_SCHEMA || raw.sequence !== index + 1) fail("invalid_memory_catalog_sequence");
    if (raw.previous_entry_sha256 !== previousEntrySha256 || !isSha256(raw.entry_sha256)) fail("memory_catalog_chain_broken");

    let compiled;
    try {
      compiled = validateCompiledMemory(raw.compiled);
    } catch {
      fail("invalid_memory_catalog_record");
    }
    if (raw.memory_id !== compiled.record.memory_id) fail("memory_catalog_identity_mismatch");

    const base = entryBase(raw.sequence, compiled, raw.previous_entry_sha256);
    if (canonicalSha256(base) !== raw.entry_sha256) fail("memory_catalog_entry_tampered");

    const previous = latestByMemory.get(compiled.record.memory_id);
    if (!previous) {
      if (compiled.record.state !== "candidate" || compiled.record.previous_record_sha256 !== null) {
        fail("memory_catalog_candidate_required");
      }
    } else {
      let expected;
      try {
        expected = transitionMemory(previous, {
          to: compiled.record.state,
          at: compiled.record.updated_at,
          consent_ref: compiled.record.consent_ref,
        });
      } catch {
        fail("invalid_memory_catalog_transition");
      }
      if (!sameCompiled(expected, compiled)) fail("forged_memory_catalog_transition");
    }

    const normalized = createEntry(raw.sequence, compiled, raw.previous_entry_sha256);
    entries.push(normalized);
    latestByMemory.set(compiled.record.memory_id, compiled);
    previousEntrySha256 = raw.entry_sha256;
  }

  return { schema: MEMORY_CATALOG_SCHEMA, entries, latestByMemory };
}

async function privateRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("unsafe_memory_catalog_file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("unsafe_memory_catalog_owner");
  if ((stat.mode & 0o077) !== 0) fail("insecure_memory_catalog_permissions");
  if (stat.size > MAX_FILE_BYTES) fail("memory_catalog_too_large");
}

function validateReadBoundary(context) {
  let input;
  try {
    input = validateMemoryReadContext(context);
  } catch {
    fail("invalid_memory_catalog_read_context");
  }
  if (input.owner_authenticated !== true) fail("memory_owner_not_authenticated");
  if (input.channel !== "local_owner_app") fail("private_memory_channel_blocked");
  return input;
}

function activeSummary(compiled) {
  const { record } = compiled;
  return Object.freeze({
    memory_id: record.memory_id,
    category: record.category,
    scope: record.scope,
    purpose: record.purpose,
    confidence_bps: record.confidence_bps,
    source_kind: record.source.kind,
    expires_at: record.expires_at,
    record_sha256: compiled.sha256,
  });
}

export class MemoryCatalogStore {
  constructor(catalogPath) {
    if (typeof catalogPath !== "string" || !isAbsolute(catalogPath)) fail("invalid_memory_catalog_path");
    this.catalogPath = resolve(catalogPath);
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    const directory = dirname(this.catalogPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const canonicalDirectory = await realpath(directory);
    const directoryStat = await lstat(canonicalDirectory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
      fail("unsafe_memory_catalog_directory");
    }
    this.catalogPath = resolve(canonicalDirectory, this.catalogPath.slice(directory.length + 1));
    try {
      await privateRegularFile(this.catalogPath);
      await this.#read();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#write({ schema: MEMORY_CATALOG_SCHEMA, entries: [] });
    }
    this.initialized = true;
  }

  async addCandidate(value) {
    return this.#serialized(async () => {
      const compiled = this.#compiled(value);
      if (compiled.record.state !== "candidate" || compiled.record.previous_record_sha256 !== null) {
        fail("memory_catalog_candidate_required");
      }
      const catalog = await this.#read();
      if (catalog.latestByMemory.has(compiled.record.memory_id)) fail("memory_catalog_identity_exists");
      return this.#append(catalog, compiled);
    });
  }

  async appendTransition(value) {
    return this.#serialized(async () => {
      const compiled = this.#compiled(value);
      const catalog = await this.#read();
      const previous = catalog.latestByMemory.get(compiled.record.memory_id);
      if (!previous) fail("memory_catalog_candidate_missing");
      let expected;
      try {
        expected = transitionMemory(previous, {
          to: compiled.record.state,
          at: compiled.record.updated_at,
          consent_ref: compiled.record.consent_ref,
        });
      } catch {
        fail("invalid_memory_catalog_transition");
      }
      if (!sameCompiled(expected, compiled)) fail("forged_memory_catalog_transition");
      return this.#append(catalog, compiled);
    });
  }

  async latest(memoryId) {
    const catalog = await this.#readReady();
    return catalog.latestByMemory.get(memoryId) ?? null;
  }

  async listActive(context) {
    const readContext = validateReadBoundary(context);
    const catalog = await this.#readReady();
    const matches = [];
    for (const compiled of catalog.latestByMemory.values()) {
      let result;
      try {
        result = evaluateMemoryRead(compiled, readContext);
      } catch {
        fail("invalid_memory_catalog_read_context");
      }
      if (result.decision === "allow") matches.push(activeSummary(compiled));
    }
    return Object.freeze(matches);
  }

  #compiled(value) {
    if (!this.initialized) fail("memory_catalog_not_initialized");
    try {
      return validateCompiledMemory(value);
    } catch {
      fail("invalid_memory_catalog_record");
    }
  }

  async #append(catalog, compiled) {
    if (catalog.entries.length >= MAX_ENTRIES) fail("memory_catalog_capacity_exceeded");
    const previousEntrySha256 = catalog.entries.at(-1)?.entry_sha256 ?? null;
    const entry = createEntry(catalog.entries.length + 1, compiled, previousEntrySha256);
    await this.#write({ schema: MEMORY_CATALOG_SCHEMA, entries: [...catalog.entries, entry] });
    return Object.freeze({
      sequence: entry.sequence,
      memory_id: entry.memory_id,
      record_sha256: compiled.sha256,
      entry_sha256: entry.entry_sha256,
    });
  }

  async #readReady() {
    if (!this.initialized) fail("memory_catalog_not_initialized");
    return this.#read();
  }

  async #read() {
    await privateRegularFile(this.catalogPath);
    const content = await readFile(this.catalogPath, { encoding: "utf8" });
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) fail("memory_catalog_too_large");
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      fail("invalid_memory_catalog_json");
    }
    return validateCatalog(parsed);
  }

  async #write(catalog) {
    const validated = validateCatalog(catalog);
    const persistable = { schema: validated.schema, entries: validated.entries };
    const temporary = `${this.catalogPath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(persistable)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, this.catalogPath);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    await privateRegularFile(this.catalogPath);
  }

  #serialized(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return result;
  }
}
