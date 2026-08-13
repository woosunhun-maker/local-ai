import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { TTSError } from "./contracts.mjs";
import { MlxProcessEngine } from "./mlx-process-engine.mjs";
import {
  APPLE_PROVIDER_ID,
  AppleClientFallbackProvider,
  PinnedLocalQwenProvider,
  QWEN_PROVIDER_ID,
  TTSProviderRegistry,
  UnavailableQwenProvider,
} from "./providers.mjs";

export const PINNED_MLX_AUDIO_REVISION = "5fac1de4e29a38e3d1e73b9ad94ae2dae616d151";
export const PINNED_QWEN_MODEL_REVISION = "1c6c0ff58c43afa8df571facde2efa077efd85e2";
export const PINNED_QWEN_REPOSITORY = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-6bit";
export const PINNED_PYTHON_VERSION = "3.11.15";
export const PINNED_TTS_WORKER_SHA256 = "8251cbbb05812b3c549b97664ec8205b61160119cadd70bc15830bbd65ccf797";
export const PINNED_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
export const PINNED_TTS_PRIVATE_TMP = "/Users/hun/PrivateAI/tmp/tts";
export const PINNED_SANDBOX_PROFILE = `(version 1)
(import "system.sb")
(allow default)
(deny network*)
(deny file-write*
  (require-not (subpath "/Users/hun/PrivateAI/tmp/tts")))
(deny file-read-data
  (require-all
    (subpath "/Users/hun")
    (require-not (subpath "/Users/hun/PrivateAI/runtime/tts"))
    (require-not (subpath "/Users/hun/PrivateAI/models/tts"))
    (require-not (subpath "/Users/hun/PrivateAI/tmp/tts"))))
(deny file-read-metadata
  (require-all
    (subpath "/Users/hun")
    (require-not (literal "/Users/hun"))
    (require-not (literal "/Users/hun/PrivateAI"))
    (require-not (literal "/Users/hun/PrivateAI/runtime"))
    (require-not (literal "/Users/hun/PrivateAI/models"))
    (require-not (literal "/Users/hun/PrivateAI/tmp"))
    (require-not (subpath "/Users/hun/PrivateAI/runtime/tts"))
    (require-not (subpath "/Users/hun/PrivateAI/models/tts"))
    (require-not (subpath "/Users/hun/PrivateAI/tmp/tts"))))
`;
export const DEFAULT_TTS_RUNTIME_MANIFEST = "/Users/hun/PrivateAI/config/tts-runtime.json";

const DEFAULT_RUNTIME_ROOT = "/Users/hun/PrivateAI/runtime/tts/";
const RUNTIME_FILES_MANIFEST = "LOCAL_AI_RUNTIME_FILES.json";

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TTSError(`invalid_${label}`);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) throw new TTSError(`invalid_${label}`);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function privateMode(metadata, code = "unsafe_runtime_permissions") {
  if ((metadata.mode & 0o077) !== 0) throw new TTSError(code);
}

function systemExecutableMode(metadata) {
  if (!metadata.isFile() || (metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0) {
    throw new TTSError("unsafe_sandbox_executable");
  }
}

function parseFilesManifest(content) {
  const files = new Map();
  for (const line of content.trim().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match || match[2].startsWith("/") || match[2].split("/").includes("..") || files.has(match[2])) {
      throw new TTSError("invalid_model_files_manifest");
    }
    files.set(match[2], match[1]);
  }
  if (!files.has("config.json") || !files.has("model.safetensors")) throw new TTSError("incomplete_model_files_manifest");
  return files;
}

async function listModelFiles(root, relativeDirectory = "") {
  const output = [];
  const directory = join(root, relativeDirectory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (relativePath === "LOCAL_AI_FILES.sha256") continue;
    if (entry.isSymbolicLink()) throw new TTSError("unsafe_model_file");
    if (entry.isDirectory()) output.push(...await listModelFiles(root, relativePath));
    else if (entry.isFile()) output.push(relativePath);
    else throw new TTSError("unsafe_model_file");
  }
  return output.sort();
}

function parseRuntimeFilesManifest(content) {
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw new TTSError("invalid_runtime_files_manifest");
  }
  exactKeys(value, ["version", "files"], "runtime_files_manifest");
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length < 1) {
    throw new TTSError("invalid_runtime_files_manifest");
  }
  const files = new Map();
  for (const entry of value.files) {
    exactKeys(entry, ["path", "sha256", "mode"], "runtime_file_entry");
    if (
      typeof entry.path !== "string" ||
      !entry.path || entry.path.includes("\0") || entry.path.includes("\\") ||
      entry.path.startsWith("/") ||
      entry.path.split("/").some((part) => !part || part === "." || part === "..") ||
      entry.path === RUNTIME_FILES_MANIFEST ||
      files.has(entry.path) ||
      !isSha256(entry.sha256) ||
      !Number.isSafeInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777
    ) {
      throw new TTSError("invalid_runtime_files_manifest");
    }
    files.set(entry.path, { sha256: entry.sha256, mode: entry.mode });
  }
  return files;
}

