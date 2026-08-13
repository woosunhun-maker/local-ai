import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { containsCredential } from "../security/credential-patterns.mjs";

const execFileAsync = promisify(execFile);
const OPENCLAW = "/opt/homebrew/bin/openclaw";
const PROFILE = "chrome";
const MAX_OUTPUT = 2 * 1024 * 1024;
const ALLOWED_ORIGINS = Object.freeze({
  coupang: new Set(["https://www.coupang.com", "https://m.coupang.com"]),
  gmail: new Set(["https://mail.google.com"]),
});

function browserError(code, statusCode = 502) {
  return Object.assign(new Error(code), { code, statusCode });
}

function parseJsonOutput(value) {
  if (typeof value !== "string" || value.length > MAX_OUTPUT) throw browserError("browser_response_invalid");
  try {
    return JSON.parse(value);
  } catch {
    throw browserError("browser_response_invalid");
  }
}

function targetId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw browserError("invalid_browser_target", 400);
  return value;
}

function ref(value) {
  if (typeof value !== "string" || !/^(?:e|ax)?[1-9][0-9]{0,5}$/.test(value)) throw browserError("invalid_browser_ref", 400);
  return value;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    throw browserError("invalid_browser_url");
  }
}

function serviceForUrl(value) {
  const url = parseUrl(value);
  for (const [service, origins] of Object.entries(ALLOWED_ORIGINS)) {
    if (origins.has(url.origin)) return service;
  }
  return null;
}

async function defaultRunner(args, timeoutMs) {
  try {
    const result = await execFileAsync(OPENCLAW, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    return result.stdout;
  } catch {
    // OpenClaw errors can include page content or local details. Never propagate them.
    throw browserError("shared_browser_unavailable", 503);
  }
}

export class SharedChromeClient {
  constructor({ runner = defaultRunner } = {}) {
    this.runner = runner;
  }

  async command(parts, timeoutMs = 20_000) {
    if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string" || part.length > 4_000)) {
      throw browserError("invalid_browser_command", 400);
    }
    return parseJsonOutput(await this.runner(["browser", "--browser-profile", PROFILE, "--json", ...parts], timeoutMs));
  }

  async status() {
    const value = await this.command(["status"], 8_000);
    return {
      connected: value?.running === true && value?.cdpReady === true,
      pageReady: value?.pageReady === true,
    };
  }

  async tabs() {
    const value = await this.command(["tabs"], 8_000);
    if (!Array.isArray(value?.tabs) || value.tabs.length > 50) throw browserError("browser_response_invalid");
    return value.tabs.map((tab) => {
      const id = targetId(tab.targetId ?? tab.id);
      const url = parseUrl(tab.url);
      return {
        id,
        service: serviceForUrl(url.toString()),
        url: url.toString(),
        title: typeof tab.title === "string" ? tab.title.slice(0, 240) : "",
      };
    });
  }

  async findSharedTab(service) {
    if (!Object.hasOwn(ALLOWED_ORIGINS, service)) throw browserError("unsupported_browser_service", 400);
    return (await this.tabs()).find((tab) => tab.service === service) ?? null;
  }

  async snapshot(id) {
    const value = await this.command([
      "snapshot", "--interactive", "--compact", "--depth", "8", "--limit", "800", "--urls", "--target-id", targetId(id),
    ]);
    if (value?.format !== "ai" || typeof value.snapshot !== "string" || value.snapshot.length > 200_000) {
      throw browserError("browser_snapshot_invalid");
    }
    return { snapshot: value.snapshot, targetId: id };
  }

  async navigateCoupangSearch(id, query) {
    const normalized = String(query ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
    if (!normalized || normalized.length > 120) throw browserError("invalid_coupang_query", 400);
    if (containsCredential(normalized, { includeLooseAssignments: true })) {
      throw browserError("credential_in_browser_query", 403);
    }
    const url = new URL("https://www.coupang.com/np/search");
    url.searchParams.set("q", normalized);
    const result = await this.command(["navigate", url.toString(), "--target-id", targetId(id)]);
    if (serviceForUrl(result?.url ?? url.toString()) !== "coupang") throw browserError("browser_origin_changed", 409);
    return { ok: true, url: result?.url ?? url.toString() };
  }

  async click(id, elementRef, service) {
    if (!Object.hasOwn(ALLOWED_ORIGINS, service)) throw browserError("unsupported_browser_service", 400);
    const result = await this.command(["click", ref(elementRef), "--target-id", targetId(id)]);
    if (typeof result?.url === "string" && serviceForUrl(result.url) !== service) throw browserError("browser_origin_changed", 409);
    return { ok: true, url: typeof result?.url === "string" ? result.url : null };
  }
}

export const SHARED_BROWSER_SERVICES = Object.freeze(Object.keys(ALLOWED_ORIGINS));
