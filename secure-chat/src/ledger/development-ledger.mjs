/**
 * Development Ledger — AI/시스템 자체 변경 이력.
 * 자동 배포·자동 커밋을 수행하지 않는다. 기록만 한다.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const DEVELOPMENT_LEDGER_SCHEMA = "local-ai.development-ledger.v1";
const MAX_ENTRIES = 500;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function boundedText(value, field, max) {
  if (typeof value !== "string") fail(`invalid_ledger_${field}`);
  const text = value.trim();
  if (text.length < 1 || text.length > max) fail(`invalid_ledger_${field}`);
  return text;
}

function publicEntry(entry) {
  return Object.freeze({
    change_id: entry.change_id,
    request: entry.request,
    proposed_by: entry.proposed_by,
    approved_by: entry.approved_by,
    files_changed: Object.freeze([...(entry.files_changed ?? [])]),
    tests: entry.tests,
    verification: entry.verification,
    rollback_reference: entry.rollback_reference,
    timestamp: entry.timestamp,
  });
}

export class DevelopmentLedgerStore {
  constructor(path, { now = () => Date.now() } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) fail("invalid_ledger_path");
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
      await this.write({ version: 1, schema: DEVELOPMENT_LEDGER_SCHEMA, entries: [] });
    }
    return this;
  }

  async read() {
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== DEVELOPMENT_LEDGER_SCHEMA || !Array.isArray(raw.entries)) {
      fail("invalid_development_ledger", 500);
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

  async record({
    request,
    proposedBy,
    approvedBy = null,
    filesChanged = [],
    tests = null,
    verification = null,
    rollbackReference = null,
  } = {}) {
    return this.serialized(async () => {
      const store = await this.read();
      const files = (Array.isArray(filesChanged) ? filesChanged : [])
        .slice(0, 200)
        .map((file) => boundedText(String(file), "file", 300));
      const entry = {
        change_id: randomUUID(),
        request: boundedText(request, "request", 2_000),
        proposed_by: boundedText(proposedBy, "proposed_by", 120),
        approved_by: approvedBy == null ? null : boundedText(approvedBy, "approved_by", 120),
        files_changed: files,
        tests: tests == null ? null : boundedText(String(tests), "tests", 500),
        verification: verification == null ? null : boundedText(String(verification), "verification", 500),
        rollback_reference: rollbackReference == null
          ? null
          : boundedText(String(rollbackReference), "rollback_reference", 300),
        timestamp: new Date(this.now()).toISOString(),
      };
      store.entries.push(entry);
      store.entries = store.entries.slice(-MAX_ENTRIES);
      await this.write(store);
      return publicEntry(entry);
    });
  }

  async list({ limit = 50 } = {}) {
    const store = await this.read();
    const capped = Math.min(Math.max(1, Number(limit) || 50), 100);
    return Object.freeze([...store.entries].reverse().slice(0, capped).map(publicEntry));
  }
}
