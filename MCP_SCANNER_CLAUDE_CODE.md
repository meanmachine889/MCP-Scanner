# MCP Security Scanner — Claude Code Build Guide

> Paste this entire file into a new Claude Code session. It contains everything needed to build the MCP Security Scanner from scratch, step by step. Follow the phases in order.

---

## What We're Building

A CLI tool (`npx scan-my-mcp`) that connects to any MCP server over HTTP, enumerates its tools/resources/prompts, runs security checks against the collected definitions, and outputs a structured report.

**Stack:** TypeScript, Node.js, `@modelcontextprotocol/sdk`
**Transport:** HTTP only (stdio is out of scope for this version)
**Output:** Colored terminal report + `--json` flag for machine-readable output
**Distribution:** npm package, run via `npx` with no install required

---

## Architecture Overview

```
User runs: npx scan-my-mcp --url https://example.com/mcp

1. cli.ts          → parse args, detect transport, orchestrate
2. transport/http.ts → connect, handshake, enumerate (tools/resources/prompts)
3. checks/index.ts  → run all checks against enumeration data
4. report.ts       → format findings to terminal or JSON
```

### Key Design Decisions

- **Never execute tools.** Scanner only reads definitions — no tool calls ever.
- **Use `@modelcontextprotocol/sdk` for transport** but intercept raw JSON before SDK parses it.
- **All checks are offline** — after enumeration, no more network contact.
- **Partial results on timeout** — always show what was found, never hang silently.
- **JSON output shape is fixed from day one** — it's the internal API for the future dashboard.

---

## Data Flow

```
initialize handshake
  → capture serverInfo + capabilities (free intelligence)
  → tools/list (paginated with cursor loop)
  → resources/list (paginated)
  → prompts/list (paginated)
  → disconnect

raw JSON blobs → checks/* → Finding[]
Finding[] → report.ts → terminal or JSON
```

---

## Core Types (establish these first, everything else references them)

```typescript
// src/types.ts

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export interface Finding {
  severity: Severity;
  check: string;        // e.g. "secret-exposure"
  title: string;        // e.g. "API key found in tool description"
  detail: string;       // specific location and content
  location: string;     // e.g. "tools[2].description"
  remediation: string;  // what to do about it
}

export interface ServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
}

export interface Inventory {
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  prompts: PromptDefinition[];
}

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface ResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface PromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface ScanResult {
  meta: {
    scanId: string;
    scannedAt: string;        // ISO timestamp
    serverUrl: string;
    scanDuration: number;     // ms
    scannerVersion: string;
    protocolVersion: string;
    partial: boolean;         // true if scan timed out or errored mid-way
  };
  server: ServerInfo;
  inventory: Inventory;
  findings: Finding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
    score: number;            // 0–100, higher = safer
  };
}
```

---

## Project Structure

```
scan-my-mcp/
├── src/
│   ├── cli.ts                  ← entry point, arg parsing
│   ├── types.ts                ← all shared types (above)
│   ├── scanner.ts              ← orchestrates full scan flow
│   ├── transport/
│   │   └── http.ts             ← MCP HTTP client (connect, handshake, enumerate)
│   ├── checks/
│   │   ├── index.ts            ← runs all checks, returns Finding[]
│   │   ├── secrets.ts          ← credential/token exposure
│   │   ├── auth.ts             ← auth enforcement check
│   │   ├── permissions.ts      ← filesystem/shell/env access scope
│   │   ├── validation.ts       ← missing input constraints
│   │   ├── injection.ts        ← prompt injection surfaces
│   │   └── context-window.ts   ← token overhead check
│   └── report.ts               ← terminal output + JSON serialization
├── package.json
├── tsconfig.json
└── README.md
```

---

## Phase 1 — Project Setup

**Goal:** Working TypeScript project, correct dependencies, can run `ts-node src/cli.ts`

### Instructions for Claude Code

1. Initialize a new Node.js project:
   ```bash
   npm init -y
   ```

