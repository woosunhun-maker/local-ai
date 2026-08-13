import { randomBytes } from "node:crypto";
import { canonicalizeJson, deepFreeze, isSha256, sha256Hex } from "./canonical.mjs";
import { buildApprovalSigningMessageFromBinding } from "./outbound-request.mjs";

export const PROPOSAL_SCHEMA = "local-ai.growth.proposal.v1";
export const PROPOSAL_TRUST = "untrusted_external_advice";
export const PROPOSAL_STATUSES = Object.freeze(["pending", "approved", "rejected", "applied"]);

const TOP_LEVEL_KEYS = new Set([
  "schema",
  "id",
  "revision",
  "recordVersion",
  "previousRecordSha256",
  "revisionParentContentSha256",
  "trust",
  "createdAt",
  "updatedAt",
  "source",
  "content",
  "lifecycle",
  "integrity",
]);
const SOURCE_KEYS = new Set([
  "type",
  "outboundRequestSha256",
  "provider",
  "model",
  "receivedAt",
  "responseText",
  "responseSha256",
]);
const CONTENT_KEYS = new Set(["title", "summary", "scopes", "changes", "evidence", "tests", "rollback"]);
const CHANGE_KEYS = new Set(["id", "area", "recommendation"]);
const EVIDENCE_KEYS = new Set(["id", "type", "sourceKind", "summary", "digest"]);
const TEST_KEYS = new Set(["id", "kind", "runnerId", "fixture", "description"]);
const ROLLBACK_KEYS = new Set(["strategy", "checkpointRequired", "description"]);
const LIFECYCLE_KEYS = new Set(["status", "events", "approval", "rejection", "application"]);
const EVENT_KEYS = new Set(["sequence", "from", "to", "at", "actor", "reason"]);
const APPROVAL_KEYS = new Set([
  "requestId",
  "payloadSha256",
  "nonce",
  "expiresAt",
  "decision",
  "keyId",
  "signature",
  "signingMessageSha256",
  "verifiedAt",
]);
const REJECTION_KEYS = new Set(["at", "actor", "reason"]);
const APPLICATION_KEYS = new Set([
  "at",
  "actor",
  "proposalSha256",
  "artifactSha256",
  "rollbackCheckpointSha256",
  "testResults",
]);
const TEST_RESULT_KEYS = new Set(["testId", "status", "evidenceSha256"]);
const INTEGRITY_KEYS = new Set(["algorithm", "contentSha256", "recordSha256"]);

const SCOPES = new Set(["ui", "performance", "privacy", "reliability", "voice", "testing", "documentation"]);
const CHANGE_AREAS = new Set([...SCOPES]);
const EVIDENCE_TYPES = new Set(["synthetic_test", "benchmark", "local_observation", "public_reference", "consultant_reasoning"]);
const EVIDENCE_SOURCES = new Set(["synthetic", "public", "local_aggregate", "external_consultant"]);
const TEST_KINDS = new Set(["unit", "integration", "benchmark", "security", "ui"]);
const TEST_RUNNERS = new Set(["node_unit", "node_integration", "ios_unit", "ios_ui", "benchmark", "security_static"]);
const ROLLBACK_STRATEGIES = new Set(["restore_checkpoint", "revert_version", "restore_file_hashes"]);
const INVISIBLE_OR_BIDI = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F]/u;
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(["approved", "rejected"]),
  approved: new Set(["applied", "rejected"]),
  rejected: new Set(),
  applied: new Set(),
});

function exactKeys(value, expected, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) throw new TypeError(`${path} has an invalid schema`);
}

function text(value, path, minimum, maximum) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) throw new TypeError(`${path} is invalid`);
  if (value !== value.normalize("NFC") || INVISIBLE_OR_BIDI.test(value)) throw new TypeError(`${path} contains display-unsafe text`);
}

function iso(value, path) {
  const milliseconds = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new TypeError(`${path} is invalid`);
  return new Date(milliseconds).toISOString();
}

function id(value, path) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,47}$/.test(value)) throw new TypeError(`${path} is invalid`);
}

function opaque(value, path, minimum = 16, maximum = 256) {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError(`${path} is invalid`);
  }
}

function normalized(value) {
  return JSON.parse(canonicalizeJson(value));
}

function validateUniqueIds(values, path) {
  const seen = new Set();
  values.forEach((entry, index) => {
    id(entry.id, `${path}[${index}].id`);
    if (seen.has(entry.id)) throw new Error(`${path} contains duplicate ids`);
    seen.add(entry.id);
  });
}

