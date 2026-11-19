import { assertNever, rustTrim, sha256HexSync } from "@purin-labs/std";
import {
  CommerceRejection,
  commerceTimestamp,
  ensureNonNegative,
  money,
  rejectCommerce,
} from "./commerce-canonical.ts";
import type { CommerceBoundaryResponse } from "./commerce-boundary.ts";
import { encodeSupplierPayoutEconomics } from "./payout-digest.ts";
import {
  SerdeRejection,
  buffered,
  fromSource,
  i64,
  required,
  struct,
  tag,
  text,
  u64,
} from "./serde-input.ts";
import type { CommerceValidationError } from "./records/commerce-records.ts";
import type { Money } from "./records/money.ts";
import type { SupplierPayable } from "./records/supplier-payable.ts";
import type { SupplierPayoutState } from "./records/supplier-payout.ts";
import type { SupplierPayoutExecutionPlan } from "./records/supplier-payout-plan.ts";

/**
 * Plan 78: `supplier_payout_plan_parse.rs`, `supplier_payout.rs`,
 * `supplier_payable.rs` and `supplier_payable_command.rs`. Every rule that
 * decides whether money may move keeps its Rust order and its Rust error.
 */

function respond(run: () => unknown): CommerceBoundaryResponse {
  try {
    return { status: "ok", value: run() };
  } catch (error) {
    if (error instanceof CommerceRejection)
      return { status: "error", error: error.error };
    throw error;
  }
}

/** Runs a serde read; a shape error becomes the boundary's own refusal. */
function decoded<T>(read: () => T, refusal: CommerceValidationError): T {
  try {
    return fromSource("direct", read);
  } catch (error) {
    if (error instanceof SerdeRejection) rejectCommerce(refusal);
    throw error;
  }
}

function invalid(field: string): CommerceValidationError {
  return { code: "invalid_identity", field };
}

function trimmedText(value: string, field: string): string {
  const trimmed = rustTrim(value);
  if (trimmed.length === 0 || value !== trimmed) rejectCommerce(invalid(field));
  return value;
}

function identityOr(value: string, field: string): string {
  const trimmed = rustTrim(value);
  if (trimmed.length === 0 || value !== trimmed) rejectCommerce(invalid(field));
  return value;
}

function timestampOr(value: string, field: string): string {
  try {
    return commerceTimestamp(value);
  } catch (error) {
    if (error instanceof CommerceRejection) rejectCommerce(invalid(field));
    throw error;
  }
}

type RawMoney = Readonly<{ currency: string; amountMinor: number }>;

function readMoney(value: unknown, path: string): RawMoney {
  const object = struct(value, path, ["currency", "amountMinor"]);
  return {
    currency: text(required(object, "currency"), `${path}.currency`),
    amountMinor: i64(required(object, "amountMinor"), `${path}.amountMinor`),
  };
}

function moneyOr(raw: RawMoney, field: string): Money {
  try {
    return money(raw.amountMinor, raw.currency);
  } catch (error) {
    if (error instanceof CommerceRejection) rejectCommerce(invalid(field));
    throw error;
  }
}

