import { ServerInfo, Inventory, Finding, AuthState } from "../types";

export function checkAuth(input: {
  serverInfo: ServerInfo;
  inventory: Inventory;
  authState?: AuthState;
}): Finding[] {
  const state: AuthState = input.authState ?? "none";

  if (state === "n/a") {
    return [{
      severity: "info",
      check: "auth-enforcement",
      title: "Local stdio server — network auth not applicable",
      detail: "Server is a local subprocess spawned over stdio. Process-level isolation is the security boundary, not MCP authentication.",
      location: "transport",
      remediation: "Ensure the spawning agent restricts which commands it can run and which arguments it can pass.",
    }];
  }

  if (state === "none") {
    return [{
      severity: "high",
      check: "auth-enforcement",
      title: "Server requires no authentication",
      detail: "Scanner connected and enumerated all tools, resources, and prompts without credentials.",
      location: "transport",
      remediation:
        "Implement OAuth 2.1 or API key authentication. All MCP servers exposed over HTTP should require authentication.",
    }];
  }

  if (state === "partial") {
    return [{
      severity: "medium",
      check: "auth-enforcement",
      title: "Partial authentication enforcement",
      detail: "initialize succeeded without credentials, but tool/resource/prompt listing requires auth. Anonymous clients can still fingerprint the server.",
      location: "transport",
      remediation:
        "Require authentication on initialize too, or strip identifying server metadata (name, version, capabilities) from unauthenticated responses.",
    }];
  }

  return [{
    severity: "info",
    check: "auth-enforcement",
    title: "Authentication enforced",
    detail: "Server requires credentials for MCP operations.",
    location: "transport",
    remediation: "No action needed.",
  }];
}