function validateContent(content) {
  exactKeys(content, CONTENT_KEYS, "proposal.content");
  text(content.title, "proposal.content.title", 1, 120);
  text(content.summary, "proposal.content.summary", 1, 2_000);
  if (!Array.isArray(content.scopes) || content.scopes.length < 1 || content.scopes.length > 8 || new Set(content.scopes).size !== content.scopes.length) {
    throw new TypeError("proposal.content.scopes is invalid");
  }
  if (content.scopes.some((scope) => !SCOPES.has(scope))) throw new Error("proposal.content.scopes contains a denied scope");

  if (!Array.isArray(content.changes) || content.changes.length < 1 || content.changes.length > 20) throw new TypeError("proposal.content.changes is invalid");
  validateUniqueIds(content.changes, "proposal.content.changes");
  content.changes.forEach((entry, index) => {
    exactKeys(entry, CHANGE_KEYS, `proposal.content.changes[${index}]`);
    if (!CHANGE_AREAS.has(entry.area)) throw new Error(`proposal.content.changes[${index}].area is denied`);
    text(entry.recommendation, `proposal.content.changes[${index}].recommendation`, 1, 2_000);
  });

  if (!Array.isArray(content.evidence) || content.evidence.length < 1 || content.evidence.length > 20) throw new TypeError("proposal.content.evidence is invalid");
  validateUniqueIds(content.evidence, "proposal.content.evidence");
  content.evidence.forEach((entry, index) => {
    exactKeys(entry, EVIDENCE_KEYS, `proposal.content.evidence[${index}]`);
    if (!EVIDENCE_TYPES.has(entry.type) || !EVIDENCE_SOURCES.has(entry.sourceKind)) throw new Error("proposal evidence type is denied");
    text(entry.summary, `proposal.content.evidence[${index}].summary`, 1, 1_000);
    if (entry.digest !== null && !isSha256(entry.digest)) throw new Error("proposal evidence digest is invalid");
  });

  if (!Array.isArray(content.tests) || content.tests.length < 1 || content.tests.length > 20) throw new TypeError("proposal.content.tests is invalid");
  validateUniqueIds(content.tests, "proposal.content.tests");
  content.tests.forEach((entry, index) => {
    exactKeys(entry, TEST_KEYS, `proposal.content.tests[${index}]`);
    if (!TEST_KINDS.has(entry.kind) || !TEST_RUNNERS.has(entry.runnerId) || entry.fixture !== "synthetic") {
      throw new Error("proposal test must use an allowlisted runner and synthetic fixture");
    }
    text(entry.description, `proposal.content.tests[${index}].description`, 1, 500);
  });

  exactKeys(content.rollback, ROLLBACK_KEYS, "proposal.content.rollback");
  if (!ROLLBACK_STRATEGIES.has(content.rollback.strategy) || content.rollback.checkpointRequired !== true) {
    throw new Error("proposal rollback policy is invalid");
  }
  text(content.rollback.description, "proposal.content.rollback.description", 1, 1_000);
  return true;
}

function recordDigestMaterial(record) {
  return {
    ...record,
    integrity: {
      algorithm: record.integrity.algorithm,
      contentSha256: record.integrity.contentSha256,
    },
  };
}

function sealRecord(base) {
  const contentSha256 = sha256Hex(canonicalizeJson(base.content));
  const unsigned = normalized({
    ...base,
    integrity: { algorithm: "sha256", contentSha256 },
  });
  const recordSha256 = sha256Hex(canonicalizeJson(unsigned));
  return deepFreeze(normalized({
    ...unsigned,
    integrity: { ...unsigned.integrity, recordSha256 },
  }));
}

function pendingEvent(at) {
  return { sequence: 1, from: null, to: "pending", at, actor: "system", reason: "external_advice_quarantined" };
}

