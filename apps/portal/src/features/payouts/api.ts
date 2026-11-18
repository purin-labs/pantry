import { controlRead } from "../../control-client";
import { isNonNegativeInteger } from "@seams/std";
import {
  type DatedSupplierPayout,
  type PayoutAuditEvent,
  type SupplierPayout,
  parseAuditEvent,
  parseDatedPayout,
  parsePayouts,
  requireExactKeys,
  requireObject,
} from "@seams/control-api/portal/payouts";

export type PayoutMutationTransport = (
  path: string,
  method: "POST",
  body: unknown,
  intent: string,
) => Promise<unknown>;

export type PayoutReadTransport = (path: string) => Promise<unknown>;

export type PayoutExceptionPage = Readonly<{
  events: readonly PayoutAuditEvent[];
  nextCursor: number | null;
}>;

/** The work queue: every payout whose outcome Pantry does not yet know. */
export async function readUnresolvedPayouts(
  organisationId: string,
  read: PayoutReadTransport = controlRead,
): Promise<readonly SupplierPayout[]> {
  return parsePayouts(await read(payoutsPath(organisationId)));
}

export async function readSupplierPayouts(
  organisationId: string,
  supplierId: string,
  read: PayoutReadTransport = controlRead,
): Promise<readonly SupplierPayout[]> {
  return parsePayouts(
    await read(
      `${payoutsPath(organisationId)}?supplierId=${encodeURIComponent(supplierId)}`,
    ),
  );
}

/** The payouts that were moving at any time in a window, for the timeline. */
export async function readPayoutsInWindow(
  organisationId: string,
  window: Readonly<{ from: number; to: number }>,
  read: PayoutReadTransport = controlRead,
): Promise<
  Readonly<{ payouts: readonly DatedSupplierPayout[]; truncated: boolean }>
> {
  const raw = requireObject(
    await read(
      `${payoutsPath(organisationId)}?view=timeline&from=${String(window.from)}&to=${String(window.to)}`,
    ),
    "supplier payout timeline",
  );
  if (
    raw.ok !== true ||
    typeof raw.truncated !== "boolean" ||
    !Array.isArray(raw.supplierPayouts)
  )
    throw new Error("The payout timeline is unavailable.");
  return {
    truncated: raw.truncated,
    payouts: raw.supplierPayouts.map(parseDatedPayout),
  };
}

/** Contradictory provider evidence that requires operator investigation. */
export async function readPayoutExceptions(
  organisationId: string,
  after = 0,
  read: PayoutReadTransport = controlRead,
): Promise<PayoutExceptionPage> {
  if (!isNonNegativeInteger(after))
    throw new Error("Supplier payout exception cursor is invalid.");
  const raw = await read(
    `${payoutsPath(organisationId)}?view=exceptions&after=${after}`,
  );
  const object = requireObject(raw, "supplier payout exception response");
  requireExactKeys(
    object,
    ["ok", "events", "nextCursor"],
    "supplier payout exception response",
  );
  if (
    object.ok !== true ||
    !Array.isArray(object.events) ||
    (object.nextCursor !== null && !isNonNegativeInteger(object.nextCursor))
  ) {
    throw new Error("Supplier payout exceptions are unavailable.");
  }
  return {
    events: object.events.map(parseAuditEvent),
    nextCursor: object.nextCursor,
  };
}

/** Viewer-authorized attachment produced by the payout audit route. */
export function supplierPayoutAuditPath(
  organisationId: string,
  payoutId: string,
): string {
  return `${payoutsPath(organisationId)}/${encodeURIComponent(payoutId)}/audit`;
}

/** What an operator should understand about a payout in this state. */
export function payoutGuidance(payout: SupplierPayout): string {
  switch (payout.state) {
    case "approval_pending":
      return "Waiting for someone other than the proposer to approve it.";
    case "approved":
      return "Approved and waiting to be sent.";
    case "submitting":
      return "Being sent. Do not propose another payout for this payable.";
    case "provider_action_required":
      return "The bank needs an action taken on their side before this can proceed.";
    case "provider_pending":
      return "The provider has it and has not finished.";
    case "settled":
      return "Sent and confirmed by the provider.";
    case "return_pending":
      return "The provider is returning this payment.";
    case "returned":
      return "Returned. The payable is owed again.";
    case "reversal_pending":
      return "The provider is reversing this payment.";
    case "reversed":
      return "Reversed. The payable is owed again.";
    case "failed":
      return "The provider refused it. The held money has been freed.";
    case "indeterminate":
      return (
        "Seams Pantry does not know whether this was sent. It is being reconciled — " +
        "do not send it again."
      );
    case "cancelled":
      return "Cancelled before anything was sent.";
  }
}

/** Whether this payout is waiting on a person rather than on a provider. */
export function needsOperator(payout: SupplierPayout): boolean {
  return (
    payout.state === "approval_pending" ||
    payout.state === "provider_action_required" ||
    payout.state === "indeterminate"
  );
}

export function payoutsPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/supplier-payouts`;
}
