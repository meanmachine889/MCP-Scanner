#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { runScan, ProgressEvent, ScanConfig } from "./scanner";
import { renderReport } from "./report";
import { Spinner } from "./ui/spinner";

const program = new Command();

program
    .name("scan-my-mcp")
    .description("Security scanner for MCP servers (HTTP or local stdio)")
    .version("0.1.0")
    .option("--url <url>", "MCP server URL to scan over HTTP")
    .option(
        "--command <command>",
        'Local MCP server command + args to scan over stdio. Quote the whole string, e.g. --command "npx -y @modelcontextprotocol/server-everything"'
    )
    .option(
        "--header <header...>",
        'HTTP headers to include (e.g. --header "Authorization: Bearer token")'
    )
    .option(
        "--env <env...>",
        'Environment variables for stdio command (e.g. --env API_KEY=xyz)'
    )
    .option("--json", "Output results as JSON instead of terminal report")
    .option("--timeout <ms>", "Total scan timeout in milliseconds", "30000");
program.parse();

const opts = program.opts();

// Validate: exactly one of --url or --command required
if (!opts.url && !opts.command) {
    console.error(
        "Error: must provide either --url <url> or --command <cmd> [args...]\n" +
        "Examples:\n" +
        "  scan-my-mcp --url https://example.com/mcp\n" +
        "  scan-my-mcp --command npx -y @modelcontextprotocol/server-everything"
    );
    process.exit(1);
}
if (opts.url && opts.command) {
    console.error("Error: cannot use both --url and --command in the same scan.");
    process.exit(1);
}

// Parse --header into a record
const headers: Record<string, string> = {};
if (opts.header) {
    for (const h of opts.header) {
        const idx = h.indexOf(":");
        if (idx > 0) {
            headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        } else {
            console.error(`Invalid header format: "${h}". Use "Name: Value"`);
            process.exit(1);
        }
    }
}

// Parse the --command string into argv tokens (respecting "double quotes")
function parseCommand(input: string): string[] {
    const tokens: string[] = [];
    const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(input)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[3]);
    }
    return tokens;
}

// Parse --env KEY=VALUE pairs
const envVars: Record<string, string> = {};
if (opts.env) {
    for (const e of opts.env) {
        const idx = e.indexOf("=");
        if (idx > 0) {
            envVars[e.slice(0, idx).trim()] = e.slice(idx + 1);
        } else {
            console.error(`Invalid env format: "${e}". Use KEY=VALUE`);
            process.exit(1);
        }
    }
}

const STAGE_MESSAGES: Record<ProgressEvent["stage"], string> = {
    "connecting":         "Connecting to MCP server…",
    "handshake":          "Performing MCP handshake…",
    "listing-tools":      "Enumerating tools…",
    "listing-resources":  "Enumerating resources…",
    "listing-prompts":    "Enumerating prompts…",
    "checking":           "Running security checks…",
};

(async () => {
    const useSpinner = !opts.json;
    const spinner = new Spinner();

    const commandTokens: string[] = opts.command ? parseCommand(opts.command) : [];
    if (opts.command && commandTokens.length === 0) {
        console.error(`Error: --command was empty or unparseable: ${JSON.stringify(opts.command)}`);
        process.exit(1);
    }

    const displayTarget = opts.url
        ? opts.url
        : commandTokens.join(" ");

    if (useSpinner) {
        console.log();
        console.log(
            "  " + chalk.magentaBright.bold("scan-my-mcp") +
            chalk.dim(" v0.1.0") +
            chalk.dim("  ·  ") +
            chalk.cyan(displayTarget)
        );
        console.log();
        spinner.start(STAGE_MESSAGES.connecting);
    }

    try {
        const baseConfig = {
            headers,
            timeoutMs: parseInt(opts.timeout, 10),
            onProgress: (event: ProgressEvent) => {
                if (useSpinner) spinner.update(STAGE_MESSAGES[event.stage]);
            },
        };

        const scanConfig: ScanConfig = opts.command
            ? {
                  ...baseConfig,
                  command: commandTokens[0],
                  args: commandTokens.slice(1),
                  env: envVars,
              }
            : { ...baseConfig, url: opts.url };

        const result = await runScan(scanConfig);

        if (useSpinner) {
            spinner.succeed(
                `Scan complete  ${chalk.dim("·")} ` +
                `${chalk.cyan(result.inventory.tools.length)} tools, ` +
                `${chalk.cyan(result.inventory.resources.length)} resources, ` +
                `${chalk.cyan(result.inventory.prompts.length)} prompts ` +
                chalk.dim(`(${(result.meta.scanDuration / 1000).toFixed(1)}s)`)
            );
        }

        if (opts.json) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            renderReport(result);
        }

        const hasCritical = result.summary.critical > 0 || result.summary.high > 0;
        process.exit(hasCritical ? 1 : 0);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (useSpinner) spinner.fail(`Scan failed: ${message}`);
        else console.error(`\nScan failed: ${message}`);
        process.exit(2);
    }
})();
