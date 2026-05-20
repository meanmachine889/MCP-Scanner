import axios, { AxiosError } from "axios";
import { ServerInfo, Inventory, ResourceDefinition, ToolDefinition, PromptDefinition } from "../types";

async function mcpPost(
    url: string,
    headers: Record<string, string>,
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs: number
) {
    const response = await axios.post(
        url,
        { jsonrpc: "2.0", id: 1, method, params },
        {
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                ...headers,
            },
            timeout: timeoutMs,
            validateStatus: () => true,
            transformResponse: [(data) => data],
        }
    );

    const contentType = String(response.headers["content-type"] ?? "");

    if (response.status >= 400) {
        const err: any = new Error(`Request failed with status code ${response.status}`);
        err.response = response;
        err.isAxiosError = true;
        throw err;
    }

    if (contentType.includes("text/event-stream")) {
        const parsed = parseSSEResponse(String(response.data ?? ""));
        return { ...response, data: parsed };
    }

    if (typeof response.data === "string") {
        try {
            response.data = JSON.parse(response.data);
        } catch {
            // leave as-is
        }
    }

    return response;
}

function parseSSEResponse(text: string): unknown {
    // SSE format: lines like "event: message\ndata: {...}\n\n"
    // We want the first parseable JSON data line.
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
        if (line.startsWith("data:")) {
            const payload = line.slice(5).trim();
            if (payload && payload !== "[DONE]") {
                try {
                    return JSON.parse(payload);
                } catch {
                    continue;
                }
            }
        }
    }
    return null;
}

async function paginatedList<T>(
    url: string,
    headers: Record<string, string>,
    method: string,
    key: string,
    timeoutMs: number
): Promise<{ items: T[]; raw: unknown[] }> {
    const items: T[] = [];
    const rawResponses: unknown[] = [];
    let cursor: string | undefined = undefined;
    let iteration = 0;

    while (iteration < 100) {
        iteration++;
        const params: Record<string, unknown> = cursor ? { cursor } : {};
        const response = await mcpPost(url, headers, method, params, timeoutMs);
        const result = response.data?.result ?? {};

        const page = (result[key] ?? []) as T[];
        items.push(...page);
        rawResponses.push(response.data);

        if (result.nextCursor) {
            cursor = result.nextCursor;
        } else {
            break;
        }
    }

    return { items, raw: rawResponses };
}

function classifyListError(error: unknown, target: string): string {
    const axiosError = error as AxiosError;
    if (axiosError?.code === "ECONNABORTED" || /timeout/i.test(axiosError?.message ?? "")) {
        return `Timed out while listing ${target}`;
    }
    if (axiosError?.response) {
        const status = axiosError.response.status;
        if (status === 401 || status === 403) {
            return `Auth required to list ${target} — provide --header for full coverage`;
        }
        if (status === 404 || status === 405) {
            return `Server does not support ${target}/list (HTTP ${status})`;
        }
        if (status >= 500) {
            return `Server error while listing ${target} (HTTP ${status})`;
        }
        return `Listing ${target} failed (HTTP ${status})`;
    }
    const msg = (error instanceof Error ? error.message : String(error)).slice(0, 140);
    return `Listing ${target} failed: ${msg}`;
}

export type TransportStage =
    | "connecting"
    | "handshake"
    | "listing-tools"
    | "listing-resources"
    | "listing-prompts";

export interface TransportResult {
    serverInfo: ServerInfo;
    inventory: Inventory;
    rawResponses: { initialize: unknown; tools: unknown[]; resources: unknown[]; prompts: unknown[] };
    partial: boolean;
    partialReason?: string;
    sessionId?: string;
    initializeBlockedByAuth: boolean;
    listingBlockedByAuth: boolean;
    coverage: {
        initialize: boolean;
        tools: boolean;
        resources: boolean;
        prompts: boolean;
    };
}

