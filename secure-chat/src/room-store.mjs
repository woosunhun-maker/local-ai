/**
 * 문(아이폰·맥·윈도우)은 여럿이어도 방과 일은 맥에 하나만 둔다.
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const ROOM_SCHEMA = "local-ai.room.v1";
const MAX_MESSAGES = 200;
const MAX_JOBS = 80;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function nowIso() {
  return new Date().toISOString();
}

function emptyRoom() {
  return {
    schema: ROOM_SCHEMA,
    messages: [],
    jobs: [],
    updatedAt: nowIso(),
  };
}

export class RoomStore {
  constructor(filePath) {
    if (typeof filePath !== "string" || !resolve(filePath).startsWith("/")) {
      fail("invalid_room_path");
    }
    this.path = resolve(filePath);
    this.initialized = false;
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#write(emptyRoom());
    }
    this.initialized = true;
    return this;
  }

  async snapshot() {
    return this.#read();
  }

  async clear() {
    await this.#write(emptyRoom());
    return this.#read();
  }

  async addUser(text) {
    const content = String(text ?? "").trim().slice(0, 8_000);
    if (!content) fail("empty_room_message");
    const room = await this.#read();
    const message = { id: randomUUID(), role: "user", content, at: nowIso() };
    const job = {
      id: randomUUID(),
      title: content.slice(0, 48),
      status: "running",
      label: "하는 중",
      at: nowIso(),
    };
    room.messages.push(message);
    room.jobs.push(job);
    this.#trim(room);
    room.updatedAt = nowIso();
    await this.#write(room);
    return { room, message, job };
  }

  async finishJob(jobId, { ok, answer }) {
    const room = await this.#read();
    const job = room.jobs.find((item) => item.id === jobId);
    if (!job) fail("room_job_not_found", 404);
    job.status = ok ? "done" : "failed";
    job.label = ok ? "끝남" : "실패";
    job.at = nowIso();
    if (typeof answer === "string" && answer.trim()) {
      room.messages.push({
        id: randomUUID(),
        role: "assistant",
        content: answer.trim().slice(0, 16_000),
        at: nowIso(),
      });
    }
    this.#trim(room);
    room.updatedAt = nowIso();
    await this.#write(room);
    return room;
  }

  #trim(room) {
    if (room.messages.length > MAX_MESSAGES) room.messages = room.messages.slice(-MAX_MESSAGES);
    if (room.jobs.length > MAX_JOBS) room.jobs = room.jobs.slice(-MAX_JOBS);
  }

  async #read() {
    if (!this.initialized) fail("room_not_initialized", 500);
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== ROOM_SCHEMA || !Array.isArray(raw.messages) || !Array.isArray(raw.jobs)) {
      fail("invalid_room_file", 500);
    }
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
