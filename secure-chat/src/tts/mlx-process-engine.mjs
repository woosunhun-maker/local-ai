import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { BoundedAsyncQueue } from "./bounded-async-queue.mjs";
import { TTSError, abortError, throwIfAborted } from "./contracts.mjs";

function absolutePath(value, code) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new TTSError(code);
  return value;
}

function safeWorkerError(code = "tts_worker_failed") {
  const allowlist = new Set([
    "invalid_model_path", "model_load_failed", "sohee_voice_missing", "worker_busy",
    "invalid_synthesis_request", "synthesis_failed", "tts_worker_start_failed",
    "tts_worker_start_timeout", "tts_worker_stopped", "tts_worker_failed",
    "invalid_tts_worker_event", "tts_worker_protocol_failed", "tts_worker_unavailable",
  ]);
  return new TTSError(allowlist.has(code) ? code : "tts_worker_failed");
}

export class MlxProcessEngine {
  #child;
  #readyPromise;
  #readyResolve;
  #readyReject;
  #startOperation;
  #requests = new Map();
  #everSpawned = false;
  #restartBudget;
  #lastFailure;
  #health = { state: "idle", available: false, restartRemaining: 0 };

  constructor({
    pythonPath,
    workerPath,
    modelPath,
    sandboxExecutable,
    sandboxProfilePath,
    privateTmpPath,
    spawnProcess = spawn,
    startupTimeoutMs = 180_000,
    maxRestartAttempts = 1,
    restartDelayMs = 250,
  }) {
    this.pythonPath = absolutePath(pythonPath, "invalid_python_path");
    this.workerPath = absolutePath(workerPath, "invalid_worker_path");
    this.modelPath = absolutePath(modelPath, "invalid_model_path");
    this.sandboxExecutable = absolutePath(sandboxExecutable, "invalid_sandbox_path");
    this.sandboxProfilePath = absolutePath(sandboxProfilePath, "invalid_sandbox_profile_path");
    this.privateTmpPath = absolutePath(privateTmpPath, "invalid_private_tmp_path");
    if (!Number.isSafeInteger(maxRestartAttempts) || maxRestartAttempts < 0 || maxRestartAttempts > 3) {
      throw new TTSError("invalid_tts_restart_limit");
    }
    this.spawnProcess = spawnProcess;
    this.startupTimeoutMs = startupTimeoutMs;
    this.maxRestartAttempts = maxRestartAttempts;
    this.restartDelayMs = restartDelayMs;
    this.#restartBudget = maxRestartAttempts;
    this.#setHealth("idle", false);
  }

