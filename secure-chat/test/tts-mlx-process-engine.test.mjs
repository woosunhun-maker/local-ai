import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { MlxProcessEngine } from "../src/tts/mlx-process-engine.mjs";

class FakeWorker extends EventEmitter {
  stdout = new PassThrough();
  commands = [];

  constructor({ crashOnSynthesis = false } = {}) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of String(chunk).trim().split("\n")) {
          const command = JSON.parse(line);
          this.commands.push(command);
          if (command.type === "synthesize") {
            queueMicrotask(() => {
              if (crashOnSynthesis) {
                this.emit("exit", 1);
                return;
              }
              this.stdout.write(`${JSON.stringify({
                type: "audio",
                id: command.id,
                sequence: 0,
                encoding: "pcm_s16le",
                sampleRate: 24_000,
                channels: 1,
                data: Buffer.from([1, 2, 3, 4]).toString("base64"),
              })}\n`);
              this.stdout.write(`${JSON.stringify({ type: "done", id: command.id })}\n`);
            });
          }
        }
        callback();
      },
    });
    queueMicrotask(() => this.stdout.write('{"type":"ready","sampleRate":24000,"speaker":"Sohee"}\n'));
  }

  kill() {
    this.emit("exit", 0);
  }
}

test("persistent MLX worker protocol streams private PCM bytes without temporary files", async () => {
  const worker = new FakeWorker();
  const engine = new MlxProcessEngine({
    pythonPath: "/private/runtime/python",
    workerPath: "/private/runtime/worker.py",
    modelPath: "/private/models/qwen",
    sandboxExecutable: "/usr/bin/sandbox-exec",
    sandboxProfilePath: "/private/runtime/deny-network.sb",
    privateTmpPath: "/private/runtime/tmp",
    spawnProcess: () => worker,
  });
  const chunks = [];
  for await (const chunk of engine.synthesize({
    text: "합성 테스트",
    speaker: "Sohee",
    language: "Korean",
    style: "natural",
    modelPath: "/private/models/qwen",
  })) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].bytes, Buffer.from([1, 2, 3, 4]));
  assert.equal(chunks[0].sampleRate, 24_000);
  assert.equal(worker.commands.filter((entry) => entry.type === "synthesize").length, 1);
  engine.stop();
});

test("worker is launched through the pinned deny-network sandbox with private cache paths", async () => {
  const calls = [];
  const worker = new FakeWorker();
  const engine = new MlxProcessEngine({
    pythonPath: "/private/runtime/venv/bin/python",
    workerPath: "/private/runtime/tts-worker.py",
    modelPath: "/private/models/qwen",
    sandboxExecutable: "/usr/bin/sandbox-exec",
    sandboxProfilePath: "/private/runtime/deny-network.sb",
    privateTmpPath: "/private/runtime/tmp",
    spawnProcess: (...args) => {
      calls.push(args);
      return worker;
    },
  });
  await engine.start();

  const [executable, args, options] = calls[0];
  assert.equal(executable, "/usr/bin/sandbox-exec");
  assert.deepEqual(args, [
    "-f", "/private/runtime/deny-network.sb", "/private/runtime/venv/bin/python",
    "-I", "-u", "/private/runtime/tts-worker.py",
  ]);
  assert.equal(options.cwd, "/private/runtime/tmp");
  assert.equal(options.env.PYTHONDONTWRITEBYTECODE, "1");
  assert.equal(options.env.HOME, "/private/runtime/tmp/home");
  assert.equal(engine.health().state, "ready");
  engine.stop();
});

test("a crashed worker is reset and restarted at most through the bounded recovery path", async () => {
  const workers = [new FakeWorker({ crashOnSynthesis: true }), new FakeWorker()];
  let spawns = 0;
  const engine = new MlxProcessEngine({
    pythonPath: "/private/runtime/venv/bin/python",
    workerPath: "/private/runtime/tts-worker.py",
    modelPath: "/private/models/qwen",
    sandboxExecutable: "/usr/bin/sandbox-exec",
    sandboxProfilePath: "/private/runtime/deny-network.sb",
    privateTmpPath: "/private/runtime/tmp",
    spawnProcess: () => workers[spawns++],
    restartDelayMs: 0,
    maxRestartAttempts: 1,
  });

  await assert.rejects(async () => {
    for await (const _chunk of engine.synthesize({
      text: "first",
      speaker: "Sohee",
      language: "Korean",
      style: "natural",
      modelPath: "/private/models/qwen",
    })) {}
  }, /tts_worker_failed/);
  for (let count = 0; count < 20 && engine.health().state !== "ready"; count += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(spawns, 2);
  assert.equal(engine.health().state, "ready");

  const chunks = [];
  for await (const chunk of engine.synthesize({
    text: "second",
    speaker: "Sohee",
    language: "Korean",
    style: "natural",
    modelPath: "/private/models/qwen",
  })) chunks.push(chunk);
  assert.equal(chunks.length, 1);
  engine.stop();
});
