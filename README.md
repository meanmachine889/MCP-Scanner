# scan-my-mcp

> Security scanner for Model Context Protocol (MCP) servers. Never executes tools — only reads their definitions.

```bash
npx scan-my-mcp --url https://mcp.deepwiki.com/mcp
```

`scan-my-mcp` connects to any MCP server (HTTP **or** local stdio), enumerates its tools, resources, and prompts, then runs six offline security checks against the collected definitions. It produces a scannable terminal report or JSON for downstream tooling.

It's read-only by design. The scanner only calls `initialize`, `tools/list`, `resources/list`, and `prompts/list`. It never calls any tool, never sends any input, never persists anything to the target server.

## Features

- **Both transports.** HTTP and local stdio (subprocess) MCP servers.
- **Modern MCP support.** `Mcp-Session-Id` is captured from `initialize` and replayed on every subsequent request.
- **Six security checks.** Secret exposure, auth enforcement, dangerous permissions, input validation, prompt injection, context-window bloat.
- **Useful exit codes.** `0` clean, `1` if any critical/high findings, `2` if the scan itself failed.
- **JSON output.** Stable schema for CI gating and dashboards.
- **Graceful failure.** Auth-gated, timing-out, partially-broken servers all produce *partial* results rather than a hang or crash.

## Quick start

```bash
# Scan a public HTTP MCP server
npx scan-my-mcp --url https://mcp.deepwiki.com/mcp

# Scan with auth
npx scan-my-mcp --url https://internal.example.com/mcp \
  --header "Authorization: Bearer $TOKEN"

# Scan a local stdio MCP server
npx scan-my-mcp --command "npx -y @modelcontextprotocol/server-everything"

# Machine-readable output for CI / dashboards
npx scan-my-mcp --url https://mcp.deepwiki.com/mcp --json | jq .summary
```

## Installation

You usually don't need to install anything — `npx` will fetch it on demand:

```bash
npx scan-my-mcp --help
```

If you want it permanently:

```bash
npm install -g scan-my-mcp
scan-my-mcp --url https://mcp.deepwiki.com/mcp
```

## CLI flags

| Flag | Description |
|---|---|
| `--url <url>` | MCP server URL (HTTP transport). |
| `--command "<cmd args>"` | Local MCP server command + args (stdio transport). Quote the whole string. |
| `--header <h...>` | HTTP headers, e.g. `--header "Authorization: Bearer abc"`. Repeatable. |
| `--env <KEY=VAL...>` | Environment variables to set on the stdio subprocess. Repeatable. |
| `--json` | Emit JSON instead of the terminal report. |
| `--timeout <ms>` | Total scan timeout. Default: `30000`. |
| `--help` / `--version` | Self-explanatory. |

Exactly one of `--url` or `--command` is required.

## What it checks

| Check | Severity | What it looks for |
|---|---|---|
| **secret-exposure** | CRITICAL | API keys, tokens, private key blocks, password / secret literals, database URLs with credentials anywhere in tool, resource, or prompt definitions. |
| **auth-enforcement** | HIGH / MEDIUM / INFO | Whether the server actually requires authentication. Distinguishes *no auth*, *partial* (initialize public, listing gated), and *full*. Stdio targets are tagged N/A — process boundary is the security boundary. |
| **permissions** | HIGH / MEDIUM | Tools claiming filesystem write, shell execution, env var access, filesystem read, or arbitrary network calls — based on keyword analysis of names and descriptions. |
| **input-validation** | MEDIUM / LOW | Unconstrained string params, parameters without a type, tools without any inputSchema. |
| **prompt-injection** | CRITICAL / HIGH / MEDIUM / LOW | Strings designed to override agent instructions ("ignore previous instructions", "you are now"), unescaped template variables, jailbreak language, raw HTML/XML. |
| **context-window** | HIGH / MEDIUM / LOW / INFO | Estimated token cost of all tool definitions, suspicious capabilities like `resources.subscribe` or `logging`. |

All checks run **offline** after enumeration — no second network round trip.

## Scoring

The report shows a 0–100 score plus a risk band:

| Score | Band |
|---|---|
| 80–100 | SAFE |
| 50–79 | MODERATE RISK |
| 0–49 | HIGH RISK |

Score starts at 100 and is reduced per finding: critical −30, high −15, medium −5, low −2. **Severity caps apply:** any critical finding caps the score at ≤39 (HIGH RISK band); any high caps at ≤69 (MODERATE band). This guarantees a server with leaked secrets can never rate "SAFE".

## JSON output shape

```ts
{
  meta: {
    scanId: string;            // uuid
    scannedAt: string;         // ISO timestamp
    serverUrl: string;         // url for http, command string for stdio
    transport: "http" | "stdio";
    scanDuration: number;      // ms
    scannerVersion: string;
    protocolVersion: string;
    partial: boolean;
    partialReason?: string;
    sessionId?: string;        // Mcp-Session-Id if the server set one
    authState: "none" | "partial" | "full" | "n/a";
    coverage: {                // which endpoints we successfully reached
      initialize: boolean;
      tools: boolean;
      resources: boolean;
      prompts: boolean;
    };
  };
  server: {
    name: string;
    version: string;
    protocolVersion: string;
    capabilities: Record<string, unknown>;
  };
  inventory: {
    tools: ToolDefinition[];
    resources: ResourceDefinition[];
    prompts: PromptDefinition[];
  };
  findings: Array<{
    severity: "critical" | "high" | "medium" | "low" | "info";
    check: string;
    title: string;
    detail: string;
    location: string;          // e.g. "tools[2].description"
    remediation: string;
  }>;
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    score: number;
  };
}
```

This shape is stable and intended for downstream consumption (CI gates, dashboards, diffs between scans).

## CI usage

```bash
npx scan-my-mcp --url $MCP_SERVER --json > scan.json
jq '.summary' scan.json

# Fail the build on any critical/high finding
npx scan-my-mcp --url $MCP_SERVER || exit 1
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Scan completed, no critical/high findings |
| `1` | Scan completed, **critical or high findings present** |
| `2` | Scan failed (network error, bad URL, missing command, etc.) |

## Programmatic use

The scanner is also exposed as an importable module:

```ts
import { runScan } from "scan-my-mcp/scanner";
import type { ScanResult } from "scan-my-mcp/types";

const result: ScanResult = await runScan({
  url: "https://mcp.deepwiki.com/mcp",
  headers: {},
  timeoutMs: 30_000,
});

console.log(result.summary);
```

## Limits / scope

- **Network egress only.** Detects what the server *says* about itself, not what its tools actually do at runtime. A tool that says "echo input" but secretly exfiltrates data will not be flagged.
- **Heuristic checks.** Permissions and prompt-injection checks rely on keyword and regex matching against descriptions. Expect occasional false positives on innocuous text, and false negatives on creatively-obfuscated content.
- **No persistence.** The CLI is stateless. Use the JSON output if you want history or diffs.
- **One server at a time.** No fleet scanning yet.

## Contributing

Issues and PRs welcome at https://github.com/<your-handle>/scan-my-mcp (set this once the repo is up).

When adding a new check:
1. Add a module under `src/checks/`.
2. Wire it into `src/checks/index.ts`.
3. Add a corresponding case to the test server in `test-server/server.js` so the check actually fires on a known input.
4. Verify with `node dist/cli.js --url http://localhost:3030/mcp`.

## License

MIT
