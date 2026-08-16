#!/opt/homebrew/bin/node

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { AuthStore } from "../src/auth-store.mjs";

const TOKEN_PATH = "/Users/hun/PrivateAI/data/secure-chat/mac-orb.token";
const AUTH_PATH = "/Users/hun/PrivateAI/data/secure-chat/auth.json";
const PAIR_URL = "http://127.0.0.1:18791/api/pair";

const store = new AuthStore(AUTH_PATH);
await store.initialize();
const pairing = await store.createPairing(undefined, { role: "owner" });
const response = await fetch(PAIR_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret: pairing.secret, deviceName: "Mac Orb" }),
});
if (!response.ok) throw new Error(`mac_orb_pair_failed:${response.status}`);
const claimed = await response.json();
if (typeof claimed?.deviceToken !== "string" || claimed.deviceToken.length < 32) {
  throw new Error("mac_orb_token_invalid");
}
await mkdir("/Users/hun/PrivateAI/data/secure-chat", { recursive: true, mode: 0o700 });
await writeFile(TOKEN_PATH, `${claimed.deviceToken}\n`, { encoding: "utf8", mode: 0o600 });
await chmod(TOKEN_PATH, 0o600);
process.stdout.write(`${JSON.stringify({ ok: true, path: TOKEN_PATH })}\n`);
