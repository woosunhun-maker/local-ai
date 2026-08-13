import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const MEMORY_KEY_ID = "local-ai.memory.v1";
export const MEMORY_KEYCHAIN_SERVICE = "local.privateai.memory.encryption";
export const MEMORY_KEYCHAIN_ACCOUNT = "local-ai";

const execFileAsync = promisify(execFile);

function decodeKey(value) {
  if (typeof value !== "string") throw new Error("memory_key_unavailable");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(normalized)) throw new Error("memory_key_invalid");
  const key = Buffer.from(normalized, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== normalized) {
    key.fill(0);
    throw new Error("memory_key_invalid");
  }
  return key;
}

export function createMacOSMemoryKeyProvider({
  run = (file, args, options) => execFileAsync(file, args, options),
} = {}) {
  if (typeof run !== "function") throw new Error("invalid_memory_key_runner");
  let cached = null;

  const provider = async (keyId) => {
    if (keyId !== MEMORY_KEY_ID) throw new Error("unknown_memory_key_id");
    if (cached) return Buffer.from(cached);
    let stdout;
    try {
      ({ stdout } = await run("/usr/bin/security", [
        "find-generic-password",
        "-w",
        "-s", MEMORY_KEYCHAIN_SERVICE,
        "-a", MEMORY_KEYCHAIN_ACCOUNT,
      ], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 1_024,
      }));
    } catch {
      throw new Error("memory_key_unavailable");
    }
    cached = decodeKey(stdout);
    return Buffer.from(cached);
  };

  provider.clear = () => {
    cached?.fill(0);
    cached = null;
  };
  return provider;
}
