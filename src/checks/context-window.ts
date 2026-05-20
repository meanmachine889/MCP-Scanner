import { ServerInfo, Inventory, Finding } from "../types";

export function checkContextWindow(input: {
  serverInfo: ServerInfo;
  inventory: Inventory;
}): Finding[] {
  const findings: Finding[] = [];
  const { tools } = input.inventory;
  const { capabilities } = input.serverInfo;

  const totalChars = tools.reduce((sum, tool) => {
    const descLen = tool.description?.length ?? 0;
    const schemaLen = tool.inputSchema ? JSON.stringify(tool.inputSchema).length : 0;
    return sum + descLen + schemaLen;
  }, 0);

  const estimatedTokens = Math.round(totalChars / 4);

  if (tools.length > 15) {
    findings.push({
      severity: "low",
      check: "context-window",
      title: "Large number of tools exposed",
      detail: `Server exposes ${tools.length} tools. Each tool definition consumes context window space in every agent call.`,
      location: "inventory.tools",
      remediation: "Consider grouping related tools or using dynamic tool registration to reduce baseline context usage.",
    });
  }

  if (estimatedTokens > 50_000) {
    findings.push({
      severity: "high",
      check: "context-window",
      title: "Excessive token overhead from tool definitions",
      detail: `Tool schemas estimate ~${estimatedTokens.toLocaleString()} tokens — this can consume the majority of an agent's context window.`,
      location: "inventory.tools",
      remediation: "Shorten tool descriptions and schemas. Remove redundant fields. Split into multiple focused servers.",
    });
  } else if (estimatedTokens > 10_000) {
    findings.push({
      severity: "medium",
      check: "context-window",
      title: "High token overhead from tool definitions",
      detail: `Tool schemas estimate ~${estimatedTokens.toLocaleString()} tokens.`,
      location: "inventory.tools",
      remediation: "Review tool descriptions for verbosity and trim where possible.",
    });
  }

  if ((capabilities?.resources as Record<string, unknown>)?.subscribe === true) {
    findings.push({
      severity: "info",
      check: "context-window",
      title: "Resource subscriptions enabled",
      detail: "Server supports real-time resource subscriptions, which expands the attack surface.",
      location: "serverInfo.capabilities.resources.subscribe",
      remediation: "Ensure subscription endpoints are authenticated and rate-limited.",
    });
  }

  if (capabilities?.logging !== undefined) {
    findings.push({
      severity: "info",
      check: "context-window",
      title: "Logging capability present",
      detail: "Server exposes a logging capability — verify that sensitive data is not included in log output.",
      location: "serverInfo.capabilities.logging",
      remediation: "Audit log output to ensure no credentials, PII, or tool inputs/outputs are logged in plaintext.",
    });
  }

  return findings;
}
