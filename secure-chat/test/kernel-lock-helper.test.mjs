import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PrivateFileLock } from "../src/private-file-lock.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const HELPER = join(ROOT, "scripts", "kernel-lock.zsh");
const HOLDER = join(ROOT, "test", "fixtures", "kernel-lock-holder.zsh");
const NODE_HOLDER = join(ROOT, "test", "fixtures", "private-file-lock-holder.mjs");

async function waitForReady(path, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`lock holder exited early: ${child.exitCode}`);
    try {
      if ((await readFile(path, "utf8")).trim() === "ready") return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("lock holder did not become ready");
}

async function terminateAndWait(child, signal = "SIGTERM", timeoutMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  let timeout;
  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("lock holder termination timeout")), timeoutMs);
      }),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((_, reject) => setTimeout(() => reject(error), timeoutMs)),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test("kernel helper excludes a second process and leaves one persistent private inode", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "local-ai-kernel-lock-")));
  await chmod(directory, 0o700);
  const lockPath = join(directory, "maintenance.lock");
  const readyPath = join(directory, "holder.ready");
  const holder = spawn("/bin/zsh", [HOLDER, HELPER, lockPath, readyPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForReady(readyPath, holder);
    await assert.rejects(
      execFileAsync("/bin/zsh", ["-fc", `source \"$1\"; local_ai_kernel_lock_acquire \"$2\"`, "lock-test", HELPER, lockPath]),
      (error) => error?.code === 1 && /holds the kernel lock/u.test(error.stderr),
    );
  } finally {
    await terminateAndWait(holder);
  }

  await execFileAsync("/bin/zsh", ["-fc", `source \"$1\"; local_ai_kernel_lock_acquire \"$2\"`, "lock-test", HELPER, lockPath]);
  const state = await lstat(lockPath);
  assert.equal(state.isFile(), true);
  assert.equal(state.isSymbolicLink(), false);
  assert.equal(state.mode & 0o777, 0o600);
  assert.equal(state.nlink, 1);
  assert.equal(state.size, 0);
});

test("nested zsh process can reuse inherited fd 9 only for the same inode", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "local-ai-inherited-lock-")));
  await chmod(directory, 0o700);
  const lockPath = join(directory, "maintenance.lock");
  const command = [
    'source "$1"',
    'local_ai_kernel_lock_acquire "$2"',
    '/bin/zsh -fc \'source "$1"; local_ai_kernel_lock_acquire "$2"\' nested "$1" "$2"',
  ].join("; ");
  await execFileAsync("/bin/zsh", ["-fc", command, "lock-test", HELPER, lockPath]);
});

test("helper rejects unsafe parent and lock metadata without removing the path", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "local-ai-unsafe-lock-")));
  const lockPath = join(directory, "maintenance.lock");
  await chmod(directory, 0o755);
  await assert.rejects(
    execFileAsync("/bin/zsh", ["-fc", `source \"$1\"; local_ai_kernel_lock_acquire \"$2\"`, "lock-test", HELPER, lockPath]),
    /private 0700 directory/u,
  );

  await chmod(directory, 0o700);
  await execFileAsync("/usr/bin/touch", [lockPath]);
  await chmod(lockPath, 0o644);
  await assert.rejects(
    execFileAsync("/bin/zsh", ["-fc", `source \"$1\"; local_ai_kernel_lock_acquire \"$2\"`, "lock-test", HELPER, lockPath]),
    /unsafe metadata/u,
  );
  const state = await lstat(lockPath);
  assert.equal(state.mode & 0o777, 0o644);
});

test("helper rejects symlink, FIFO, directory, and multiply-linked lock paths", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "local-ai-lock-types-")));
  await chmod(directory, 0o700);
  const acquire = (path) => execFileAsync(
    "/bin/zsh",
    ["-fc", `source \"$1\"; local_ai_kernel_lock_acquire \"$2\"`, "lock-test", HELPER, path],
  );

  const target = join(directory, "target");
  const symbolic = join(directory, "symbolic.lock");
  await writeFile(target, "", { mode: 0o600 });
  await symlink(target, symbolic);
  await assert.rejects(acquire(symbolic), /unsafe metadata/u);
  assert.equal((await lstat(symbolic)).isSymbolicLink(), true);

  const fifo = join(directory, "fifo.lock");
  await execFileAsync("/usr/bin/mkfifo", [fifo]);
  await chmod(fifo, 0o600);
  await assert.rejects(acquire(fifo), /unsafe metadata/u);
  assert.equal((await lstat(fifo)).isFIFO(), true);

  const nestedDirectory = join(directory, "directory.lock");
  await mkdir(nestedDirectory, { mode: 0o700 });
  await assert.rejects(acquire(nestedDirectory), /unsafe metadata/u);
  assert.equal((await lstat(nestedDirectory)).isDirectory(), true);

  const original = join(directory, "original.lock");
  const hardlink = join(directory, "hardlink.lock");
  await writeFile(original, "", { mode: 0o600 });
  await link(original, hardlink);
  await assert.rejects(acquire(hardlink), /unsafe metadata/u);
  assert.equal((await lstat(original)).nlink, 2);
});

