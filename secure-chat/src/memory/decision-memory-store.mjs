/**
 * Decision Memory — 의논 후 확정된 결정.
 * 확인형 사용자 기억(memory.json)과 파일을 분리한다. 자동 active 승격 없음.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const DECISION_STORE_SCHEMA = "local-ai.decision-memory.v1";
const MAX_ITEMS = 200;
const FORBIDDEN = /비밀번호|패스워드|password|otp|인증번호|주민등록|계좌|카드번호/iu;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function boundedText(value, field, max) {
  if (typeof value !== "string") fail(`invalid_decision_${field}`);
  const text = value.trim();
  if (text.length < 1 || text.length > max) fail(`invalid_decision_${field}`);
  if (FORBIDDEN.test(text)) fail("forbidden_sensitive_decision");
  return text;
}

function publicItem(item) {
  return Object.freeze({
    id: item.id,
    decision: item.decision,
    reason: item.reason,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    confirmed_at: item.confirmed_at,
  });
}

export class DecisionMemoryStore {
  constructor(path, { now = () => Date.now() } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) fail("invalid_decision_path");
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
      await this.write({ version: 1, schema: DECISION_STORE_SCHEMA, items: [] });
    }
    return this;
  }

  async read() {
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== DECISION_STORE_SCHEMA || !Array.isArray(raw.items)) fail("invalid_decision_store", 500);
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

  async propose({ decision, reason }) {
    return this.serialized(async () => {
      const store = await this.read();
      const at = new Date(this.now()).toISOString();
      const item = {
        id: randomUUID(),
        decision: boundedText(decision, "decision", 1_000),
        reason: boundedText(reason ?? "이유 미기재", "reason", 2_000),
        status: "candidate",
        created_at: at,
        updated_at: at,
        confirmed_at: null,
      };
      store.items.push(item);
      store.items = store.items.slice(-MAX_ITEMS);
      await this.write(store);
      return publicItem(item);
    });
  }

  async confirm(id) {
    return this.serialized(async () => {
      const store = await this.read();
      const target = store.items.find((item) => item.id === id);
      if (!target) fail("decision_not_found", 404);
      const at = new Date(this.now()).toISOString();
      target.status = "active";
      target.updated_at = at;
      target.confirmed_at = at;
      await this.write(store);
      return publicItem(target);
    });
  }

  async listActive() {
    const store = await this.read();
    return Object.freeze(store.items.filter((item) => item.status === "active").map(publicItem));
  }

  async listCandidates() {
    const store = await this.read();
    return Object.freeze(store.items.filter((item) => item.status === "candidate").map(publicItem));
  }
}
