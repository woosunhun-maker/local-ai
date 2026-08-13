#!/usr/bin/env node

import { runIntentCalibration } from "../src/trust/intent-calibration.mjs";

try {
  const report = await runIntentCalibration();
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.failed > 0) process.exitCode = 1;
} catch {
  process.stderr.write("intent_calibration_unavailable\n");
  process.exitCode = 1;
}
