import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { analyzeLocalIntent } from "./local-intent-analyzer.mjs";
import { decideIntentNextStep } from "./intent-negotiation.mjs";

export const INTENT_SHADOW_SCHEMA = "local-ai.intent-shadow-metrics.v1";

const NEXT_STATES = Object.freeze(["answer", "clarify", "prepare", "execute_read", "request_approval", "discuss"]);

function emptyMetrics() {
  return {
    schema: INTENT_SHADOW_SCHEMA,
    total: 0,
    succeeded: 0,
    failed: 0,
    next: Object.fromEntries(NEXT_STATES.map((state) => [state, 0])),
    latency: { count: 0, total_ms: 0, maximum_ms: 0 },
    updated_at: null,
  };
}

function integer(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function validateMetrics(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_intent_shadow_metrics");
  const keys = Object.keys(value).sort();
  const expected = ["schema", "total", "succeeded", "failed", "next", "latency", "updated_at"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("invalid_intent_shadow_metrics");
  if (value.schema !== INTENT_SHADOW_SCHEMA || !integer(value.total) || !integer(value.succeeded) || !integer(value.failed)) {
    throw new Error("invalid_intent_shadow_metrics");
  }
  if (value.total !== value.succeeded + value.failed) throw new Error("invalid_intent_shadow_totals");
  if (!value.next || Object.keys(value.next).sort().join("|") !== [...NEXT_STATES].sort().join("|")) throw new Error("invalid_intent_shadow_outcomes");
  for (const state of NEXT_STATES) if (!integer(value.next[state])) throw new Error("invalid_intent_shadow_outcomes");
  if (NEXT_STATES.reduce((sum, state) => sum + value.next[state], 0) !== value.succeeded) throw new Error("invalid_intent_shadow_outcomes");
  const latency = value.latency;
  if (!latency || Object.keys(latency).sort().join("|") !== "count|maximum_ms|total_ms") throw new Error("invalid_intent_shadow_latency");
  if (!integer(latency.count) || !integer(latency.total_ms) || !integer(latency.maximum_ms)) throw new Error("invalid_intent_shadow_latency");
  if (latency.count !== value.total) throw new Error("invalid_intent_shadow_latency");
  if (value.updated_at !== null) {
    if (typeof value.updated_at !== "string" || new Date(Date.parse(value.updated_at)).toISOString() !== value.updated_at) {
      throw new Error("invalid_intent_shadow_timestamp");
    }
  }
  return value;
}

export class IntentShadowMonitor {
  constructor(path, {
    analyze = analyzeLocalIntent,
    now = () => Date.now(),
  } = {}) {
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error("invalid_intent_shadow_path");
    if (typeof analyze !== "function") throw new Error("invalid_intent_shadow_analyzer");
    this.path = path;
    this.analyze = analyze;
    this.now = now;
    this.queue = Promise.resolve();
    this.initialized = false;
  }

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      validateMetrics(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await this.#write(emptyMetrics());
    }
    this.initialized = true;
  }

  async observe({ utterance, ingress = "local_owner_app" }) {
    if (!this.initialized) throw new Error("intent_shadow_not_initialized");
    const startedAt = this.now();
    let next = null;
    try {
      const compiled = await this.analyze({ utterance, ingress });
      next = decideIntentNextStep(compiled).next;
      if (!NEXT_STATES.includes(next)) throw new Error("invalid_intent_shadow_outcome");
    } catch {
      next = null;
    }
    const finishedAt = this.now();
    const duration = Math.max(0, Math.min(120_000, Math.round(finishedAt - startedAt)));
    await this.#serialized(async () => {
      const metrics = validateMetrics(JSON.parse(await readFile(this.path, "utf8")));
      metrics.total += 1;
      metrics.latency.count += 1;
      metrics.latency.total_ms += duration;
      metrics.latency.maximum_ms = Math.max(metrics.latency.maximum_ms, duration);
      if (next === null) metrics.failed += 1;
      else {
        metrics.succeeded += 1;
        metrics.next[next] += 1;
      }
      metrics.updated_at = new Date(finishedAt).toISOString();
      await this.#write(metrics);
    });
    return Object.freeze({ ok: next !== null, next, duration_ms: duration });
  }

  async status() {
    if (!this.initialized) throw new Error("intent_shadow_not_initialized");
    return structuredClone(validateMetrics(JSON.parse(await readFile(this.path, "utf8"))));
  }

  async #write(value) {
    validateMetrics(value);
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }

  async #serialized(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => {});
    return await result;
  }
}
