import { TTSError, abortError, throwIfAborted } from "./contracts.mjs";

export class BoundedAsyncQueue {
  #items = [];
  #readers = [];
  #writers = [];
  #closed = false;
  #failure;

  constructor(capacity = 2) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TTSError("invalid_queue_capacity");
    this.capacity = capacity;
  }

  get size() {
    return this.#items.length;
  }

  get pendingWriters() {
    return this.#writers.length;
  }

  async push(value, { signal } = {}) {
    throwIfAborted(signal);
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new TTSError("queue_closed");

    const reader = this.#readers.shift();
    if (reader) {
      reader.cleanup();
      reader.resolve({ value, done: false });
      return;
    }
    if (this.#items.length < this.capacity) {
      this.#items.push(value);
      return;
    }

    await new Promise((resolve, reject) => {
      const entry = { value, resolve, reject, cleanup: () => {} };
      if (signal) {
        const onAbort = () => {
          this.#writers = this.#writers.filter((candidate) => candidate !== entry);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.#writers.push(entry);
    });
  }

  async shift({ signal } = {}) {
    throwIfAborted(signal);
    if (this.#failure) throw this.#failure;
    if (this.#items.length) {
      const value = this.#items.shift();
      this.#admitWriter();
      return { value, done: false };
    }
    const writer = this.#writers.shift();
    if (writer) {
      writer.cleanup();
      writer.resolve();
      return { value: writer.value, done: false };
    }
    if (this.#closed) return { value: undefined, done: true };

    return await new Promise((resolve, reject) => {
      const entry = { resolve, reject, cleanup: () => {} };
      if (signal) {
        const onAbort = () => {
          this.#readers = this.#readers.filter((candidate) => candidate !== entry);
          reject(abortError(signal.reason));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.#readers.push(entry);
    });
  }

  close() {
    if (this.#closed || this.#failure) return;
    this.#closed = true;
    const error = new TTSError("queue_closed");
    for (const writer of this.#writers.splice(0)) {
      writer.cleanup();
      writer.reject(error);
    }
    if (!this.#items.length) this.#finishReaders();
  }

  fail(error = new TTSError("queue_failed")) {
    if (this.#failure) return;
    this.#failure = error;
    this.#items = [];
    for (const writer of this.#writers.splice(0)) {
      writer.cleanup();
      writer.reject(error);
    }
    for (const reader of this.#readers.splice(0)) {
      reader.cleanup();
      reader.reject(error);
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const result = await this.shift();
      if (result.done) return;
      yield result.value;
    }
  }

  #admitWriter() {
    const writer = this.#writers.shift();
    if (writer) {
      writer.cleanup();
      writer.resolve();
      const reader = this.#readers.shift();
      if (reader) {
        reader.cleanup();
        reader.resolve({ value: writer.value, done: false });
      } else {
        this.#items.push(writer.value);
      }
    }
    if (this.#closed && !this.#items.length) this.#finishReaders();
  }

  #finishReaders() {
    for (const reader of this.#readers.splice(0)) {
      reader.cleanup();
      reader.resolve({ value: undefined, done: true });
    }
  }
}
