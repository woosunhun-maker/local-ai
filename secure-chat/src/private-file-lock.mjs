import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";

const LOCKF_PATH = "/usr/bin/lockf";
const LOCKF_ARGS = Object.freeze(["-s", "-t", "1", "3"]);
const LOCK_BUSY_EXIT = 75;

function lockError(prefix, suffix) {
  return Object.assign(new Error(`${prefix}_${suffix}`), { statusCode: 503 });
}

function exactPrivateDirectory(details) {
  return details.isDirectory() &&
    details.uid === process.getuid() &&
    (details.mode & 0o777) === 0o700;
}

function exactPrivateRegularFile(details) {
  return details.isFile() &&
    details.uid === process.getuid() &&
    (details.mode & 0o777) === 0o600 &&
    details.nlink === 1;
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class PrivateFileLock {
  constructor(path, {
    retryAttempts = 3,
    retryDelayMs = 25,
    errorPrefix = "private_file_lock",
  } = {}) {
    if (typeof path !== "string" || !path) throw new TypeError("private file lock path is required");
    if (!Number.isSafeInteger(retryAttempts) || retryAttempts < 1 || retryAttempts > 10) {
      throw new TypeError("invalid private file lock retry count");
    }
    if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 1_000) {
      throw new TypeError("invalid private file lock retry delay");
    }
    if (typeof errorPrefix !== "string" || !/^[a-z0-9_]{1,48}$/u.test(errorPrefix)) {
      throw new TypeError("invalid private file lock error prefix");
    }
    this.path = path;
    this.directory = dirname(path);
    this.retryAttempts = retryAttempts;
    this.retryDelayMs = retryDelayMs;
    this.errorPrefix = errorPrefix;
  }

  async assertPrivateDirectory() {
    let details;
    try {
      details = await lstat(this.directory);
    } catch {
      throw lockError(this.errorPrefix, "directory_invalid");
    }
    if (!exactPrivateDirectory(details)) throw lockError(this.errorPrefix, "directory_invalid");
  }

  async lockfStatus(fd) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let child;
      try {
        child = spawn(LOCKF_PATH, LOCKF_ARGS, {
          shell: false,
          stdio: ["ignore", "ignore", "ignore", fd],
        });
      } catch {
        finish(null);
        return;
      }
      child.once("error", () => finish(null));
      child.once("exit", (code, signal) => finish(signal === null ? code : null));
    });
  }

  async openCandidate() {
    await this.assertPrivateDirectory();
    let handle;
    try {
      handle = await open(
        this.path,
        constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      const details = await handle.stat();
      if (!exactPrivateRegularFile(details)) throw lockError(this.errorPrefix, "inode_invalid");
      return { handle, details };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.message?.startsWith(`${this.errorPrefix}_`)) throw error;
      throw lockError(this.errorPrefix, "inode_invalid");
    }
  }

  async acquire() {
    for (let attempt = 0; attempt < this.retryAttempts; attempt += 1) {
      const candidate = await this.openCandidate();
      const status = await this.lockfStatus(candidate.handle.fd);
      if (status === LOCK_BUSY_EXIT) {
        await candidate.handle.close();
        if (attempt === this.retryAttempts - 1) throw lockError(this.errorPrefix, "locked");
        await delay(this.retryDelayMs);
        continue;
      }
      if (status !== 0) {
        await candidate.handle.close();
        throw lockError(this.errorPrefix, "kernel_lock_failed");
      }

      try {
        const [held, pathname] = await Promise.all([
          candidate.handle.stat(),
          lstat(this.path),
          this.assertPrivateDirectory(),
        ]);
        if (
          !exactPrivateRegularFile(held) ||
          !exactPrivateRegularFile(pathname) ||
          !sameInode(candidate.details, held) ||
          !sameInode(held, pathname)
        ) throw lockError(this.errorPrefix, "pathname_changed");

        // Convert legacy metadata locks only after the kernel lock and exact
        // pathname identity are held. Lock files remain content-free at rest.
        await candidate.handle.truncate(0);
        await candidate.handle.sync();
        const [normalized, finalPathname] = await Promise.all([
          candidate.handle.stat(),
          lstat(this.path),
          this.assertPrivateDirectory(),
        ]);
        if (
          !exactPrivateRegularFile(normalized) ||
          !exactPrivateRegularFile(finalPathname) ||
          normalized.size !== 0 ||
          !sameInode(held, normalized) ||
          !sameInode(normalized, finalPathname)
        ) {
          throw lockError(this.errorPrefix, "inode_invalid");
        }

        let released = false;
        return Object.freeze({
          release: async () => {
            if (released) return;
            released = true;
            await candidate.handle.close();
          },
        });
      } catch (error) {
        await candidate.handle.close().catch(() => {});
        if (error?.message?.startsWith(`${this.errorPrefix}_`)) throw error;
        throw lockError(this.errorPrefix, "pathname_changed");
      }
    }
    throw lockError(this.errorPrefix, "locked");
  }

  async withLock(operation) {
    if (typeof operation !== "function") throw new TypeError("private file lock operation is required");
    const lease = await this.acquire();
    try {
      return await operation();
    } finally {
      await lease.release();
    }
  }
}
