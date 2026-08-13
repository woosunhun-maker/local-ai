import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { promisify } from "node:util";
import { PrivateFileLock } from "../src/private-file-lock.mjs";

const execFileAsync = promisify(execFile);
const HOLDER = join(import.meta.dirname, "fixtures", "private-file-lock-holder.mjs");

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-kernel-lock-"));
  await chmod(directory, 0o700);
  return { directory, path: join(directory, "store.lock") };
}

async function waitForLine(child, expected = "ready") {
  let output = "";
  for await (const chunk of child.stdout) {
    output += chunk;
    const line = output.split("\n")[0];
    if (line === expected) return;
  }
  throw new Error("lock holder exited before readiness");
}

test("kernel FD lock remains zero-byte, excludes a second holder, and releases after close or throw", async () => {
  const { path } = await fixture();
  const first = new PrivateFileLock(path, { retryAttempts: 1, errorPrefix: "first_lock" });
  const second = new PrivateFileLock(path, { retryAttempts: 1, errorPrefix: "second_lock" });
  const lease = await first.acquire();
  await assert.rejects(second.acquire(), /second_lock_locked/u);
  await lease.release();
  const next = await second.acquire();
  await next.release();
  const details = await stat(path);
  assert.equal(details.isFile(), true);
  assert.equal(details.mode & 0o777, 0o600);
  assert.equal(details.nlink, 1);
  assert.equal(details.size, 0);

  await assert.rejects(first.withLock(async () => { throw new Error("synthetic-operation-failure"); }), /synthetic-operation-failure/u);
  await second.withLock(async () => {});
});

test("SIGKILL closes the inherited kernel FD and permits a new holder", async (t) => {
  const { path } = await fixture();
  const child = spawn(process.execPath, [HOLDER, path], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  await waitForLine(child);
  const contender = new PrivateFileLock(path, { retryAttempts: 1, errorPrefix: "contender_lock" });
  await assert.rejects(contender.acquire(), /contender_lock_locked/u);
  child.kill("SIGKILL");
  await once(child, "exit");
  const recovered = await contender.acquire();
  await recovered.release();
  assert.equal((await stat(path)).size, 0);
});

test("symlink, FIFO, directory, hardlink, relaxed mode, and relaxed parent are rejected", async (t) => {
  await t.test("symlink", async () => {
    const { directory, path } = await fixture();
    const target = join(directory, "target");
    await writeFile(target, "", { mode: 0o600 });
    await symlink(target, path);
    await assert.rejects(new PrivateFileLock(path).acquire(), /inode_invalid/u);
  });
  await t.test("fifo", async () => {
    const { path } = await fixture();
    await execFileAsync("/usr/bin/mkfifo", [path]);
    await chmod(path, 0o600);
    await assert.rejects(new PrivateFileLock(path).acquire(), /inode_invalid/u);
  });
  await t.test("directory", async () => {
    const { path } = await fixture();
    await mkdir(path, { mode: 0o600 });
    await assert.rejects(new PrivateFileLock(path).acquire(), /inode_invalid/u);
  });
  await t.test("hardlink", async () => {
    const { directory, path } = await fixture();
    const target = join(directory, "target");
    await writeFile(target, "", { mode: 0o600 });
    await link(target, path);
    await assert.rejects(new PrivateFileLock(path).acquire(), /inode_invalid/u);
  });
  await t.test("mode", async () => {
    const { path } = await fixture();
    await writeFile(path, "", { mode: 0o644 });
    await assert.rejects(new PrivateFileLock(path).acquire(), /inode_invalid/u);
  });
  await t.test("parent", async () => {
    const { directory, path } = await fixture();
    await chmod(directory, 0o755);
    await assert.rejects(new PrivateFileLock(path).acquire(), /directory_invalid/u);
  });
});

test("pathname swap while waiting never runs the operation and preserves the replacement", async (t) => {
  const { directory, path } = await fixture();
  await writeFile(path, "legacy", { mode: 0o600 });
  const holder = spawn(process.execPath, [HOLDER, path], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL"); });
  await waitForLine(holder);

  let operationRan = false;
  const lock = new PrivateFileLock(path, { retryAttempts: 1, errorPrefix: "swap_lock" });
  const pending = lock.withLock(async () => { operationRan = true; });
  const rejected = assert.rejects(pending, /swap_lock_pathname_changed/u);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const retired = join(directory, "retired.lock");
  await rename(path, retired);
  await writeFile(path, "replacement", { mode: 0o600, flag: "wx" });
  holder.kill("SIGTERM");
  await once(holder, "exit");

  await rejected;
  assert.equal(operationRan, false);
  assert.equal(await readFile(path, "utf8"), "replacement");
  assert.equal((await lstat(path)).isFile(), true);
});

test("an abnormal lockf result fails closed before the operation", async () => {
  const { path } = await fixture();
  const lock = new PrivateFileLock(path, { retryAttempts: 1, errorPrefix: "abnormal_lock" });
  lock.lockfStatus = async () => 70;
  let operationRan = false;
  await assert.rejects(lock.withLock(async () => { operationRan = true; }), /abnormal_lock_kernel_lock_failed/u);
  assert.equal(operationRan, false);
  assert.equal((await stat(path)).size, 0);
});
