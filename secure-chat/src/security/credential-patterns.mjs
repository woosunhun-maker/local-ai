export const CREDENTIAL_REDACTION = "[REDACTED_CREDENTIAL]";

// Keep matchers factory-backed. Each scan receives a fresh RegExp, so global
// lastIndex state can never leak between concurrent requests.
const STRONG_CREDENTIAL_PATTERNS = Object.freeze([
  Object.freeze({
    code: "private_key",
    expression: () => /(?<secret>-----BEGIN [A-Z0-9 ]{0,48}PRIVATE KEY-----)/gu,
  }),
  Object.freeze({
    code: "lg_thinq_pat",
    expression: () => /(?<prefix>^|[^A-Za-z0-9_])(?<secret>thinqpat_[A-Za-z0-9_-]{32,128})(?![A-Za-z0-9_-])/giu,
  }),
  Object.freeze({
    code: "telegram_bot_token",
    // A Telegram token is commonly embedded after "/bot" in an API URL, so a
    // word boundary before its numeric id is not sufficient. Preserve the
    // non-digit predecessor as context when redacting.
    expression: () => /(?<prefix>^|[^0-9])(?<secret>[0-9]{8,14}:[A-Za-z0-9_-]{30,128})(?![A-Za-z0-9_-])/gu,
  }),
  Object.freeze({
    code: "aws_access_key",
    expression: () => /\b(?<secret>(?:AKIA|ASIA)[A-Z0-9]{16})(?![A-Z0-9])/gu,
  }),
  Object.freeze({
    code: "google_api_key",
    expression: () => /(?<prefix>^|[^A-Za-z0-9_])(?<secret>AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9_-])/gu,
  }),
  Object.freeze({
    code: "github_token",
    expression: () => /\b(?<secret>(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}))\b/gu,
  }),
  Object.freeze({
    code: "slack_token",
    expression: () => /(?<prefix>^|[^A-Za-z0-9_])(?<secret>xox[baprs]-[A-Za-z0-9-]{16,255})(?![A-Za-z0-9-])/gu,
  }),
  Object.freeze({
    code: "openai_key",
    expression: () => /(?<prefix>^|[^A-Za-z0-9_])(?<secret>(?:sk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,255})(?![A-Za-z0-9_-])/gu,
  }),
  Object.freeze({
    code: "jwt",
    expression: () => /(?<prefix>^|[^A-Za-z0-9_])(?<secret>eyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048})(?![A-Za-z0-9_-])/gu,
  }),
  Object.freeze({
    code: "bearer_token",
    expression: () => /(?<prefix>\bBearer[ \t]+)(?<secret>[A-Za-z0-9._~+/=-]{16,4096})/giu,
  }),
  Object.freeze({
    code: "credential_assignment",
    expression: () => /(?<prefix>["'`]?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|home[_ -]?assistant[_ -]?token|ha[_ -]?token|(?:lg[_ -]?)?thinq[_ -]?(?:pat|token)|password|passwd|secret|authorization|bearer)["'`]?\s*[:=]\s*(?<quote>["'`]))(?<secret>[^"'`\r\n]{12,})(?<suffix>\k<quote>)/giu,
  }),
  Object.freeze({
    code: "credential_assignment",
    expression: () => /(?<prefix>["'`]?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|private[_ -]?key|home[_ -]?assistant[_ -]?token|ha[_ -]?token|(?:lg[_ -]?)?thinq[_ -]?(?:pat|token)|password|passwd|secret|authorization|bearer)["'`]?\s*[:=]\s*)(?<secret>[A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})/giu,
  }),
]);

