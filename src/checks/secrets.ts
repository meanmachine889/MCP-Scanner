import { ServerInfo, Inventory, Finding } from "../types";

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

function scanText(text: string, location: string): Finding[] {
  const findings: Finding[] = [];
  if (!text) return findings;

  for (const { name, pattern } of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    const matches = text.match(regex);
    if (matches && matches.length > 0) {
      const sample = matches[0].slice(0, 24) + (matches[0].length > 24 ? "..." : "");
      findings.push({
        severity: "critical",
        check: "secret-exposure",
        title: `${name} found in ${location}`,
        detail: `Matched pattern for ${name}: "${sample}"`,
        location,
        remediation:
          "Remove credentials from server definitions. Use environment variables and never embed secrets in tool descriptions or schemas.",
      });
    }
  }

  return findings;
}

export function checkSecrets(input: {
  serverInfo: ServerInfo;
  inventory: Inventory;
}): Finding[] {
  const findings: Finding[] = [];
  const { serverInfo, inventory } = input;

  findings.push(...scanText(serverInfo.name, "serverInfo.name"));
  findings.push(...scanText(serverInfo.version, "serverInfo.version"));

  inventory.tools.forEach((tool, i) => {
    findings.push(...scanText(tool.description ?? "", `tools[${i}].description`));
    if (tool.inputSchema) {
      findings.push(...scanText(JSON.stringify(tool.inputSchema), `tools[${i}].inputSchema`));
    }
  });

  inventory.resources.forEach((resource, i) => {
    findings.push(...scanText(resource.description ?? "", `resources[${i}].description`));
    findings.push(...scanText(resource.uri, `resources[${i}].uri`));
    findings.push(...scanText(resource.name, `resources[${i}].name`));
  });

  inventory.prompts.forEach((prompt, i) => {
    findings.push(...scanText(prompt.description ?? "", `prompts[${i}].description`));
  });

  return findings;
}
