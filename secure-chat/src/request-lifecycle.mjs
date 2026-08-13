export function createRequestSignal(request, response, timeoutMs = 620_000) {
  const connectionController = new AbortController();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  const abortConnection = () => {
    if (!connectionController.signal.aborted) connectionController.abort("client_disconnected");
  };

  request.once("aborted", abortConnection);
  response.once("close", () => {
    if (!response.writableEnded) abortConnection();
  });

  return AbortSignal.any([connectionController.signal, timeoutSignal]);
}
