import chalk from "chalk";
import { ScanResult, Severity } from "./types";

if (chalk.level < 2) {
    chalk.level = 2;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];
const BOX_WIDTH = 64;     // visible width including the two border chars
const INNER_PAD = 2;      // left/right inner padding

// ─── color helpers ──────────────────────────────────────────────────────────
const accent = chalk.cyanBright;
const muted  = chalk.dim;

function severityAccent(severity: Severity, text: string): string {
    switch (severity) {
        case "critical": return chalk.redBright.bold(text);
        case "high":     return chalk.red.bold(text);
        case "medium":   return chalk.yellowBright.bold(text);
        case "low":      return chalk.blueBright.bold(text);
        case "info":     return chalk.gray.bold(text);
    }
}

function severityBadge(severity: Severity): string {
    const label = ` ${severity.toUpperCase()} `;
    switch (severity) {
        case "critical": return chalk.bgRed.white.bold(label);
        case "high":     return chalk.bgRedBright.black.bold(label);
        case "medium":   return chalk.bgYellow.black.bold(label);
        case "low":      return chalk.bgBlue.white.bold(label);
        case "info":     return chalk.bgGray.white.bold(label);
    }
}

function severityChip(severity: Severity, n: number): string {
    const label = ` ${n} ${severity} `;
    if (n === 0) return muted(label);
    switch (severity) {
        case "critical": return chalk.bgRed.white.bold(label);
        case "high":     return chalk.bgRedBright.black.bold(label);
        case "medium":   return chalk.bgYellow.black.bold(label);
        case "low":      return chalk.bgBlue.white.bold(label);
        case "info":     return chalk.bgGray.white.bold(label);
    }
}

function scoreColor(score: number, text: string): string {
    if (score >= 80) return chalk.greenBright.bold(text);
    if (score >= 50) return chalk.yellowBright.bold(text);
    return chalk.redBright.bold(text);
}

function scoreBar(score: number, width = 20): string {
    const filled = Math.max(0, Math.min(width, Math.round((score / 100) * width)));
    const empty = width - filled;
    const fillCh = "█";
    const emptyCh = "░";
    const fillColor =
        score >= 80 ? chalk.greenBright
        : score >= 50 ? chalk.yellowBright
        : chalk.redBright;
    return fillColor(fillCh.repeat(filled)) + chalk.gray(emptyCh.repeat(empty));
}

function riskBadge(score: number): string {
    if (score >= 80) return chalk.bgGreen.black.bold(" SAFE ");
    if (score >= 50) return chalk.bgYellow.black.bold(" MODERATE RISK ");
    return chalk.bgRed.white.bold(" HIGH RISK ");
}

// ─── box helpers (visible-width aware) ──────────────────────────────────────
function boxTop(): string {
    return accent("╭" + "─".repeat(BOX_WIDTH - 2) + "╮");
}
function boxBottom(): string {
    return accent("╰" + "─".repeat(BOX_WIDTH - 2) + "╯");
}
function boxLine(styledContent: string, plainWidth: number): string {
    const interior = BOX_WIDTH - 2 - INNER_PAD * 2;
    const fill = Math.max(0, interior - plainWidth);
    return (
        accent("│") +
        " ".repeat(INNER_PAD) +
        styledContent +
        " ".repeat(fill + INNER_PAD) +
        accent("│")
    );
}
function boxSeparator(): string {
    return accent("├" + "─".repeat(BOX_WIDTH - 2) + "┤");
}

// ─── word wrap to a fixed width ─────────────────────────────────────────────
function wrap(text: string, width: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
        if (!line) {
            line = w;
            continue;
        }
        if ((line + " " + w).length > width) {
            lines.push(line);
            line = w;
        } else {
            line += " " + w;
        }
    }
    if (line) lines.push(line);
    return lines;
}

