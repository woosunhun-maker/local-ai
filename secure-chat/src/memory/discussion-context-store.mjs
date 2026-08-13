/**
 * Active Discussion Context — 진행 중 장기 논의/미결.
 * 영구 사용자 사실로 승격하지 않는다. TTL이 지나면 expired.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const DISCUSSION_STORE_SCHEMA = "local-ai.discussion-context.v1";
const MAX_ITEMS = 100;
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1_000;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function boundedText(value, field, max) {
  if (typeof value !== "string") fail(`invalid_discussion_${field}`);
  const text = value.trim();
  if (text.length < 1 || text.length > max) fail(`invalid_discussion_${field}`);
  return text;
}

function publicItem(item) {
  return Object.freeze({
    id: item.id,
    topic: item.topic,
    open_questions: Object.freeze([...(item.open_questions ?? [])]),
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    expires_at: item.expires_at,
  });
}

export class DiscussionContextStore {
  constructor(path, {
    now = () => Date.now(),
    ttlMs = DEFAULT_TTL_MS,
  } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) fail("invalid_discussion_path");
    this.path = path;
    this.now = now;
    this.ttlMs = ttlMs;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await this.read();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.write({ version: 1, schema: DISCUSSION_STORE_SCHEMA, items: [] });
    }
    return this;
  }

  async read() {
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== DISCUSSION_STORE_SCHEMA || !Array.isArray(raw.items)) {
      fail("invalid_discussion_store", 500);
    }
    return raw;
  }

  async write(value) {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
  }

  serialized(work) {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  #expire(store, atMs) {
    for (const item of store.items) {
      if (item.status === "open" && Date.parse(item.expires_at) <= atMs) {
        item.status = "expired";
        item.updated_at = new Date(atMs).toISOString();
      }
    }
  }

  async open({ topic, openQuestions = [] }) {
    return this.serialized(async () => {
      const store = await this.read();
      const atMs = this.now();
      this.#expire(store, atMs);
      const at = new Date(atMs).toISOString();
      const questions = (Array.isArray(openQuestions) ? openQuestions : [])
        .slice(0, 12)
        .map((entry) => boundedText(entry, "open_question", 300));
      const item = {
        id: randomUUID(),
        topic: boundedText(topic, "topic", 500),
        open_questions: questions,
        status: "open",
        created_at: at,
        updated_at: at,
        expires_at: new Date(atMs + this.ttlMs).toISOString(),
      };
      store.items.push(item);
      store.items = store.items.slice(-MAX_ITEMS);
      await this.write(store);
      return publicItem(item);
    });
  }

  async resolve(id) {
    return this.serialized(async () => {
      const store = await this.read();
      const atMs = this.now();
      this.#expire(store, atMs);
      const target = store.items.find((item) => item.id === id);
      if (!target) fail("discussion_not_found", 404);
      target.status = "resolved";
      target.updated_at = new Date(atMs).toISOString();
      await this.write(store);
      return publicItem(target);
    });
  }

  async listOpen() {
    return this.serialized(async () => {
      const store = await this.read();
      const atMs = this.now();
      this.#expire(store, atMs);
      await this.write(store);
      return Object.freeze(store.items.filter((item) => item.status === "open").map(publicItem));
    });
  }
}
