import {
  canonicalSha256,
  canonicalizeJson,
  deepFreeze,
  isSha256,
} from "../growth/canonical.mjs";

export const INTENT_HYPOTHESIS_SCHEMA = "local-ai.intent-hypothesis.v1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const LABEL = /^[a-z][a-z0-9._-]{0,63}$/u;
const EFFECT_CLASSES = new Set(["none", "public_read", "private_read", "reversible_write", "irreversible_write"]);
const INGRESS_CHANNELS = new Set(["local_owner_app", "telegram", "voice"]);
const SLOT_STATES = new Set(["confirmed", "inferred", "missing"]);
const SLOT_SOURCES = new Set(["user", "confirmed_memory", "session_context", "public_lookup", "model_inference", "none"]);

// Profiles are code-owned. A model may propose an intent, but it cannot redefine
// which facts are material or downgrade the effect class of a known action.
const ACTION_PROFILES = new Map([
  ["conversation.answer", {
    effectClass: "none",
    requiredSlots: [],
    preparations: [],
  }],
  ["coupang.search", {
    effectClass: "public_read",
    requiredSlots: ["query"],
    preparations: [],
  }],
  ["coupang.cart.add", {
    effectClass: "reversible_write",
    requiredSlots: [
      "product_url", "product_name", "option_decision", "quantity",
      "expected_unit_price", "max_total_price", "currency",
    ],
    preparations: ["coupang.search"],
  }],
  ["mail.important.list", {
    effectClass: "private_read",
    requiredSlots: ["provider", "max_results", "unread_only"],
    preparations: [],
  }],
  ["mail.message.read", {
    effectClass: "private_read",
    requiredSlots: ["provider", "selection_id"],
    preparations: [],
  }],
]);

export class IntentNegotiationError extends Error {
  constructor(code) {
    super(code);
    this.name = "IntentNegotiationError";
    this.code = code;
  }
}

function fail(code) {
  throw new IntentNegotiationError(code);
}

function plain(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function exactKeys(value, expected, code) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) fail(code);
}

function text(value, code, maximum = 300) {
  if (typeof value !== "string") fail(code);
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) fail(code);
  return normalized;
}

function identifier(value, code) {
  const normalized = text(value, code, 128);
  if (!ID.test(normalized)) fail(code);
  return normalized;
}

function label(value, code) {
  const normalized = text(value, code, 64).toLowerCase();
  if (!LABEL.test(normalized)) fail(code);
  return normalized;
}

function enumeration(value, choices, code) {
  if (!choices.has(value)) fail(code);
  return value;
}

function integer(value, code, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code);
  return value;
}