export async function connectAndenumerate(config: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
    onProgress?: (stage: TransportStage) => void;
}): Promise<TransportResult> {
    const { url, headers, onProgress } = config;

    onProgress?.("connecting");

    const emptyServerInfo: ServerInfo = {
        name: "unknown",
        version: "unknown",
        protocolVersion: "unknown",
        capabilities: {},
    };

    const emptyInventory: Inventory = {
        tools: [],
        resources: [],
        prompts: [],
    };

    onProgress?.("handshake");
    let initResponse: Awaited<ReturnType<typeof mcpPost>> | null = null;
    try {
        initResponse = await mcpPost(
            url,
            headers,
            "initialize",
            {
                protocolVersion: "2024-11-05",
                clientInfo: { name: "scan-my-mcp", version: "0.1.0" },
                capabilities: {},
            },
            10_000
        );
    } catch (error) {
        const axiosError = error as AxiosError;

        if (axiosError.response) {
            const status = axiosError.response.status;

            if (status === 401 || status === 403) {
                return {
                    serverInfo: emptyServerInfo,
                    inventory: emptyInventory,
                    rawResponses: { initialize: null, tools: [], resources: [], prompts: [] },
                    partial: true,
                    partialReason: "Auth enforced — provide --header for full scan (e.g. --header \"Authorization: Bearer token\")",
                    initializeBlockedByAuth: true,
                    listingBlockedByAuth: false,
                    coverage: { initialize: false, tools: false, resources: false, prompts: false },
                };
            }

            if (status === 404) {
                throw new Error("No MCP endpoint found at this URL");
            }

            if (status >= 500) {
                return {
                    serverInfo: emptyServerInfo,
                    inventory: emptyInventory,
                    rawResponses: { initialize: null, tools: [], resources: [], prompts: [] },
                    partial: true,
                    partialReason: `Server error during initialize: HTTP ${status}`,
                    initializeBlockedByAuth: false,
                    listingBlockedByAuth: false,
                    coverage: { initialize: false, tools: false, resources: false, prompts: false },
                };
            }
        }

        const message = axiosError.message ?? String(error);
        throw new Error(`Connection failed: ${message}`);
    }

    const initResult = initResponse?.data?.result ?? {};
    const serverInfo: ServerInfo = {
        name: initResult.serverInfo?.name ?? "unknown",
        version: initResult.serverInfo?.version ?? "unknown",
        protocolVersion: initResult.protocolVersion ?? "unknown",
        capabilities: initResult.capabilities ?? {},
    };

    // Capture Mcp-Session-Id from initialize response and replay it on every
    // subsequent call (modern MCP Streamable HTTP transport requires this).
    const rawSessionId = initResponse?.headers?.["mcp-session-id"];
    const sessionId = typeof rawSessionId === "string" && rawSessionId
        ? rawSessionId
        : undefined;
    const sessionHeaders: Record<string, string> = { ...headers };
    if (sessionId) {
        sessionHeaders["Mcp-Session-Id"] = sessionId;
    }

    mcpPost(url, sessionHeaders, "notifications/initialized", {}, 5_000).catch(() => { });

    let tools: ToolDefinition[] = [];
    let resources: ResourceDefinition[] = [];
    let prompts: PromptDefinition[] = [];
    let toolsRaw: unknown[] = [];
    let resourcesRaw: unknown[] = [];
    let promptsRaw: unknown[] = [];
    let partial = false;
    let partialReason: string | undefined;
    let listingBlockedByAuth = false;
    const coverage = {
        initialize: true,
        tools: false,
        resources: false,
        prompts: false,
    };

    function isAuthError(err: unknown): boolean {
        const ax = err as AxiosError;
        const s = ax?.response?.status;
        return s === 401 || s === 403;
    }

    onProgress?.("listing-tools");
    try {
        const result = await paginatedList<ToolDefinition>(url, sessionHeaders, "tools/list", "tools", 8_000);
        tools = result.items;
        toolsRaw = result.raw;
        coverage.tools = true;
    } catch (err) {
        partial = true;
        partialReason = classifyListError(err, "tools");
        if (isAuthError(err)) listingBlockedByAuth = true;
    }

    onProgress?.("listing-resources");
    try {
        const result = await paginatedList<ResourceDefinition>(url, sessionHeaders, "resources/list", "resources", 8_000);
        resources = result.items;
        resourcesRaw = result.raw;
        coverage.resources = true;
    } catch (err) {
        partial = true;
        partialReason = partialReason ?? classifyListError(err, "resources");
        if (isAuthError(err)) listingBlockedByAuth = true;
    }

    onProgress?.("listing-prompts");
    try {
        const result = await paginatedList<PromptDefinition>(url, sessionHeaders, "prompts/list", "prompts", 8_000);
        prompts = result.items;
        promptsRaw = result.raw;
        coverage.prompts = true;
    } catch (err) {
        partial = true;
        partialReason = partialReason ?? classifyListError(err, "prompts");
        if (isAuthError(err)) listingBlockedByAuth = true;
    }

    return {
        serverInfo,
        inventory: { tools, resources, prompts },
        rawResponses: {
            initialize: initResult,
            tools: toolsRaw,
            resources: resourcesRaw,
            prompts: promptsRaw,
        },
        partial,
        partialReason,
        sessionId,
        initializeBlockedByAuth: false,
        listingBlockedByAuth,
        coverage,
    };
}
