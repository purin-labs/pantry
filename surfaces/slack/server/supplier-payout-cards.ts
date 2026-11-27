import type { SupplierPayoutRow } from "@purin-labs/area-commerce-contract/server/supplier-payouts";

/**
 * What a supplier payout looks like in Slack.
 *
 * The approval card is the only one that matters to get right. An approver
 * reading it in a chat window is the last person who will look at these numbers
 * before money leaves, so the card states the exact economics — what the
 * supplier receives, what it costs, which account it reaches, and what happens
 * if it comes back — rather than a summary that reads well.
 *
 * Nothing here renders an account number. The masked summary is the whole of
 * what Slack ever sees of a supplier's banking details, and a channel is not a
 * place to widen that.
 */
export type PayoutApprovalCard = Readonly<{
  supplierId: string;
  payableId: string;
  rail: "gmo_aozora_private" | "wise_enterprise_payouts";
  maskedDestination: string;
  destinationRevisionId: string;
  currency: string;
  recipientAmountMinor: number;
  observedFeeMinor: number;
  feeCeilingMinor: number;
  /** Present for a cross-border rail; absent for a domestic one. */
  rate: string | null;
  rateExpiresAt: string | null;
  executionDeadline: string;
}>;

/**
 * Render the approval card.
 *
 * The consequence of a return is stated on the card rather than left to be
 * inferred. An approver who does not know that a returned payment re-owes the
 * payable cannot weigh the decision they are being asked to make.
 */
export function renderPayoutApprovalCard(card: PayoutApprovalCard): string {
  const lines = [
    `*Approve a payout to ${card.supplierId}*`,
    "",
    `Supplier receives: ${money(card.recipientAmountMinor, card.currency)}`,
    `Fee observed: ${money(card.observedFeeMinor, card.currency)} ` +
      `(ceiling ${money(card.feeCeilingMinor, card.currency)})`,
    `Rail: ${railName(card.rail)}`,
    `Destination: ${card.maskedDestination} (revision ${card.destinationRevisionId})`,
    `Against payable: ${card.payableId}`,
  ];
  if (card.rate !== null) {
    lines.push(
      `Rate: ${card.rate}` +
        (card.rateExpiresAt === null ? "" : ` — expires ${card.rateExpiresAt}`),
    );
  }
  lines.push(
    `Approval valid until: ${card.executionDeadline}`,
    "",
    "Approving authorizes exactly these economics. A changed quote, fee, " +
      "recipient or amount invalidates it and returns the payout for a fresh " +
      "proposal.",
    "If the payment is later returned or reversed, the payable is owed again — " +
      "it is not written off.",
  );
  return lines.join("\n");
}

/**
 * Payouts still on their way out, grouped by rail.
 *
 * Grouped because the question an operator asks about a stuck payment is
 * usually "is this rail having a bad day", and a flat list buries that.
 */
export function renderOutgoingPayouts(
  payouts: readonly SupplierPayoutRow[],
): string {
  if (payouts.length === 0) return "Nothing is outstanding to suppliers.";
  const byRail = new Map<string, SupplierPayoutRow[]>();
  for (const payout of payouts) {
    const existing = byRail.get(payout.rail) ?? [];
    existing.push(payout);
    byRail.set(payout.rail, existing);
  }
  const sections = [...byRail.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return sections
    .map(([rail, rows]) =>
      [
        `*${railName(rail as PayoutApprovalCard["rail"])}* — ${rows.length} outstanding`,
        ...rows.map(
          (row) =>
            `• ${row.supplierId}: ${money(row.recipientAmountMinor, row.currency)} — ` +
            `${stateSentence(row.stateKind)}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * Report what happened to a payout.
 *
 * Indeterminate is deliberately not phrased as a failure. It is the absence of
 * an answer, and telling an operator a payment "failed" when Pantry does not
 * know is how a supplier gets paid twice.
 */
export function renderPayoutOutcome(payout: SupplierPayoutRow): string {
  return (
    `*${payout.supplierId}* — ` +
    `${money(payout.recipientAmountMinor, payout.currency)} — ` +
    `${stateSentence(payout.stateKind)}`
  );
}

function stateSentence(state: SupplierPayoutRow["stateKind"]): string {
  switch (state) {
    case "approval_pending":
      return "waiting for approval";
    case "approved":
      return "approved, not yet sent";
    case "submitting":
      return "being sent";
    case "provider_action_required":
      return "the bank needs an action on their side";
    case "provider_pending":
      return "with the provider";
    case "settled":
      return "sent and confirmed";
    case "return_pending":
      return "being returned";
    case "returned":
      return "returned — the payable is owed again";
    case "reversal_pending":
      return "being reversed";
    case "reversed":
      return "reversed — the payable is owed again";
    case "failed":
      return "refused by the provider; the held money has been freed";
    case "indeterminate":
      // Not "failed". Pantry does not know, and saying otherwise invites a
      // second payment.
      return "outcome unknown — being reconciled, do not send again";
    case "cancelled":
      return "cancelled before anything was sent";
  }
}

function railName(rail: PayoutApprovalCard["rail"]): string {
  return rail === "gmo_aozora_private" ? "GMO Aozora" : "Wise";
}

function money(amountMinor: number, currency: string): string {
  // JPY has no minor unit; rendering 10000 as "100.00" would understate a
  // payment by two orders of magnitude on the card an approver reads.
  const digits = ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2;
  const value = digits === 0 ? amountMinor : amountMinor / 100;
  return `${value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${currency.toUpperCase()}`;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
