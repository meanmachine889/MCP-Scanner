import { v4 as uuidv4 } from "uuid";
import { connectAndenumerate, TransportResult } from "./transport/http";
import { connectAndEnumerateStdio } from "./transport/stdio";
import { runAllChecks } from "./checks/index";
import { AuthState, Finding, ScanResult, TransportKind } from "./types";
import { version } from "../package.json";

export type ProgressEvent =
    | { stage: "connecting" }
    | { stage: "handshake" }
    | { stage: "listing-tools" }
    | { stage: "listing-resources" }
    | { stage: "listing-prompts" }
    | { stage: "checking" };

export type ScanConfig = {
    headers: Record<string, string>;
    timeoutMs: number;
    onProgress?: (event: ProgressEvent) => void;
} & (
    | { url: string; command?: never; args?: never; env?: never }
    | { command: string; args?: string[]; env?: Record<string, string>; url?: never }
);

export async function runScan(config: ScanConfig): Promise<ScanResult> {
    const startedAt = Date.now();
    const headersProvided = Object.keys(config.headers).length > 0;

    let transport: TransportResult;
    let kind: TransportKind;
    let target: string;

    if (config.command) {
        kind = "stdio";
        target = [config.command, ...(config.args ?? [])].join(" ");
        transport = await connectAndEnumerateStdio({
            command: config.command,
            args: config.args,
            env: config.env,
            timeoutMs: config.timeoutMs,
            onProgress: (stage) => config.onProgress?.({ stage }),
        });
    } else {
        kind = "http";
        target = config.url!;
        transport = await connectAndenumerate({
            url: config.url!,
            headers: config.headers,
            timeoutMs: config.timeoutMs,
            onProgress: (stage) => config.onProgress?.({ stage }),
        });
    }

    config.onProgress?.({ stage: "checking" });

    const {
        serverInfo,
        inventory,
        partial,
        partialReason,
        sessionId,
        initializeBlockedByAuth,
        listingBlockedByAuth,
        coverage,
    } = transport;

    // For local stdio servers, MCP-level auth is N/A (security boundary is the OS process).
    let authState: AuthState;
    if (kind === "stdio") {
        authState = "n/a";
    } else if (headersProvided || initializeBlockedByAuth) {
        authState = "full";
    } else if (listingBlockedByAuth) {
        authState = "partial";
    } else {
        authState = "none";
    }

    const findings = runAllChecks({ serverInfo, inventory, authState });

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
            serverUrl: target,
            transport: kind,
            scanDuration: Date.now() - startedAt,
            scannerVersion: version,
            protocolVersion: serverInfo.protocolVersion,
            partial,
            partialReason,
            sessionId,
            authState,
            coverage,
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

    let score =
        100 -
        counts.critical * 30 -
        counts.high * 15 -
        counts.medium * 5 -
        counts.low * 2;

    if (counts.critical > 0) {
        score = Math.min(score, 39);
    } else if (counts.high > 0) {
        score = Math.min(score, 69);
    }

    score = Math.max(0, score);
    return { ...counts, score };
}
