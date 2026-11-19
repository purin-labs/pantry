import { assertNever } from "@purin-labs/std";
import type { Money } from "./records/money.ts";
import type { SupplierPayoutExecutionPlan } from "./records/supplier-payout-plan.ts";

declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/** Exact UTF-8 fields, each prefixed by its eight-byte big-endian byte count. */
export function encodeSupplierPayoutEconomics(
  plan: SupplierPayoutExecutionPlan,
): Uint8Array {
  const subject = plan.subject;
  const fields = [
    subject.organisationId,
    subject.merchantId,
    subject.supplierId,
    subject.payoutId,
    subject.payableId,
    subject.purchaseRequestId,
  ];
  switch (plan.kind) {
    case "gmo_aozora":
      fields.push(
        "gmo_aozora",
        plan.integrationAccountId,
        plan.sourceAccountId,
        plan.destinationRevisionId,
        plan.amountBasis,
        moneyField(plan.recipientAmount),
        moneyField(plan.observedFee.amount),
        plan.observedFee.observedAt,
        moneyField(plan.feeCeiling),
        plan.requestedTransferDate,
      );
      break;
    case "wise":
      fields.push(
        "wise",
        plan.integrationAccountId,
        plan.profileId,
        plan.funding,
        plan.destinationRevisionId,
        plan.providerRecipientId,
        plan.quoteId,
        plan.paymentOptionId,
        plan.payInMethod,
        plan.payOutMethod,
        plan.amountBasis,
        moneyField(plan.sourceTotal),
        moneyField(plan.targetAmount),
        moneyField(plan.feeTotal),
        moneyField(plan.taxTotal),
        moneyField(plan.feeCeiling),
        plan.rate,
        plan.rateExpiresAt,
        plan.transferRequirementsDigest,
        plan.customerTransactionId,
      );
      break;
    default:
      return assertNever(plan);
  }
  const encoder = new TextEncoder();
  const domain = encoder.encode("satyr:supplier-payout:economics:v1");
  const encodedFields = fields.map(encodeField.bind(null, encoder));
  let byteLength = domain.length;
  for (const field of encodedFields) byteLength += 8 + field.length;
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  bytes.set(domain);
  let offset = domain.length;
  for (const field of encodedFields) {
    view.setBigUint64(offset, BigInt(field.length), false);
    bytes.set(field, offset + 8);
    offset += 8 + field.length;
  }
  return bytes;
}

function encodeField(
  encoder: { encode(input: string): Uint8Array },
  field: string,
): Uint8Array {
  return encoder.encode(field);
}

function moneyField(money: Money): string {
  return `${money.currency}:${money.amountMinor}`;
}
