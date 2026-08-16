/**
 * 같은 집 와이파이에서 「이 맥에 연결」을 누르면, 맥이 허용할 때까지 기다린다.
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const JOIN_SCHEMA = "local-ai.join.v1";
const TTL_MS = 10 * 60 * 1000;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function nowIso() {
  return new Date().toISOString();
}

export class JoinStore {
  constructor(filePath) {
    if (typeof filePath !== "string" || !resolve(filePath).startsWith("/")) fail("invalid_join_path");
    this.path = resolve(filePath);
    this.initialized = false;
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#write({ schema: JOIN_SCHEMA, requests: [] });
    }
    this.initialized = true;
    return this;
  }

  async request(deviceName) {
    const name = String(deviceName ?? "").trim().slice(0, 60) || "기기";
    const state = await this.#read();
    this.#expire(state);
    const item = {
      id: randomUUID(),
      deviceName: name,
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      token: null,
    };
    state.requests.push(item);
    await this.#write(state);
    return { id: item.id, expiresAt: item.expiresAt };
  }

  async pending() {
    const state = await this.#read();
    this.#expire(state);
    await this.#write(state);
    return state.requests
      .filter((item) => !item.token)
      .map((item) => ({ id: item.id, deviceName: item.deviceName, createdAt: item.createdAt }));
  }

  async allow(id, deviceToken) {
    const token = String(deviceToken ?? "");
    if (token.length < 16) fail("invalid_join_token");
    const state = await this.#read();
    this.#expire(state);
    const item = state.requests.find((entry) => entry.id === id);
    if (!item) fail("join_not_found", 404);
    item.token = token;
    await this.#write(state);
    return { ok: true, id };
  }

  async wait(id) {
    const state = await this.#read();
    this.#expire(state);
    const item = state.requests.find((entry) => entry.id === id);
    if (!item) fail("join_not_found", 404);
    if (item.token) return { status: "ready", deviceToken: item.token };
    return { status: "pending" };
  }

  #expire(state) {
    const now = Date.now();
    state.requests = state.requests.filter((item) => Date.parse(item.expiresAt) > now);
  }

  async #read() {
    if (!this.initialized) fail("join_not_initialized", 500);
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== JOIN_SCHEMA || !Array.isArray(raw.requests)) fail("invalid_join_file", 500);
    return raw;
  }

  async #write(data) {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }
}