2. Install dependencies:
   ```bash
   npm install @modelcontextprotocol/sdk axios chalk commander uuid
   npm install -D typescript ts-node @types/node @types/uuid tsx
   ```

3. Create `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "commonjs",
       "lib": ["ES2022"],
       "outDir": "./dist",
       "rootDir": "./src",
       "strict": true,
       "esModuleInterop": true,
       "resolveJsonModule": true,
       "skipLibCheck": true
     },
     "include": ["src/**/*"],
     "exclude": ["node_modules", "dist"]
   }
   ```

4. Update `package.json` with:
   ```json
   {
     "main": "dist/cli.js",
     "bin": {
       "scan-my-mcp": "./dist/cli.js"
     },
     "scripts": {
       "build": "tsc",
       "dev": "tsx src/cli.ts",
       "start": "node dist/cli.js"
     }
   }
   ```

5. Create `src/types.ts` with all types from the Core Types section above.

**Verify:** `npm run dev -- --help` should not throw a module error.

---

## Phase 2 — CLI Entry Point

**Goal:** Argument parsing, `--url` and `--header` flags, `--json` flag, basic error handling shell.

### Instructions for Claude Code

Create `src/cli.ts`:

```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { runScan } from "./scanner";
import { renderReport } from "./report";

const program = new Command();

program
  .name("scan-my-mcp")
  .description("Security scanner for MCP servers")
  .version("0.1.0")
  .requiredOption("--url <url>", "MCP server URL to scan")
  .option(
    "--header <header...>",
    'HTTP headers to include (e.g. --header "Authorization: Bearer token")'
  )
  .option("--json", "Output results as JSON instead of terminal report")
  .option("--timeout <ms>", "Total scan timeout in milliseconds", "30000");

program.parse();

const opts = program.opts();

// Parse --header flags into a Record
const headers: Record<string, string> = {};
if (opts.header) {
  for (const h of opts.header) {
    const idx = h.indexOf(":");
    if (idx === -1) {
      console.error(`Invalid header format: "${h}". Use "Name: Value"`);
      process.exit(1);
    }
    const key = h.slice(0, idx).trim();
    const value = h.slice(idx + 1).trim();
    headers[key] = value;
  }
}

(async () => {
  try {
    const result = await runScan({
      url: opts.url,
      headers,
      timeoutMs: parseInt(opts.timeout, 10),
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      renderReport(result);
    }

    // Exit code: 0 if no critical/high, 1 if critical/high findings exist
    const hasCritical =
      result.summary.critical > 0 || result.summary.high > 0;
    process.exit(hasCritical ? 1 : 0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nScan failed: ${message}`);
    process.exit(2);
  }
})();
```

**Verify:** `npm run dev -- --url https://example.com/mcp` should print "Scan failed" (connection refused) without crashing ungracefully.

---

## Phase 3 — HTTP Transport Layer

**Goal:** Connect to an MCP server, complete the handshake, enumerate all tools/resources/prompts with cursor pagination.

### MCP Handshake Sequence (MUST follow this order)

```
1. POST /mcp  { method: "initialize", params: { protocolVersion, clientInfo, capabilities: {} } }
   ← receive: serverInfo, capabilities, protocolVersion

2. POST /mcp  { method: "notifications/initialized" }  (no response expected, fire and forget)

3. POST /mcp  { method: "tools/list", params: { cursor? } }  ← paginate until no nextCursor
4. POST /mcp  { method: "resources/list", params: { cursor? } }
5. POST /mcp  { method: "prompts/list", params: { cursor? } }
```

### Instructions for Claude Code

Create `src/transport/http.ts`:

Key requirements:
- Use `axios` for HTTP requests (not `fetch`) — better timeout and error handling
- Set `Content-Type: application/json` on all requests
- Detect `text/event-stream` response and return a partial result with a finding: "SSE transport detected — partial scan only"
- Implement cursor pagination loop for all three list methods
- Apply these timeouts:
  - connect/initialize: 10,000ms
  - each list call: 8,000ms
  - hard total ceiling: passed in from CLI (default 30,000ms)