  health() {
    return { ...this.#health };
  }

  async start() {
    if (this.#child && this.#readyPromise) return await this.#readyPromise;
    if (this.#startOperation) return await this.#startOperation;
    const operation = this.#startWithBoundedRestart();
    this.#startOperation = operation;
    try {
      return await operation;
    } finally {
      if (this.#startOperation === operation) this.#startOperation = undefined;
    }
  }

  async *synthesize({ text, speaker, language, style, modelPath, signal }) {
    if (modelPath !== this.modelPath || speaker !== "Sohee" || language !== "Korean") {
      throw new TTSError("invalid_local_tts_binding");
    }
    throwIfAborted(signal);
    await this.start();
    const id = randomUUID();
    const queue = new BoundedAsyncQueue(4);
    const request = { queue, nextSequence: 0 };
    this.#requests.set(id, request);
    const abort = () => this.#trySend({ type: "cancel", id });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.#send({ type: "synthesize", id, text, style });
      while (true) {
        const event = await queue.shift({ signal });
        if (event.done) return;
        throwIfAborted(signal);
        yield event.value;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.#requests.get(id) === request) {
        this.#requests.delete(id);
        queue.fail(abortError(signal?.reason));
        this.#trySend({ type: "cancel", id });
      }
    }
  }

  stop() {
    const child = this.#child;
    if (!child) {
      this.#setHealth("stopped", false, "tts_worker_stopped");
      return;
    }
    this.#trySend({ type: "shutdown", id: randomUUID() });
    this.#child = undefined;
    this.#readyPromise = undefined;
    this.#readyResolve = undefined;
    this.#readyReject = undefined;
    child.kill("SIGTERM");
    this.#failRequests(safeWorkerError("tts_worker_stopped"));
    this.#setHealth("stopped", false, "tts_worker_stopped");
  }

  async #startWithBoundedRestart() {
    while (true) {
      const restarting = this.#everSpawned;
      if (restarting) {
        if (this.#restartBudget <= 0) {
          this.#setHealth("unavailable", false, this.#lastFailure?.code ?? "tts_worker_failed");
          throw this.#lastFailure ?? safeWorkerError();
        }
        this.#restartBudget -= 1;
        this.#setHealth("restarting", false);
        if (this.restartDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.restartDelayMs));
      }
      try {
        return await this.#spawnOnce();
      } catch (error) {
        this.#lastFailure = error instanceof TTSError ? error : safeWorkerError();
        if (this.#restartBudget <= 0) {
          this.#setHealth("unavailable", false, this.#lastFailure.code);
          throw this.#lastFailure;
        }
      }
    }
  }

  async #spawnOnce() {
    this.#everSpawned = true;
    this.#setHealth("starting", false);
    let child;
    let readyPromise;
    try {
      readyPromise = new Promise((resolve, reject) => {
        this.#readyResolve = resolve;
        this.#readyReject = reject;
      });
      this.#readyPromise = readyPromise;
      const binPath = this.pythonPath.slice(0, this.pythonPath.lastIndexOf("/"));
      child = this.spawnProcess(
        this.sandboxExecutable,
        ["-f", this.sandboxProfilePath, this.pythonPath, "-I", "-u", this.workerPath],
        {
          cwd: this.privateTmpPath,
          env: {
            PATH: binPath,
            HOME: `${this.privateTmpPath}/home`,
            TMPDIR: `${this.privateTmpPath}/tmp/`,
            XDG_CACHE_HOME: `${this.privateTmpPath}/cache`,
            HF_HOME: `${this.privateTmpPath}/huggingface`,
            PYTHONDONTWRITEBYTECODE: "1",
            PYTHONNOUSERSITE: "1",
            LOCAL_AI_TTS_MODEL_PATH: this.modelPath,
            HF_HUB_OFFLINE: "1",
            TRANSFORMERS_OFFLINE: "1",
            HF_HUB_DISABLE_TELEMETRY: "1",
            DO_NOT_TRACK: "1",
            NO_PROXY: "*",
          },
          stdio: ["pipe", "pipe", "ignore"],
        },
      );
      this.#child = child;
      child.once("error", (error) => this.#failChild(child, safeWorkerError("tts_worker_start_failed"), error));
      child.once("exit", (code) => this.#failChild(child, safeWorkerError(code === 0 ? "tts_worker_stopped" : "tts_worker_failed")));
      void this.#readEvents(child);
    } catch {
      const error = safeWorkerError("tts_worker_start_failed");
      void readyPromise?.catch(() => {});
      this.#failChild(child, error);
      throw error;
    }

    const timeout = setTimeout(() => {
      this.#failChild(child, safeWorkerError("tts_worker_start_timeout"), undefined, { kill: true });
    }, this.startupTimeoutMs);
    timeout.unref?.();
    try {
      return await readyPromise;
    } finally {
      clearTimeout(timeout);
    }
  }

  async #send(value) {
    const stream = this.#child?.stdin;
    if (!stream?.writable) throw safeWorkerError("tts_worker_unavailable");
    const accepted = stream.write(`${JSON.stringify(value)}\n`);
    if (accepted) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        stream.removeListener("drain", onDrain);
        stream.removeListener("error", onFailure);
        stream.removeListener("close", onFailure);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onFailure = () => {
        cleanup();
        reject(safeWorkerError("tts_worker_unavailable"));
      };
      stream.once("drain", onDrain);
      stream.once("error", onFailure);
      stream.once("close", onFailure);
    });
  }

  #trySend(value) {
    void this.#send(value).catch(() => {
      // The worker failure path owns health and active-request transitions.
    });
  }

  async #readEvents(child) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (this.#child !== child) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          this.#failChild(child, safeWorkerError("invalid_tts_worker_event"), undefined, { kill: true });
          return;
        }
        if (event.type === "ready") {
          if (
            this.#health.state !== "starting" || event.speaker !== "Sohee" ||
            !Number.isSafeInteger(event.sampleRate) || event.sampleRate !== 24_000
          ) {
            this.#failChild(child, safeWorkerError("invalid_tts_worker_event"), undefined, { kill: true });
            return;
          }
          this.#setHealth("ready", true);
          this.#readyResolve?.({ sampleRate: event.sampleRate, speaker: event.speaker });
          continue;
        }
        if (event.type === "fatal" || event.type === "protocol_error") {
          this.#failChild(child, safeWorkerError(event.code), undefined, { kill: true });
          return;
        }
        if (typeof event.id !== "string") {
          this.#failChild(child, safeWorkerError("invalid_tts_worker_event"), undefined, { kill: true });
          return;
        }
        const request = this.#requests.get(event.id);
        if (!request) continue;
        if (event.type === "audio") {
          if (
            event.sequence !== request.nextSequence || event.encoding !== "pcm_s16le" ||
            event.sampleRate !== 24_000 || event.channels !== 1 || typeof event.data !== "string" ||
            event.data.length < 4 || event.data.length > 700_000 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(event.data)
          ) {
            this.#failChild(child, safeWorkerError("invalid_tts_worker_event"), undefined, { kill: true });
            return;
          }
          const bytes = Buffer.from(event.data, "base64");
          if (!bytes.length || bytes.length > 512 * 1024 || bytes.length % 2 !== 0) {
            this.#failChild(child, safeWorkerError("invalid_tts_worker_event"), undefined, { kill: true });
            return;
          }
          request.nextSequence += 1;
          try {
            await request.queue.push({ bytes, encoding: event.encoding, sampleRate: event.sampleRate, channels: event.channels });
          } catch (error) {
            if (this.#requests.get(event.id) !== request) continue;
            this.#requests.delete(event.id);
            request.queue.fail(error);
            this.#trySend({ type: "cancel", id: event.id });
          }
        } else if (event.type === "done" || event.type === "cancelled") {
          this.#requests.delete(event.id);
          request.queue.close();
          if (event.type === "done") this.#restartBudget = this.maxRestartAttempts;
        } else if (event.type === "error") {
          this.#requests.delete(event.id);
          request.queue.fail(safeWorkerError(event.code));
        } else {
          this.#failChild(child, safeWorkerError("invalid_tts_worker_event"), undefined, { kill: true });
          return;
        }
      }
    } catch {
      this.#failChild(child, safeWorkerError("tts_worker_protocol_failed"), undefined, { kill: true });
    }
  }

  #failChild(child, error, _cause, { kill = false } = {}) {
    if (child && this.#child !== child) return;
    const wasReady = this.#health.state === "ready";
    if (kill && child && !child.killed) child.kill("SIGTERM");
    this.#readyReject?.(error);
    this.#child = undefined;
    this.#readyPromise = undefined;
    this.#readyResolve = undefined;
    this.#readyReject = undefined;
    this.#lastFailure = error;
    this.#failRequests(error);
    const canRestart = this.#restartBudget > 0;
    this.#setHealth(canRestart ? "degraded" : "unavailable", false, error.code);
    if (wasReady && canRestart) {
      queueMicrotask(() => void this.start().catch(() => {
        // Health remains unavailable and the provider resolves to the device fallback.
      }));
    }
  }

  #failRequests(error) {
    for (const request of this.#requests.values()) request.queue.fail(error);
    this.#requests.clear();
  }

  #setHealth(state, available, reason) {
    this.#health = {
      state,
      available,
      restartRemaining: this.#restartBudget,
      ...(reason ? { reason } : {}),
    };
  }
}
