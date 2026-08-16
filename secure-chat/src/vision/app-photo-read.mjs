import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1_800_000;
const OCR_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/ocr-local.swift");

function decodeOwnerImage(raw) {
  if (typeof raw !== "string" || raw.length < 32 || raw.length > 2_800_000) {
    throw Object.assign(new Error("invalid_app_image"), { statusCode: 400 });
  }
  const compact = raw.replace(/^data:image\/\w+;base64,/, "").replace(/\s+/g, "");
  let buffer;
  try {
    buffer = Buffer.from(compact, "base64");
  } catch {
    throw Object.assign(new Error("invalid_app_image"), { statusCode: 400 });
  }
  if (buffer.length < 32 || buffer.length > MAX_BYTES) {
    throw Object.assign(new Error("app_image_too_large"), { statusCode: 413 });
  }
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (!jpeg && !png) {
    throw Object.assign(new Error("unsupported_app_image"), { statusCode: 400 });
  }
  return { buffer, ext: jpeg ? "jpg" : "png" };
}

export function inspectOwnerAppImage(raw) {
  return decodeOwnerImage(raw);
}

export async function readOwnerAppPhoto(raw, { runner } = {}) {
  const { buffer, ext } = decodeOwnerImage(raw);
  if (typeof runner === "function") {
    const text = await runner(buffer, ext);
    return String(text || "").trim();
  }
  const dir = await mkdtemp(join(tmpdir(), "localai-ocr-"));
  const file = join(dir, `photo.${ext}`);
  try {
    await writeFile(file, buffer);
    const text = await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/swift", [OCR_SCRIPT, file], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(Object.assign(new Error("app_ocr_timeout"), { statusCode: 504 }));
      }, 20_000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length < 32_000) stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 4_000) stderr += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(Object.assign(new Error("app_ocr_failed"), { statusCode: 502, detail: stderr.slice(0, 200) }));
          return;
        }
        resolve(stdout);
      });
    });
    const cleaned = String(text || "").replace(/\s+\n/g, "\n").trim();
    if (cleaned.length < 2) {
      throw Object.assign(new Error("app_ocr_empty"), { statusCode: 422 });
    }
    return cleaned.slice(0, 8_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
