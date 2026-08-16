import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { draftLesson } from "./self-consult.mjs";

export const LESSON_STORE_SCHEMA = "local-ai.lessons.v1";
const MAX_ITEMS = 40;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export class LessonStore {
  constructor(path, { now = () => Date.now() } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) fail("invalid_lesson_path");
    this.path = path;
    this.now = now;
    this.queue = Promise.resolve();
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await this.read();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.write({ version: 1, schema: LESSON_STORE_SCHEMA, lastConsultAt: 0, items: [] });
    }
    return this;
  }

  async read() {
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== LESSON_STORE_SCHEMA || !Array.isArray(raw.items)) fail("invalid_lesson_store", 500);
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

  async snapshot() {
    const store = await this.read();
    const today = dayKey(this.now());
    return Object.freeze({
      lastConsultAt: Number(store.lastConsultAt) || 0,
      consultCountToday: store.items.filter((item) => String(item.createdAt ?? "").startsWith(today)).length,
      lessons: store.items.slice(-8).map((item) => Object.freeze({
        topic: item.topic,
        lesson: item.lesson,
      })),
    });
  }

  async remember(question, answer) {
    const drafted = draftLesson(question, answer);
    if (!drafted) return null;
    return this.serialized(async () => {
      const store = await this.read();
      const at = this.now();
      const item = {
        id: randomUUID(),
        topic: drafted.topic,
        lesson: drafted.lesson,
        createdAt: new Date(at).toISOString(),
      };
      store.items.push(item);
      store.items = store.items.slice(-MAX_ITEMS);
      store.lastConsultAt = at;
      await this.write(store);
      return Object.freeze({ topic: item.topic, lesson: item.lesson });
    });
  }
}