function validateLifecycle(record) {
  const lifecycle = record.lifecycle;
  exactKeys(lifecycle, LIFECYCLE_KEYS, "proposal.lifecycle");
  if (!PROPOSAL_STATUSES.includes(lifecycle.status)) throw new Error("proposal lifecycle status is invalid");
  if (!Array.isArray(lifecycle.events) || lifecycle.events.length < 1) throw new Error("proposal lifecycle events are invalid");
  lifecycle.events.forEach((entry, index) => {
    exactKeys(entry, EVENT_KEYS, `proposal.lifecycle.events[${index}]`);
    if (entry.sequence !== index + 1 || !PROPOSAL_STATUSES.includes(entry.to) || (entry.from !== null && !PROPOSAL_STATUSES.includes(entry.from))) {
      throw new Error("proposal lifecycle event chain is invalid");
    }
    if (index === 0 && (entry.from !== null || entry.to !== "pending")) throw new Error("proposal lifecycle must start pending");
    if (index > 0) {
      if (entry.from !== lifecycle.events[index - 1].to) throw new Error("proposal lifecycle event continuity is invalid");
      if (!ALLOWED_TRANSITIONS[entry.from].has(entry.to)) throw new Error("proposal lifecycle contains an invalid transition");
    }
    const expectedActor = entry.to === "pending" ? "system" : entry.to === "applied" ? "fixed_runner" : "user";
    if (entry.actor !== expectedActor) throw new Error("proposal lifecycle event actor is invalid");
    iso(entry.at, `proposal.lifecycle.events[${index}].at`);
    text(entry.actor, `proposal.lifecycle.events[${index}].actor`, 1, 40);
    if (entry.reason !== null) text(entry.reason, `proposal.lifecycle.events[${index}].reason`, 1, 500);
  });
  if (lifecycle.events.at(-1).to !== lifecycle.status) throw new Error("proposal lifecycle status does not match its events");

  if (lifecycle.approval !== null) {
    exactKeys(lifecycle.approval, APPROVAL_KEYS, "proposal.lifecycle.approval");
    opaque(lifecycle.approval.requestId, "proposal.lifecycle.approval.requestId");
    opaque(lifecycle.approval.nonce, "proposal.lifecycle.approval.nonce", 32);
    opaque(lifecycle.approval.keyId, "proposal.lifecycle.approval.keyId", 8);
    opaque(lifecycle.approval.signature, "proposal.lifecycle.approval.signature", 40, 512);
    if (lifecycle.approval.decision !== "approved" || lifecycle.approval.payloadSha256 !== record.integrity.contentSha256) {
      throw new Error("proposal approval is not bound to this content");
    }
    if (!isSha256(lifecycle.approval.signingMessageSha256)) throw new Error("proposal approval message digest is invalid");
    iso(lifecycle.approval.expiresAt, "proposal.lifecycle.approval.expiresAt");
    iso(lifecycle.approval.verifiedAt, "proposal.lifecycle.approval.verifiedAt");
    if (Date.parse(lifecycle.approval.verifiedAt) >= Date.parse(lifecycle.approval.expiresAt)) throw new Error("proposal approval was verified after expiry");
  }
  if (["approved", "applied"].includes(lifecycle.status) && lifecycle.approval === null) throw new Error("approved proposal is missing approval proof");

  if (lifecycle.rejection !== null) {
    exactKeys(lifecycle.rejection, REJECTION_KEYS, "proposal.lifecycle.rejection");
    iso(lifecycle.rejection.at, "proposal.lifecycle.rejection.at");
    text(lifecycle.rejection.actor, "proposal.lifecycle.rejection.actor", 1, 40);
    text(lifecycle.rejection.reason, "proposal.lifecycle.rejection.reason", 1, 500);
  }
  if (lifecycle.status === "rejected" && lifecycle.rejection === null) throw new Error("rejected proposal is missing rejection details");

  if (lifecycle.application !== null) {
    exactKeys(lifecycle.application, APPLICATION_KEYS, "proposal.lifecycle.application");
    iso(lifecycle.application.at, "proposal.lifecycle.application.at");
    if (lifecycle.application.actor !== "fixed_runner") throw new Error("proposal application actor is invalid");
    for (const field of ["proposalSha256", "artifactSha256", "rollbackCheckpointSha256"]) {
      if (!isSha256(lifecycle.application[field])) throw new Error(`proposal application ${field} is invalid`);
    }
    if (lifecycle.application.proposalSha256 !== record.integrity.contentSha256) throw new Error("application is not bound to proposal content");
    if (!Array.isArray(lifecycle.application.testResults) || lifecycle.application.testResults.length !== record.content.tests.length) {
      throw new Error("application test coverage is incomplete");
    }
    const expectedTests = new Set(record.content.tests.map((entry) => entry.id));
    for (const result of lifecycle.application.testResults) {
      exactKeys(result, TEST_RESULT_KEYS, "proposal.lifecycle.application.testResults[]");
      if (!expectedTests.delete(result.testId) || result.status !== "passed" || !isSha256(result.evidenceSha256)) {
        throw new Error("application test result is invalid");
      }
    }
    if (expectedTests.size) throw new Error("application test coverage is incomplete");
  }
  if (lifecycle.status === "applied" && lifecycle.application === null) throw new Error("applied proposal is missing application evidence");
  if (lifecycle.status === "pending" && (lifecycle.approval || lifecycle.rejection || lifecycle.application)) {
    throw new Error("pending proposal contains terminal state data");
  }
  if (lifecycle.status === "approved" && (lifecycle.rejection || lifecycle.application)) throw new Error("approved proposal contains terminal state data");
  if (lifecycle.status === "rejected" && lifecycle.application) throw new Error("rejected proposal contains application data");
  if (lifecycle.status === "applied" && lifecycle.rejection) throw new Error("applied proposal contains rejection data");
  if (lifecycle.application && Date.parse(lifecycle.application.at) >= Date.parse(lifecycle.approval.expiresAt)) {
    throw new Error("proposal was applied after approval expiry");
  }
  return true;
}

