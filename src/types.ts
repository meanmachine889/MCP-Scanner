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

export type AuthState = "none" | "partial" | "full" | "n/a";
export type TransportKind = "http" | "stdio";

export interface ScanResult {
  meta: {
    scanId: string;
    scannedAt: string;        // ISO timestamp
    serverUrl: string;        // display target (url for http, command for stdio)
    transport: TransportKind;
    scanDuration: number;     // ms
    scannerVersion: string;
    protocolVersion: string;
    partial: boolean;         // true if scan timed out or errored mid-way
    partialReason?: string;
    sessionId?: string;
    authState: AuthState;
    coverage: {
      initialize: boolean;
      tools: boolean;
      resources: boolean;
      prompts: boolean;
    };
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