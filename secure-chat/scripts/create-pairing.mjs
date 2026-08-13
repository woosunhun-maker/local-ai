#!/opt/homebrew/bin/node

import { AuthStore } from "../src/auth-store.mjs";

const store = new AuthStore("/Users/hun/PrivateAI/data/secure-chat/auth.json");
await store.initialize();
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--owner")) {
  throw new Error("usage: create-pairing.mjs [--owner]");
}
const role = args[0] === "--owner" ? "owner" : "member";
const pairing = await store.createPairing(undefined, { role });
const baseUrl = process.env.LOCAL_AI_CHAT_PUBLIC_URL ?? "http://127.0.0.1:18791/";
const url = new URL(baseUrl);
url.hash = `pair=${pairing.secret}`;
console.log(JSON.stringify({
  url: url.toString(),
  expiresAt: new Date(pairing.expiresAt).toISOString(),
  role: pairing.role,
  scopes: pairing.scopes,
  note: "이 URL은 5분 내 한 기기에서 한 번만 사용할 수 있습니다.",
}, null, 2));