const LOOSE_ASSIGNMENT_PATTERNS = Object.freeze([
  Object.freeze({
    code: "credential_assignment",
    expression: () => /(?<prefix>["'`]?(?:token|key|credential|auth)["'`]?\s*[:=]\s*(?<quote>["'`]))(?<secret>[^"'`\r\n]{12,})(?<suffix>\k<quote>)/giu,
  }),
  Object.freeze({
    code: "credential_assignment",
    expression: () => /(?<prefix>["'`]?(?:token|key|credential|auth)["'`]?\s*[:=]\s*)(?<secret>[A-Za-z0-9][A-Za-z0-9._~+/=-]{15,})/giu,
  }),
]);

// These are exact, repository-owned fixtures that predate the shared detector.
// Constructing them from pieces keeps credential-shaped literals out of source.
const SYNTHETIC_CREDENTIAL_VALUES = new Set([
  ["123456789", ":", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghi"].join(""),
  ["ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", "signaturevalue"].join(""),
  ["sk", "-proj-", "synthetic_DO_NOT_EXPOSE_", "12345678901234567890"].join(""),
]);

const SAFE_PLACEHOLDER_VALUES = new Set([
  CREDENTIAL_REDACTION,
  "<redacted>",
  "REDACTED",
]);

const CREDENTIAL_REFERENCE_PATTERNS = Object.freeze([
  /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}\r\n]*)?\}$/u,
  /^\$[A-Za-z_][A-Za-z0-9_]*$/u,
  /^(?:process|import\.meta)\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[["'][A-Za-z_][A-Za-z0-9_]*["']\])$/u,
  /^(?:Deno|Bun)\.env\.get\(["'][A-Za-z_][A-Za-z0-9_]*["']\)$/u,
]);

const SOURCE_CODE_REFERENCE_PATTERNS = Object.freeze([
  /^(?:Bearer[ \t]+)?\$\{[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*\}$/u,
  /^[A-Za-z_$][A-Za-z0-9_$]*$/u,
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u,
]);

function selectedPatterns(includeLooseAssignments) {
  return includeLooseAssignments
    ? [...STRONG_CREDENTIAL_PATTERNS, ...LOOSE_ASSIGNMENT_PATTERNS]
    : STRONG_CREDENTIAL_PATTERNS;
}

function shouldIgnoreCredential(value, { allowSynthetic, allowCodeReferences }, code) {
  const normalized = String(value ?? "").trim();
  if (SAFE_PLACEHOLDER_VALUES.has(normalized)) return true;
  if (code === "credential_assignment") {
    if (CREDENTIAL_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
    if (allowCodeReferences && SOURCE_CODE_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  }
  return allowSynthetic && SYNTHETIC_CREDENTIAL_VALUES.has(normalized);
}

function scanCredentialCodes(text, options) {
  if (typeof text !== "string" || text.length === 0) return [];
  const codes = [];
  const seen = new Set();
  for (const pattern of selectedPatterns(options.includeLooseAssignments)) {
    for (const match of text.matchAll(pattern.expression())) {
      const value = match.groups?.secret ?? match[0];
      if (shouldIgnoreCredential(value, options, pattern.code) || seen.has(pattern.code)) continue;
      seen.add(pattern.code);
      codes.push(pattern.code);
    }
  }
  return codes;
}

export function credentialFindingCodes(text, {
  includeLooseAssignments = false,
  allowSynthetic = false,
  allowCodeReferences = false,
} = {}) {
  return Object.freeze(scanCredentialCodes(text, {
    includeLooseAssignments: includeLooseAssignments === true,
    allowSynthetic: allowSynthetic === true,
    allowCodeReferences: allowCodeReferences === true,
  }));
}

export function containsCredential(text, options = {}) {
  return credentialFindingCodes(text, options).length > 0;
}

function redactPrivateKeyBlocks(text, replacement) {
  const begin = /-----BEGIN ([A-Z0-9 ]{0,48}PRIVATE KEY)-----/gu;
  let output = "";
  let offset = 0;
  for (const match of text.matchAll(begin)) {
    if (match.index < offset) continue;
    const endMarker = `-----END ${match[1]}-----`;
    const endIndex = text.indexOf(endMarker, match.index + match[0].length);
    output += text.slice(offset, match.index);
    if (endIndex === -1) {
      output += replacement;
      // A truncated PEM block is still sensitive. Fail closed by suppressing
      // the remainder instead of returning key material without its header.
      offset = text.length;
    } else {
      output += replacement;
      offset = endIndex + endMarker.length;
    }
  }
  return output + text.slice(offset);
}

function redactPattern(text, pattern, options, replacement) {
  return text.replace(pattern.expression(), (...args) => {
    const match = args[0];
    const groups = typeof args.at(-1) === "object" ? args.at(-1) : null;
    const value = groups?.secret ?? match;
    if (shouldIgnoreCredential(value, options, pattern.code)) return match;
    const valueOffset = match.indexOf(value);
    if (valueOffset < 0) return replacement;
    return `${match.slice(0, valueOffset)}${replacement}${match.slice(valueOffset + value.length)}`;
  });
}

export function redactCredentials(text, {
  includeLooseAssignments = false,
  allowSynthetic = false,
  allowCodeReferences = false,
  replacement = CREDENTIAL_REDACTION,
} = {}) {
  if (typeof text !== "string") throw new TypeError("credential_text_required");
  if (typeof replacement !== "string" || replacement.length < 1 || replacement.length > 128) {
    throw new TypeError("credential_replacement_invalid");
  }
  const options = {
    includeLooseAssignments: includeLooseAssignments === true,
    allowSynthetic: allowSynthetic === true,
    allowCodeReferences: allowCodeReferences === true,
  };
  let redacted = redactPrivateKeyBlocks(text, replacement);
  for (const pattern of selectedPatterns(options.includeLooseAssignments)) {
    if (pattern.code === "private_key") continue;
    redacted = redactPattern(redacted, pattern, options, replacement);
  }
  return redacted;
}
