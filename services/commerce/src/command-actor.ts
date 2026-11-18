// Who sent the request that commits a command (Plan 80 step 3). The HTTP
// layer runs each admin request inside this scope, and the ledger names the
// actor in the command's receipt. Work that no request started (the alarm,
// merchant plugin handlers) has no actor.
import { AsyncLocalStorage } from "node:async_hooks";

import type { CommerceMutationActorV1 } from "@seams/commerce-client";

export const commandActor = new AsyncLocalStorage<CommerceMutationActorV1>();