function readStrings(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, string> {
  const object = struct(value, path, keys);
  const result: Record<string, string> = {};
  for (const key of keys)
    result[key] = text(required(object, key), `${path}.${key}`);
  return result;
}

// Payout plans

const SUBJECT = [
  "payoutId",
  "organisationId",
  "merchantId",
  "supplierId",
  "payableId",
  "purchaseRequestId",
] as const;
const SEAL = ["approvalDigest", "executionDeadline", "idempotencyKey"] as const;
const GMO_FIELDS = [
  "subject",
  "integrationAccountId",
  "sourceAccountId",
  "destinationRevisionId",
  "maskedDestinationSummary",
  "amountBasis",
  "recipientAmount",
  "observedFee",
  "feeCeiling",
  "requestedTransferDate",
  "supplierReference",
  "seal",
] as const;
const WISE_FIELDS = [
  "subject",
  "integrationAccountId",
  "profileId",
  "funding",
  "destinationRevisionId",
  "providerRecipientId",
  "quoteId",
  "paymentOptionId",
  "payInMethod",
  "payOutMethod",
  "amountBasis",
  "sourceTotal",
  "targetAmount",
  "feeTotal",
  "taxTotal",
  "feeCeiling",
  "rate",
  "rateExpiresAt",
  "transferRequirementsDigest",
  "customerTransactionId",
  "supplierReference",
  "seal",
] as const;
const PLAN_MONEY = new Set([
  "recipientAmount",
  "feeCeiling",
  "sourceTotal",
  "targetAmount",
  "feeTotal",
  "taxTotal",
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = Readonly<Record<string, any>>;

function readPlan(value: unknown): Raw {
  const object = struct(value, "payoutPlan");
  const kind = tag(object, "kind", ["gmo_aozora", "wise"]);
  const names = kind === "gmo_aozora" ? GMO_FIELDS : WISE_FIELDS;
  const fields = struct(
    Object.fromEntries(
      Object.entries(object).filter(([key]) => key !== "kind"),
    ),
    "payoutPlan",
    names,
  );
  const raw: Record<string, unknown> = { kind };
  for (const key of names) {
    const member = required(fields, key);
    if (key === "subject") raw[key] = readStrings(member, key, SUBJECT);
    else if (key === "seal") raw[key] = readStrings(member, key, SEAL);
    else if (key === "observedFee") {
      const fee = struct(member, key, ["amount", "observedAt"]);
      raw[key] = {
        amount: readMoney(required(fee, "amount"), "observedFee.amount"),
        observedAt: text(required(fee, "observedAt"), "observedFee.observedAt"),
      };
    } else if (PLAN_MONEY.has(key)) raw[key] = readMoney(member, key);
    else raw[key] = text(member, key);
  }
  return raw;
}

/** Rust `parse_supplier_payout_execution_plan`. */
export function parseSupplierPayoutExecutionPlan(
  value: unknown,
): SupplierPayoutExecutionPlan {
  const raw = decoded(readPlan.bind(null, value), invalid("payoutPlan"));
  switch (raw.kind) {
    case "gmo_aozora":
      return gmoPlan(raw);
    case "wise":
      return wisePlan(raw);
    default:
      throw new Error("unreachable payout plan kind");
  }
}

function amountBasis(raw: string, field: string): "recipient_receives" {
  if (raw !== "recipient_receives") rejectCommerce(invalid(field));
  return raw;
}

function subject(raw: Raw): Raw {
  return {
    payoutId: identityOr(raw.payoutId, "payoutPlan.subject.payoutId"),
    organisationId: identityOr(
      raw.organisationId,
      "payoutPlan.subject.organisationId",
    ),
    merchantId: identityOr(raw.merchantId, "payoutPlan.subject.merchantId"),
    supplierId: identityOr(raw.supplierId, "payoutPlan.subject.supplierId"),
    payableId: identityOr(raw.payableId, "payoutPlan.subject.payableId"),
    purchaseRequestId: identityOr(
      raw.purchaseRequestId,
      "payoutPlan.subject.purchaseRequestId",
    ),
  };
}

function seal(raw: Raw): Raw {
  const executionDeadline = timestampOr(
    raw.executionDeadline,
    "payoutPlan.seal.executionDeadline",
  );
  const approvalDigest = raw.approvalDigest as string;
  if (approvalDigest.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(approvalDigest))
    rejectCommerce(invalid("payoutPlan.approvalDigest"));
  trimmedText(raw.idempotencyKey, "payoutPlan.idempotencyKey");
  return {
    approvalDigest,
    executionDeadline,
    idempotencyKey: raw.idempotencyKey,
  };
}

function requirePositive(amount: Money, field: string): Money {
  const checked = ensureNonNegative(amount);
  if (checked.amountMinor === 0)
    rejectCommerce({ code: "invalid_quantity", field });
  return checked;
}

function sameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency)
    rejectCommerce({ code: "currency_mismatch" });
}

function digestText(value: string, field: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) rejectCommerce(invalid(field));
  return value;
}

function masked(value: string, field: string): string {
  trimmedText(value, field);
  if ((value.match(/[0-9]/g) ?? []).length > 4)
    rejectCommerce(invalid(`${field}.unmasked`));
  return value;
}

