import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { PrivateFileLock } from "./private-file-lock.mjs";

const MAX_MESSAGES = 50;
const MAX_CONTENT_LENGTH = 4_000;
const STORE_KEYS = new Set(["messages"]);
const MESSAGE_KEYS = new Set(["id", "content", "createdAt", "deliveredAt"]);

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateStore(value) {
  if (!exactKeys(value, STORE_KEYS) || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) {
    throw new Error("invalid_proactive_store");
  }
  const ids = new Set();
  for (const message of value.messages) {
    if (
      !exactKeys(message, MESSAGE_KEYS) ||
      typeof message.id !== "string" || !/^[A-Za-z0-9_-]{16}$/u.test(message.id) ||
      typeof message.content !== "string" || !message.content.trim() || message.content.length > MAX_CONTENT_LENGTH ||
      !validTimestamp(message.createdAt) ||
      (message.deliveredAt !== null && !validTimestamp(message.deliveredAt)) ||
      ids.has(message.id)
    ) throw new Error("invalid_proactive_store");
    ids.add(message.id);
  }
  return value;
}

export class ProactiveStore {
  constructor(path) {
    if (typeof path !== "string" || !path) throw new TypeError("proactive store path is required");
    this.path = path;
    this.directory = dirname(path);
    this.fileLock = new PrivateFileLock(`${path}.lock`, { errorPrefix: "proactive_store_lock" });
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    await this.fileLock.withLock(async () => {
      try {
        await this.read();
        const details = await lstat(this.path);
        if (!details.isFile() || details.uid !== process.getuid() || details.nlink !== 1) {
          throw new Error("invalid_proactive_store_inode");
        }
        await chmod(this.path, 0o600);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await this.write({ messages: [] });
      }
    });
  }

  async read() {
    return validateStore(JSON.parse(await readFile(this.path, "utf8")));
  }

  async write(value) {
    validateStore(value);
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async enqueue(content) {
    const normalized = String(content ?? "").trim();
    if (!normalized || normalized.length > MAX_CONTENT_LENGTH) {
      throw Object.assign(new Error("invalid_proactive_message"), { statusCode: 400 });
    }

    return this.fileLock.withLock(async () => {
      const data = await this.read();
      const message = {
        id: randomBytes(12).toString("base64url"),
        content: normalized,
        createdAt: new Date().toISOString(),
        deliveredAt: null,
      };
      data.messages.push(message);
      data.messages = data.messages.slice(-MAX_MESSAGES);
      await this.write(data);
      return { id: message.id, createdAt: message.createdAt };
    });
  }

  async consumePending() {
    return this.fileLock.withLock(async () => {
      const data = await this.read();
      const deliveredAt = new Date().toISOString();
      const pending = data.messages
        .filter((message) => !message.deliveredAt)
        .map(({ id, content, createdAt }) => ({ id, content, createdAt }));
      if (pending.length > 0) {
        const ids = new Set(pending.map((message) => message.id));
        for (const message of data.messages) {
          if (ids.has(message.id)) message.deliveredAt = deliveredAt;
        }
        await this.write(data);
      }
      return pending;
    });
  }
}
