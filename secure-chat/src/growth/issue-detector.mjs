import { OUTBOUND_DRAFT_SCHEMA, PERFORMANCE_TEMPLATE_ID } from "./dlp.mjs";

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

export function detectPerformanceIssue(events, {
  minimumSamples = 10,
  p95ThresholdMs = 5_000,
  errorRateThreshold = 0.2,
} = {}) {
  const durations = events
    .filter((entry) => entry?.event === "chat" && Number.isSafeInteger(entry.durationMs) && entry.durationMs >= 0)
    .map((entry) => entry.durationMs)
    .sort((left, right) => left - right);
  const failures = events.filter((entry) => entry?.event === "request_failed").length;
  const sampleCount = durations.length + failures;
  if (sampleCount < minimumSamples) return null;

  const medianMs = percentile(durations, 0.5);
  const p95Ms = percentile(durations, 0.95);
  const errorRate = failures / sampleCount;
  if (p95Ms < p95ThresholdMs && errorRate < errorRateThreshold) return null;

  return {
    schema: OUTBOUND_DRAFT_SCHEMA,
    templateId: PERFORMANCE_TEMPLATE_ID,
    facts: {
      sampleCount,
      medianLatencyMs: medianMs,
      p95LatencyMs: p95Ms,
      failureCount: failures,
    },
  };
}