async function listRuntimeFiles(root, relativeDirectory = "") {
  const output = [];
  const directory = join(root, relativeDirectory);
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) throw new TTSError("unsafe_runtime_file");
  privateMode(directoryMetadata);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (relativePath === RUNTIME_FILES_MANIFEST) continue;
    if (entry.isSymbolicLink()) throw new TTSError("unsafe_runtime_file");
    if (entry.isDirectory()) output.push(...await listRuntimeFiles(root, relativePath));
    else if (entry.isFile()) output.push(relativePath);
    else throw new TTSError("unsafe_runtime_file");
  }
  return output.sort();
}

export async function verifyRuntimeFiles(
  runtime,
  {
    allowedRoot = DEFAULT_RUNTIME_ROOT,
    expectedPythonVersion = PINNED_PYTHON_VERSION,
    expectedSandboxExecutable = PINNED_SANDBOX_EXECUTABLE,
    expectedPrivateTmpPath = PINNED_TTS_PRIVATE_TMP,
    expectedSandboxProfile = PINNED_SANDBOX_PROFILE,
  } = {},
) {
  exactKeys(runtime, [
    "rootPath", "pythonPath", "pythonVersion", "pythonSha256", "workerPath", "workerSha256",
    "sandboxExecutable", "sandboxProfilePath", "sandboxProfileSha256", "filesManifestSha256",
    "privateTmpPath", "mlxAudioRevision",
  ], "tts_runtime");
  if (runtime.mlxAudioRevision !== PINNED_MLX_AUDIO_REVISION || runtime.pythonVersion !== expectedPythonVersion) {
    throw new TTSError("unpinned_tts_runtime");
  }
  if (![runtime.pythonSha256, runtime.workerSha256, runtime.sandboxProfileSha256, runtime.filesManifestSha256].every(isSha256)) {
    throw new TTSError("unverified_runtime_hash");
  }
  if (runtime.workerSha256 !== PINNED_TTS_WORKER_SHA256 && allowedRoot === DEFAULT_RUNTIME_ROOT) {
    throw new TTSError("unpinned_tts_worker");
  }

  const normalizedRoot = `${resolve(allowedRoot)}/`;
  if (!resolve(runtime.rootPath).startsWith(normalizedRoot)) throw new TTSError("unsafe_tts_runtime_path");
  const root = await realpath(runtime.rootPath);
  if (root !== resolve(runtime.rootPath)) throw new TTSError("runtime_path_must_be_canonical");

  const expectedPythonPath = join(root, "venv/bin/python");
  const expectedWorkerPath = join(root, "tts-worker.py");
  const expectedSandboxProfilePath = join(root, "deny-network.sb");
  if (
    runtime.pythonPath !== expectedPythonPath ||
    runtime.workerPath !== expectedWorkerPath ||
    runtime.sandboxProfilePath !== expectedSandboxProfilePath ||
    runtime.sandboxExecutable !== expectedSandboxExecutable ||
    runtime.privateTmpPath !== expectedPrivateTmpPath
  ) {
    throw new TTSError("unsafe_tts_runtime_path");
  }

  const sandboxMetadata = await lstat(runtime.sandboxExecutable);
  if ((await realpath(runtime.sandboxExecutable)) !== runtime.sandboxExecutable) throw new TTSError("unsafe_sandbox_executable");
  systemExecutableMode(sandboxMetadata);
  const privateTmp = await realpath(runtime.privateTmpPath);
  const privateTmpMetadata = await lstat(privateTmp);
  if (privateTmp !== runtime.privateTmpPath || !privateTmpMetadata.isDirectory() || privateTmpMetadata.isSymbolicLink()) {
    throw new TTSError("unsafe_tts_private_tmp");
  }
  privateMode(privateTmpMetadata, "unsafe_tts_private_tmp");

  const manifestPath = join(root, RUNTIME_FILES_MANIFEST);
  const content = await readFile(manifestPath, "utf8");
  if (createHash("sha256").update(content).digest("hex") !== runtime.filesManifestSha256) {
    throw new TTSError("runtime_manifest_hash_mismatch");
  }
  const files = parseRuntimeFilesManifest(content);
  const actualFiles = await listRuntimeFiles(root);
  if (actualFiles.length !== files.size || actualFiles.some((path) => !files.has(path))) {
    throw new TTSError("runtime_file_set_mismatch");
  }
  for (const [relativePath, expected] of files) {
    const path = join(root, relativePath);
    const metadata = await lstat(path);
    if (
      !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      (await realpath(path)) !== path || (metadata.mode & 0o777) !== expected.mode
    ) {
      throw new TTSError("unsafe_runtime_file");
    }
    privateMode(metadata);
    if (await sha256File(path) !== expected.sha256) throw new TTSError("runtime_file_hash_mismatch");
  }
  if (await sha256File(runtime.pythonPath) !== runtime.pythonSha256) throw new TTSError("python_hash_mismatch");
  if (await sha256File(runtime.workerPath) !== runtime.workerSha256) throw new TTSError("worker_hash_mismatch");
  const sandboxProfile = await readFile(runtime.sandboxProfilePath, "utf8");
  if (sandboxProfile !== expectedSandboxProfile || await sha256File(runtime.sandboxProfilePath) !== runtime.sandboxProfileSha256) {
    throw new TTSError("sandbox_profile_hash_mismatch");
  }
  return { fileCount: files.size, manifestSha256: runtime.filesManifestSha256 };
}

