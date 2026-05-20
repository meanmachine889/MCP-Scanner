import { spawn, ChildProcess } from "child_process";
import {
    ServerInfo,
    Inventory,
    ToolDefinition,
    ResourceDefinition,
    PromptDefinition,
} from "../types";
import { TransportResult, TransportStage } from "./http";

interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

class StdioClient {
    private child: ChildProcess;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private buffer = "";
    private stderr = "";
    private closed = false;

    constructor(command: string, args: string[], env?: Record<string, string>) {
        this.child = spawn(command, args, {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, ...(env ?? {}) },
        });

        this.child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
        this.child.stderr?.on("data", (chunk: Buffer) => {
            // Capture stderr so we can surface it on failure
            this.stderr += chunk.toString("utf8");
            if (this.stderr.length > 4_000) {
                this.stderr = this.stderr.slice(-4_000);
            }
        });
        this.child.on("error", (err) => this.rejectAll(err));
        this.child.on("exit", (code, signal) => {
            this.closed = true;
            if (this.pending.size > 0) {
                const tail = this.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 240);
                const detail = tail ? ` — stderr: ${tail}` : "";
                this.rejectAll(
                    new Error(
                        `MCP subprocess exited (code=${code}, signal=${signal})${detail}`
                    )
                );
            }
        });
    }

    private onStdout(chunk: Buffer): void {
        this.buffer += chunk.toString("utf8");
        let idx: number;
        while ((idx = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            try {
                const msg = JSON.parse(line);
                this.handleMessage(msg);
            } catch {
                // Non-JSON line (some servers print banners to stdout). Skip.
            }
        }
    }

    private handleMessage(msg: { id?: number; result?: unknown; error?: { message: string } }): void {
        if (typeof msg.id !== "number") return; // ignore notifications from server
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
    }

    private rejectAll(err: Error): void {
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }

    request(
        method: string,
        params: Record<string, unknown> = {},
        timeoutMs: number = 10_000
    ): Promise<unknown> {
        if (this.closed) {
            return Promise.reject(new Error("Subprocess has exited"));
        }
        const id = this.nextId++;
        const message = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.child.stdin?.write(message);
            } catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(err as Error);
            }
        });
    }

    notify(method: string, params: Record<string, unknown> = {}): void {
        if (this.closed) return;
        const message = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
        try {
            this.child.stdin?.write(message);
        } catch {
            // ignore — fire and forget
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.rejectAll(new Error("Client closed"));
        try { this.child.stdin?.end(); } catch { /* noop */ }
        try { this.child.kill(); } catch { /* noop */ }
    }
}

function classifyStdioListError(error: unknown, target: string): string {
    const msg = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    if (/timed out/i.test(msg)) return `Timed out while listing ${target}`;
    if (/not found|Method not found/i.test(msg)) {
        return `Server does not support ${target}/list (method not found)`;
    }
    if (/subprocess exited/i.test(msg)) return `Subprocess exited while listing ${target}: ${msg}`;
    return `Listing ${target} failed: ${msg}`;
}

export async function connectAndEnumerateStdio(config: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    timeoutMs: number;
    onProgress?: (stage: TransportStage) => void;
}): Promise<TransportResult> {
    const { command, args = [], env, onProgress } = config;

    onProgress?.("connecting");

    const client = new StdioClient(command, args, env);

    const emptyServerInfo: ServerInfo = {
        name: "unknown",
        version: "unknown",
        protocolVersion: "unknown",
        capabilities: {},
    };

    onProgress?.("handshake");
    let initResult: any;
    try {
        initResult = await client.request(
            "initialize",
            {
                protocolVersion: "2024-11-05",
                clientInfo: { name: "scan-my-mcp", version: "0.1.0" },
                capabilities: {},
            },
            10_000
        );
    } catch (err) {
        client.close();
        const msg = err instanceof Error ? err.message : String(err);
        if (/ENOENT|spawn .* ENOENT/i.test(msg)) {
            throw new Error(`Command not found: ${command}. Check that it's installed and on PATH.`);
        }
        throw new Error(`MCP handshake failed: ${msg}`);
    }

    const serverInfo: ServerInfo = {
        name: initResult?.serverInfo?.name ?? "unknown",
        version: initResult?.serverInfo?.version ?? "unknown",
        protocolVersion: initResult?.protocolVersion ?? "unknown",
        capabilities: initResult?.capabilities ?? {},
    };

    client.notify("notifications/initialized");

    let tools: ToolDefinition[] = [];
    let resources: ResourceDefinition[] = [];
    let prompts: PromptDefinition[] = [];
    const toolsRaw: unknown[] = [];
    const resourcesRaw: unknown[] = [];
    const promptsRaw: unknown[] = [];
    let partial = false;
    let partialReason: string | undefined;
    const coverage = { initialize: true, tools: false, resources: false, prompts: false };

    async function paginate<T>(
        method: string,
        key: string,
        raw: unknown[]
    ): Promise<T[]> {
        const items: T[] = [];
        let cursor: string | undefined = undefined;
        let iter = 0;
        while (iter++ < 100) {
            const params: Record<string, unknown> = cursor ? { cursor } : {};
            const result = (await client.request(method, params, 8_000)) as Record<string, any>;
            const page = (result?.[key] ?? []) as T[];
            items.push(...page);
            raw.push(result);
            if (result?.nextCursor) cursor = result.nextCursor;
            else break;
        }
        return items;
    }

    onProgress?.("listing-tools");
    try {
        tools = await paginate<ToolDefinition>("tools/list", "tools", toolsRaw);
        coverage.tools = true;
    } catch (err) {
        partial = true;
        partialReason = classifyStdioListError(err, "tools");
    }

    onProgress?.("listing-resources");
    try {
        resources = await paginate<ResourceDefinition>("resources/list", "resources", resourcesRaw);
        coverage.resources = true;
    } catch (err) {
        partial = true;
        partialReason = partialReason ?? classifyStdioListError(err, "resources");
    }

    onProgress?.("listing-prompts");
    try {
        prompts = await paginate<PromptDefinition>("prompts/list", "prompts", promptsRaw);
        coverage.prompts = true;
    } catch (err) {
        partial = true;
        partialReason = partialReason ?? classifyStdioListError(err, "prompts");
    }

    client.close();

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
        sessionId: undefined,
        initializeBlockedByAuth: false,
        listingBlockedByAuth: false,
        coverage,
    };
}