- On timeout, return whatever was collected so far with `partial: true`
- Capture raw response JSON before any transformation — the raw descriptions are what checks need

The function signature:
```typescript
export async function connectAndEnumerate(config: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<{
  serverInfo: ServerInfo;
  inventory: Inventory;
  rawResponses: {
    initialize: unknown;
    tools: unknown[];
    resources: unknown[];
    prompts: unknown[];
  };
  partial: boolean;
  partialReason?: string;
}>
```

### Error handling rules

| HTTP Status | Behavior |
|-------------|----------|
| 401 / 403 | Return partial=true, add finding: "Auth enforced — provide --header for full scan" |
| 404 | Throw: "No MCP endpoint found at this URL" |
| 5xx | Return partial=true with what was collected, note server error |
| Network error | Throw with clean message |
| SSE detected | Return partial=true, add finding about SSE |

**Verify:** Running against a real public MCP server should print raw JSON inventory to console (add a temporary console.log in scanner.ts).

---

## Phase 4 — Scanner Orchestrator

**Goal:** Wire transport → checks → summary score into one clean function.

### Instructions for Claude Code

Create `src/scanner.ts`:

```typescript
import { v4 as uuidv4 } from "uuid";
import { connectAndEnumerate } from "./transport/http";
import { runAllChecks } from "./checks/index";
import { ScanResult } from "./types";
import { version } from "../package.json";

export async function runScan(config: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<ScanResult> {
  const startedAt = Date.now();

  const { serverInfo, inventory, partial, partialReason } =
    await connectAndEnumerate(config);

  const findings = runAllChecks({ serverInfo, inventory });

  // Add partial scan finding if applicable
  if (partial && partialReason) {
    findings.push({
      severity: "info",
      check: "scan-coverage",
      title: "Partial scan",
      detail: partialReason,
      location: "transport",
      remediation: "Ensure the server is reachable and provide auth headers if required.",
    });
  }

  const summary = buildSummary(findings);

  return {
    meta: {
      scanId: uuidv4(),
      scannedAt: new Date().toISOString(),
      serverUrl: config.url,
      scanDuration: Date.now() - startedAt,
      scannerVersion: version,
      protocolVersion: serverInfo.protocolVersion,
      partial,
    },
    server: serverInfo,
    inventory,
    findings,
    summary,
  };
}

function buildSummary(findings: Finding[]) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  // Score: start at 100, deduct by severity
  const score = Math.max(
    0,
    100 -
      counts.critical * 25 -
      counts.high * 10 -
      counts.medium * 5 -
      counts.low * 2 -
      counts.info * 0
  );

  return { ...counts, score };
}
```

---

## Phase 5 — Security Checks

**Goal:** 6 check modules that each take `{ serverInfo, inventory }` and return `Finding[]`.

### Instructions for Claude Code

Create `src/checks/index.ts` — runs all checks and merges results:

```typescript
import { ServerInfo, Inventory, Finding } from "../types";
import { checkSecrets } from "./secrets";
import { checkAuth } from "./auth";
import { checkPermissions } from "./permissions";
import { checkValidation } from "./validation";
import { checkInjection } from "./injection";
import { checkContextWindow } from "./context-window";

export function runAllChecks(input: {
  serverInfo: ServerInfo;
  inventory: Inventory;
}): Finding[] {
  return [
    ...checkSecrets(input),
    ...checkAuth(input),
    ...checkPermissions(input),
    ...checkValidation(input),
    ...checkInjection(input),
    ...checkContextWindow(input),
  ];
}
```

---

### Check 1 — `src/checks/secrets.ts` (CRITICAL)

**What it does:** Scans all text fields (tool descriptions, resource descriptions, prompt descriptions, server name/version) for patterns matching real credentials.

**Patterns to detect:**

