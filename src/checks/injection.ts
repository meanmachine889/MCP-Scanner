import { ServerInfo, Inventory, Finding, Severity } from "../types";

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

function scanText(text: string, location: string): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;

  for (const { pattern, title, severity } of INJECTION_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    const matches = text.match(regex);
    if (matches && matches.length > 0) {
      const sample = matches[0].slice(0, 60) + (matches[0].length > 60 ? "..." : "");
      findings.push({
        severity,
        check: "prompt-injection",
        title,
        detail: `Matched in ${location}: "${sample}"`,
        location,
        remediation:
          "Sanitize tool descriptions and prompts. Treat all server-supplied text as untrusted. Never embed instructions that override agent behavior.",
      });
    }
  }

  return findings;
}

export function checkInjection(input: {
  serverInfo: ServerInfo;
  inventory: Inventory;
}): Finding[] {
  const findings: Finding[] = [];
  const { inventory } = input;

  inventory.tools.forEach((tool, i) => {
    findings.push(...scanText(tool.description ?? "", `tools[${i}].description`));
  });

  inventory.resources.forEach((resource, i) => {
    findings.push(...scanText(resource.description ?? "", `resources[${i}].description`));
  });

  inventory.prompts.forEach((prompt, i) => {
    findings.push(...scanText(prompt.description ?? "", `prompts[${i}].description`));
  });

  return findings;
}
