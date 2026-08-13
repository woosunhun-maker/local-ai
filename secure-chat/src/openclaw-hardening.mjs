function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string"))];
}

export function hardenOpenClawConfig(source, newGatewayToken) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("invalid_openclaw_config");
  if (typeof newGatewayToken !== "string" || newGatewayToken.length < 32) throw new Error("invalid_new_gateway_token");
  if (source.gateway?.bind !== "loopback" || source.tools?.exec?.security !== "allowlist" || source.tools?.fs?.workspaceOnly !== true) {
    throw new Error("openclaw_security_preconditions_failed");
  }
  const config = structuredClone(source);
  const mainAgent = config.agents?.list?.find((entry) => entry.id === "main");
  if (!mainAgent) throw new Error("main_agent_missing");

  config.gateway.auth.token = newGatewayToken;
  config.tools.deny = unique([...(config.tools.deny ?? []), "sessions_spawn", "sessions_send", "session_status"]);
  if (config.agents?.defaults?.models) delete config.agents.defaults.models["openai/gpt-5.6-sol"];
  mainAgent.tools = {
    ...(mainAgent.tools ?? {}),
    deny: unique([...(mainAgent.tools?.deny ?? []), "sessions_spawn", "sessions_send", "session_status"]),
  };
  config.agents.list = config.agents.list.filter((entry) => entry.id !== "cloud-consultant");
  config.channels = { ...(config.channels ?? {}), telegram: { enabled: false } };
  config.plugins = {
    ...(config.plugins ?? {}),
    entries: {
      ...(config.plugins?.entries ?? {}),
      telegram: { ...(config.plugins?.entries?.telegram ?? {}), enabled: false },
    },
  };
  return config;
}

export function hardenExecApprovals(source, safeRunnerPath) {
  if (!source || typeof source !== "object" || Array.isArray(source) || source.version !== 1) {
    throw new Error("invalid_exec_approvals");
  }
  if (typeof safeRunnerPath !== "string" || !safeRunnerPath.startsWith("/Users/hun/PrivateAI/app/secure-chat/") || !safeRunnerPath.endsWith("openclaw-safe-runner.mjs")) {
    throw new Error("invalid_safe_runner_path");
  }
  const result = structuredClone(source);
  result.defaults = {
    ...(result.defaults ?? {}),
    security: "allowlist",
    ask: "off",
    askFallback: "deny",
  };
  result.agents = { ...(result.agents ?? {}) };
  const current = result.agents.main ?? {};
  const existing = Array.isArray(current.allowlist)
    ? current.allowlist.find((entry) => entry?.pattern === safeRunnerPath)
    : null;
  result.agents.main = {
    ...current,
    allowlist: [{
      ...(existing ?? {}),
      pattern: safeRunnerPath,
      id: existing?.id ?? "local-ai-safe-runner-v1",
    }],
  };
  return result;
}
