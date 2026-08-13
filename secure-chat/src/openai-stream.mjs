export async function* verifyOpenAIEventStream(source) {
  const decoder = new TextDecoder();
  let tail = "";
  let completed = false;

  const inspect = (text) => {
    tail = `${tail}${text}`;
    if (/(?:^|\n)data:\s*\[DONE\]\s*(?:\n|$)/.test(tail) || /(?:^|\n)event:\s*done\s*(?:\n|$)/.test(tail)) {
      completed = true;
    }
    tail = tail.slice(-256);
  };

  for await (const chunk of source) {
    inspect(decoder.decode(chunk, { stream: true }));
    yield chunk;
  }
  inspect(decoder.decode());

  if (!completed) throw new Error("openai_stream_interrupted");
}