test("an inherited fd 9 for another inode is rejected without replacing either path", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "local-ai-wrong-inherited-lock-")));
  await chmod(directory, 0o700);
  const first = join(directory, "first.lock");
  const second = join(directory, "second.lock");
  await writeFile(second, "", { mode: 0o600 });
  const before = await lstat(second);
  const command = [
    'source "$1"',
    'local_ai_kernel_lock_acquire "$2"',
    'local_ai_kernel_lock_acquire "$3"',
  ].join("; ");
  await assert.rejects(
    execFileAsync("/bin/zsh", ["-fc", command, "lock-test", HELPER, first, second]),
    /different file/u,
  );
  const after = await lstat(second);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, 0);
  assert.equal(after.mode & 0o777, 0o600);
});

test("zsh and Node maintenance locks contend on the same kernel inode", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "local-ai-cross-runtime-lock-")));
  await chmod(directory, 0o700);
  const lockPath = join(directory, "runtime-mutation.lock");
  const readyPath = join(directory, "holder.ready");
  const holder = spawn("/bin/zsh", [HOLDER, HELPER, lockPath, readyPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const nodeLock = new PrivateFileLock(lockPath, {
    retryAttempts: 1,
    retryDelayMs: 0,
    errorPrefix: "runtime_mutation_lock",
  });
  try {
    await waitForReady(readyPath, holder);
    await assert.rejects(nodeLock.acquire(), /runtime_mutation_lock_locked/u);
  } finally {
    await terminateAndWait(holder);
  }
  const lease = await nodeLock.acquire();
  await lease.release();
});

test("a Node holder excludes zsh and zsh recovers after the holder exits", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "local-ai-node-holder-lock-")));
  await chmod(directory, 0o700);
  const lockPath = join(directory, "runtime-mutation.lock");
  const holder = spawn(process.execPath, [NODE_HOLDER, lockPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for await (const chunk of holder.stdout) {
    output += chunk;
    if (output.includes("ready\n")) break;
  }
  assert.match(output, /ready/u);
  const acquire = () => execFileAsync(
    "/bin/zsh",
    ["-fc", `source \"$1\"; local_ai_kernel_lock_acquire \"$2\"`, "lock-test", HELPER, lockPath],
  );
  try {
    await assert.rejects(acquire(), /holds the kernel lock/u);
  } finally {
    await terminateAndWait(holder);
  }
  await acquire();
});

test("pinned TTS installer acquires its dedicated singleton before mutable cleanup or install work", async () => {
  const installerPath = join(ROOT, "scripts", "install-pinned-qwen-tts.sh");
  const [helper, installer] = await Promise.all([
    readFile(HELPER, "utf8"),
    readFile(installerPath, "utf8"),
  ]);
  await Promise.all([
    execFileAsync("/bin/zsh", ["-n", HELPER]),
    execFileAsync("/bin/zsh", ["-n", installerPath]),
  ]);

  assert.match(helper, /\/usr\/bin\/lockf -s -t 0 9/u);
  assert.doesNotMatch(helper, /rm[^\n]*LOCAL_AI_KERNEL_LOCK_PATH/u);
  assert.match(installer, /qwen-tts-install\.lock/u);
  const acquire = installer.indexOf('local_ai_kernel_lock_acquire "$TTS_INSTALL_LOCK"');
  const exitTrap = installer.indexOf("trap cleanup EXIT");
  const firstMutableInstall = installer.indexOf('/bin/mkdir -p "$RUNTIME_ROOT"');
  const firstDownload = installer.indexOf(" -m pip install");
  assert.ok(acquire >= 0 && acquire < exitTrap);
  assert.ok(exitTrap < firstMutableInstall && firstMutableInstall < firstDownload);
  assert.doesNotMatch(installer, /rm[^\n]*TTS_INSTALL_LOCK/u);
});