```typescript
const SECRET_PATTERNS = [
  { name: "Anthropic API key",   pattern: /sk-ant-[a-zA-Z0-9\-_]{20,}/g },
  { name: "OpenAI API key",      pattern: /sk-[a-zA-Z0-9]{32,}/g },
  { name: "AWS Access Key",      pattern: /AKIA[0-9A-Z]{16}/g },
  { name: "AWS Secret Key",      pattern: /[a-zA-Z0-9/+=]{40}(?=.*aws)/gi },
  { name: "Bearer token",        pattern: /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/gi },
  { name: "Generic API key",     pattern: /api[_-]?key['":\s]+[a-zA-Z0-9\-_]{16,}/gi },
  { name: "Private key block",   pattern: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/g },
  { name: "Database URL",        pattern: /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/gi },
  { name: "GitHub token",        pattern: /gh[pousr]_[a-zA-Z0-9]{36}/g },
  { name: "Slack token",         pattern: /xox[baprs]-[a-zA-Z0-9\-]+/g },
  { name: "Generic password",    pattern: /password['":\s]+[^\s'"]{8,}/gi },
  { name: "Generic secret",      pattern: /secret['":\s]+[^\s'"]{8,}/gi },
];
```

**Fields to scan:**
- `tools[n].description`
- `tools[n].inputSchema` (stringified)
- `resources[n].description`
- `resources[n].uri` (connection strings appear here)
- `prompts[n].description`
- `serverInfo.name`
- `serverInfo.version`
- Error messages captured during enumeration

**Severity:** Always CRITICAL.

**Location format:** `tools[2].description`

**Remediation:** "Remove credentials from server definitions. Use environment variables and never embed secrets in tool descriptions or schemas."

---

### Check 2 — `src/checks/auth.ts` (HIGH)

**What it does:** Determines whether the server enforced any authentication during the scan.

**Logic:**
- If the scanner connected and enumerated without providing any `Authorization` header → server has no auth → HIGH finding
- Read from `serverInfo.capabilities` — absence of any auth-related capability is a signal
- Check if `initialize` response contains any auth challenge fields

**Finding when no auth:**
```
severity: "high"
title: "Server requires no authentication"
detail: "Scanner connected and enumerated all tools without credentials."
remediation: "Implement OAuth 2.1 or API key authentication. All MCP servers exposed over HTTP should require authentication."
```

**Finding when auth present (info):**
```
severity: "info"
title: "Authentication enforced"
detail: "Server returned 401 without credentials — auth is active."
```

---

### Check 3 — `src/checks/permissions.ts` (HIGH/MEDIUM)

**What it does:** Flags tools that claim access to high-risk system resources based on name and description keywords.

**Keyword groups:**

```typescript
const PERMISSION_GROUPS = [
  {
    severity: "high" as Severity,
    label: "filesystem write access",
    keywords: ["write file", "delete file", "create file", "rm ", "unlink",
               "writeFile", "writeFileSync", "fs.write", "overwrite"],
  },
  {
    severity: "high" as Severity,
    label: "shell/command execution",
    keywords: ["exec(", "execSync", "spawn(", "shell", "bash", "sh -c",
               "run command", "execute command", "system("],
  },
  {
    severity: "high" as Severity,
    label: "environment variable access",
    keywords: ["process.env", "os.environ", "getenv", "env vars",
               "environment variable"],
  },
  {
    severity: "medium" as Severity,
    label: "filesystem read access",
    keywords: ["read file", "readFile", "readFileSync", "fs.read",
               "list directory", "readdir"],
  },
  {
    severity: "medium" as Severity,
    label: "network request capability",
    keywords: ["http request", "fetch(", "axios", "curl", "wget",
               "make request", "call url", "endpoint"],
  },
];
```

Scan tool names + descriptions. A match produces one finding per tool per group. Include the matched keyword in the detail.

---

### Check 4 — `src/checks/validation.ts` (MEDIUM)

**What it does:** Flags tool input parameters that have no type constraints — open doors for injection or unexpected behavior.