function gmoPlan(raw: Raw): SupplierPayoutExecutionPlan {
  amountBasis(raw.amountBasis, "gmoPlan.amountBasis");
  const planSubject = subject(raw.subject);
  const integrationAccountId = identityOr(
    raw.integrationAccountId,
    "gmoPlan.integrationAccountId",
  );
  const sourceAccountId = identityOr(
    raw.sourceAccountId,
    "gmoPlan.sourceAccountId",
  );
  const destinationRevisionId = identityOr(
    raw.destinationRevisionId,
    "gmoPlan.destinationRevisionId",
  );
  const recipient = moneyOr(raw.recipientAmount, "gmoPlan.recipientAmount");
  const feeAmount = moneyOr(
    raw.observedFee.amount,
    "gmoPlan.observedFee.amount",
  );
  const observedAt = timestampOr(
    raw.observedFee.observedAt,
    "gmoPlan.observedFee.observedAt",
  );
  const observedFee = { amount: ensureNonNegative(feeAmount), observedAt };
  const ceiling = moneyOr(raw.feeCeiling, "gmoPlan.feeCeiling");
  const requestedTransferDate = timestampOr(
    raw.requestedTransferDate,
    "gmoPlan.requestedTransferDate",
  );
  const planSeal = seal(raw.seal);
  const recipientAmount = requirePositive(recipient, "gmoPlan.recipientAmount");
  if (recipientAmount.currency !== "JPY")
    rejectCommerce({ code: "currency_mismatch" });
  const feeCeiling = ensureNonNegative(ceiling);
  sameCurrency(recipientAmount, feeCeiling);
  sameCurrency(recipientAmount, observedFee.amount);
  if (observedFee.amount.amountMinor > feeCeiling.amountMinor)
    rejectCommerce({
      code: "invalid_lifecycle",
      reason: "gmoPlan.observedFee.aboveCeiling",
    });
  return {
    kind: "gmo_aozora",
    subject: planSubject,
    integrationAccountId,
    sourceAccountId,
    destinationRevisionId,
    maskedDestinationSummary: masked(
      raw.maskedDestinationSummary,
      "gmoPlan.maskedDestinationSummary",
    ),
    amountBasis: "recipient_receives",
    recipientAmount,
    observedFee,
    feeCeiling,
    requestedTransferDate,
    supplierReference: trimmedText(
      raw.supplierReference,
      "gmoPlan.supplierReference",
    ),
    seal: planSeal,
  } as SupplierPayoutExecutionPlan;
}

function decimalRate(value: string): string {
  let digits = 0;
  let points = 0;
  // Rust reads bytes; any non-ASCII character is refused, so code units suffice.
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character >= "0" && character <= "9") digits++;
    else if (character === ".") points++;
    else if (!(character === "-" && index === 0))
      rejectCommerce(invalid("payoutPlan.rate"));
  }
  if (digits === 0 || points > 1 || value.startsWith("-"))
    rejectCommerce(invalid("payoutPlan.rate"));
  return value;
}

function wisePlan(raw: Raw): SupplierPayoutExecutionPlan {
  amountBasis(raw.amountBasis, "wisePlan.amountBasis");
  if (raw.funding !== "balance") rejectCommerce(invalid("wisePlan.funding"));
  const planSubject = subject(raw.subject);
  const integrationAccountId = identityOr(
    raw.integrationAccountId,
    "wisePlan.integrationAccountId",
  );
  const profileId = identityOr(raw.profileId, "wisePlan.profileId");
  const destinationRevisionId = identityOr(
    raw.destinationRevisionId,
    "wisePlan.destinationRevisionId",
  );
  const providerRecipientId = identityOr(
    raw.providerRecipientId,
    "wisePlan.providerRecipientId",
  );
  const quoteId = identityOr(raw.quoteId, "wisePlan.quoteId");
  const paymentOptionId = identityOr(
    raw.paymentOptionId,
    "wisePlan.paymentOptionId",
  );
  const sourceRaw = moneyOr(raw.sourceTotal, "wisePlan.sourceTotal");
  const targetRaw = moneyOr(raw.targetAmount, "wisePlan.targetAmount");
  const feeRaw = moneyOr(raw.feeTotal, "wisePlan.feeTotal");
  const taxRaw = moneyOr(raw.taxTotal, "wisePlan.taxTotal");
  const ceilingRaw = moneyOr(raw.feeCeiling, "wisePlan.feeCeiling");
  const rate = decimalRate(raw.rate);
  const rateExpiresAt = timestampOr(
    raw.rateExpiresAt,
    "wisePlan.rateExpiresAt",
  );
  const planSeal = seal(raw.seal);
  const sourceTotal = requirePositive(sourceRaw, "wisePlan.sourceTotal");
  const targetAmount = requirePositive(targetRaw, "wisePlan.targetAmount");
  const feeTotal = ensureNonNegative(feeRaw);
  const taxTotal = ensureNonNegative(taxRaw);
  const feeCeiling = ensureNonNegative(ceilingRaw);
  sameCurrency(sourceTotal, feeTotal);
  sameCurrency(sourceTotal, taxTotal);
  sameCurrency(sourceTotal, feeCeiling);
  // Release Wasm wraps on i64 overflow.
  const charged = BigInt.asIntN(
    64,
    BigInt(feeTotal.amountMinor) + BigInt(taxTotal.amountMinor),
  );
  if (charged > BigInt(feeCeiling.amountMinor))
    rejectCommerce({
      code: "invalid_lifecycle",
      reason: "wisePlan.price.aboveCeiling",
    });
  const customerTransactionId = trimmedText(
    raw.customerTransactionId,
    "wisePlan.customerTransactionId",
  );
  return {
    kind: "wise",
    subject: planSubject,
    integrationAccountId,
    profileId,
    funding: "balance",
    destinationRevisionId,
    providerRecipientId,
    quoteId,
    paymentOptionId,
    payInMethod: trimmedText(raw.payInMethod, "wisePlan.payInMethod"),
    payOutMethod: trimmedText(raw.payOutMethod, "wisePlan.payOutMethod"),
    amountBasis: "recipient_receives",
    sourceTotal,
    targetAmount,
    feeTotal,
    taxTotal,
    feeCeiling,
    rate,
    rateExpiresAt,
    transferRequirementsDigest: digestText(
      raw.transferRequirementsDigest,
      "wisePlan.transferRequirementsDigest",
    ),
    customerTransactionId,
    supplierReference: trimmedText(
      raw.supplierReference,
      "wisePlan.supplierReference",
    ),
    seal: planSeal,
  } as SupplierPayoutExecutionPlan;
}

