import { ServerInfo, Inventory, Finding, AuthState } from "../types";
import { checkSecrets } from "./secrets";
import { checkAuth } from "./auth";
import { checkPermissions } from "./permissions";
import { checkValidation } from "./validation";
import { checkInjection } from "./injection";
import { checkContextWindow } from "./context-window";

export function runAllChecks(input: {
  serverInfo: ServerInfo;
  inventory: Inventory;
  authState?: AuthState;
}): Finding[] {
  return [
    ...checkSecrets(input),
    ...checkAuth(input),
    ...checkPermissions(input),
    ...checkValidation(input),
    ...checkInjection(input),
    ...checkContextWindow(input),
  ];
}