export function validateProposalRecord(record) {
  exactKeys(record, TOP_LEVEL_KEYS, "proposal");
  if (record.schema !== PROPOSAL_SCHEMA || record.trust !== PROPOSAL_TRUST) throw new Error("Unsupported or trusted proposal schema");
  opaque(record.id, "proposal.id");
  if (!Number.isInteger(record.revision) || record.revision < 1 || !Number.isInteger(record.recordVersion) || record.recordVersion < 1) {
    throw new Error("proposal version is invalid");
  }
  if (record.previousRecordSha256 !== null && !isSha256(record.previousRecordSha256)) throw new Error("proposal previous record digest is invalid");
  if (record.revisionParentContentSha256 !== null && !isSha256(record.revisionParentContentSha256)) throw new Error("proposal revision parent digest is invalid");
  if (record.recordVersion === 1 && record.previousRecordSha256 !== null) throw new Error("initial proposal cannot have a previous record");
  if (record.recordVersion > 1 && record.previousRecordSha256 === null) throw new Error("versioned proposal is missing its previous record digest");
  if (record.revision === 1 && record.revisionParentContentSha256 !== null) throw new Error("initial proposal cannot have a revision parent");
  if (record.revision > 1 && record.revisionParentContentSha256 === null) throw new Error("revised proposal is missing its parent content digest");
  const createdAt = Date.parse(iso(record.createdAt, "proposal.createdAt"));
  const updatedAt = Date.parse(iso(record.updatedAt, "proposal.updatedAt"));
  if (updatedAt < createdAt) throw new Error("proposal update precedes creation");

  exactKeys(record.source, SOURCE_KEYS, "proposal.source");
  if (record.source.type !== "external_consultation" || !isSha256(record.source.outboundRequestSha256)) throw new Error("proposal source is invalid");
  text(record.source.provider, "proposal.source.provider", 1, 80);
  text(record.source.model, "proposal.source.model", 1, 120);
  iso(record.source.receivedAt, "proposal.source.receivedAt");
  text(record.source.responseText, "proposal.source.responseText", 1, 20_000);
  if (!isSha256(record.source.responseSha256) || sha256Hex(record.source.responseText) !== record.source.responseSha256) {
    throw new Error("proposal external response digest mismatch");
  }

  validateContent(record.content);
  validateLifecycle(record);
  exactKeys(record.integrity, INTEGRITY_KEYS, "proposal.integrity");
  if (record.integrity.algorithm !== "sha256" || sha256Hex(canonicalizeJson(record.content)) !== record.integrity.contentSha256) {
    throw new Error("proposal content digest mismatch");
  }
  if (sha256Hex(canonicalizeJson(recordDigestMaterial(record))) !== record.integrity.recordSha256) {
    throw new Error("proposal record digest mismatch");
  }
  return true;
}

