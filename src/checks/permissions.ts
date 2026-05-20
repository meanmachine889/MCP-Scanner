import { ServerInfo, Inventory, Finding, Severity } from "../types";

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

export function checkPermissions(input: {
  serverInfo: ServerInfo;
  inventory: Inventory;
}): Finding[] {
  const findings: Finding[] = [];
  const { tools } = input.inventory;

  tools.forEach((tool, toolIndex) => {
    const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();

    for (const group of PERMISSION_GROUPS) {
      const matched = group.keywords.find(kw => haystack.includes(kw.toLowerCase()));
      if (matched) {
        findings.push({
          severity: group.severity,
          check: "permissions",
          title: `Tool claims ${group.label}`,
          detail: `Tool '${tool.name}' description/name matches keyword "${matched}" — implies ${group.label}.`,
          location: `tools[${toolIndex}]`,
          remediation:
            "Restrict tool capabilities to the minimum required. Sandbox filesystem, shell, and network access. Document scope explicitly and gate behind explicit user consent.",
        });
      }
    }
  });

  return findings;
}
