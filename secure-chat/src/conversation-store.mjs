/**
 * 챗지피티처럼 대화가 여러 개여도, 원본은 맥 디스크에만 둔다.
 */
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const CONVERSATION_SCHEMA = "local-ai.conversations.v1";
const MAX_CONVERSATIONS = 200;
const MAX_MESSAGES = 400;
const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 1_800_000;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { statusCode });
}

function nowIso() {
  return new Date().toISOString();
}

function emptyState() {
  return { schema: CONVERSATION_SCHEMA, conversations: [], updatedAt: nowIso() };
}

function titleFrom(text) {
  const line = String(text ?? "").replace(/\s+/g, " ").trim();
  return line ? line.slice(0, 32) : "새 대화";
}

export class ConversationStore {
  constructor(filePath, imageDir) {
    if (typeof filePath !== "string" || !resolve(filePath).startsWith("/")) {
      fail("invalid_conversation_path");
    }
    this.path = resolve(filePath);
    this.imageDir = resolve(imageDir ?? join(dirname(this.path), "chat-images"));
    this.initialized = false;
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await mkdir(this.imageDir, { recursive: true, mode: 0o700 });
    try {
      await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#write(emptyState());
    }
    this.initialized = true;
    return this;
  }

  async list({ full = false } = {}) {
    const state = await this.#read();
    const ordered = state.conversations
      .slice()
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (full) return ordered;
    return ordered.map((item) => ({
      id: item.id,
      title: item.title,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      preview: previewOf(item),
      messageCount: item.messages.length,
    }));
  }

  async get(id) {
    const found = (await this.#read()).conversations.find((item) => item.id === id);
    if (!found) fail("conversation_not_found", 404);
    return found;
  }

  async create() {
    const state = await this.#read();
    const conversation = {
      id: randomUUID(),
      title: "새 대화",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      draft: "",
      messages: [],
    };
    state.conversations.unshift(conversation);
    this.#trim(state);
    await this.#write(state);
    return conversation;
  }

  async remove(id) {
    const state = await this.#read();
    const before = state.conversations.length;
    state.conversations = state.conversations.filter((item) => item.id !== id);
    if (state.conversations.length === before) fail("conversation_not_found", 404);
    await this.#write(state);
    return { ok: true, id };
  }

  async rename(id, title) {
    const cleaned = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (!cleaned) fail("empty_conversation_title");
    return this.#mutate(id, (conversation) => {
      conversation.title = cleaned;
    });
  }

  async setDraft(id, draft) {
    return this.#mutate(id, (conversation) => {
      conversation.draft = String(draft ?? "").slice(0, 8_000);
    });
  }

  async addUser(id, { text, images } = {}) {
    const content = String(text ?? "").trim().slice(0, 8_000);
    const files = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
    if (!content && files.length === 0) fail("empty_conversation_message");
    const savedImages = [];
    for (const image of files) {
      savedImages.push(await this.#saveImage(id, image));
    }
    return this.#mutate(id, (conversation) => {
      const message = {
        id: randomUUID(),
        role: "user",
        content: content || (savedImages.length ? "사진" : ""),
        createdAt: nowIso(),
        images: savedImages,
      };
      conversation.messages.push(message);
      if (conversation.title === "새 대화") conversation.title = titleFrom(message.content);
      return message;
    });
  }

  async addAssistant(id, text) {
    const content = String(text ?? "").trim().slice(0, 16_000);
    if (!content) fail("empty_conversation_message");
    return this.#mutate(id, (conversation) => {
      const message = {
        id: randomUUID(),
        role: "assistant",
        content,
        createdAt: nowIso(),
        images: [],
      };
      conversation.messages.push(message);
      return message;
    });
  }

  async upsert(payload) {
    const id = String(payload?.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) fail("invalid_conversation_id");
    const messages = Array.isArray(payload?.messages) ? payload.messages : [];
    const state = await this.#read();
    let conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) {
      conversation = {
        id,
        title: "새 대화",
        createdAt: typeof payload?.createdAt === "string" ? payload.createdAt : nowIso(),
        updatedAt: nowIso(),
        draft: "",
        messages: [],
      };
      state.conversations.unshift(conversation);
    }
    conversation.title = titleFrom(payload?.title) === "새 대화" && payload?.title
      ? String(payload.title).slice(0, 60)
      : String(payload?.title ?? conversation.title).slice(0, 60) || conversation.title;
    conversation.draft = String(payload?.draft ?? conversation.draft).slice(0, 8_000);
    conversation.messages = messages
      .filter((item) => item && ["user", "assistant"].includes(item.role) && typeof item.content === "string")
      .slice(-MAX_MESSAGES)
      .map((item) => ({
        id: /^[0-9a-f-]{36}$/i.test(String(item.id ?? "")) ? item.id : randomUUID(),
        role: item.role,
        content: item.content.slice(0, 16_000),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : nowIso(),
        images: Array.isArray(item.images) ? item.images.slice(0, MAX_IMAGES) : [],
      }));
    if (conversation.title === "새 대화") {
      const first = conversation.messages.find((item) => item.role === "user");
      if (first) conversation.title = titleFrom(first.content);
    }
    conversation.updatedAt = nowIso();
    this.#trim(state);
    await this.#write(state);
    return conversation;
  }

  async readImage(conversationId, imageId) {
    const conversation = await this.get(conversationId);
    const image = conversation.messages.flatMap((item) => item.images ?? []).find((item) => item.id === imageId);
    if (!image) fail("image_not_found", 404);
    const bytes = await readFile(this.#imagePath(conversationId, imageId));
    return { bytes, mime: image.mime ?? "image/jpeg" };
  }

  #imagePath(conversationId, imageId) {
    return join(this.imageDir, `${conversationId}-${imageId}.jpg`);
  }

  async #saveImage(conversationId, image) {
    const mime = String(image?.mime ?? "image/jpeg");
    if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "image/webp") {
      fail("unsupported_image_type");
    }
    const raw = String(image?.data ?? "").replace(/^data:[^,]+,/, "");
    const bytes = Buffer.from(raw, "base64");
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) fail("image_too_large");
    const id = randomUUID();
    await writeFile(this.#imagePath(conversationId, id), bytes, { mode: 0o600 });
    return { id, mime: "image/jpeg" };
  }

  async #mutate(id, change) {
    const state = await this.#read();
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) fail("conversation_not_found", 404);
    const extra = change(conversation);
    conversation.messages = conversation.messages.slice(-MAX_MESSAGES);
    conversation.updatedAt = nowIso();
    await this.#write(state);
    return extra === undefined ? conversation : { conversation, message: extra };
  }

  #trim(state) {
    if (state.conversations.length > MAX_CONVERSATIONS) {
      state.conversations = state.conversations
        .slice()
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, MAX_CONVERSATIONS);
    }
  }

  async #read() {
    if (!this.initialized) fail("conversations_not_initialized", 500);
    const raw = JSON.parse(await readFile(this.path, "utf8"));
    if (!raw || raw.schema !== CONVERSATION_SCHEMA || !Array.isArray(raw.conversations)) {
      fail("invalid_conversation_file", 500);
    }
    return raw;
  }

  async #write(data) {
    data.updatedAt = nowIso();
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(data)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
  }
}

function previewOf(conversation) {
  const last = [...(conversation.messages ?? [])].reverse().find((item) => item.content);
  return last ? String(last.content).replace(/\s+/g, " ").slice(0, 90) : "";
}