// ─── main render ────────────────────────────────────────────────────────────
export function renderReport(result: ScanResult): void {
    const { meta, server, inventory, findings, summary } = result;

    // ─ Header banner ────────────────────────────────────────
    console.log();
    console.log(boxTop());

    const titlePlain = `scan-my-mcp  v${meta.scannerVersion}`;
    const titleStyled =
        chalk.magentaBright.bold("scan-my-mcp") +
        muted(`  v${meta.scannerVersion}`);
    console.log(boxLine(titleStyled, titlePlain.length));

    // Truncate long stdio command strings to fit the box
    const interior = BOX_WIDTH - 2 - INNER_PAD * 2;
    const targetText = meta.serverUrl.length > interior
        ? meta.serverUrl.slice(0, interior - 1) + "…"
        : meta.serverUrl;
    const transportPrefix = meta.transport === "stdio" ? chalk.magenta("stdio ") : chalk.cyan("http  ");
    const transportPlain = meta.transport === "stdio" ? "stdio " : "http  ";
    console.log(boxLine(transportPrefix + chalk.whiteBright(targetText), transportPlain.length + targetText.length));

    console.log(boxSeparator());

    const serverLabel = `${server.name} v${server.version}`;
    const serverStyled = chalk.whiteBright(server.name) + muted(` v${server.version}`);
    const serverLine = chalk.bold("Server   ") + muted("│ ") + serverStyled;
    const serverPlain = "Server   │ " + serverLabel;
    console.log(boxLine(serverLine, serverPlain.length));

    const protoStyled = chalk.bold("Protocol ") + muted("│ ") + chalk.whiteBright(server.protocolVersion);
    const protoPlain = `Protocol │ ${server.protocolVersion}`;
    console.log(boxLine(protoStyled, protoPlain.length));

    const invText = `${inventory.tools.length} tools  ·  ${inventory.resources.length} resources  ·  ${inventory.prompts.length} prompts`;
    const invStyled =
        chalk.bold("Items    ") + muted("│ ") +
        accent(`${inventory.tools.length}`) + " tools  " +
        muted("·") + "  " +
        accent(`${inventory.resources.length}`) + " resources  " +
        muted("·") + "  " +
        accent(`${inventory.prompts.length}`) + " prompts";
    const invPlain = "Items    │ " + invText;
    console.log(boxLine(invStyled, invPlain.length));

    const durStyled = chalk.bold("Duration ") + muted("│ ") + chalk.whiteBright(`${(meta.scanDuration / 1000).toFixed(1)}s`);
    const durPlain = `Duration │ ${(meta.scanDuration / 1000).toFixed(1)}s`;
    console.log(boxLine(durStyled, durPlain.length));

    if (meta.partial) {
        const warn = "⚠  Partial scan — results may be incomplete";
        console.log(boxLine(chalk.yellowBright(warn), warn.length));
    }

    console.log(boxBottom());
    console.log();

    // ─ Security score panel ─────────────────────────────────
    const scoreText = `${summary.score}/100`;
    const scoreLine =
        "  " +
        chalk.bold("Security Score") + "   " +
        scoreColor(summary.score, scoreText) + "  " +
        scoreBar(summary.score, 20) + "  " +
        riskBadge(summary.score);
    console.log(scoreLine);

    // Coverage indicator on its own line so it's not mistaken for the score
    const coverageBadge = meta.partial
        ? chalk.bgYellow.black.bold(" PARTIAL COVERAGE ")
        : chalk.bgGreen.black.bold(" FULL COVERAGE ");
    const enumerated: string[] = [];
    if (meta.coverage.initialize) enumerated.push("initialize");
    if (meta.coverage.tools) enumerated.push("tools");
    if (meta.coverage.resources) enumerated.push("resources");
    if (meta.coverage.prompts) enumerated.push("prompts");
    console.log(
        "  " +
        chalk.bold("Coverage      ") + "   " +
        coverageBadge +
        "  " +
        muted(enumerated.length ? `enumerated: ${enumerated.join(", ")}` : "no endpoints reached")
    );

    // Auth state badge
    const authBadge =
        meta.authState === "n/a"     ? chalk.bgBlue.white.bold(" LOCAL STDIO ")
      : meta.authState === "full"    ? chalk.bgGreen.black.bold(" AUTH ENFORCED ")
      : meta.authState === "partial" ? chalk.bgYellow.black.bold(" PARTIAL AUTH ")
      :                                chalk.bgRed.white.bold(" NO AUTH ");
    console.log(
        "  " +
        chalk.bold("Auth          ") + "   " +
        authBadge +
        (meta.sessionId ? "  " + muted(`session: ${meta.sessionId.slice(0, 12)}…`) : "")
    );
    console.log();

    // ─ Findings ─────────────────────────────────────────────
    const sorted = [...findings].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    );

    if (sorted.length === 0) {
        console.log("  " + chalk.greenBright.bold("✓ No findings — server looks clean."));
        console.log();
    } else {
        console.log("  " + chalk.bold.underline(`FINDINGS  (${sorted.length})`));
        console.log();

        const wrapWidth = 56;
        for (const f of sorted) {
            const bar = severityAccent(f.severity, "▌");
            console.log("  " + bar + "  " + severityBadge(f.severity) + "  " + chalk.bold.whiteBright(f.title));
            console.log("  " + bar + "  " + muted("at ") + accent(f.location));
            for (const line of wrap(f.detail, wrapWidth)) {
                console.log("  " + bar + "  " + chalk.white(line));
            }
            const fixLines = wrap(f.remediation, wrapWidth);
            console.log("  " + bar + "  " + chalk.greenBright("→ ") + muted(fixLines[0]));
            for (let i = 1; i < fixLines.length; i++) {
                console.log("  " + bar + "    " + muted(fixLines[i]));
            }
            console.log("  " + bar);
        }
        console.log();
    }

    // ─ Summary chips ────────────────────────────────────────
    console.log("  " + chalk.bold.underline("SUMMARY"));
    console.log();
    console.log(
        "  " +
        severityChip("critical", summary.critical) + "  " +
        severityChip("high", summary.high) + "  " +
        severityChip("medium", summary.medium) + "  " +
        severityChip("low", summary.low) + "  " +
        severityChip("info", summary.info)
    );
    console.log();
    console.log(
        "  " + muted("Scanned at ") +
        chalk.whiteBright(new Date(meta.scannedAt).toLocaleString()) +
        muted("  ·  Tip: run with ") +
        accent("--json") +
        muted(" for machine-readable output.")
    );
    console.log();
}
