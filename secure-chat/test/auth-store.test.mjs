import assert from "node:assert/strict";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStore } from "../src/auth-store.mjs";

test("auth store uses the same persistent content-free kernel lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-auth-lock-"));
  const path = join(directory, "auth.json");
  const store = new AuthStore(path);
  await store.initialize();
  const details = await stat(`${path}.lock`);
  assert.equal(details.isFile(), true);
  assert.equal(details.mode & 0o777, 0o600);
  assert.equal(details.size, 0);
});

test("auth store serializes concurrent pairing writers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-auth-concurrent-"));
  const path = join(directory, "auth.json");
  const first = new AuthStore(path);
  const second = new AuthStore(path);
  await first.initialize();
  await second.initialize();
  await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 === 0 ? first : second).createPairing(60_000)));
  assert.equal((await first.read()).pairings.length, 8);
});

test("concurrent first initialization cannot overwrite a completed auth mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-auth-init-race-"));
  const path = join(directory, "auth.json");
  const first = new AuthStore(path);
  const second = new AuthStore(path);
  const originalWrite = first.write.bind(first);
  let releaseWrite;
  const release = new Promise((resolve) => { releaseWrite = resolve; });
  let enteredWrite;
  const entered = new Promise((resolve) => { enteredWrite = resolve; });
  let paused = false;
  first.write = async (value) => {
    if (!paused && value?.version === 2 && value.pairings?.length === 0) {
      paused = true;
      enteredWrite();
      await release;
    }
    return originalWrite(value);
  };

  const firstInitialization = first.initialize();
  await entered;
  const secondFlow = (async () => {
    await second.initialize();
    return second.createPairing(60_000);
  })();
  releaseWrite();
  await Promise.all([firstInitialization, secondFlow]);
  assert.equal((await first.read()).pairings.length, 1);
});

test("pairing secret is single-use and creates an authenticated device", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-auth-"));
  const store = new AuthStore(join(directory, "auth.json"));
  await store.initialize();
  const pairing = await store.createPairing(60_000);
  const claimed = await store.claimPairing(pairing.secret, "Test iPhone");
  assert.ok(claimed?.deviceToken);
  assert.equal(await store.claimPairing(pairing.secret, "Second device"), null);
  assert.deepEqual(await store.authenticate(claimed.deviceToken), {
    id: claimed.deviceId,
    name: "Test iPhone",
    role: "member",
    scopes: ["chat", "status"],
  });
  assert.equal(await store.authenticate("wrong-token-that-is-long-enough-to-pass-length-check"), null);
  assert.equal((await store.listDevices()).length, 1);
  assert.equal(await store.revokeAllDevices(), 1);
  assert.equal(await store.authenticate(claimed.deviceToken), null);
});

test("owner approval scope is granted only by an explicitly owner-scoped pairing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-auth-owner-"));
  const store = new AuthStore(join(directory, "auth.json"));
  await store.initialize();
  const memberPairing = await store.createPairing(60_000);
  const ownerPairing = await store.createPairing(60_000, { role: "owner" });
  const member = await store.claimPairing(memberPairing.secret, "Member iPhone");
  const owner = await store.claimPairing(ownerPairing.secret, "Owner iPhone");
  assert.equal((await store.authenticate(member.deviceToken)).scopes.includes("approvals"), false);
  assert.deepEqual((await store.authenticate(owner.deviceToken)).scopes, ["approvals", "chat", "status"]);
});

test("v1 migration never promotes an existing device or pairing to owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-auth-migration-"));
  const path = join(directory, "auth.json");
  await writeFile(path, JSON.stringify({
    version: 1,
    pairings: [{ id: "SYNTHETICPAIRING1", tokenHash: "a".repeat(64), createdAt: 1, expiresAt: 2, usedAt: null }],
    devices: [{ id: "SYNTHETICDEVICE1", name: "Existing", tokenHash: "b".repeat(64), createdAt: 1, lastSeenAt: 1, revokedAt: null }],
  }));
  const store = new AuthStore(path);
  await store.initialize();
  const migrated = await store.read();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.devices[0].role, "member");
  assert.deepEqual(migrated.devices[0].scopes, ["chat", "status"]);
  assert.equal(migrated.pairings[0].role, "member");
});

test("expired pairing secret is rejected", async () => {
  const directory = await mkdtemp(join(tmpdir(), "local-ai-auth-expired-"));
  const store = new AuthStore(join(directory, "auth.json"));
  await store.initialize();
  const pairing = await store.createPairing(-1);
  assert.equal(await store.claimPairing(pairing.secret, "Late device"), null);
});
