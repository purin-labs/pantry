// The principal of a command that a merchant plugin submits (Plan 77 step
// 5). The plugin authority runs the command inside this scope, and the ledger
// names the plugin in the command's receipt.
import { AsyncLocalStorage } from "node:async_hooks";

import type { CommerceMutationPrincipalV1 } from "@purin-labs/commerce-client";

export const commandPrincipal =
  new AsyncLocalStorage<CommerceMutationPrincipalV1>();
