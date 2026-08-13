export class EphemeralTelegramContext {
  constructor({ now = () => Date.now(), ttlMs = 15 * 60_000, maxMessages = 12, maxCharacters = 12_000 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000) throw new Error("invalid_context_ttl");
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 2) throw new Error("invalid_context_message_limit");
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1_000) throw new Error("invalid_context_character_limit");
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.maxCharacters = maxCharacters;
    this.entries = new Map();
  }

  get(key) {
    const id = String(key);
    const entry = this.entries.get(id);
    if (!entry || this.now() - entry.touchedAt >= this.ttlMs) {
      this.entries.delete(id);
      return [];
    }
    return entry.messages.map((message) => ({ ...message }));
  }

  append(key, role, content) {
    if (!new Set(["user", "assistant"]).has(role) || typeof content !== "string" || !content.trim()) throw new Error("invalid_context_message");
    const id = String(key);
    const messages = [...this.get(id), { role, content: content.trim().slice(0, 4_000) }].slice(-this.maxMessages);
    while (messages.reduce((total, message) => total + message.content.length, 0) > this.maxCharacters) messages.shift();
    this.entries.set(id, { touchedAt: this.now(), messages });
  }

  clear(key) {
    this.entries.delete(String(key));
  }
}
