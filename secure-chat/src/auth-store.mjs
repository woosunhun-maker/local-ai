import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { PrivateFileLock } from "./private-file-lock.mjs";

export const DEVICE_ROLES = Object.freeze(["member", "owner"]);
export const DEVICE_SCOPES = Object.freeze(["status", "chat", "approvals"]);
const MEMBER_SCOPES = Object.freeze(["chat", "status"]);
const OWNER_SCOPES = Object.freeze(["approvals", "chat", "status"]);
const EMPTY_STORE = Object.freeze({ version: 2, pairings: [], devices: [] });

export function tokenHash(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function safeHashEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function scopesForRole(role) {
  if (role === "member") return [...MEMBER_SCOPES];
  if (role === "owner") return [...OWNER_SCOPES];
  throw new TypeError("invalid_device_role");
}

function validateRoleAndScopes(role, scopes) {
  if (!DEVICE_ROLES.includes(role) || !Array.isArray(scopes)) throw new Error("invalid_device_authorization");
  const expected = scopesForRole(role);
  if (scopes.length !== expected.length || scopes.some((scope, index) => scope !== expected[index])) {
    throw new Error("invalid_device_scopes");
  }
}

function validateStore(store) {
  if (store?.version !== 2 || !Array.isArray(store.pairings) || !Array.isArray(store.devices)) {
    throw new Error("인증 저장소 형식이 올바르지 않습니다.");
  }
  for (const pairing of store.pairings) {
    validateRoleAndScopes(pairing.role, pairing.scopes);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(pairing.id) || !/^[a-f0-9]{64}$/.test(pairing.tokenHash) || !Number.isFinite(pairing.createdAt) || !Number.isFinite(pairing.expiresAt)) {
      throw new Error("invalid_pairing_record");
    }
  }
  for (const device of store.devices) {
    validateRoleAndScopes(device.role, device.scopes);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(device.id) || typeof device.name !== "string" || !/^[a-f0-9]{64}$/.test(device.tokenHash) || !Number.isFinite(device.createdAt)) {
      throw new Error("invalid_device_record");
    }
  }
  return store;
}

function migrateV1(store) {
  if (store?.version !== 1 || !Array.isArray(store.pairings) || !Array.isArray(store.devices)) {
    throw new Error("인증 저장소 형식이 올바르지 않습니다.");
  }
  return validateStore({
    version: 2,
    pairings: store.pairings.map((entry) => ({ ...entry, role: "member", scopes: [...MEMBER_SCOPES] })),
    devices: store.devices.map((entry) => ({ ...entry, role: "member", scopes: [...MEMBER_SCOPES] })),
  });
}

export class AuthStore {
  constructor(path) {
    this.path = path;
    this.directory = path.slice(0, path.lastIndexOf("/"));
    this.lockPath = `${path}.lock`;
    this.fileLock = new PrivateFileLock(this.lockPath, { errorPrefix: "auth_store_lock" });
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.withLock(async () => {
      try {
        const parsed = JSON.parse(await readFile(this.path, "utf8"));
        if (parsed?.version === 1) await this.write(migrateV1(parsed));
        else validateStore(parsed);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await this.write(EMPTY_STORE);
      }
    });
  }

  async read() {
    return validateStore(JSON.parse(await readFile(this.path, "utf8")));
  }

  async write(value) {
    validateStore(value);
    const temporary = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  async withLock(operation) {
    return this.fileLock.withLock(operation);
  }

  async createPairing(ttlMs = 5 * 60 * 1000, { role = "member" } = {}) {
    const scopes = scopesForRole(role);
    return this.withLock(async () => {
      const store = await this.read();
      const now = Date.now();
      const secret = randomToken();
      const id = randomToken(12);
      store.pairings = store.pairings.filter((entry) => !entry.usedAt && entry.expiresAt > now);
      store.pairings.push({ id, tokenHash: tokenHash(secret), createdAt: now, expiresAt: now + ttlMs, usedAt: null, role, scopes });
      await this.write(store);
      return { id, secret, expiresAt: now + ttlMs, role, scopes: [...scopes] };
    });
  }

  async claimPairing(secret, deviceName) {
    return this.withLock(async () => {
      const store = await this.read();
      const now = Date.now();
      const suppliedHash = tokenHash(secret);
      const pairing = store.pairings.find((entry) => !entry.usedAt && entry.expiresAt > now && safeHashEqual(entry.tokenHash, suppliedHash));
      if (!pairing) return null;
      pairing.usedAt = now;
      const deviceToken = randomToken();
      const normalizedName = String(deviceName).trim().slice(0, 60);
      if (!normalizedName) throw new TypeError("invalid_device_name");
      const device = {
        id: randomToken(12),
        name: normalizedName,
        tokenHash: tokenHash(deviceToken),
        role: pairing.role,
        scopes: [...pairing.scopes],
        createdAt: now,
        lastSeenAt: now,
        revokedAt: null,
      };
      store.devices.push(device);
      await this.write(store);
      return { deviceId: device.id, deviceToken, role: device.role, scopes: [...device.scopes] };
    });
  }

  async authenticate(token) {
    if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;
    const store = await this.read();
    const suppliedHash = tokenHash(token);
    const device = store.devices.find((entry) => !entry.revokedAt && safeHashEqual(entry.tokenHash, suppliedHash));
    return device ? { id: device.id, name: device.name, role: device.role, scopes: [...device.scopes] } : null;
  }

  async listDevices() {
    const store = await this.read();
    return store.devices.map(({ id, name, role, scopes, createdAt, lastSeenAt, revokedAt }) => ({
      id,
      name,
      role,
      scopes: [...scopes],
      createdAt,
      lastSeenAt,
      revokedAt,
    }));
  }

  async revokeAllDevices() {
    return this.withLock(async () => {
      const store = await this.read();
      const now = Date.now();
      let revoked = 0;
      for (const device of store.devices) {
        if (!device.revokedAt) {
          device.revokedAt = now;
          revoked += 1;
        }
      }
      store.pairings = [];
      await this.write(store);
      return revoked;
    });
  }
}