/** Rust `validateSupplierPayoutPlan`: the plan, its economics digest, and whether the seal carries it. */
export function validateSupplierPayoutPlan(
  input: unknown,
): CommerceBoundaryResponse {
  return respond(() => {
    const plan = parseSupplierPayoutExecutionPlan(input);
    const economicsDigest = sha256HexSync(encodeSupplierPayoutEconomics(plan));
    return {
      plan,
      economicsDigest,
      matchesApproval: plan.seal.approvalDigest === economicsDigest,
    };
  });
}

// Payout observations

const OBSERVATION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  provider_pending: ["providerTransferId", "providerState", "observedAt"],
  settled: ["providerTransferId", "receiptReference", "settledAt"],
  return_pending: ["providerTransferId", "observedAt"],
  returned: ["providerTransferId", "payableRestorationReceiptId", "returnedAt"],
  reversal_pending: ["providerTransferId", "observedAt"],
  reversed: ["providerTransferId", "payableRestorationReceiptId", "reversedAt"],
  failed: ["failure", "providerEvidenceId", "failedAt"],
  cancelled: ["cancelledAt"],
};

const INVALID_OBSERVATION: CommerceValidationError = {
  code: "invalid_lifecycle",
  reason: "supplierPayout.observation",
};

function readTagged(
  value: unknown,
  path: string,
  variants: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, string>> {
  const object = struct(value, path);
  const kind = tag(object, "kind", Object.keys(variants));
  const names = variants[kind]!;
  struct(
    Object.fromEntries(
      Object.entries(object).filter(([key]) => key !== "kind"),
    ),
    path,
    names,
  );
  const result: Record<string, string> = { kind };
  for (const key of names)
    result[key] = text(required(object, key), `${path}.${key}`);
  return result;
}

function resource(value: string): string {
  const trimmed = rustTrim(value);
  if (trimmed.length === 0 || value !== trimmed)
    rejectCommerce({ code: "invalid_identity", field: "ResourceId" });
  return value;
}

/** Rust `parse_payout_observation`. */
export function parsePayoutObservation(value: unknown): SupplierPayoutState {
  const raw = decoded(
    readTagged.bind(null, value, "observation", OBSERVATION_FIELDS),
    INVALID_OBSERVATION,
  );
  switch (raw.kind) {
    case "provider_pending":
      resource(raw.providerState!);
      return {
        kind: "provider_pending",
        providerTransferId: resource(raw.providerTransferId!),
        providerState: raw.providerState!,
        observedAt: commerceTimestamp(raw.observedAt!),
      };
    case "settled":
      resource(raw.receiptReference!);
      return {
        kind: "settled",
        providerTransferId: resource(raw.providerTransferId!),
        receiptReference: raw.receiptReference!,
        settledAt: commerceTimestamp(raw.settledAt!),
      };
    case "return_pending":
    case "reversal_pending":
      return {
        kind: raw.kind,
        providerTransferId: resource(raw.providerTransferId!),
        observedAt: commerceTimestamp(raw.observedAt!),
      } as SupplierPayoutState;
    case "returned":
      return {
        kind: "returned",
        providerTransferId: resource(raw.providerTransferId!),
        payableRestorationReceiptId: resource(raw.payableRestorationReceiptId!),
        returnedAt: commerceTimestamp(raw.returnedAt!),
      };
    case "reversed":
      return {
        kind: "reversed",
        providerTransferId: resource(raw.providerTransferId!),
        payableRestorationReceiptId: resource(raw.payableRestorationReceiptId!),
        reversedAt: commerceTimestamp(raw.reversedAt!),
      };
    case "failed": {
      const failure = raw.failure!;
      if (
        failure !== "provider_rejected" &&
        failure !== "insufficient_funds" &&
        failure !== "destination_rejected"
      )
        rejectCommerce(INVALID_OBSERVATION);
      return {
        kind: "failed",
        failure,
        providerEvidenceId: resource(raw.providerEvidenceId!),
        failedAt: commerceTimestamp(raw.failedAt!),
      };
    }
    case "cancelled":
      return {
        kind: "cancelled",
        cancelledAt: commerceTimestamp(raw.cancelledAt!),
      };
    default:
      throw new Error("unreachable payout observation kind");
  }
}

export function validateSupplierPayoutObservation(
  input: unknown,
): CommerceBoundaryResponse {
  return respond(parsePayoutObservation.bind(null, input));
}

// Supplier payables

const PAYABLE_FIELDS = [
  "payableId",
  "organisationId",
  "merchantId",
  "supplierId",
  "purchaseRequestId",
  "paymentReference",
  "evidenceReference",
  "grossAmount",
  "dueDate",
  "revision",
  "allocation",
  "lifecycle",
] as const;
const LIFECYCLES = [
  "draft",
  "approved",
  "partially_paid",
  "paid",
  "void",
] as const;
type Lifecycle = (typeof LIFECYCLES)[number];
const COMMANDS = [
  "validate",
  "approve",
  "void",
  "allocate",
  "settle",
  "release",
  "restore",
] as const;

type PayableCommand =
  | Readonly<{ kind: "validate" | "approve" | "void" }>
  | Readonly<{ kind: "allocate" | "settle" | "restore"; amount: RawMoney }>
  | Readonly<{ kind: "release"; amount: RawMoney; payoutState: Raw }>;

function readPayableRequest(value: unknown): Readonly<{
  payable: Raw;
  command: PayableCommand;
}> {
  const object = struct(value, "payableCommand", ["payable", "command"]);
  const payableObject = struct(
    required(object, "payable"),
    "payable",
    PAYABLE_FIELDS,
  );
  const payable: Record<string, unknown> = {};
  for (const key of PAYABLE_FIELDS) {
    const member = required(payableObject, key);
    if (key === "grossAmount") payable[key] = readMoney(member, key);
    else if (key === "revision") payable[key] = u64(member, key);
    else if (key === "allocation") {
      const allocation = struct(member, key, ["inFlight", "settled"]);
      payable[key] = {
        inFlight: readMoney(required(allocation, "inFlight"), "inFlight"),
        settled: readMoney(required(allocation, "settled"), "settled"),
      };
    } else payable[key] = text(member, key);
  }
  return { payable, command: readCommand(required(object, "command")) };
}

function readCommand(value: unknown): PayableCommand {
  const object = struct(value, "command");
  const kind = tag(object, "kind", COMMANDS);
  return buffered(readCommandFields.bind(null, object, kind));
}

function readCommandFields(
  object: Record<string, unknown>,
  kind: (typeof COMMANDS)[number],
): PayableCommand {
  const rest = Object.fromEntries(
    Object.entries(object).filter(([key]) => key !== "kind"),
  );
  switch (kind) {
    case "validate":
    case "approve":
    case "void":
      struct(rest, "command", []);
      return { kind };
    case "allocate":
    case "settle":
    case "restore": {
      const fields = struct(rest, "command", ["amount"]);
      return { kind, amount: readMoney(required(fields, "amount"), "amount") };
    }
    case "release": {
      const fields = struct(rest, "command", ["amount", "payoutState"]);
      return {
        kind,
        amount: readMoney(required(fields, "amount"), "amount"),
        payoutState: readTagged(
          required(fields, "payoutState"),
          "payoutState",
          {
            failed: ["failure", "providerEvidenceId", "failedAt"],
            cancelled: ["cancelledAt"],
          },
        ),
      };
    }
    default:
      return assertNever(kind);
  }
}

type Payable = {
  payableId: string;
  organisationId: string;
  merchantId: string;
  supplierId: string;
  purchaseRequestId: string;
  paymentReference: string;
  evidenceReference: string;
  grossAmount: Money;
  dueDate: string;
  revision: number;
  allocation: { inFlight: Money; settled: Money };
  lifecycle: Lifecycle;
};

function lifecycleRule(reason: string): CommerceValidationError {
  return { code: "invalid_lifecycle", reason };
}

function payableFromRaw(raw: Raw): Payable {
  const payableId = identityOr(raw.payableId, "supplierPayable.payableId");
  const organisationId = identityOr(
    raw.organisationId,
    "supplierPayable.organisationId",
  );
  const merchantId = identityOr(raw.merchantId, "supplierPayable.merchantId");
  const supplierId = identityOr(raw.supplierId, "supplierPayable.supplierId");
  const purchaseRequestId = identityOr(
    raw.purchaseRequestId,
    "supplierPayable.purchaseRequestId",
  );
  const grossRaw = moneyOr(raw.grossAmount, "supplierPayable.grossAmount");
  const dueDate = timestampOr(raw.dueDate, "supplierPayable.dueDate");
  const inFlightRaw = moneyOr(
    raw.allocation.inFlight,
    "supplierPayable.allocation.inFlight",
  );
  const settledRaw = moneyOr(
    raw.allocation.settled,
    "supplierPayable.allocation.settled",
  );
  if (!LIFECYCLES.includes(raw.lifecycle))
    rejectCommerce(invalid("supplierPayable.lifecycle"));
  const lifecycle = raw.lifecycle as Lifecycle;
  // SupplierPayable::draft
  const grossAmount = ensureNonNegative(grossRaw);
  if (grossAmount.amountMinor === 0)
    rejectCommerce({
      code: "invalid_quantity",
      field: "supplierPayable.grossAmount",
    });
  const paymentReference = trimmedText(
    raw.paymentReference,
    "supplierPayable.paymentReference",
  );
  const evidenceReference = trimmedText(
    raw.evidenceReference,
    "supplierPayable.evidenceReference",
  );
  // SupplierPayable::from_parts
  if (raw.revision === 0)
    rejectCommerce(lifecycleRule("supplierPayable.revision"));
  const inFlight = storedAmount(
    grossAmount,
    inFlightRaw,
    "supplierPayable.allocation.inFlight",
  );
  const settled = storedAmount(
    grossAmount,
    settledRaw,
    "supplierPayable.allocation.settled",
  );
  const committed = BigInt(inFlight.amountMinor) + BigInt(settled.amountMinor);
  if (committed > 9223372036854775807n)
    rejectCommerce(lifecycleRule("supplierPayable.allocation"));
  if (committed > BigInt(grossAmount.amountMinor))
    rejectCommerce(lifecycleRule("supplierPayable.allocation.overCommitted"));
  const payable: Payable = {
    payableId,
    organisationId,
    merchantId,
    supplierId,
    purchaseRequestId,
    paymentReference,
    evidenceReference,
    grossAmount,
    dueDate,
    revision: raw.revision,
    allocation: { inFlight, settled },
    lifecycle,
  };
  if (
    lifecycle !== "draft" &&
    lifecycle !== "void" &&
    settlementLifecycle(payable) !== lifecycle
  )
    rejectCommerce(lifecycleRule("supplierPayable.lifecycle"));
  return payable;
}

function storedAmount(gross: Money, amount: Money, field: string): Money {
  if (amount.currency !== gross.currency)
    rejectCommerce({ code: "currency_mismatch" });
  if (amount.amountMinor < 0)
    rejectCommerce({ code: "invalid_quantity", field });
  return amount;
}

function checkedAmount(payable: Payable, amount: Money): Money {
  if (amount.currency !== payable.grossAmount.currency)
    rejectCommerce({ code: "currency_mismatch" });
  if (amount.amountMinor <= 0)
    rejectCommerce({
      code: "invalid_quantity",
      field: "supplierPayable.amount",
    });
  return amount;
}

function payableMoney(payable: Payable, amountMinor: number): Money {
  return ensureNonNegative(money(amountMinor, payable.grossAmount.currency));
}

function settlementLifecycle(payable: Payable): Lifecycle {
  if (
    payable.allocation.settled.amountMinor === payable.grossAmount.amountMinor
  )
    return "paid";
  if (payable.allocation.settled.amountMinor > 0) return "partially_paid";
  return "approved";
}

function requireFundable(payable: Payable): void {
  if (payable.lifecycle === "draft" || payable.lifecycle === "void")
    rejectCommerce(lifecycleRule("supplierPayable.notApproved"));
}

function nextRevision(payable: Payable): number {
  if (payable.revision >= 18446744073709551615)
    rejectCommerce({ code: "invalid_revision" });
  return payable.revision + 1;
}

function allocated(payable: Payable): Money {
  return payableMoney(
    payable,
    payable.allocation.inFlight.amountMinor +
      payable.allocation.settled.amountMinor,
  );
}

function applyCommand(payable: Payable, command: PayableCommand): Payable {
  switch (command.kind) {
    case "validate":
      return payable;
    case "approve":
      if (payable.lifecycle !== "draft")
        rejectCommerce(lifecycleRule("supplierPayable.approve"));
      return {
        ...payable,
        lifecycle: "approved",
        revision: nextRevision(payable),
      };
    case "void":
      if (payable.lifecycle === "paid" || payable.lifecycle === "void")
        rejectCommerce(lifecycleRule("supplierPayable.void"));
      if (allocated(payable).amountMinor !== 0)
        rejectCommerce(lifecycleRule("supplierPayable.void.allocated"));
      return { ...payable, lifecycle: "void", revision: nextRevision(payable) };
    case "allocate": {
      const amount = moneyOr(command.amount, "payableCommand.amount");
      requireFundable(payable);
      const checked = checkedAmount(payable, amount);
      const remaining = payableMoney(
        payable,
        payable.grossAmount.amountMinor - allocated(payable).amountMinor,
      );
      if (checked.amountMinor > remaining.amountMinor)
        rejectCommerce(lifecycleRule("supplierPayable.allocate.exceeds"));
      const inFlight = payableMoney(
        payable,
        payable.allocation.inFlight.amountMinor + checked.amountMinor,
      );
      return {
        ...payable,
        allocation: { ...payable.allocation, inFlight },
        revision: nextRevision(payable),
      };
    }
    case "settle": {
      const amount = moneyOr(command.amount, "payableCommand.amount");
      requireFundable(payable);
      const checked = checkedAmount(payable, amount);
      if (checked.amountMinor > payable.allocation.inFlight.amountMinor)
        rejectCommerce(lifecycleRule("supplierPayable.settle.unallocated"));
      const next: Payable = {
        ...payable,
        allocation: {
          inFlight: payableMoney(
            payable,
            payable.allocation.inFlight.amountMinor - checked.amountMinor,
          ),
          settled: payableMoney(
            payable,
            payable.allocation.settled.amountMinor + checked.amountMinor,
          ),
        },
      };
      return {
        ...next,
        lifecycle: settlementLifecycle(next),
        revision: nextRevision(payable),
      };
    }
    case "restore": {
      const amount = moneyOr(command.amount, "payableCommand.amount");
      const checked = checkedAmount(payable, amount);
      if (checked.amountMinor > payable.allocation.settled.amountMinor)
        rejectCommerce(lifecycleRule("supplierPayable.restore.unsettled"));
      const next: Payable = {
        ...payable,
        allocation: {
          ...payable.allocation,
          settled: payableMoney(
            payable,
            payable.allocation.settled.amountMinor - checked.amountMinor,
          ),
        },
      };
      return {
        ...next,
        lifecycle: settlementLifecycle(next),
        revision: nextRevision(payable),
      };
    }
    case "release": {
      releaseState(command.payoutState);
      const amount = moneyOr(command.amount, "payableCommand.amount");
      const checked = checkedAmount(payable, amount);
      if (checked.amountMinor > payable.allocation.inFlight.amountMinor)
        rejectCommerce(lifecycleRule("supplierPayable.release.unallocated"));
      const next: Payable = {
        ...payable,
        allocation: {
          ...payable.allocation,
          inFlight: payableMoney(
            payable,
            payable.allocation.inFlight.amountMinor - checked.amountMinor,
          ),
        },
      };
      return {
        ...next,
        lifecycle: settlementLifecycle(next),
        revision: nextRevision(payable),
      };
    }
    default:
      return assertNever(command);
  }
}

/** Only a failed or cancelled payout can authorize a release. */
function releaseState(raw: Raw): void {
  if (raw.kind === "cancelled") {
    timestampOr(raw.cancelledAt, "payableCommand.payoutState.cancelledAt");
    return;
  }
  if (
    ![
      "insufficient_funds",
      "destination_rejected",
      "provider_rejected",
      "approval_expired",
    ].includes(raw.failure)
  )
    rejectCommerce(invalid("payableCommand.payoutState.failure"));
  identityOr(
    raw.providerEvidenceId,
    "payableCommand.payoutState.providerEvidenceId",
  );
  timestampOr(raw.failedAt, "payableCommand.payoutState.failedAt");
}

/** Rust `apply_supplier_payable_command`. */
export function applySupplierPayableCommandValue(
  value: unknown,
): SupplierPayable {
  const request = decoded(
    readPayableRequest.bind(null, value),
    invalid("payableCommand"),
  );
  const payable = payableFromRaw(request.payable);
  return applyCommand(payable, request.command) as SupplierPayable;
}

export function applySupplierPayableCommand(
  input: unknown,
): CommerceBoundaryResponse {
  return respond(applySupplierPayableCommandValue.bind(null, input));
}

// Reconciliation

const LEGAL_PAYOUT_TRANSITIONS: readonly (readonly [string, string])[] = [
  ["approval_pending", "approved"],
  ["approval_pending", "cancelled"],
  ["approved", "submitting"],
  ["approved", "cancelled"],
  ["submitting", "provider_action_required"],
  ["submitting", "provider_pending"],
  ["submitting", "settled"],
  ["submitting", "cancelled"],
  ["submitting", "failed"],
  ["submitting", "indeterminate"],
  ["indeterminate", "provider_action_required"],
  ["indeterminate", "provider_pending"],
  ["indeterminate", "settled"],
  ["indeterminate", "failed"],
  ["indeterminate", "cancelled"],
  ["provider_action_required", "provider_pending"],
  ["provider_action_required", "provider_action_required"],
  ["provider_action_required", "indeterminate"],
  ["provider_action_required", "failed"],
  ["provider_action_required", "cancelled"],
  ["provider_action_required", "settled"],
  ["provider_pending", "settled"],
  ["provider_pending", "failed"],
  ["provider_pending", "cancelled"],
  ["provider_pending", "indeterminate"],
  ["settled", "return_pending"],
  ["settled", "reversal_pending"],
  ["settled", "returned"],
  ["settled", "reversed"],
  ["return_pending", "returned"],
  ["return_pending", "settled"],
  ["reversal_pending", "reversed"],
  ["reversal_pending", "settled"],
];

/** Rust `SupplierPayoutState::accepts_kind`. */
export function payoutAcceptsKind(from: string, next: string): boolean {
  return LEGAL_PAYOUT_TRANSITIONS.some(
    ([left, right]) => left === from && right === next,
  );
}

function readReconciliation(value: unknown): Raw {
  const object = struct(value, "reconciliation", [
    "fromKind",
    "observation",
    "payable",
    "amount",
  ]);
  return {
    fromKind: text(required(object, "fromKind"), "fromKind"),
    observation: required(object, "observation"),
    payable: required(object, "payable"),
    amount: required(object, "amount"),
  };
}

/** Rust `reconcile_payout`: the observed state and the payable it implies. */
export function reconcileSupplierPayout(
  input: unknown,
): CommerceBoundaryResponse {
  return respond(() => {
    const request = decoded(
      readReconciliation.bind(null, input),
      INVALID_OBSERVATION,
    );
    const next = parsePayoutObservation(request.observation);
    if (!payoutAcceptsKind(request.fromKind, next.kind))
      rejectCommerce(INVALID_OBSERVATION);
    let command: unknown;
    if (next.kind === "failed" || next.kind === "cancelled")
      command = { kind: "release", amount: request.amount, payoutState: next };
    else if (next.kind === "returned" || next.kind === "reversed")
      command = { kind: "restore", amount: request.amount };
    else if (
      next.kind === "settled" &&
      request.fromKind !== "return_pending" &&
      request.fromKind !== "reversal_pending"
    )
      command = { kind: "settle", amount: request.amount };
    else command = { kind: "validate" };
    const payable = applySupplierPayableCommandValue({
      payable: request.payable,
      command,
    });
    return { state: next, payable };
  });
}
