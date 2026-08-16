import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomInt, randomUUID } from "node:crypto";

export class PairPinStore {
  constructor(filePath) {
    this.path = resolve(filePath);
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#write({ pins: {} });
    }
    return this;
  }

  async issue(secret, ttlMs = 30 * 60 * 1000) {
    const data = await this.#read();
    const now = Date.now();
    for (const [pin, row] of Object.entries(data.pins)) {
      if (row.expiresAt <= now) delete data.pins[pin];
    }
    let pin = "";
    for (let i = 0; i < 20; i += 1) {
      const candidate = String(randomInt(0, 10_000)).padStart(4, "0");
      if (!data.pins[candidate]) {
        pin = candidate;
        break;
      }
    }
    if (!pin) throw Object.assign(new Error("pin_exhausted"), { statusCode: 503 });
    data.pins[pin] = { secret, expiresAt: now + ttlMs };
    await this.#write(data);
    return pin;
  }

  async take(pin) {
    const code = String(pin ?? "").trim();
    if (!/^\d{4}$/.test(code)) return null;
    const data = await this.#read();
    const row = data.pins[code];
    delete data.pins[code];
    await this.#write(data);
    if (!row || row.expiresAt <= Date.now()) return null;
    return row.secret;
  }

  async #read() {
    return JSON.parse(await readFile(this.path, "utf8"));
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
