import { resolveCommerceMerchant } from "@purin-labs/area-commerce/server/contract/square-link";
import { deviceFleetStub } from "@purin-labs/area-devices/server/contract/fleet-stub";
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
    | "terminal_collection_unresolved"
    | "terminal_collection_unverifiable";
}>;

/**
 * Retires the assignment of a counter: the counter stops taking card
 * payments, and the provider connection stays.
 *
 * A LAN terminal (`lan_gateway_device`, GMO stera) with an unresolved
 * collection cannot be retired. The only code that records its capture or
 * its decline on the sale reads the active assignment of the counter, so a
 * retirement would leave a captured card payment unrecorded on the sale. The
 * operator finishes or cancels the collection first. A Square payment
 * attempt keeps its own binding, and the commerce engine reconciles it
 * without the assignment, so a Square counter retires at once.
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
  const target = assignment.value.target;
  if (target.kind === "lan_gateway_device") {
    const open = await gatewayCollectionState(
      input,
      target.gatewayId,
      target.deviceSourceKey,
    );
    if (open !== "resolved") return { ok: false, error: { code: open } };
  }
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
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    organisationId: OrganisationId;
    pantryLocationId: string;
  }>,
  gatewayId: string,
  sourceKey: string,
): Promise<
  | "resolved"
  | "terminal_collection_unresolved"
  | "terminal_collection_unverifiable"
> {
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
