import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createOpenClawGrowthDispatchAdapter,
  parseStructuredAdvice,
  proposalContentFromAdvice,
} from "../src/growth/openclaw-dispatch-adapter.mjs";
import { validateProposalRecord, createUntrustedProposal } from "../src/growth/proposal.mjs";

const advice = {
  judgment: "지연이 임계치를 넘었습니다.",
  evidence: "집계 지연 수치만으로 병목 후보를 좁힐 수 있습니다.",
  risks: "실제 입력으로 시험하면 개인정보가 섞일 수 있습니다.",
  recommendation: "고정 합성 입력으로 큐 대기 시간을 먼저 비교합니다.",
};

function clientEnvelope(text = JSON.stringify(advice), overrides = {}) {
  return {
    version: 1,
    ok: true,
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning: "high",
    executionMode: "stateless_tool_free",
    outputs: [{ text }],
    ...overrides,
  };
}

test("external advice accepts only the fixed four-field text contract", () => {
  assert.deepEqual(parseStructuredAdvice(JSON.stringify(advice)), advice);
  assert.throws(() => parseStructuredAdvice(JSON.stringify({ ...advice, command: "run" })), /schema_invalid/);
  assert.throws(() => parseStructuredAdvice(JSON.stringify({ ...advice, risks: "\u202Ehidden" })), /display_unsafe/);
});

test("structured advice maps only to an untrusted synthetic proposal", () => {
  const content = proposalContentFromAdvice(advice);
  const proposal = createUntrustedProposal({
    outboundRequestSha256: "a".repeat(64),
    provider: "openai",
    model: "gpt-5.6-sol",
    externalResponse: JSON.stringify(advice),
    content,
  }, { now: Date.parse("2026-08-05T00:00:00.000Z"), id: "synthetic_correlation_1" });
  assert.equal(validateProposalRecord(proposal), true);
  assert.equal(proposal.trust, "untrusted_external_advice");
  assert.equal(proposal.content.tests[0].fixture, "synthetic");
});

test("adapter sends dynamic content only through strict bounded stdin to the fixed SDK client", async () => {
  let captured;
  const adapter = createOpenClawGrowthDispatchAdapter({
    run: async (file, args, input, options) => {
      captured = { file, args, input, options };
      return { stdout: JSON.stringify(clientEnvelope()) };
    },
  });
  const marker = "202608080731";
  const payloadCanonical = `{"facts":{"sampleCount":${marker}}}`;
  const result = await adapter({ correlationId: "synthetic_correlation_1", payloadCanonical });

  assert.equal(captured.file, "/opt/homebrew/bin/node");
  assert.deepEqual(captured.args, ["/Users/hun/PrivateAI/app/runner/openclaw-consult-client.mjs"]);
  assert.equal(captured.args.some((argument) => argument.includes(marker)), false);
  assert.equal(Object.values(captured.options.env).some((value) => value.includes(marker)), false);
  assert.deepEqual(Object.keys(captured.options).sort(), [
    "env",
    "maxInputBytes",
    "maxOutputBytes",
    "timeoutMs",
  ]);
  assert.equal(captured.options.maxInputBytes, 32 * 1024);

  const stdinEnvelope = JSON.parse(captured.input);
  assert.deepEqual(Object.keys(stdinEnvelope).sort(), ["prompt", "version"]);
  assert.equal(stdinEnvelope.version, 1);
  assert.ok(stdinEnvelope.prompt.endsWith(payloadCanonical));
  assert.ok(stdinEnvelope.prompt.includes(marker));
  assert.equal(result.providerRequestId, null);
  assert.deepEqual(JSON.parse(result.responseText), advice);
});

test("adapter rechecks the outbound prompt for credentials immediately before dispatch", async () => {
  let calls = 0;
  const adapter = createOpenClawGrowthDispatchAdapter({
    run: async () => {
      calls += 1;
      return { stdout: JSON.stringify(clientEnvelope()) };
    },
  });
  const credential = ["thinq", "pat_", "A".repeat(40)].join("");
  const payloadCanonical = JSON.stringify({ facts: { sampleCount: 20 }, note: credential });
  await assert.rejects(
    adapter({ correlationId: "synthetic_correlation_2", payloadCanonical }),
    /growth_payload_credential_blocked/,
  );
  assert.equal(calls, 0);
});

test("adapter accepts only the fixed SDK envelope and fixed model policy", async () => {
  for (const malformed of [
    clientEnvelope(undefined, { model: "another-model" }),
    clientEnvelope(undefined, { reasoning: "low" }),
    clientEnvelope(undefined, { executionMode: "tool_enabled" }),
    { ...clientEnvelope(), unexpected: true },
  ]) {
    const adapter = createOpenClawGrowthDispatchAdapter({
      run: async () => ({ stdout: JSON.stringify(malformed) }),
    });
    await assert.rejects(
      adapter({ payloadCanonical: '{"facts":{"sampleCount":20}}' }),
      /growth_model_envelope_(?:invalid|schema_invalid)/,
    );
  }
});

test("adapter source has no command-line prompt or OpenClaw CLI fallback", async () => {
  const source = await readFile(new URL("../src/growth/openclaw-dispatch-adapter.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("node:child_process"), false);
  assert.equal(source.includes("/opt/homebrew/bin/openclaw"), false);
  assert.equal(source.includes('"--prompt"'), false);
  assert.equal(source.includes("execFileWithInput"), true);
  assert.equal(source.includes("containsCredential"), true);
});
