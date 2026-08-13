/**
 * 확인형 공통 장기기억 (채팅방/폴더와 무관).
 * ai-council MemoryStore와 같은 JSON 스키마를 공유한다.
 */
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const FORBIDDEN = /비밀번호|패스워드|password|otp|인증번호|주민등록|계좌|카드번호|010[-.\s]?\d{3,4}/iu;
const TOKEN = /[0-9A-Za-z가-힣]{2,}/gu;

export class ConfirmedMemoryStoreError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.name = "ConfirmedMemoryStoreError";
    this.statusCode = statusCode;
  }
}

function fail(code, statusCode = 400) {
  throw new ConfirmedMemoryStoreError(code, statusCode);
}

function nowSeconds() {
  return Date.now() / 1000;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") fail("invalid_memory_item");
  return {
    id: String(raw.id),
    text: String(raw.text),
    status: String(raw.status),
    share_external: Boolean(raw.share_external),
    created_at: Number(raw.created_at) || 0,
    updated_at: Number(raw.updated_at) || 0,
  };
}

function tokensOf(text) {
  const matches = String(text).match(TOKEN) ?? [];
  return new Set(matches.map((token) => token.toLowerCase()));
}

export class ConfirmedMemoryStore {
  constructor(filePath) {
    if (typeof filePath !== "string" || !resolve(filePath).startsWith("/")) {
      fail("invalid_confirmed_memory_path");
    }
    this.path = resolve(filePath);
    this.initialized = false;
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#write({ items: [] });
    }
    this.initialized = true;
    return this;
  }

  async #read() {
    if (!this.initialized) fail("confirmed_memory_not_initialized", 500);
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || !Array.isArray(raw.items)) fail("invalid_confirmed_memory_file", 500);
    return raw;
  }

  async #write(data) {
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(data, null, 2)}\n`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }

  async listActive() {
    const data = await this.#read();
    return data.items.map(normalizeItem).filter((item) => item.status === "active");
  }

  async listCandidates() {
    const data = await this.#read();
    return data.items.map(normalizeItem).filter((item) => item.status === "candidate");
  }

  async countActive() {
    return (await this.listActive()).length;
  }

  async propose(text) {
    const cleaned = String(text ?? "").trim();
    if (!cleaned) fail("empty_memory_text");
    if (FORBIDDEN.test(cleaned)) fail("forbidden_sensitive_memory");
    const stamp = nowSeconds();
    const item = {
      id: randomUUID(),
      text: cleaned,
      status: "candidate",
      share_external: false,
      created_at: stamp,
      updated_at: stamp,
    };
    const data = await this.#read();
    data.items.push(item);
    await this.#write(data);
    return item;
  }

  async confirm(memoryId, { shareExternal = false } = {}) {
    const data = await this.#read();
    const target = data.items.find((item) => item?.id === memoryId);
    if (!target) fail("memory_not_found", 404);
    target.status = "active";
    target.share_external = Boolean(shareExternal);
    target.updated_at = nowSeconds();
    await this.#write(data);
    return normalizeItem(target);
  }

  async selectForPrompt(query, { limit = 6, forExternal = false, charLimit = 1200 } = {}) {
    let active = await this.listActive();
    if (forExternal) active = active.filter((item) => item.share_external);
    if (active.length < 1) return [];

    const queryTokens = tokensOf(query);
    const scored = active.map((item) => {
      const overlap = [...tokensOf(item.text)].filter((token) => queryTokens.has(token)).length;
      return { overlap, updatedAt: item.updated_at, item };
    });
    scored.sort((left, right) => {
      if (right.overlap !== left.overlap) return right.overlap - left.overlap;
      return right.updatedAt - left.updatedAt;
    });
    if (scored[0]?.overlap === 0) {
      scored.sort((left, right) => right.updatedAt - left.updatedAt);
    }

    const selected = [];
    let used = 0;
    for (const row of scored) {
      if (selected.length >= limit) break;
      if (used + row.item.text.length > charLimit && selected.length > 0) break;
      selected.push(row.item);
      used += row.item.text.length;
    }
    return selected;
  }

  async activeContextBlock(query = "", { forExternal = false, limit = 6 } = {}) {
    const items = await this.selectForPrompt(query, { forExternal, limit });
    if (items.length < 1) return "";
    return `사용자에 대해 확인된 기억(관련 항목만):\n${items.map((item) => `- ${item.text}`).join("\n")}`;
  }
}

export function withMemorySystemMessage(messages, memoryBlock) {
  const block = String(memoryBlock ?? "").trim();
  if (!block) return messages;
  const systemPrefix =
    "당신은 사용자의 Mac에서 동작하는 로컬 AI입니다. 클라우드가 아닙니다. " +
    "확인된 기억만 사실로 참고하고, 없는 내용은 지어내지 마세요.\n\n" +
    block;
  const cloned = messages.map((message) => ({ ...message }));
  const first = cloned[0];
  if (first?.role === "system") {
    cloned[0] = { ...first, content: `${first.content}\n\n${systemPrefix}` };
    return cloned;
  }
  return [{ role: "system", content: systemPrefix }, ...cloned];
}
