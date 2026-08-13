const POLICIES = Object.freeze({
  decision: Object.freeze({ bucket: "decision", limit: 20, windowMs: 60_000 }),
  chat: Object.freeze({ bucket: "chat", limit: 30, windowMs: 60_000 }),
  tts: Object.freeze({ bucket: "tts", limit: 120, windowMs: 60_000 }),
  read: Object.freeze({ bucket: "read", limit: 180, windowMs: 60_000 }),
  other: Object.freeze({ bucket: "other", limit: 60, windowMs: 60_000 }),
});

export function ratePolicyFor(method, path) {
  if (method === "POST" && (
    /^\/api\/approvals\/.+\/decision$/.test(path) ||
    /^\/api\/codex\/approvals\/.+\/decision$/.test(path) ||
    path === "/api/approval-key" ||
    path === "/api/codex/approval-key"
  )) return POLICIES.decision;
  if (method === "POST" && path === "/api/chat") return POLICIES.chat;
  if (method === "POST" && path === "/api/tts/stream") return POLICIES.tts;
  if (method === "GET" && path.startsWith("/api/")) return POLICIES.read;
  return POLICIES.other;
}

export class FixedWindowRateLimiter {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.entries = new Map();
  }

  allow(subject, policy) {
    const now = this.now();
    const key = `${subject}:${policy.bucket}`;
    const current = this.entries.get(key) ?? { startedAt: now, count: 0 };
    if (now - current.startedAt >= policy.windowMs) {
      current.startedAt = now;
      current.count = 0;
    }
    current.count += 1;
    this.entries.set(key, current);
    return current.count <= policy.limit;
  }
}
