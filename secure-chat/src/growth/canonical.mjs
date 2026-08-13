import { createHash } from "node:crypto";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function normalizeString(value) {
  return value.normalize("NFC");
}

function assertPlainObject(value, path) {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain JSON object`);
  }
}

function canonicalizeValue(value, path, ancestors) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(normalizeString(value));
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => canonicalizeValue(entry, `${path}[${index}]`, ancestors)).join(",")}]`;
    }

    assertPlainObject(value, path);
    const normalizedEntries = [];
    const normalizedKeys = new Set();
    for (const [rawKey, entry] of Object.entries(value)) {
      const key = normalizeString(rawKey);
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`${path} contains a forbidden key`);
      if (normalizedKeys.has(key)) throw new TypeError(`${path} contains colliding normalized keys`);
      normalizedKeys.add(key);
      normalizedEntries.push([key, entry]);
    }
    normalizedEntries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${normalizedEntries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalizeValue(entry, `${path}.${key}`, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value) {
  return canonicalizeValue(value, "$", new Set());
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value) {
  return sha256Hex(canonicalizeJson(value));
}

export function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