**Rules:**
- A parameter with `type: "string"` and no `maxLength`, no `pattern`, no `enum` → medium finding
- A parameter with no `type` at all → medium finding
- A tool with no `inputSchema` at all → low finding (no input validation defined)
- Required parameters with no constraints are higher priority than optional ones

**Finding:**
```
severity: "medium"
title: "Unconstrained string parameter"
detail: "Tool 'execute_query' parameter 'query' accepts arbitrary string input with no length limit or pattern constraint."
location: "tools[3].inputSchema.properties.query"
remediation: "Add maxLength, pattern regex, or enum constraints to string parameters. Validate and sanitize all inputs server-side."
```

---

### Check 5 — `src/checks/injection.ts` (MEDIUM)

**What it does:** Identifies tool descriptions that contain patterns that could facilitate prompt injection.

**Patterns to flag:**

```typescript
const INJECTION_PATTERNS = [
  {
    pattern: /ignore (previous|all|above|prior) instructions/gi,
    title: "Direct prompt injection attempt in tool description",
    severity: "critical" as Severity,
  },
  {
    pattern: /you (are|must|should|will) now/gi,
    title: "Role-redefining language in tool description",
    severity: "high" as Severity,
  },
  {
    pattern: /\{\{.*?\}\}|\$\{.*?\}/g,
    title: "Unescaped template variable in tool description",
    severity: "medium" as Severity,
  },
  {
    pattern: /<\/?[a-z]+(\s[^>]*)?>.*?<\/[a-z]+>/gi,
    title: "HTML/XML tags in tool description",
    severity: "low" as Severity,
  },
  {
    pattern: /system prompt|system message|jailbreak|DAN mode/gi,
    title: "Suspicious jailbreak language in tool description",
    severity: "high" as Severity,
  },
];
```

Scan: tool descriptions, resource descriptions, prompt templates.

---

### Check 6 — `src/checks/context-window.ts` (LOW/INFO)

**What it does:** Estimates token overhead from tool definitions and warns when it's excessive.

**Logic:**
- Rough token estimate: `total_chars_of_all_tool_schemas / 4`
- >15 tools total → low finding
- Estimated tokens >10,000 → medium finding
- Estimated tokens >50,000 → high finding (one team burned 72% of their context on tool defs)

**Also check from serverInfo:**
- `capabilities.resources.subscribe: true` → info finding (real-time subscriptions expand attack surface)
- `capabilities.logging` present → info finding (check if sensitive data is logged)

---

## Phase 6 — Report Renderer

**Goal:** Clean, colored terminal output. Scannable in 10 seconds.

### Instructions for Claude Code

Create `src/report.ts` using `chalk` for colors.

**Terminal output format:**

```
┌─────────────────────────────────────────┐
│  scan-my-mcp v0.1.0                     │
│  https://example.com/mcp                │
└─────────────────────────────────────────┘

Server:   my-company-mcp v1.2.0
Protocol: 2024-11-05
Scanned:  23 tools · 4 resources · 2 prompts
Duration: 1.4s

Security Score: 42/100  ████░░░░░░  HIGH RISK

FINDINGS (8)
─────────────────────────────────────────
● CRITICAL  API key found in tool description
            tools[2].description contains pattern matching sk-ant-...
            Fix: Remove credentials from tool definitions. Use environment variables.

● CRITICAL  Database URL with credentials
            resources[0].uri contains postgresql://admin:secret@...
            Fix: Use connection pooling with env-var credentials, never embed in URI.

● HIGH      Server requires no authentication
            Scanner connected without credentials.
            Fix: Implement OAuth 2.1 or API key auth.

● MEDIUM    Unconstrained string parameter
            tools[5].inputSchema.properties.query — no maxLength or pattern
            Fix: Add input constraints to all string parameters.

…

SUMMARY
─────────────────────────────────────────
  2 critical   8 high   3 medium   1 low   2 info

  Run with --json for machine-readable output.
  Docs: https://scan-my-mcp.dev
```

**Color rules:**
- CRITICAL → red bold
- HIGH → red
- MEDIUM → yellow
- LOW → blue
- INFO → gray
- Score 80–100 → green, 50–79 → yellow, 0–49 → red

