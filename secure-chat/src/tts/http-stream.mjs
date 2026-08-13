import { TTSError, abortError, serializeTtsEvent, throwIfAborted } from "./contracts.mjs";

export async function writeWithDrain(response, payload, { signal } = {}) {
  throwIfAborted(signal);
  if (response.destroyed || response.writableEnded) throw abortError("client_disconnected");
  if (response.write(payload)) return;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("drain", onDrain);
      response.removeListener("error", onError);
      response.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback) => (value) => {
      cleanup();
      callback(value);
    };
    const onDrain = finish(resolve);
    const onError = finish(() => reject(new TTSError("tts_response_write_failed")));
    const onClose = finish(() => reject(abortError("client_disconnected")));
    const onAbort = finish(() => reject(abortError(signal?.reason)));
    response.once("drain", onDrain);
    response.once("error", onError);
    response.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  throwIfAborted(signal);
}

export async function streamTtsEvents(response, events, { signal, serialize = serializeTtsEvent } = {}) {
  for await (const event of events) {
    await writeWithDrain(response, `${serialize(event)}\n`, { signal });
  }
  throwIfAborted(signal);
  if (!response.destroyed && !response.writableEnded) response.end();
}
