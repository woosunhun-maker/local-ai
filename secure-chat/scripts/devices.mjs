#!/opt/homebrew/bin/node

import { AuthStore } from "../src/auth-store.mjs";

const store = new AuthStore("/Users/hun/PrivateAI/data/secure-chat/auth.json");
await store.initialize();

if (process.argv.length === 3 && process.argv[2] === "--list") {
  const devices = await store.listDevices();
  console.log(JSON.stringify(devices.map((device) => ({
    id: device.id,
    name: device.name,
    role: device.role,
    scopes: device.scopes,
    createdAt: device.createdAt ? new Date(device.createdAt).toISOString() : null,
    lastSeenAt: device.lastSeenAt ? new Date(device.lastSeenAt).toISOString() : null,
    status: device.revokedAt ? "revoked" : "active",
  })), null, 2));
} else if (process.argv.length === 3 && process.argv[2] === "--revoke-all") {
  const revoked = await store.revokeAllDevices();
  console.log(JSON.stringify({ revoked, pendingPairingsCleared: true }));
} else {
  console.error("사용법: devices.mjs --list | --revoke-all");
  process.exitCode = 12;
}
