import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalizeJson, deepFreeze } from "./canonical.mjs";
import { validateProposalRecord } from "./proposal.mjs";

function validateProposalId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new TypeError("proposal id is invalid");
}

export class GrowthProposalStore {
  constructor(rootPath) {
    if (typeof rootPath !== "string" || !rootPath.trim()) throw new TypeError("proposal store path is required");
    this.rootPath = resolve(rootPath);
    this.lockPath = join(this.rootPath, ".store.lock");
  }

  async initialize() {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
  }

  proposalDirectory(proposalId) {
    validateProposalId(proposalId);
    return join(this.rootPath, proposalId);
  }

  async withLock(operation) {
    let handle;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST" || attempt === 79) throw error;
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
    }
    try {
      return await operation();
    } finally {
      await handle?.close();
      await unlink(this.lockPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async readLatest(proposalId) {
    const directory = this.proposalDirectory(proposalId);
    try {
      const record = JSON.parse(await readFile(join(directory, "current.json"), "utf8"));
      validateProposalRecord(record);
      if (record.id !== proposalId) throw new Error("proposal store id mismatch");
      return deepFreeze(record);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async listLatest({ limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError("proposal list limit is invalid");
    const entries = await readdir(this.rootPath, { withFileTypes: true });
    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{16,128}$/.test(entry.name)) continue;
      const record = await this.readLatest(entry.name);
      if (record) records.push(record);
    }
    return records
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, limit);
  }

  async append(record) {
    validateProposalRecord(record);
    return this.withLock(async () => {
      const directory = this.proposalDirectory(record.id);
      const recordsDirectory = join(directory, "records");
      await mkdir(recordsDirectory, { recursive: true, mode: 0o700 });
      const current = await this.readLatest(record.id);
      if (!current) {
        if (record.recordVersion !== 1 || record.previousRecordSha256 !== null) {
          throw new Error("proposal store requires an initial record");
        }
      } else if (
        record.recordVersion !== current.recordVersion + 1 ||
        record.previousRecordSha256 !== current.integrity.recordSha256
      ) {
        throw new Error("proposal store rejected a stale or disconnected record");
      }

      const serialized = `${canonicalizeJson(record)}\n`;
      const recordName = `record-${String(record.recordVersion).padStart(6, "0")}-${record.integrity.recordSha256}.json`;
      const recordPath = join(recordsDirectory, recordName);
      try {
        await writeFile(recordPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST" || (await readFile(recordPath, "utf8")) !== serialized) throw error;
      }

      const temporaryPath = join(directory, `.current.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
      await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporaryPath, join(directory, "current.json"));
      return Object.freeze({
        proposalId: record.id,
        recordVersion: record.recordVersion,
        recordSha256: record.integrity.recordSha256,
        recordPath,
      });
    });
  }
}
