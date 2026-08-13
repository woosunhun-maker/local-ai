import assert from "node:assert/strict";
import test from "node:test";
import {
  containsCredential,
  credentialFindingCodes,
  CREDENTIAL_REDACTION,
  redactCredentials,
} from "../src/security/credential-patterns.mjs";

function fixtureCredentials() {
  const jwt = [
    ["ey", "J", "a".repeat(18)].join(""),
    ["ey", "J", "b".repeat(18)].join(""),
    ["c".repeat(22)].join(""),
  ].join(".");
  return Object.freeze([
    Object.freeze(["lg_thinq_pat", ["thin", "qpat_", "a".repeat(56)].join("")]),
    Object.freeze(["telegram_bot_token", ["123456789", ":", "A".repeat(35)].join("")]),
    Object.freeze(["aws_access_key", ["A", "KIA", "B".repeat(16)].join("")]),
    Object.freeze(["google_api_key", ["AI", "za", "C".repeat(35)].join("")]),
    Object.freeze(["github_token", ["gh", "p_", "D".repeat(32)].join("")]),
    Object.freeze(["slack_token", ["xox", "b-", "E".repeat(32)].join("")]),
    Object.freeze(["openai_key", ["s", "k-proj-", "F".repeat(32)].join("")]),
    Object.freeze(["jwt", jwt]),
  ]);
}

test("detects each strong credential family without returning credential values", () => {
  for (const [expectedCode, value] of fixtureCredentials()) {
    const codes = credentialFindingCodes(`prefix ${value} suffix`);
    assert.equal(codes.includes(expectedCode), true, expectedCode);
    assert.equal(JSON.stringify(codes).includes(value), false, expectedCode);
  }

  const privateKeyHeader = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
  assert.deepEqual(credentialFindingCodes(privateKeyHeader), ["private_key"]);
});

test("detects bearer values and strict or opt-in loose assignments", () => {
  const bearerValue = ["header", ".", "payload", ".", "signature"].join("");
  assert.equal(containsCredential(`Bearer ${bearerValue}`), true);

  const assignedSecret = ["assigned", "-", "secret", "-", "value"].join("");
  assert.equal(containsCredential(`client_secret='${assignedSecret}'`), true);

  const looseValue = ["generic", "-", "token", "-", "value"].join("");
  assert.equal(containsCredential(`token='${looseValue}'`), false);
  assert.equal(containsCredential(`token='${looseValue}'`, { includeLooseAssignments: true }), true);

  const unlabeledHomeAssistantValue = `random-${"H".repeat(24)}`;
  assert.equal(containsCredential(`home_assistant_token='${unlabeledHomeAssistantValue}'`), true);
  assert.equal(containsCredential(`lg_thinq_pat='${unlabeledHomeAssistantValue}'`), true);
});

test("URL-safe credentials ending in punctuation-safe alphabet characters are detected", () => {
  const endingHyphen = Object.freeze([
    ["lg_thinq_pat", ["thin", "qpat_", "A".repeat(31), "-"].join("")],
    ["google_api_key", ["AI", "za", "B".repeat(34), "-"].join("")],
    ["slack_token", ["xox", "b-", "C".repeat(15), "-"].join("")],
    ["openai_key", ["s", "k-", "D".repeat(15), "-"].join("")],
    ["jwt", [["ey", "J", "E".repeat(8)].join(""), "F".repeat(8), `${"G".repeat(7)}-`].join(".")],
  ]);
  for (const [code, value] of endingHyphen) {
    assert.equal(credentialFindingCodes(`(${value})`).includes(code), true, code);
    assert.equal(redactCredentials(`(${value})`).includes(value), false, code);
  }
});

test("detects and redacts a Telegram bot token inside its API path", () => {
  const token = ["123456789", ":", "Z".repeat(35)].join("");
  const source = `https://api.telegram.invalid/bot${token}/sendMessage`;
  assert.deepEqual(credentialFindingCodes(source), ["telegram_bot_token"]);
  const redacted = redactCredentials(source);
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted, `https://api.telegram.invalid/bot${CREDENTIAL_REDACTION}/sendMessage`);
});

test("environment references and explicit redaction placeholders stay usable", () => {
  const benign = [
    "api_key=process.env.OPENAI_API_KEY",
    "client_secret='${CLIENT_SECRET}'",
    "access_token=$ACCESS_TOKEN",
    `password='${CREDENTIAL_REDACTION}'`,
  ];
  for (const value of benign) {
    assert.equal(containsCredential(value, { includeLooseAssignments: true }), false, value);
  }
});

test("isolated source scanning can explicitly allow code references", () => {
  for (const value of [
    "authorization=normalizeAuthorization",
    "secret=pairingLink.secret",
    "authorization='Bearer ${state.token}'",
  ]) {
    assert.equal(containsCredential(value), true, value);
    assert.equal(containsCredential(value, { allowCodeReferences: true }), false, value);
  }
});

test("redacts the credential value while preserving surrounding context", () => {
  const fixtures = fixtureCredentials();
  const privateHeader = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
  const privateFooter = ["-----END ", "PRIVATE KEY", "-----"].join("");
  const privateBlock = [privateHeader, "QUJDREVGR0g=", privateFooter].join("\n");
  const looseValue = ["generic", "-", "credential", "-", "value"].join("");
  const source = [
    "before",
    ...fixtures.map(([, value]) => value),
    `token='${looseValue}'`,
    privateBlock,
    "after",
  ].join("\n");

  const redacted = redactCredentials(source, { includeLooseAssignments: true });
  for (const [, value] of fixtures) assert.equal(redacted.includes(value), false);
  assert.equal(redacted.includes(looseValue), false);
  assert.equal(redacted.includes("QUJDREVGR0g="), false);
  assert.equal(redacted.startsWith("before\n"), true);
  assert.equal(redacted.endsWith("\nafter"), true);
  assert.equal(redacted.includes(CREDENTIAL_REDACTION), true);
  assert.equal(redactCredentials(redacted, { includeLooseAssignments: true }), redacted);
});

test("a truncated private-key block redacts the remaining material fail closed", () => {
  const privateHeader = ["-----BEGIN ", "PRIVATE KEY", "-----"].join("");
  const redacted = redactCredentials(`before\n${privateHeader}\nSYNTHETIC_KEY_MATERIAL\nprivate tail`);
  assert.equal(redacted, `before\n${CREDENTIAL_REDACTION}`);
});

test("allowSynthetic exempts only the exact repository-owned legacy fixture", () => {
  const fixture = ["123456789", ":", "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghi"].join("");
  const neighbor = `${fixture}Z`;
  assert.equal(containsCredential(fixture), true);
  assert.equal(containsCredential(fixture, { allowSynthetic: true }), false);
  assert.equal(containsCredential(neighbor, { allowSynthetic: true }), true);
});

test("scans a one-megabyte benign input and still detects a credential at the end", () => {
  const credential = ["thin", "qpat_", "9".repeat(56)].join("");
  const largeInput = `${"ordinary text ".repeat(80_000)} ${credential}`;
  assert.equal(largeInput.length > 1_000_000, true);
  assert.deepEqual(credentialFindingCodes(largeInput), ["lg_thinq_pat"]);
});

test("non-string detection is safe and invalid redaction inputs fail closed", () => {
  assert.deepEqual(credentialFindingCodes(null), []);
  assert.equal(containsCredential(undefined), false);
  assert.throws(() => redactCredentials(null), /credential_text_required/u);
  assert.throws(() => redactCredentials("safe", { replacement: "" }), /credential_replacement_invalid/u);
});
