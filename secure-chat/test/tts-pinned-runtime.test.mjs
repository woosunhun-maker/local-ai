import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PINNED_MLX_AUDIO_REVISION,
  createRuntimeTtsRegistry,
  verifyModelFiles,
  verifyRuntimeFiles,
} from "../src/tts/pinned-runtime.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("verifies every file named by a pinned model manifest", async () => {
  const allowedRoot = await realpath(await mkdtemp(join(tmpdir(), "local-ai-model-root-")));
  const root = await realpath(await mkdtemp(join(allowedRoot, "test-runtime-")));
  const config = Buffer.from('{"model":"synthetic"}\n');
  const weights = Buffer.from("synthetic model bytes");
  await writeFile(join(root, "config.json"), config);
  await writeFile(join(root, "model.safetensors"), weights);
  const manifest = `${sha256(config)}  config.json\n${sha256(weights)}  model.safetensors\n`;
  await writeFile(join(root, "LOCAL_AI_FILES.sha256"), manifest);

  const result = await verifyModelFiles(root, sha256(manifest), { allowedRoot });
  assert.equal(result.fileCount, 2);
});

test("rejects a model file changed after its manifest was created", async () => {
  const allowedRoot = await realpath(await mkdtemp(join(tmpdir(), "local-ai-model-root-")));
  const root = await realpath(await mkdtemp(join(allowedRoot, "test-tamper-")));
  const config = Buffer.from("safe config");
  const original = Buffer.from("original weights");
  await writeFile(join(root, "config.json"), config);
  await writeFile(join(root, "model.safetensors"), Buffer.from("changed weights"));
  const manifest = `${sha256(config)}  config.json\n${sha256(original)}  model.safetensors\n`;
  await writeFile(join(root, "LOCAL_AI_FILES.sha256"), manifest);

  await assert.rejects(verifyModelFiles(root, sha256(manifest), { allowedRoot }), /model_file_hash_mismatch/);
});

test("rejects an unlisted file that could alter model loading", async () => {
  const allowedRoot = await realpath(await mkdtemp(join(tmpdir(), "local-ai-model-root-")));
  const root = await realpath(await mkdtemp(join(allowedRoot, "test-extra-")));
  const config = Buffer.from("safe config");
  const weights = Buffer.from("safe weights");
  await writeFile(join(root, "config.json"), config);
  await writeFile(join(root, "model.safetensors"), weights);
  await writeFile(join(root, "custom_code.py"), "print('unexpected')\n");
  const manifest = `${sha256(config)}  config.json\n${sha256(weights)}  model.safetensors\n`;
  await writeFile(join(root, "LOCAL_AI_FILES.sha256"), manifest);

  await assert.rejects(verifyModelFiles(root, sha256(manifest), { allowedRoot }), /model_file_set_mismatch/);
});

test("verifies the complete private venv plus worker and sandbox profile", async () => {
  const allowedRoot = await realpath(await mkdtemp(join(tmpdir(), "local-ai-runtime-root-")));
  const root = await realpath(await mkdtemp(join(allowedRoot, "verified-runtime-")));
  const privateTmp = await realpath(await mkdtemp(join(allowedRoot, "private-tmp-")));
  await mkdir(join(root, "venv/bin"), { recursive: true, mode: 0o700 });
  await chmod(join(root, "venv"), 0o700);
  await chmod(join(root, "venv/bin"), 0o700);
  const fileValues = new Map([
    ["venv/bin/python", Buffer.from("pinned python")],
    ["tts-worker.py", Buffer.from("pinned worker")],
    ["deny-network.sb", Buffer.from("test sandbox\n")],
  ]);
  for (const [path, value] of fileValues) {
    await writeFile(join(root, path), value);
    await chmod(join(root, path), path === "deny-network.sb" ? 0o600 : 0o700);
  }
  const files = [...fileValues].map(([path, value]) => ({
    path,
    sha256: sha256(value),
    mode: path === "deny-network.sb" ? 0o600 : 0o700,
  }));
  const canonicalManifest = `${JSON.stringify({ files, version: 1 })}\n`;
  await writeFile(join(root, "LOCAL_AI_RUNTIME_FILES.json"), canonicalManifest);
  await chmod(join(root, "LOCAL_AI_RUNTIME_FILES.json"), 0o600);
  const runtime = {
    rootPath: root,
    pythonPath: join(root, "venv/bin/python"),
    pythonVersion: "test-python",
    pythonSha256: sha256(fileValues.get("venv/bin/python")),
    workerPath: join(root, "tts-worker.py"),
    workerSha256: sha256(fileValues.get("tts-worker.py")),
    sandboxExecutable: "/usr/bin/true",
    sandboxProfilePath: join(root, "deny-network.sb"),
    sandboxProfileSha256: sha256(fileValues.get("deny-network.sb")),
    filesManifestSha256: sha256(canonicalManifest),
    privateTmpPath: privateTmp,
    mlxAudioRevision: PINNED_MLX_AUDIO_REVISION,
  };
  const options = {
    allowedRoot,
    expectedPythonVersion: "test-python",
    expectedSandboxExecutable: "/usr/bin/true",
    expectedPrivateTmpPath: privateTmp,
    expectedSandboxProfile: "test sandbox\n",
  };

  const result = await verifyRuntimeFiles(runtime, options);
  assert.equal(result.fileCount, 3);
  await writeFile(runtime.workerPath, "changed worker");
  await assert.rejects(verifyRuntimeFiles(runtime, options), /runtime_file_hash_mismatch/);
});

test("runtime verification and prewarm do not block chat registry startup", async () => {
  let releaseManifest;
  const manifestPending = new Promise((resolve) => { releaseManifest = resolve; });
  let state = "idle";
  const engine = {
    health: () => ({ state, available: state === "ready", restartRemaining: 1 }),
    async start() { state = "ready"; },
    async *synthesize() {},
  };
  const registry = await createRuntimeTtsRegistry({
    manifestLoader: () => manifestPending,
    engineFactory: () => engine,
  });
  const initial = registry.catalog().providers.find((provider) => provider.id === "qwen3-tts-local");
  assert.equal(initial.availability.state, "unavailable");
  assert.equal(initial.runtimeHealth.state, "verifying");

  releaseManifest({
    runtime: {},
    model: {
      repository: "example/model",
      revision: "a".repeat(40),
      filesManifestSha256: "b".repeat(64),
      localPath: "/private/models/qwen",
    },
  });
  await registry.runtimeInitialization;
  const ready = registry.catalog().providers.find((provider) => provider.id === "qwen3-tts-local");
  assert.equal(ready.availability.state, "available");
  assert.equal(ready.runtimeHealth.state, "ready");
});
