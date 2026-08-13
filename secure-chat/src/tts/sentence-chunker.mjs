import { TTSError } from "./contracts.mjs";

const TERMINATORS = new Set([".", "?", "!", "。", "？", "！", "\n"]);
const CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "}"]);
const SOFT_BREAKS = new Set([" ", "\n", ",", "，", ";", ":", "、"]);

function isDecimalPoint(text, index) {
  const previousIsDigit = /\d/.test(text[index - 1] ?? "");
  const next = text[index + 1];
  return text[index] === "." && previousIsDigit && (next === undefined || /\d/.test(next));
}

function cleanSegment(text) {
  return text.replace(/\s+/gu, " ").trim();
}

export class KoreanSentenceChunker {
  #buffer = "";

  constructor({ maxCharacters = 120, minimumSoftBreak = 48 } = {}) {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 24) throw new TTSError("invalid_chunk_size");
    if (!Number.isSafeInteger(minimumSoftBreak) || minimumSoftBreak < 1 || minimumSoftBreak >= maxCharacters) {
      throw new TTSError("invalid_soft_break");
    }
    this.maxCharacters = maxCharacters;
    this.minimumSoftBreak = minimumSoftBreak;
  }

  get bufferedCharacters() {
    return this.#buffer.length;
  }

  push(fragment) {
    if (typeof fragment !== "string") throw new TTSError("invalid_tts_fragment");
    if (!fragment) return [];
    this.#buffer += fragment.replaceAll("\u0000", "");
    return this.#drain(false);
  }

  flush() {
    const chunks = this.#drain(true);
    this.#buffer = "";
    return chunks;
  }

  reset() {
    this.#buffer = "";
  }

  #drain(flush) {
    const chunks = [];
    while (this.#buffer) {
      const sentenceEnd = this.#sentenceBoundary();
      if (sentenceEnd > 0) {
        this.#take(sentenceEnd, chunks);
        continue;
      }
      if (this.#buffer.length >= this.maxCharacters) {
        this.#take(this.#boundedBreak(), chunks);
        continue;
      }
      break;
    }
    if (flush && this.#buffer) this.#take(this.#buffer.length, chunks);
    return chunks;
  }

  #sentenceBoundary() {
    for (let index = 0; index < this.#buffer.length; index += 1) {
      if (!TERMINATORS.has(this.#buffer[index]) || isDecimalPoint(this.#buffer, index)) continue;
      let end = index + 1;
      while (CLOSERS.has(this.#buffer[end])) end += 1;
      return end;
    }
    return 0;
  }

  #boundedBreak() {
    for (let index = this.maxCharacters; index >= this.minimumSoftBreak; index -= 1) {
      if (SOFT_BREAKS.has(this.#buffer[index - 1])) return index;
    }
    return this.maxCharacters;
  }

  #take(length, chunks) {
    const segment = cleanSegment(this.#buffer.slice(0, length));
    this.#buffer = this.#buffer.slice(length).replace(/^\s+/u, "");
    if (segment) chunks.push(segment);
  }
}