export function createUntrustedProposal(input, options = {}) {
  const at = iso(options.now ?? Date.now(), "now");
  const proposalId = options.id ?? randomBytes(12).toString("base64url");
  opaque(proposalId, "proposal.id");
  if (!isSha256(input.outboundRequestSha256)) throw new Error("outboundRequestSha256 is invalid");
  text(input.externalResponse, "externalResponse", 1, 20_000);
  text(input.provider, "provider", 1, 80);
  text(input.model, "model", 1, 120);
  validateContent(input.content);

  const record = sealRecord({
    schema: PROPOSAL_SCHEMA,
    id: proposalId,
    revision: 1,
    recordVersion: 1,
    previousRecordSha256: null,
    revisionParentContentSha256: null,
    trust: PROPOSAL_TRUST,
    createdAt: at,
    updatedAt: at,
    source: {
      type: "external_consultation",
      outboundRequestSha256: input.outboundRequestSha256,
      provider: input.provider,
      model: input.model,
      receivedAt: at,
      responseText: input.externalResponse,
      responseSha256: sha256Hex(input.externalResponse),
    },
    content: input.content,
    lifecycle: {
      status: "pending",
      events: [pendingEvent(at)],
      approval: null,
      rejection: null,
      application: null,
    },
  });
  validateProposalRecord(record);
  return record;
}

export function reviseUntrustedProposal(previous, nextContent, options = {}) {
  validateProposalRecord(previous);
  if (!["pending", "rejected"].includes(previous.lifecycle.status)) throw new Error("Only pending or rejected proposals can be revised");
  validateContent(nextContent);
  const at = iso(options.now ?? Date.now(), "now");
  const record = sealRecord({
    ...previous,
    revision: previous.revision + 1,
    recordVersion: previous.recordVersion + 1,
    previousRecordSha256: previous.integrity.recordSha256,
    revisionParentContentSha256: previous.integrity.contentSha256,
    updatedAt: at,
    content: nextContent,
    lifecycle: {
      status: "pending",
      events: [pendingEvent(at)],
      approval: null,
      rejection: null,
      application: null,
    },
    integrity: undefined,
  });
  validateProposalRecord(record);
  return record;
}

export function transitionProposalState(previous, nextStatus, details = {}, options = {}) {
  validateProposalRecord(previous);
  if (!PROPOSAL_STATUSES.includes(nextStatus) || !ALLOWED_TRANSITIONS[previous.lifecycle.status].has(nextStatus)) {
    throw new Error(`Invalid proposal transition: ${previous.lifecycle.status} -> ${nextStatus}`);
  }
  const at = iso(options.now ?? Date.now(), "now");
  const lifecycle = normalized(previous.lifecycle);
  let actor;
  let reason = null;

  if (nextStatus === "approved") {
    const approval = details.approval;
    if (!approval || typeof options.verifyApproval !== "function") throw new Error("Verified approval proof is required");
    const binding = {
      requestId: approval.requestId,
      payloadSha256: previous.integrity.contentSha256,
      nonce: approval.nonce,
      expiresAt: approval.expiresAt,
    };
    const signingMessage = buildApprovalSigningMessageFromBinding(binding, "approved");
    if (Date.parse(at) >= Date.parse(binding.expiresAt)) throw new Error("Proposal approval has expired");
    const proof = {
      ...binding,
      decision: "approved",
      keyId: approval.keyId,
      signature: approval.signature,
      signingMessageSha256: sha256Hex(signingMessage),
      verifiedAt: at,
    };
    opaque(proof.keyId, "approval.keyId", 8);
    opaque(proof.signature, "approval.signature", 40, 512);
    if (options.verifyApproval({ signingMessage, proof, proposal: previous }) !== true) throw new Error("Approval signature verification failed");
    lifecycle.approval = proof;
    actor = "user";
  } else if (nextStatus === "rejected") {
    text(details.reason, "rejection.reason", 1, 500);
    actor = "user";
    reason = details.reason;
    lifecycle.rejection = { at, actor, reason };
  } else if (nextStatus === "applied") {
    if (Date.parse(at) >= Date.parse(previous.lifecycle.approval.expiresAt)) throw new Error("Proposal apply approval has expired");
    const application = details.application;
    if (!application) throw new Error("Application evidence is required");
    lifecycle.application = {
      at,
      actor: "fixed_runner",
      proposalSha256: previous.integrity.contentSha256,
      artifactSha256: application.artifactSha256,
      rollbackCheckpointSha256: application.rollbackCheckpointSha256,
      testResults: application.testResults,
    };
    actor = "fixed_runner";
  }

  lifecycle.status = nextStatus;
  lifecycle.events.push({
    sequence: lifecycle.events.length + 1,
    from: previous.lifecycle.status,
    to: nextStatus,
    at,
    actor,
    reason,
  });

  const record = sealRecord({
    ...previous,
    recordVersion: previous.recordVersion + 1,
    previousRecordSha256: previous.integrity.recordSha256,
    updatedAt: at,
    lifecycle,
    integrity: undefined,
  });
  validateProposalRecord(record);
  return record;
}
