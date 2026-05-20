import { ServerInfo, Inventory, Finding } from "../types";

export function checkValidation(input: {
  serverInfo: ServerInfo;
  inventory: Inventory;
}): Finding[] {
  const findings: Finding[] = [];
  const { tools } = input.inventory;

  tools.forEach((tool, toolIndex) => {
    if (!tool.inputSchema) {
      findings.push({
        severity: "low",
        check: "input-validation",
        title: "Tool has no input schema",
        detail: `Tool '${tool.name}' defines no inputSchema — no input validation is enforced.`,
        location: `tools[${toolIndex}].inputSchema`,
        remediation: "Define an inputSchema with typed, constrained parameters for every tool.",
      });
      return;
    }

    const properties = tool.inputSchema.properties ?? {};
    const required = tool.inputSchema.required ?? [];

    for (const [paramName, paramDef] of Object.entries(properties)) {
      const param = paramDef as Record<string, unknown>;

      if (!param.type) {
        findings.push({
          severity: "medium",
          check: "input-validation",
          title: "Parameter has no type",
          detail: `Tool '${tool.name}' parameter '${paramName}' has no type defined.`,
          location: `tools[${toolIndex}].inputSchema.properties.${paramName}`,
          remediation: "Add a type field to all parameters. Use specific types like 'string', 'integer', or 'boolean'.",
        });
        continue;
      }

      if (
        param.type === "string" &&
        !param.maxLength &&
        !param.pattern &&
        !param.enum
      ) {
        const isRequired = required.includes(paramName);
        findings.push({
          severity: isRequired ? "medium" : "low",
          check: "input-validation",
          title: "Unconstrained string parameter",
          detail: `Tool '${tool.name}' parameter '${paramName}' accepts arbitrary string input with no length limit or pattern constraint.`,
          location: `tools[${toolIndex}].inputSchema.properties.${paramName}`,
          remediation:
            "Add maxLength, pattern regex, or enum constraints to string parameters. Validate and sanitize all inputs server-side.",
        });
      }
    }
  });

  return findings;
}