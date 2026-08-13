import { PrivateFileLock } from "../../src/private-file-lock.mjs";

const path = process.argv[2];
if (!path) process.exit(0);
const lock = new PrivateFileLock(path, { retryAttempts: 1, errorPrefix: "fixture_lock" });
const lease = await lock.acquire();
process.stdout.write("ready\n");

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await lease.release();
  process.exit(0);
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
setInterval(() => {}, 1_000);
