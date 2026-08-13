function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed);
}

export function toOpenAICompletion(payload, model) {
  const content = payload?.message?.content;
  if (typeof content !== "string") throw new Error("malformed_ollama_response");
  return {
    id: `local-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

export async function* ollamaStreamToSSE(source, requestId = undefined) {
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const convert = function* (line) {
    const payload = parseLine(line);
    if (!payload) return;
    const content = payload?.message?.content;
    if (typeof content === "string" && content.length > 0) {
      yield `event: delta\ndata: ${JSON.stringify({ requestId, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    }
    if (payload.done === true && !finished) {
      finished = true;
    }
  };

  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      yield* convert(line);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) yield* convert(buffer);
  if (!finished) throw new Error("ollama_stream_interrupted");
}
