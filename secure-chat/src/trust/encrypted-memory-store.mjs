import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  canonicalSha256,
  canonicalizeJson,
  isSha256,
  sha256Hex,
} from "../growth/canonical.mjs";
import {
  evaluateMemoryRead,
  validateCompiledMemory,
} from "./memory-firewall.mjs";

export const ENCRYPTED_MEMORY_PAYLOAD_SCHEMA = "local-ai.encrypted-memory-payload.v1";

const ALGORITHM = "aes-256-gcm";
const MAX_PLAINTEXT_BYTES = 16 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class EncryptedMemoryStoreError extends Error {
  constructor(code) {
    super(code);
    this.name = "EncryptedMemoryStoreError";
    this.code = code;
  }
}

function fail(code) {
  throw new EncryptedMemoryStoreError(code);
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

function boundedBase64Url(value, code, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !BASE64URL.test(value)) fail(code);
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    fail(code);
  }
  if (decoded.toString("base64url") !== value) fail(code);
  return decoded;
}

function timestamp(value, code) {
  if (typeof value !== "string") fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return value;
}

function immutableBinding(record) {
  return {
    schema: "local-ai.memory-payload-binding.v1",
    memory_id: record.memory_id,
    namespace: record.namespace,
    subject_id: record.subject_id,
    category: record.category,
    scope: record.scope,
    purpose: record.purpose,
    value_sha256: record.value_sha256,
    source_sha256: record.source.source_sha256,
    created_at: record.created_at,
    expires_at: record.expires_at,
  };
}

function aadFor(envelope) {
  return canonicalizeJson({
    schema: envelope.schema,
    memory_id: envelope.memory_id,
    namespace: envelope.namespace,
    subject_id: envelope.subject_id,
    binding_sha256: envelope.binding_sha256,
    key_id: envelope.key_id,
    algorithm: envelope.algorithm,
    created_at: envelope.created_at,
  });
}

function validateEnvelope(value) {
  const input = plain(value, "invalid_encrypted_memory_payload");
  exactKeys(input, [
    "schema", "memory_id", "namespace", "subject_id", "binding_sha256", "key_id",
    "algorithm", "nonce", "ciphertext", "tag", "created_at",
  ], "invalid_encrypted_memory_payload_fields");
  if (input.schema !== ENCRYPTED_MEMORY_PAYLOAD_SCHEMA || input.algorithm !== ALGORITHM) fail("unsupported_encrypted_memory_payload");
  if (typeof input.memory_id !== "string" || typeof input.namespace !== "string" || typeof input.subject_id !== "string") {
    fail("invalid_encrypted_memory_identity");
  }
  if (!isSha256(input.binding_sha256) || typeof input.key_id !== "string" || !KEY_ID.test(input.key_id)) fail("invalid_encrypted_memory_binding");
  const nonce = boundedBase64Url(input.nonce, "invalid_encrypted_memory_nonce", 16, 16);
  const ciphertext = boundedBase64Url(input.ciphertext, "invalid_encrypted_memory_ciphertext", 1, 32 * 1024);
  const tag = boundedBase64Url(input.tag, "invalid_encrypted_memory_tag", 22, 22);
  if (nonce.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_PLAINTEXT_BYTES + 32) fail("invalid_encrypted_memory_encoding");
  return {
    schema: input.schema,
    memory_id: input.memory_id,
    namespace: input.namespace,
    subject_id: input.subject_id,
    binding_sha256: input.binding_sha256,
    key_id: input.key_id,
    algorithm: input.algorithm,
    nonce: input.nonce,
    ciphertext: input.ciphertext,
    tag: input.tag,
    created_at: timestamp(input.created_at, "invalid_encrypted_memory_created_at"),
  };
}

function validateKey(value) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail("invalid_memory_encryption_key");
  const key = Buffer.from(value);
  if (key.length !== 32) {
    key.fill(0);
    fail("invalid_memory_encryption_key");
  }
  return key;
}

async function privateRegularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("unsafe_encrypted_memory_file");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail("unsafe_encrypted_memory_owner");
  if ((stat.mode & 0o077) !== 0) fail("insecure_encrypted_memory_permissions");
}

export class EncryptedMemoryStore {
  constructor(rootPath, {
    keyId = "local-ai.memory.v1",
    keyProvider,
    now = () => new Date().toISOString(),
  } = {}) {
    if (typeof rootPath !== "string" || !resolve(rootPath).startsWith("/")) fail("invalid_encrypted_memory_root");
    if (typeof keyId !== "string" || !KEY_ID.test(keyId)) fail("invalid_memory_key_id");
    if (typeof keyProvider !== "function") fail("memory_key_provider_required");
    this.rootPath = resolve(rootPath);
    this.keyId = keyId;
    this.keyProvider = keyProvider;
    this.now = now;
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    this.rootPath = await realpath(this.rootPath);
    const stat = await lstat(this.rootPath);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail("unsafe_encrypted_memory_root");
    this.initialized = true;
  }

