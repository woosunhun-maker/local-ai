#!/opt/homebrew/bin/node

import { spawn } from "node:child_process";

const LEGACY_RUNNER = "/Users/hun/PrivateAI/app/runner/local-ai-runner.sh";
const ACTIONS = new Set([
  "system.summary",
  "local-ai.health",
  "secure-chat.devices",
  "openclaw.status",
  "open-webui.status",
  "ollama.list",
  "ollama.ps",
  "home-assistant.status",
  "home-assistant.entities",
  "openclaw.gateway.restart",
  "openclaw.chat-endpoint.enable",
  "secure-chat.devices.revoke-all",
]);

function allowedArguments(args) {
  if (args.length === 1 && ["--list", "--pending"].includes(args[0])) return true;
  if (args.length !== 2 || !["--describe", "--action"].includes(args[0])) return false;
  return ACTIONS.has(args[1]);
}

const args = process.argv.slice(2);
if (!allowedArguments(args)) {
  console.error("차단됨: 고정된 로컬 작업만 실행할 수 있으며 legacy GPT consultation은 허용되지 않습니다.");
  process.exitCode = 12;
} else {
  const child = spawn(LEGACY_RUNNER, args, { shell: false, stdio: "inherit" });
  child.once("error", () => {
    process.exitCode = 20;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 20 : (code ?? 20);
  });
}