function timestamp(value, code) {
  if (typeof value !== "string") fail(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
  return value;
}

function normalizeObjective(value) {
  const input = plain(value, "invalid_intent_objective");
  exactKeys(input, ["kind", "summary", "effect_class"], "invalid_intent_objective_fields");
  return {
    kind: label(input.kind, "invalid_intent_kind"),
    summary: text(input.summary, "invalid_intent_summary", 300),
    effect_class: enumeration(input.effect_class, EFFECT_CLASSES, "invalid_intent_effect_class"),
  };
}

function normalizeSlot(value) {
  const input = plain(value, "invalid_intent_slot");
  exactKeys(input, ["key", "state", "source", "value_sha256"], "invalid_intent_slot_fields");
  const state = enumeration(input.state, SLOT_STATES, "invalid_intent_slot_state");
  const source = enumeration(input.source, SLOT_SOURCES, "invalid_intent_slot_source");
  const valueSha256 = input.value_sha256;
  if (state === "missing") {
    if (source !== "none" || valueSha256 !== null) fail("invalid_missing_intent_slot");
  } else if (source === "none" || !isSha256(valueSha256)) {
    fail("invalid_resolved_intent_slot");
  }
  return {
    key: label(input.key, "invalid_intent_slot_key"),
    state,
    source,
    value_sha256: valueSha256,
  };
}

function normalizeSlots(value) {
  if (!Array.isArray(value) || value.length > 64) fail("invalid_intent_slots");
  const slots = value.map(normalizeSlot).sort((left, right) => left.key.localeCompare(right.key));
  if (new Set(slots.map((entry) => entry.key)).size !== slots.length) fail("duplicate_intent_slot");
  return slots;
}

function normalizeAmbiguity(value) {
  const input = plain(value, "invalid_intent_ambiguity");
  exactKeys(input, ["slot", "material", "blocks_effect", "question"], "invalid_intent_ambiguity_fields");
  if (typeof input.material !== "boolean" || typeof input.blocks_effect !== "boolean") fail("invalid_intent_ambiguity_flags");
  if (input.blocks_effect && !input.material) fail("blocking_ambiguity_must_be_material");
  return {
    slot: label(input.slot, "invalid_intent_ambiguity_slot"),
    material: input.material,
    blocks_effect: input.blocks_effect,
    question: text(input.question, "invalid_intent_ambiguity_question", 240),
  };
}

function normalizeAmbiguities(value) {
  if (!Array.isArray(value) || value.length > 32) fail("invalid_intent_ambiguities");
  const entries = value.map(normalizeAmbiguity).sort((left, right) => left.slot.localeCompare(right.slot));
  if (new Set(entries.map((entry) => entry.slot)).size !== entries.length) fail("duplicate_intent_ambiguity");
  return entries;
}

function normalizePreparation(value) {
  const input = plain(value, "invalid_intent_preparation");
  exactKeys(input, ["kind", "effect_class"], "invalid_intent_preparation_fields");
  const effectClass = enumeration(input.effect_class, EFFECT_CLASSES, "invalid_intent_preparation_effect");
  if (!new Set(["none", "public_read"]).has(effectClass)) fail("unsafe_intent_preparation");
  return {
    kind: label(input.kind, "invalid_intent_preparation_kind"),
    effect_class: effectClass,
  };
}

function normalizePreparations(value) {
  if (!Array.isArray(value) || value.length > 16) fail("invalid_intent_preparations");
  const entries = value.map(normalizePreparation).sort((left, right) => left.kind.localeCompare(right.kind));
  if (new Set(entries.map((entry) => entry.kind)).size !== entries.length) fail("duplicate_intent_preparation");
  return entries;
}

function normalizeCandidate(value) {
  const input = plain(value, "invalid_intent_hypothesis");
  exactKeys(input, [
    "schema", "hypothesis_id", "request_sha256", "ingress", "objective", "confidence_bps",
    "slots", "ambiguities", "preparations", "created_at",
  ], "invalid_intent_hypothesis_fields");
  if (input.schema !== INTENT_HYPOTHESIS_SCHEMA) fail("unsupported_intent_hypothesis_schema");
  if (!isSha256(input.request_sha256)) fail("invalid_intent_request_digest");
  const objective = normalizeObjective(input.objective);
  const profile = ACTION_PROFILES.get(objective.kind);
  if (profile && objective.effect_class !== profile.effectClass) fail("intent_effect_class_mismatch");
  const slots = normalizeSlots(input.slots);
  const ambiguities = normalizeAmbiguities(input.ambiguities);
  const preparations = normalizePreparations(input.preparations);
  if (profile) {
    for (const preparation of preparations) {
      if (!profile.preparations.includes(preparation.kind)) fail("unapproved_intent_preparation");
      const preparationProfile = ACTION_PROFILES.get(preparation.kind);
      if (!preparationProfile || preparation.effect_class !== preparationProfile.effectClass) {
        fail("intent_preparation_effect_mismatch");
      }
    }
  }
  return {
    schema: INTENT_HYPOTHESIS_SCHEMA,
    hypothesis_id: identifier(input.hypothesis_id, "invalid_intent_hypothesis_id"),
    request_sha256: input.request_sha256,
    ingress: enumeration(input.ingress, INGRESS_CHANNELS, "invalid_intent_ingress"),
    objective,
    confidence_bps: integer(input.confidence_bps, "invalid_intent_confidence", 0, 10_000),
    slots,
    ambiguities,
    preparations,
    created_at: timestamp(input.created_at, "invalid_intent_created_at"),
  };
}

export function compileIntentHypothesis(candidate) {
  const hypothesis = normalizeCandidate(candidate);
  const canonical = canonicalizeJson(hypothesis);
  return deepFreeze({ hypothesis: deepFreeze(hypothesis), canonical, sha256: canonicalSha256(hypothesis) });
}

export function validateCompiledIntentHypothesis(value) {
  const input = plain(value, "invalid_compiled_intent_hypothesis");
  exactKeys(input, ["hypothesis", "canonical", "sha256"], "invalid_compiled_intent_hypothesis_fields");
  const recompiled = compileIntentHypothesis(input.hypothesis);
  if (input.canonical !== recompiled.canonical || input.sha256 !== recompiled.sha256) fail("compiled_intent_hypothesis_tampered");
  return recompiled;
}

function result(next, code, details = {}) {
  return deepFreeze({ next, code, ...details });
}

export function decideIntentNextStep(compiledValue) {
  const recompiled = validateCompiledIntentHypothesis(compiledValue);
  const hypothesis = recompiled.hypothesis;
  const profile = ACTION_PROFILES.get(hypothesis.objective.kind);
  if (!profile) return result("discuss", "unregistered_action_profile");

  const slots = new Map(hypothesis.slots.map((entry) => [entry.key, entry]));
  const missingSlots = profile.requiredSlots.filter((key) => !slots.has(key) || slots.get(key).state === "missing");
  const declaredBlocking = hypothesis.ambiguities.filter((entry) => entry.blocks_effect).map((entry) => entry.slot);
  const blockers = [...new Set([...missingSlots, ...declaredBlocking])].sort();

  if (blockers.length > 0) {
    const readyPreparations = hypothesis.preparations.filter((preparation) => {
      const preparationProfile = ACTION_PROFILES.get(preparation.kind);
      return preparationProfile?.requiredSlots.every((key) => slots.has(key) && slots.get(key).state !== "missing");
    });
    if (readyPreparations.length > 0) {
      return result("prepare", "safe_read_can_reduce_ambiguity", {
        blocking_slots: blockers,
        preparation_kinds: readyPreparations.map((entry) => entry.kind),
      });
    }
    const preparationBlockers = hypothesis.preparations.flatMap((preparation) => {
      const preparationProfile = ACTION_PROFILES.get(preparation.kind);
      return preparationProfile?.requiredSlots.filter((key) => !slots.has(key) || slots.get(key).state === "missing") ?? [];
    });
    return result("clarify", "material_information_missing", {
      blocking_slots: [...new Set([...blockers, ...preparationBlockers])].sort(),
    });
  }
  if (hypothesis.confidence_bps < 7_000) {
    return result("clarify", "low_intent_confidence", { blocking_slots: blockers });
  }

  if (profile.effectClass === "none") return result("answer", "no_external_effect");
  if (profile.effectClass === "public_read" || profile.effectClass === "private_read") {
    return result("execute_read", "read_plan_ready");
  }
  return result("request_approval", "exact_effect_preview_required");
}

export const INTENT_ACTION_PROFILES = deepFreeze(Object.fromEntries(
  [...ACTION_PROFILES].map(([kind, profile]) => [kind, {
    effectClass: profile.effectClass,
    requiredSlots: [...profile.requiredSlots],
    preparations: [...profile.preparations],
  }]),
));