  #path(memoryId) {
    return join(this.rootPath, `${sha256Hex(memoryId)}.json`);
  }

  async create(compiledMemory, value) {
    if (!this.initialized) fail("encrypted_memory_store_not_initialized");
    const { record } = validateCompiledMemory(compiledMemory);
    let canonical;
    try {
      canonical = canonicalizeJson(value);
    } catch {
      fail("invalid_memory_payload_value");
    }
    const plaintext = Buffer.from(canonical, "utf8");
    if (plaintext.length < 1 || plaintext.length > MAX_PLAINTEXT_BYTES) {
      plaintext.fill(0);
      fail("memory_payload_too_large");
    }
    if (canonicalSha256(value) !== record.value_sha256) {
      plaintext.fill(0);
      fail("memory_payload_digest_mismatch");
    }

    try {
      return await this.#serialized(async () => {
        const key = validateKey(await this.keyProvider(this.keyId));
        const nonce = randomBytes(12);
        const bindingSha256 = canonicalSha256(immutableBinding(record));
        const envelopeBase = {
          schema: ENCRYPTED_MEMORY_PAYLOAD_SCHEMA,
          memory_id: record.memory_id,
          namespace: record.namespace,
          subject_id: record.subject_id,
          binding_sha256: bindingSha256,
          key_id: this.keyId,
          algorithm: ALGORITHM,
          created_at: timestamp(this.now(), "invalid_encrypted_memory_created_at"),
        };
        let ciphertext;
        let tag;
        try {
          const cipher = createCipheriv(ALGORITHM, key, nonce);
          cipher.setAAD(Buffer.from(aadFor(envelopeBase), "utf8"));
          ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
          tag = cipher.getAuthTag();
        } finally {
          key.fill(0);
          plaintext.fill(0);
        }
        const envelope = validateEnvelope({
          ...envelopeBase,
          nonce: nonce.toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
          tag: tag.toString("base64url"),
        });
        ciphertext.fill(0);
        tag.fill(0);

        const destination = this.#path(record.memory_id);
        const temporary = join(this.rootPath, `.${sha256Hex(record.memory_id)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
        try {
          await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
          try {
            await link(temporary, destination);
          } catch (error) {
            if (error?.code === "EEXIST") fail("memory_payload_already_exists");
            throw error;
          }
        } finally {
          await unlink(temporary).catch(() => {});
        }
        await privateRegularFile(destination);
        return Object.freeze({
          memory_id: record.memory_id,
          binding_sha256: envelope.binding_sha256,
          created_at: envelope.created_at,
        });
      });
    } finally {
      plaintext.fill(0);
    }
  }

  async read(compiledMemory, context) {
    if (!this.initialized) fail("encrypted_memory_store_not_initialized");
    const compiled = validateCompiledMemory(compiledMemory);
    const access = evaluateMemoryRead(compiled, context);
    if (access.decision !== "allow") fail(access.code);
    const plaintext = await this.#decryptCanonical(compiled);
    try {
      let value;
      try {
        value = JSON.parse(plaintext.toString("utf8"));
      } catch {
        fail("invalid_encrypted_memory_plaintext");
      }
      if (canonicalSha256(value) !== compiled.record.value_sha256) fail("memory_payload_digest_mismatch");
      return value;
    } finally {
      plaintext.fill(0);
    }
  }

  async verify(compiledMemory) {
    if (!this.initialized) fail("encrypted_memory_store_not_initialized");
    const compiled = validateCompiledMemory(compiledMemory);
    const plaintext = await this.#decryptCanonical(compiled);
    try {
      if (sha256Hex(plaintext) !== compiled.record.value_sha256) fail("memory_payload_digest_mismatch");
      return Object.freeze({
        memory_id: compiled.record.memory_id,
        value_sha256: compiled.record.value_sha256,
        binding_sha256: canonicalSha256(immutableBinding(compiled.record)),
      });
    } finally {
      plaintext.fill(0);
    }
  }

  async #decryptCanonical(compiled) {
    const { record } = compiled;
    const path = this.#path(record.memory_id);
    try {
      await privateRegularFile(path);
    } catch (error) {
      if (error?.code === "ENOENT") fail("memory_payload_not_found");
      throw error;
    }
    let envelope;
    try {
      envelope = validateEnvelope(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") fail("memory_payload_not_found");
      if (error instanceof EncryptedMemoryStoreError) throw error;
      fail("invalid_encrypted_memory_payload");
    }
    const expectedBinding = canonicalSha256(immutableBinding(record));
    if (
      envelope.memory_id !== record.memory_id
      || envelope.namespace !== record.namespace
      || envelope.subject_id !== record.subject_id
      || envelope.binding_sha256 !== expectedBinding
      || envelope.key_id !== this.keyId
    ) fail("memory_payload_binding_mismatch");

    const key = validateKey(await this.keyProvider(this.keyId));
    const nonce = Buffer.from(envelope.nonce, "base64url");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
    const tag = Buffer.from(envelope.tag, "base64url");
    let plaintext;
    try {
      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAAD(Buffer.from(aadFor(envelope), "utf8"));
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      fail("memory_payload_authentication_failed");
    } finally {
      key.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
      tag.fill(0);
    }
    return plaintext;
  }

  async #serialized(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return await result;
  }
}