**Sorting:** Always show findings sorted by severity (critical first).

---

## Phase 7 — Polish & Ship

### Instructions for Claude Code

1. **Add shebang to cli.ts:** First line must be `#!/usr/bin/env node`

2. **Build and test locally:**
   ```bash
   npm run build
   node dist/cli.js --url https://YOUR_TEST_SERVER/mcp
   ```

3. **Test with --json flag:**
   ```bash
   node dist/cli.js --url https://YOUR_TEST_SERVER/mcp --json | jq .summary
   ```

4. **Test exit codes:**
   ```bash
   node dist/cli.js --url https://SERVER_WITH_NO_ISSUES/mcp
   echo $?  # should be 0

   node dist/cli.js --url https://SERVER_WITH_HIGH_FINDINGS/mcp
   echo $?  # should be 1
   ```

5. **Publish to npm:**
   ```bash
   npm login
   npm publish --access public
   ```

6. **Verify npx works:**
   ```bash
   npx scan-my-mcp --url https://example.com/mcp
   ```

### package.json final state
```json
{
  "name": "scan-my-mcp",
  "version": "0.1.0",
  "description": "Security scanner for MCP servers",
  "main": "dist/cli.js",
  "bin": { "scan-my-mcp": "./dist/cli.js" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli.ts",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["mcp", "security", "scanner", "ai", "agents"],
  "license": "MIT"
}
```

---

## Testing Strategy

### Manual test targets

**Test against a server with known issues (build one yourself):**
```typescript
// test-server.ts — a deliberately vulnerable MCP server for testing
// Tools with: exposed API key in description, no auth, unconstrained params
// Run locally, scan with: npm run dev -- --url http://localhost:3000/mcp
```
Ask Claude Code to generate this test server — it's the fastest way to verify all checks fire correctly.

**Test edge cases:**
- Server that returns 401 → should produce partial scan, auth finding
- Server with 0 tools → should complete cleanly, score 100
- Server that times out → should return partial results, not hang
- Server with 50+ tools → should paginate correctly, flag context window
- `--json` flag → output must be valid JSON (pipe to `jq` to verify)

---

## What's Out of Scope (do not build yet)

- stdio transport (local MCP servers)
- Web dashboard
- Continuous monitoring / scheduled scans
- CI/CD GitHub Action
- Custom check rules
- Authentication to the scanner itself (it's a CLI)

These are Phase 2 features. Ship the CLI first.

---

## Common Errors Claude Code May Hit

| Error | Cause | Fix |
|-------|-------|-----|
| `Cannot find module '@modelcontextprotocol/sdk'` | Not installed | `npm install @modelcontextprotocol/sdk` |
| `ERR_REQUIRE_ESM` | SDK is ESM, project is CJS | Set `"module": "NodeNext"` in tsconfig or use `tsx` |
| `notifications/initialized` gets 404 | Some servers don't implement notifications endpoint | Catch and ignore — fire and forget |
| Pagination loop never ends | Server returns same cursor repeatedly | Add max iteration guard (100 pages) |
| Chalk produces no color in CI | `chalk` detects no TTY | Use `chalk.level = 1` override or `--no-color` flag |

---

## Definition of Done

The scanner is shippable when:

- [ ] `npx scan-my-mcp --url <real-server>` runs end to end
- [ ] All 6 check modules return findings on a vulnerable test server
- [ ] `--json` output passes `jq` validation
- [ ] Exit code is 1 when critical/high findings present
- [ ] Timeout produces partial results, not a hang
- [ ] 401 response produces a useful message, not a crash
- [ ] Package is published to npm and `npx` works cold (no prior install)

---

## Next Product (build after scanner is shipped)

See `AI_SAAS_BUILDS.md` — Product 2 is **Agent Observability Dashboard**. The SDK you build for that product shares the data model from this scanner's `ScanResult` type. Keep `types.ts` clean — it will grow.