export async function verifyModelFiles(
  modelPath,
  expectedManifestSha256,
  { allowedRoot = "/Users/hun/PrivateAI/models/tts/" } = {},
) {
  const normalizedRoot = `${resolve(allowedRoot)}/`;
  if (!resolve(modelPath).startsWith(normalizedRoot)) throw new TTSError("invalid_model_path");
  if (!isSha256(expectedManifestSha256)) throw new TTSError("unverified_model_hash");
  const root = await realpath(modelPath);
  if (root !== resolve(modelPath)) throw new TTSError("model_path_must_be_canonical");
  const manifestPath = join(root, "LOCAL_AI_FILES.sha256");
  const content = await readFile(manifestPath, "utf8");
  if (createHash("sha256").update(content).digest("hex") !== expectedManifestSha256) {
    throw new TTSError("model_manifest_hash_mismatch");
  }
  const files = parseFilesManifest(content);
  const actualFiles = await listModelFiles(root);
  if (actualFiles.length !== files.size || actualFiles.some((path) => !files.has(path))) {
    throw new TTSError("model_file_set_mismatch");
  }
  for (const [relativePath, expectedHash] of files) {
    const path = join(root, relativePath);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (await realpath(path)) !== path) {
      throw new TTSError("unsafe_model_file");
    }
    if (await sha256File(path) !== expectedHash) throw new TTSError("model_file_hash_mismatch");
  }
  return { fileCount: files.size, manifestSha256: expectedManifestSha256 };
}

export async function loadPinnedTtsManifest(path = DEFAULT_TTS_RUNTIME_MANIFEST) {
  const value = JSON.parse(await readFile(path, "utf8"));
  exactKeys(value, ["version", "runtime", "model"], "tts_runtime_manifest");
  exactKeys(value.model, ["repository", "revision", "localPath", "filesManifestSha256"], "tts_model");
  if (value.version !== 2) throw new TTSError("unpinned_tts_runtime");
  if (value.model.repository !== PINNED_QWEN_REPOSITORY || value.model.revision !== PINNED_QWEN_MODEL_REVISION) {
    throw new TTSError("unpinned_tts_model");
  }
  await verifyRuntimeFiles(value.runtime);
  await verifyModelFiles(value.model.localPath, value.model.filesManifestSha256);
  return value;
}

class RuntimeProviderSlot {
  id = QWEN_PROVIDER_ID;
  #provider;
  #reason = "runtime_verifying";

  install(provider) {
    this.#provider = provider;
  }

  unavailable(reason) {
    this.#provider = undefined;
    this.#reason = reason;
  }

  describe() {
    if (this.#provider) return this.#provider.describe();
    const description = new UnavailableQwenProvider(this.#reason).describe();
    return {
      ...description,
      runtimeHealth: {
        state: this.#reason === "runtime_verifying" ? "verifying" : "unavailable",
        restartRemaining: 0,
      },
    };
  }

  async *synthesize(options) {
    if (!this.#provider) throw new TTSError("provider_unavailable");
    yield* this.#provider.synthesize(options);
  }
}

export async function createRuntimeTtsRegistry({
  manifestPath = DEFAULT_TTS_RUNTIME_MANIFEST,
  engineFactory,
  manifestLoader = loadPinnedTtsManifest,
} = {}) {
  const slot = new RuntimeProviderSlot();
  const registry = new TTSProviderRegistry({
    providers: [slot, new AppleClientFallbackProvider()],
    primaryProviderId: QWEN_PROVIDER_ID,
    fallbackProviderId: APPLE_PROVIDER_ID,
  });
  registry.runtimeInitialization = (async () => {
    let manifest;
    try {
      manifest = await manifestLoader(manifestPath);
      const engine = engineFactory
        ? engineFactory(manifest)
        : new MlxProcessEngine({
            pythonPath: manifest.runtime.pythonPath,
            workerPath: manifest.runtime.workerPath,
            modelPath: manifest.model.localPath,
            sandboxExecutable: manifest.runtime.sandboxExecutable,
            sandboxProfilePath: manifest.runtime.sandboxProfilePath,
            privateTmpPath: manifest.runtime.privateTmpPath,
          });
      slot.install(new PinnedLocalQwenProvider({
        model: {
          repository: manifest.model.repository,
          revision: manifest.model.revision,
          sha256: manifest.model.filesManifestSha256,
          localPath: manifest.model.localPath,
        },
        engine,
      }));
      try {
        await engine.start?.();
      } catch {
        // Engine health is reflected by the provider; chat startup and Apple fallback stay available.
      }
    } catch (error) {
      slot.unavailable(error?.code === "ENOENT" ? "model_not_installed" : "model_verification_failed");
    }
  })();
  return registry;
}
