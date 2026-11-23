import { resolveCommerceMerchant } from "@purin-labs/area-commerce/server/contract/square-link";
import { deviceFleetStub } from "@purin-labs/area-devices/server/contract/fleet-stub";
import type { TerminalAssignment } from "@purin-labs/commerce-contracts";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

import { counterSaleRecordsCollection } from "./counter-register";
import {
  readActiveTerminalAssignment,
  retireTerminalAssignment,
} from "./data/terminal-assignment-store";

type CounterRetirementError = Readonly<{
  code:
    | "terminal_assignment_not_found"
    | "terminal_assignment_corrupt"
    | "terminal_assignment_conflict"
    | CounterCollectionRefusal;
}>;

/** Why the active assignment of a counter cannot end now. */
export type CounterCollectionRefusal =
  "terminal_collection_unresolved" | "terminal_collection_unverifiable";

type CounterScope = Readonly<{
  env: Env;
  scope: OrganisationExecutionScope;
  organisationId: OrganisationId;
  pantryLocationId: string;
}>;

/**
 * Whether the active assignment of a counter may end, by a retirement or by
 * a new assignment that replaces it. Null: it may.
 *
 * A LAN terminal (`lan_gateway_device`, GMO stera) with an unresolved
 * collection may not. The only code that records its capture or its decline
 * on the sale reads the active assignment of the counter, so an end would
 * leave a captured card payment unrecorded on the sale. The operator finishes
 * or cancels the collection first. A Square payment attempt keeps its own
 * binding, and the commerce engine reconciles it without the assignment, so
 * a Square assignment ends at once.
 */
export async function counterCollectionRefusal(
  input: CounterScope,
  assignment: TerminalAssignment,
): Promise<CounterCollectionRefusal | null> {
  const target = assignment.target;
  if (target.kind !== "lan_gateway_device") return null;
  const state = await gatewayCollectionState(
    input,
    target.gatewayId,
    target.deviceSourceKey,
  );
  return state === "resolved" ? null : state;
}

/**
 * Retires the assignment of a counter: the counter stops taking card
 * payments, and the provider connection stays. `counterCollectionRefusal`
 * holds the rule for an open collection.
 */
export async function retireCounterTerminal(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    organisationId: OrganisationId;
    pantryLocationId: string;
    now: number;
  }>,
): Promise<Result<null, CounterRetirementError>> {
  const db = input.scope.database;
  const assignment = await readActiveTerminalAssignment(
    db,
    input.organisationId,
    input.pantryLocationId,
  );
  if (!assignment.ok)
    return {
      ok: false,
      error: {
        code:
          assignment.error.code === "terminal_assignment_corrupt"
            ? "terminal_assignment_corrupt"
            : "terminal_assignment_not_found",
      },
    };
  const refusal = await counterCollectionRefusal(input, assignment.value);
  if (refusal !== null) return { ok: false, error: { code: refusal } };
  const retired = await retireTerminalAssignment({
    db,
    organisationId: input.organisationId,
    assignmentId: assignment.value.assignmentId,
    revision: assignment.value.revision,
    // The operator withdrew this counter's authority; nothing replaced it and
    // the provider connection is untouched.
    reason: "revoked",
    now: input.now,
  });
  return retired
    ? { ok: true, value: null }
    : { ok: false, error: { code: "terminal_assignment_conflict" } };
}

/**
 * The last collection of a LAN terminal is resolved when the terminal ended
 * it and the sale records that end: the payment for a capture, the decline
 * for a decline or a cancel.
 */
async function gatewayCollectionState(
  input: CounterScope,
  gatewayId: string,
  sourceKey: string,
): Promise<"resolved" | CounterCollectionRefusal> {
  const fleet = deviceFleetStub(input.env, input.scope, input.pantryLocationId);
  if (fleet === null) return "terminal_collection_unverifiable";
  const record = await fleet.readTerminalCollection(gatewayId, sourceKey);
  if (record === null) return "resolved";
  if (record.state === "collecting" || record.state === "result_unknown")
    return "terminal_collection_unresolved";
  const merchant = await resolveCommerceMerchant(
    input.env,
    input.scope,
    input.organisationId,
  );
  if (merchant === null) return "terminal_collection_unverifiable";
  const sale = await merchant.client.readCounterSale(
    merchant.merchantId,
    record.checkoutId,
  );
  if (!sale.ok)
    return sale.error.kind === "http" && sale.error.status === 404
      ? "resolved"
      : "terminal_collection_unverifiable";
  return counterSaleRecordsCollection(sale.value, {
    state: record.state,
    paymentAttemptId: record.paymentAttemptId,
  })
    ? "resolved"
    : "terminal_collection_unresolved";
}
