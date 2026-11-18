import { createHash } from "node:crypto";

import type {
  CarrierRateSnapshot,
  DutyIncoterm,
  DutyQuoteSnapshot,
  EstimatedDeliverySnapshot,
  TaxQuoteSnapshot,
} from "@seams/commerce-contracts";

import type {
  CarrierRateQuoteProvider,
  CarrierRateQuoteProviderRequest,
  CarrierRateQuoteProviderResult,
} from "./checkout-carrier-rate-provider.ts";
import { carrierRateQuoteInputDigest } from "./checkout-carrier-rate-provider.ts";

import type {
  CheckoutChargeQuoteProvider,
  DutyQuoteProviderRequest,
  DutyQuoteProviderResult,
  TaxQuoteProviderRequest,
  TaxQuoteProviderResult,
} from "./checkout-charge-provider.ts";
import {
  dutyQuoteInputDigest,
  taxQuoteInputDigest,
} from "./checkout-charge-provider.ts";
import type { CommerceDatabase } from "./database.ts";
import type { Variant, VariantBy } from "@seams/type-utils";
import { hasExactKeys, isNormalizedText, isRecord } from "@seams/std";

type ChargeQuoteAttemptBase = Readonly<{
  attemptId: string;
  componentKind: "carrier_rate" | "tax" | "duty";
  merchantId: string;
  parentAttemptId: string;
  checkoutId: string;
  checkoutRevision: number;
  buyerSessionDigest: string;
  providerAccountReference: string;
  inputDigest: string;
  createdAt: string;
  expiresAt: string;
}>;

type TaxQuotedResult = Variant<TaxQuoteProviderResult, "quoted">;
type DutyQuotedResult = Variant<DutyQuoteProviderResult, "quoted">;
type CarrierRateQuotedResult = Variant<
  CarrierRateQuoteProviderResult,
  "quoted"
>;

type CheckoutChargeQuoteAttempt =
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "carrier_rate";
        state: "pending";
        result?: never;
        field?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "carrier_rate";
        state: "quoted";
        result: CarrierRateQuotedResult;
        field?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "carrier_rate";
        state: "unavailable";
        field: string;
        result?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "carrier_rate";
        state: "indeterminate";
        field: string;
        retryAfter: string;
        result?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "tax";
        state: "pending";
        result?: never;
        field?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "tax";
        state: "quoted";
        result: TaxQuotedResult;
        field?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "tax";
        state: "unavailable";
        field: string;
        result?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "tax";
        state: "indeterminate";
        field: string;
        retryAfter: string;
        result?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "duty";
        state: "pending";
        result?: never;
        field?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "duty";
        state: "quoted";
        result: DutyQuotedResult;
        field?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "duty";
        state: "unavailable";
        field: string;
        result?: never;
        retryAfter?: never;
      }>)
  | (ChargeQuoteAttemptBase &
      Readonly<{
        componentKind: "duty";
        state: "indeterminate";
        field: string;
        retryAfter: string;
        result?: never;
      }>);

type DurableCheckoutChargeQuoteProviderInput = Readonly<{
  database: CommerceDatabase;
  merchantId: string;
  parentAttemptId: string;
  checkoutId: string;
  checkoutRevision: number;
  buyerSessionDigest: string;
  createdAt: string;
  expiresAt: string;
  provider: CheckoutChargeQuoteProvider;
}>;

type DurableCarrierRateQuoteProviderInput = Readonly<
  Omit<DurableCheckoutChargeQuoteProviderInput, "provider"> &
    Readonly<{
      provider: CarrierRateQuoteProvider;
    }>
>;

type ChargeQuoteAttemptRow = Readonly<{
  attemptId: string;
  parentAttemptId: string;
  checkoutId: string;
  checkoutRevision: number;
  buyerSessionDigest: string;
  componentKind: CheckoutChargeQuoteAttempt["componentKind"];
  providerAccountReference: string;
  inputDigest: string;
  lifecycleState: CheckoutChargeQuoteAttempt["state"];
  attemptJson: string;
  createdAt: string;
  expiresAt: string;
}>;

export class DurableCheckoutChargeQuoteProvider implements CheckoutChargeQuoteProvider {
  readonly input: DurableCheckoutChargeQuoteProviderInput;

  constructor(input: DurableCheckoutChargeQuoteProviderInput) {
    this.input = input;
  }

  quoteTax(request: TaxQuoteProviderRequest): TaxQuoteProviderResult {
    const pending = pendingTaxQuoteAttempt(this.input, request);
    insertPendingChargeQuoteAttempt(this.input.database, pending);
    const stored = readCheckoutChargeQuoteAttempt(
      this.input.database,
      pending.merchantId,
      pending.attemptId,
    );
    if (
      stored === undefined ||
      stored.componentKind !== "tax" ||
      !chargeQuoteAttemptInputMatches(stored, pending)
    ) {
      return { kind: "unavailable", field: "shippingRoute.taxAttemptIdentity" };
    }
    switch (stored.state) {
      case "quoted":
      case "unavailable":
        return taxAttemptResult(stored);
      case "pending":
      case "indeterminate":
        return executeTaxQuoteAttempt(this.input, request, stored);
    }
  }

  quoteDuty(request: DutyQuoteProviderRequest): DutyQuoteProviderResult {
    const pending = pendingDutyQuoteAttempt(this.input, request);
    insertPendingChargeQuoteAttempt(this.input.database, pending);
    const stored = readCheckoutChargeQuoteAttempt(
      this.input.database,
      pending.merchantId,
      pending.attemptId,
    );
    if (
      stored === undefined ||
      stored.componentKind !== "duty" ||
      !chargeQuoteAttemptInputMatches(stored, pending)
    ) {
      return {
        kind: "unavailable",
        field: "shippingRoute.dutyAttemptIdentity",
      };
    }
    switch (stored.state) {
      case "quoted":
      case "unavailable":
        return dutyAttemptResult(stored);
      case "pending":
      case "indeterminate":
        return executeDutyQuoteAttempt(this.input, request, stored);
    }
  }
}

export class DurableCarrierRateQuoteProvider implements CarrierRateQuoteProvider {
  readonly input: DurableCarrierRateQuoteProviderInput;

  constructor(input: DurableCarrierRateQuoteProviderInput) {
    this.input = input;
  }

  quoteRate(
    request: CarrierRateQuoteProviderRequest,
  ): CarrierRateQuoteProviderResult {
    const pending = pendingCarrierRateQuoteAttempt(this.input, request);
    insertPendingChargeQuoteAttempt(this.input.database, pending);
    const stored = readCheckoutChargeQuoteAttempt(
      this.input.database,
      pending.merchantId,
      pending.attemptId,
    );
    if (
      stored === undefined ||
      stored.componentKind !== "carrier_rate" ||
      !chargeQuoteAttemptInputMatches(stored, pending)
    ) {
      return {
        kind: "unavailable",
        field: "shippingRoute.carrierRateAttemptIdentity",
      };
    }
    switch (stored.state) {
      case "quoted":
      case "unavailable":
        return carrierRateAttemptResult(stored);
      case "pending":
      case "indeterminate":
        return executeCarrierRateQuoteAttempt(this.input, request, stored);
    }
  }
}

function readCheckoutChargeQuoteAttempt(
  database: CommerceDatabase,
  merchantId: string,
  attemptId: string,
): CheckoutChargeQuoteAttempt | undefined {
  const row = database
    .prepare(
      `SELECT attempt_id AS attemptId, parent_attempt_id AS parentAttemptId,
            checkout_id AS checkoutId, checkout_revision AS checkoutRevision,
            buyer_session_digest AS buyerSessionDigest, component_kind AS componentKind,
            provider_account_reference AS providerAccountReference,
            input_digest AS inputDigest, lifecycle_state AS lifecycleState,
            attempt_json AS attemptJson, created_at AS createdAt, expires_at AS expiresAt
     FROM checkout_charge_quote_attempt
     WHERE merchant_id = ? AND attempt_id = ?`,
    )
    .get<ChargeQuoteAttemptRow>(merchantId, attemptId);
  if (row === undefined) return undefined;
  const attempt = parseStoredChargeQuoteAttempt(row.attemptJson);
  if (!chargeQuoteAttemptRowMatches(attempt, merchantId, row)) {
    throw new Error("Stored charge quote attempt columns are inconsistent");
  }
  return attempt;
}

function chargeQuoteAttemptRowMatches(
  attempt: CheckoutChargeQuoteAttempt,
  merchantId: string,
  row: ChargeQuoteAttemptRow,
): boolean {
  return (
    attempt.merchantId === merchantId &&
    attempt.attemptId === row.attemptId &&
    attempt.parentAttemptId === row.parentAttemptId &&
    attempt.checkoutId === row.checkoutId &&
    attempt.checkoutRevision === row.checkoutRevision &&
    attempt.buyerSessionDigest === row.buyerSessionDigest &&
    attempt.componentKind === row.componentKind &&
    attempt.providerAccountReference === row.providerAccountReference &&
    attempt.inputDigest === row.inputDigest &&
    attempt.state === row.lifecycleState &&
    attempt.createdAt === row.createdAt &&
    attempt.expiresAt === row.expiresAt
  );
}

function pendingTaxQuoteAttempt(
  input: DurableCheckoutChargeQuoteProviderInput,
  request: TaxQuoteProviderRequest,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "tax"; state: "pending" }
> {
  return {
    ...chargeQuoteAttemptBase(
      input,
      "tax",
      request.providerAccountReference,
      taxQuoteInputDigest(request),
    ),
    componentKind: "tax",
    state: "pending",
  };
}

function pendingCarrierRateQuoteAttempt(
  input: DurableCarrierRateQuoteProviderInput,
  request: CarrierRateQuoteProviderRequest,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "carrier_rate"; state: "pending" }
> {
  return {
    ...chargeQuoteAttemptBase(
      input,
      "carrier_rate",
      request.providerAccountReference,
      carrierRateQuoteInputDigest(request),
    ),
    componentKind: "carrier_rate",
    state: "pending",
  };
}

function pendingDutyQuoteAttempt(
  input: DurableCheckoutChargeQuoteProviderInput,
  request: DutyQuoteProviderRequest,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "duty"; state: "pending" }
> {
  return {
    ...chargeQuoteAttemptBase(
      input,
      "duty",
      request.providerAccountReference,
      dutyQuoteInputDigest(request),
    ),
    componentKind: "duty",
    state: "pending",
  };
}

function chargeQuoteAttemptBase(
  input: Omit<DurableCheckoutChargeQuoteProviderInput, "provider">,
  componentKind: "carrier_rate" | "tax" | "duty",
  providerAccountReference: string,
  inputDigest: string,
): ChargeQuoteAttemptBase {
  return {
    attemptId: `checkout_charge_attempt_${sha256(`${input.parentAttemptId}:${componentKind}`)}`,
    componentKind,
    merchantId: requireText(input.merchantId, "merchantId"),
    parentAttemptId: requireText(input.parentAttemptId, "parentAttemptId"),
    checkoutId: requireText(input.checkoutId, "checkoutId"),
    checkoutRevision: requirePositiveInteger(
      input.checkoutRevision,
      "checkoutRevision",
    ),
    buyerSessionDigest: requireDigest(
      input.buyerSessionDigest,
      "buyerSessionDigest",
    ),
    providerAccountReference: requireText(
      providerAccountReference,
      "providerAccountReference",
    ),
    inputDigest: requireDigest(inputDigest, "inputDigest"),
    createdAt: requireTimestamp(input.createdAt, "createdAt"),
    expiresAt: requireTimestamp(input.expiresAt, "expiresAt"),
  };
}

function insertPendingChargeQuoteAttempt(
  database: CommerceDatabase,
  attempt: VariantBy<CheckoutChargeQuoteAttempt, "state", "pending">,
): void {
  database
    .prepare(
      `INSERT INTO checkout_charge_quote_attempt (
       merchant_id, attempt_id, parent_attempt_id, checkout_id,
       checkout_revision, buyer_session_digest, component_kind,
       provider_account_reference, input_digest, lifecycle_state,
       attempt_json, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT DO NOTHING`,
    )
    .run(
      attempt.merchantId,
      attempt.attemptId,
      attempt.parentAttemptId,
      attempt.checkoutId,
      attempt.checkoutRevision,
      attempt.buyerSessionDigest,
      attempt.componentKind,
      attempt.providerAccountReference,
      attempt.inputDigest,
      attempt.state,
      JSON.stringify(attempt),
      attempt.createdAt,
      attempt.expiresAt,
    );
}

function executeCarrierRateQuoteAttempt(
  input: DurableCarrierRateQuoteProviderInput,
  request: CarrierRateQuoteProviderRequest,
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    {
      componentKind: "carrier_rate";
      state: "pending" | "indeterminate";
    }
  >,
): CarrierRateQuoteProviderResult {
  let result: CarrierRateQuoteProviderResult;
  try {
    result = input.provider.quoteRate(request);
  } catch {
    const indeterminate = indeterminateCarrierRateQuoteAttempt(
      attempt,
      "carrierRateQuote.providerIndeterminate",
    );
    return persistCarrierRateAttempt(
      input.database,
      attempt.state,
      indeterminate,
    );
  }
  switch (result.kind) {
    case "quoted": {
      if (!carrierRateQuotedResultMatchesAttempt(result, attempt)) {
        const unavailable = unavailableCarrierRateQuoteAttempt(
          attempt,
          "shippingRoute.carrierRateResultIdentity",
        );
        return persistCarrierRateAttempt(
          input.database,
          attempt.state,
          unavailable,
        );
      }
      const quoted: Extract<
        CheckoutChargeQuoteAttempt,
        {
          componentKind: "carrier_rate";
          state: "quoted";
        }
      > = {
        ...chargeQuoteAttemptIdentity(attempt),
        componentKind: "carrier_rate",
        state: "quoted",
        result,
      };
      return persistCarrierRateAttempt(input.database, attempt.state, quoted);
    }
    case "unavailable": {
      const unavailable = unavailableCarrierRateQuoteAttempt(
        attempt,
        result.field,
      );
      return persistCarrierRateAttempt(
        input.database,
        attempt.state,
        unavailable,
      );
    }
    case "indeterminate": {
      const indeterminate = providerIndeterminateCarrierRateQuoteAttempt(
        attempt,
        result,
      );
      return persistCarrierRateAttempt(
        input.database,
        attempt.state,
        indeterminate,
      );
    }
  }
}

function executeTaxQuoteAttempt(
  input: DurableCheckoutChargeQuoteProviderInput,
  request: TaxQuoteProviderRequest,
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    { componentKind: "tax"; state: "pending" | "indeterminate" }
  >,
): TaxQuoteProviderResult {
  let result: TaxQuoteProviderResult;
  try {
    result = input.provider.quoteTax(request);
  } catch {
    const indeterminate = indeterminateTaxQuoteAttempt(
      attempt,
      "taxQuote.providerIndeterminate",
    );
    return persistTaxAttempt(input.database, attempt.state, indeterminate);
  }
  switch (result.kind) {
    case "quoted": {
      if (!taxQuotedResultMatchesAttempt(result, attempt)) {
        const unavailable = unavailableTaxQuoteAttempt(
          attempt,
          "shippingRoute.taxResultIdentity",
        );
        return persistTaxAttempt(input.database, attempt.state, unavailable);
      }
      const quoted: Extract<
        CheckoutChargeQuoteAttempt,
        { componentKind: "tax"; state: "quoted" }
      > = {
        ...chargeQuoteAttemptIdentity(attempt),
        componentKind: "tax",
        state: "quoted",
        result,
      };
      return persistTaxAttempt(input.database, attempt.state, quoted);
    }
    case "unavailable": {
      const unavailable = unavailableTaxQuoteAttempt(attempt, result.field);
      return persistTaxAttempt(input.database, attempt.state, unavailable);
    }
    case "indeterminate": {
      const indeterminate = providerIndeterminateTaxQuoteAttempt(
        attempt,
        result,
      );
      return persistTaxAttempt(input.database, attempt.state, indeterminate);
    }
  }
}

function persistCarrierRateAttempt(
  database: CommerceDatabase,
  expectedState: "pending" | "indeterminate",
  attempt: VariantBy<
    CheckoutChargeQuoteAttempt,
    "componentKind",
    "carrier_rate"
  >,
): CarrierRateQuoteProviderResult {
  persistChargeQuoteAttempt(database, expectedState, attempt);
  const stored = readCheckoutChargeQuoteAttempt(
    database,
    attempt.merchantId,
    attempt.attemptId,
  );
  if (
    stored === undefined ||
    stored.componentKind !== "carrier_rate" ||
    !chargeQuoteAttemptInputMatches(stored, attempt)
  ) {
    return {
      kind: "unavailable",
      field: "shippingRoute.carrierRateAttemptPersistence",
    };
  }
  return carrierRateAttemptResult(stored);
}

function executeDutyQuoteAttempt(
  input: DurableCheckoutChargeQuoteProviderInput,
  request: DutyQuoteProviderRequest,
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    { componentKind: "duty"; state: "pending" | "indeterminate" }
  >,
): DutyQuoteProviderResult {
  let result: DutyQuoteProviderResult;
  try {
    result = input.provider.quoteDuty(request);
  } catch {
    const indeterminate = indeterminateDutyQuoteAttempt(
      attempt,
      "dutyQuote.providerIndeterminate",
    );
    return persistDutyAttempt(input.database, attempt.state, indeterminate);
  }
  switch (result.kind) {
    case "quoted": {
      if (!dutyQuotedResultMatchesAttempt(result, attempt)) {
        const unavailable = unavailableDutyQuoteAttempt(
          attempt,
          "shippingRoute.dutyResultIdentity",
        );
        return persistDutyAttempt(input.database, attempt.state, unavailable);
      }
      const quoted: Extract<
        CheckoutChargeQuoteAttempt,
        { componentKind: "duty"; state: "quoted" }
      > = {
        ...chargeQuoteAttemptIdentity(attempt),
        componentKind: "duty",
        state: "quoted",
        result,
      };
      return persistDutyAttempt(input.database, attempt.state, quoted);
    }
    case "unavailable": {
      const unavailable = unavailableDutyQuoteAttempt(attempt, result.field);
      return persistDutyAttempt(input.database, attempt.state, unavailable);
    }
    case "indeterminate": {
      const indeterminate = providerIndeterminateDutyQuoteAttempt(
        attempt,
        result,
      );
      return persistDutyAttempt(input.database, attempt.state, indeterminate);
    }
  }
}

function persistTaxAttempt(
  database: CommerceDatabase,
  expectedState: "pending" | "indeterminate",
  attempt: VariantBy<CheckoutChargeQuoteAttempt, "componentKind", "tax">,
): TaxQuoteProviderResult {
  persistChargeQuoteAttempt(database, expectedState, attempt);
  const stored = readCheckoutChargeQuoteAttempt(
    database,
    attempt.merchantId,
    attempt.attemptId,
  );
  if (
    stored === undefined ||
    stored.componentKind !== "tax" ||
    !chargeQuoteAttemptInputMatches(stored, attempt)
  ) {
    return {
      kind: "unavailable",
      field: "shippingRoute.taxAttemptPersistence",
    };
  }
  return taxAttemptResult(stored);
}

function persistDutyAttempt(
  database: CommerceDatabase,
  expectedState: "pending" | "indeterminate",
  attempt: VariantBy<CheckoutChargeQuoteAttempt, "componentKind", "duty">,
): DutyQuoteProviderResult {
  persistChargeQuoteAttempt(database, expectedState, attempt);
  const stored = readCheckoutChargeQuoteAttempt(
    database,
    attempt.merchantId,
    attempt.attemptId,
  );
  if (
    stored === undefined ||
    stored.componentKind !== "duty" ||
    !chargeQuoteAttemptInputMatches(stored, attempt)
  ) {
    return {
      kind: "unavailable",
      field: "shippingRoute.dutyAttemptPersistence",
    };
  }
  return dutyAttemptResult(stored);
}

function persistChargeQuoteAttempt(
  database: CommerceDatabase,
  expectedState: "pending" | "indeterminate",
  attempt: CheckoutChargeQuoteAttempt,
): void {
  database
    .prepare(
      `UPDATE checkout_charge_quote_attempt
     SET lifecycle_state = ?, attempt_json = ?
     WHERE merchant_id = ? AND attempt_id = ? AND lifecycle_state = ?`,
    )
    .run(
      attempt.state,
      JSON.stringify(attempt),
      attempt.merchantId,
      attempt.attemptId,
      expectedState,
    );
}

function taxAttemptResult(
  attempt: VariantBy<CheckoutChargeQuoteAttempt, "componentKind", "tax">,
): TaxQuoteProviderResult {
  switch (attempt.state) {
    case "quoted":
      return attempt.result;
    case "unavailable":
      return { kind: "unavailable", field: attempt.field };
    case "indeterminate":
      return {
        kind: "indeterminate",
        field: attempt.field,
        retryAfter: attempt.retryAfter,
      };
    case "pending":
      return {
        kind: "indeterminate",
        field: "taxQuote.pending",
        retryAfter: attempt.createdAt,
      };
  }
}

function carrierRateAttemptResult(
  attempt: VariantBy<
    CheckoutChargeQuoteAttempt,
    "componentKind",
    "carrier_rate"
  >,
): CarrierRateQuoteProviderResult {
  switch (attempt.state) {
    case "quoted":
      return attempt.result;
    case "unavailable":
      return { kind: "unavailable", field: attempt.field };
    case "indeterminate":
      return {
        kind: "indeterminate",
        field: attempt.field,
        retryAfter: attempt.retryAfter,
      };
    case "pending":
      return {
        kind: "indeterminate",
        field: "carrierRateQuote.pending",
        retryAfter: attempt.createdAt,
      };
  }
}

function dutyAttemptResult(
  attempt: VariantBy<CheckoutChargeQuoteAttempt, "componentKind", "duty">,
): DutyQuoteProviderResult {
  switch (attempt.state) {
    case "quoted":
      return attempt.result;
    case "unavailable":
      return { kind: "unavailable", field: attempt.field };
    case "indeterminate":
      return {
        kind: "indeterminate",
        field: attempt.field,
        retryAfter: attempt.retryAfter,
      };
    case "pending":
      return {
        kind: "indeterminate",
        field: "dutyQuote.pending",
        retryAfter: attempt.createdAt,
      };
  }
}

function unavailableTaxQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    { componentKind: "tax"; state: "pending" | "indeterminate" }
  >,
  field: string,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "tax"; state: "unavailable" }
> {
  return {
    ...chargeQuoteAttemptIdentity(attempt),
    componentKind: "tax",
    state: "unavailable",
    field: requireText(field, "chargeQuote.field"),
  };
}

function unavailableCarrierRateQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    {
      componentKind: "carrier_rate";
      state: "pending" | "indeterminate";
    }
  >,
  field: string,
): Extract<
  CheckoutChargeQuoteAttempt,
  {
    componentKind: "carrier_rate";
    state: "unavailable";
  }
> {
  return {
    ...chargeQuoteAttemptIdentity(attempt),
    componentKind: "carrier_rate",
    state: "unavailable",
    field: requireText(field, "chargeQuote.field"),
  };
}

function unavailableDutyQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    { componentKind: "duty"; state: "pending" | "indeterminate" }
  >,
  field: string,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "duty"; state: "unavailable" }
> {
  return {
    ...chargeQuoteAttemptIdentity(attempt),
    componentKind: "duty",
    state: "unavailable",
    field: requireText(field, "chargeQuote.field"),
  };
}

function indeterminateTaxQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    { componentKind: "tax"; state: "pending" | "indeterminate" }
  >,
  field: string,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "tax"; state: "indeterminate" }
> {
  return providerIndeterminateTaxQuoteAttempt(attempt, {
    kind: "indeterminate",
    field,
    retryAfter: chargeQuoteRetryAfter(attempt),
  });
}

function indeterminateCarrierRateQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    {
      componentKind: "carrier_rate";
      state: "pending" | "indeterminate";
    }
  >,
  field: string,
): Extract<
  CheckoutChargeQuoteAttempt,
  {
    componentKind: "carrier_rate";
    state: "indeterminate";
  }
> {
  return providerIndeterminateCarrierRateQuoteAttempt(attempt, {
    kind: "indeterminate",
    field,
    retryAfter: chargeQuoteRetryAfter(attempt),
  });
}

function indeterminateDutyQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    { componentKind: "duty"; state: "pending" | "indeterminate" }
  >,
  field: string,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "duty"; state: "indeterminate" }
> {
  return providerIndeterminateDutyQuoteAttempt(attempt, {
    kind: "indeterminate",
    field,
    retryAfter: chargeQuoteRetryAfter(attempt),
  });
}

function providerIndeterminateTaxQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    { componentKind: "tax"; state: "pending" | "indeterminate" }
  >,
  result: Readonly<{
    kind: "indeterminate";
    field: string;
    retryAfter: string;
  }>,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "tax"; state: "indeterminate" }
> {
  return {
    ...chargeQuoteAttemptIdentity(attempt),
    componentKind: "tax",
    state: "indeterminate",
    field: requireText(result.field, "chargeQuote.field"),
    retryAfter: boundedRetryAfter(result.retryAfter, attempt.expiresAt),
  };
}

function providerIndeterminateCarrierRateQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    {
      componentKind: "carrier_rate";
      state: "pending" | "indeterminate";
    }
  >,
  result: Readonly<{
    kind: "indeterminate";
    field: string;
    retryAfter: string;
  }>,
): Extract<
  CheckoutChargeQuoteAttempt,
  {
    componentKind: "carrier_rate";
    state: "indeterminate";
  }
> {
  return {
    ...chargeQuoteAttemptIdentity(attempt),
    componentKind: "carrier_rate",
    state: "indeterminate",
    field: requireText(result.field, "chargeQuote.field"),
    retryAfter: boundedRetryAfter(result.retryAfter, attempt.expiresAt),
  };
}

function providerIndeterminateDutyQuoteAttempt(
  attempt: Extract<
    CheckoutChargeQuoteAttempt,
    { componentKind: "duty"; state: "pending" | "indeterminate" }
  >,
  result: Readonly<{
    kind: "indeterminate";
    field: string;
    retryAfter: string;
  }>,
): Extract<
  CheckoutChargeQuoteAttempt,
  { componentKind: "duty"; state: "indeterminate" }
> {
  return {
    ...chargeQuoteAttemptIdentity(attempt),
    componentKind: "duty",
    state: "indeterminate",
    field: requireText(result.field, "chargeQuote.field"),
    retryAfter: boundedRetryAfter(result.retryAfter, attempt.expiresAt),
  };
}

function chargeQuoteRetryAfter(attempt: CheckoutChargeQuoteAttempt): string {
  return new Date(
    Math.min(
      Date.parse(attempt.createdAt) + 30_000,
      Date.parse(attempt.expiresAt),
    ),
  ).toISOString();
}

function boundedRetryAfter(retryAfterValue: string, expiresAt: string): string {
  const retryAfter = requireTimestamp(
    retryAfterValue,
    "chargeQuote.retryAfter",
  );
  if (Date.parse(retryAfter) > Date.parse(expiresAt)) {
    throw new Error("Charge quote retry exceeds its expiry");
  }
  return retryAfter;
}

function chargeQuoteAttemptIdentity(
  attempt: CheckoutChargeQuoteAttempt,
): ChargeQuoteAttemptBase {
  return {
    attemptId: attempt.attemptId,
    componentKind: attempt.componentKind,
    merchantId: attempt.merchantId,
    parentAttemptId: attempt.parentAttemptId,
    checkoutId: attempt.checkoutId,
    checkoutRevision: attempt.checkoutRevision,
    buyerSessionDigest: attempt.buyerSessionDigest,
    providerAccountReference: attempt.providerAccountReference,
    inputDigest: attempt.inputDigest,
    createdAt: attempt.createdAt,
    expiresAt: attempt.expiresAt,
  };
}

function chargeQuoteAttemptInputMatches(
  left: CheckoutChargeQuoteAttempt,
  right: CheckoutChargeQuoteAttempt,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.componentKind === right.componentKind &&
    left.merchantId === right.merchantId &&
    left.parentAttemptId === right.parentAttemptId &&
    left.checkoutId === right.checkoutId &&
    left.checkoutRevision === right.checkoutRevision &&
    left.buyerSessionDigest === right.buyerSessionDigest &&
    left.providerAccountReference === right.providerAccountReference &&
    left.inputDigest === right.inputDigest &&
    left.createdAt === right.createdAt &&
    left.expiresAt === right.expiresAt
  );
}

function taxQuotedResultMatchesAttempt(
  result: TaxQuotedResult,
  attempt: VariantBy<CheckoutChargeQuoteAttempt, "componentKind", "tax">,
): boolean {
  return (
    result.inputDigest === attempt.inputDigest &&
    result.expiresAt === attempt.expiresAt &&
    result.quote.providerAccountReference === attempt.providerAccountReference
  );
}

function carrierRateQuotedResultMatchesAttempt(
  result: CarrierRateQuotedResult,
  attempt: VariantBy<
    CheckoutChargeQuoteAttempt,
    "componentKind",
    "carrier_rate"
  >,
): boolean {
  return (
    result.inputDigest === attempt.inputDigest &&
    result.expiresAt === attempt.expiresAt &&
    result.rate.providerAccountReference === attempt.providerAccountReference &&
    validCarrierRateQuotedResult(result)
  );
}

function validCarrierRateQuotedResult(
  result: CarrierRateQuotedResult,
): boolean {
  if (
    result.rate.shippingAmount.currency !== "JPY" ||
    !Number.isSafeInteger(result.rate.shippingAmount.amountMinor) ||
    result.rate.shippingAmount.amountMinor < 0 ||
    result.rate.lineAllocations.length === 0 ||
    result.estimatedDelivery.kind !== "window"
  ) {
    return false;
  }
  const lineIds = new Set<string>();
  let allocatedMinor = 0;
  for (const allocation of result.rate.lineAllocations) {
    if (
      lineIds.has(allocation.checkoutLineId) ||
      allocation.amount.currency !== "JPY" ||
      !Number.isSafeInteger(allocation.amount.amountMinor) ||
      allocation.amount.amountMinor < 0
    ) {
      return false;
    }
    lineIds.add(allocation.checkoutLineId);
    allocatedMinor += allocation.amount.amountMinor;
    if (!Number.isSafeInteger(allocatedMinor)) return false;
  }
  const earliest = Date.parse(result.estimatedDelivery.earliest);
  const latest = Date.parse(result.estimatedDelivery.latest);
  return (
    allocatedMinor === result.rate.shippingAmount.amountMinor &&
    Number.isFinite(earliest) &&
    Number.isFinite(latest) &&
    latest >= earliest
  );
}

function dutyQuotedResultMatchesAttempt(
  result: DutyQuotedResult,
  attempt: VariantBy<CheckoutChargeQuoteAttempt, "componentKind", "duty">,
): boolean {
  return (
    result.inputDigest === attempt.inputDigest &&
    result.expiresAt === attempt.expiresAt &&
    result.quote.providerAccountReference === attempt.providerAccountReference
  );
}

function parseStoredChargeQuoteAttempt(
  value: string,
): CheckoutChargeQuoteAttempt {
  const object = requireRecord(JSON.parse(value), "chargeQuoteAttempt");
  const componentKind = requireComponentKind(object.componentKind);
  const state = requireLifecycleState(object.state);
  const base = parseChargeQuoteAttemptBase(object, componentKind);
  const baseKeys = chargeQuoteAttemptBaseKeys();
  switch (state) {
    case "pending":
      requireExactKeys(object, [...baseKeys, "state"]);
      return parsedPendingAttempt(base, componentKind);
    case "quoted":
      requireExactKeys(object, [...baseKeys, "state", "result"]);
      return parsedQuotedAttempt(base, componentKind, object.result);
    case "unavailable":
      requireExactKeys(object, [...baseKeys, "state", "field"]);
      return parsedUnavailableAttempt(
        base,
        componentKind,
        requireText(object.field, "chargeQuoteAttempt.field"),
      );
    case "indeterminate": {
      requireExactKeys(object, [...baseKeys, "state", "field", "retryAfter"]);
      const field = requireText(object.field, "chargeQuoteAttempt.field");
      const retryAfter = requireTimestamp(
        object.retryAfter,
        "chargeQuoteAttempt.retryAfter",
      );
      if (Date.parse(retryAfter) > Date.parse(base.expiresAt)) {
        throw new Error("Stored charge quote retry exceeds its expiry");
      }
      return parsedIndeterminateAttempt(base, componentKind, field, retryAfter);
    }
  }
}

function parsedPendingAttempt(
  base: ChargeQuoteAttemptBase,
  componentKind: CheckoutChargeQuoteAttempt["componentKind"],
): VariantBy<CheckoutChargeQuoteAttempt, "state", "pending"> {
  switch (componentKind) {
    case "carrier_rate":
      return { ...base, componentKind, state: "pending" };
    case "tax":
      return { ...base, componentKind, state: "pending" };
    case "duty":
      return { ...base, componentKind, state: "pending" };
  }
}

function parsedQuotedAttempt(
  base: ChargeQuoteAttemptBase,
  componentKind: CheckoutChargeQuoteAttempt["componentKind"],
  value: unknown,
): VariantBy<CheckoutChargeQuoteAttempt, "state", "quoted"> {
  switch (componentKind) {
    case "carrier_rate":
      return {
        ...base,
        componentKind,
        state: "quoted",
        result: parseCarrierRateQuotedResult(value, base),
      };
    case "tax":
      return {
        ...base,
        componentKind,
        state: "quoted",
        result: parseTaxQuotedResult(value, base),
      };
    case "duty":
      return {
        ...base,
        componentKind,
        state: "quoted",
        result: parseDutyQuotedResult(value, base),
      };
  }
}

function parsedUnavailableAttempt(
  base: ChargeQuoteAttemptBase,
  componentKind: CheckoutChargeQuoteAttempt["componentKind"],
  field: string,
): VariantBy<CheckoutChargeQuoteAttempt, "state", "unavailable"> {
  switch (componentKind) {
    case "carrier_rate":
      return { ...base, componentKind, state: "unavailable", field };
    case "tax":
      return { ...base, componentKind, state: "unavailable", field };
    case "duty":
      return { ...base, componentKind, state: "unavailable", field };
  }
}

function parsedIndeterminateAttempt(
  base: ChargeQuoteAttemptBase,
  componentKind: CheckoutChargeQuoteAttempt["componentKind"],
  field: string,
  retryAfter: string,
): VariantBy<CheckoutChargeQuoteAttempt, "state", "indeterminate"> {
  switch (componentKind) {
    case "carrier_rate":
      return {
        ...base,
        componentKind,
        state: "indeterminate",
        field,
        retryAfter,
      };
    case "tax":
      return {
        ...base,
        componentKind,
        state: "indeterminate",
        field,
        retryAfter,
      };
    case "duty":
      return {
        ...base,
        componentKind,
        state: "indeterminate",
        field,
        retryAfter,
      };
  }
}

function parseChargeQuoteAttemptBase(
  object: Record<string, unknown>,
  componentKind: CheckoutChargeQuoteAttempt["componentKind"],
): ChargeQuoteAttemptBase {
  return {
    attemptId: requireText(object.attemptId, "chargeQuoteAttempt.attemptId"),
    componentKind,
    merchantId: requireText(object.merchantId, "chargeQuoteAttempt.merchantId"),
    parentAttemptId: requireText(
      object.parentAttemptId,
      "chargeQuoteAttempt.parentAttemptId",
    ),
    checkoutId: requireText(object.checkoutId, "chargeQuoteAttempt.checkoutId"),
    checkoutRevision: requirePositiveInteger(
      object.checkoutRevision,
      "chargeQuoteAttempt.checkoutRevision",
    ),
    buyerSessionDigest: requireDigest(
      object.buyerSessionDigest,
      "chargeQuoteAttempt.buyerSessionDigest",
    ),
    providerAccountReference: requireText(
      object.providerAccountReference,
      "chargeQuoteAttempt.providerAccountReference",
    ),
    inputDigest: requireDigest(
      object.inputDigest,
      "chargeQuoteAttempt.inputDigest",
    ),
    createdAt: requireTimestamp(
      object.createdAt,
      "chargeQuoteAttempt.createdAt",
    ),
    expiresAt: requireTimestamp(
      object.expiresAt,
      "chargeQuoteAttempt.expiresAt",
    ),
  };
}

function parseCarrierRateQuotedResult(
  value: unknown,
  base: ChargeQuoteAttemptBase,
): CarrierRateQuotedResult {
  const object = requireRecord(value, "chargeQuoteAttempt.result");
  requireExactKeys(object, [
    "kind",
    "rate",
    "estimatedDelivery",
    "inputDigest",
    "expiresAt",
  ]);
  if (object.kind !== "quoted") {
    throw new Error("Stored carrier rate quote result kind is invalid");
  }
  const result: CarrierRateQuotedResult = {
    kind: "quoted",
    rate: parseCarrierRateSnapshot(object.rate),
    estimatedDelivery: parseCarrierEstimatedDelivery(object.estimatedDelivery),
    inputDigest: requireDigest(
      object.inputDigest,
      "chargeQuoteAttempt.result.inputDigest",
    ),
    expiresAt: requireTimestamp(
      object.expiresAt,
      "chargeQuoteAttempt.result.expiresAt",
    ),
  };
  if (
    !carrierRateQuotedResultMatchesAttempt(result, {
      ...base,
      componentKind: "carrier_rate",
      state: "pending",
    })
  ) {
    throw new Error("Stored carrier rate quote result identity is invalid");
  }
  return result;
}

function parseCarrierRateSnapshot(value: unknown): CarrierRateSnapshot {
  const object = requireRecord(value, "carrierRate");
  requireExactKeys(object, [
    "providerAccountReference",
    "rateReference",
    "service",
    "shippingAmount",
    "lineAllocations",
  ]);
  const service = requireRecord(object.service, "carrierRate.service");
  requireExactKeys(service, ["code", "name"]);
  const shippingAmount = parseJpyMoney(
    object.shippingAmount,
    "carrierRate.shippingAmount",
  );
  return {
    providerAccountReference: requireText(
      object.providerAccountReference,
      "carrierRate.providerAccountReference",
    ),
    rateReference: requireText(
      object.rateReference,
      "carrierRate.rateReference",
    ),
    service: {
      code: requireText(service.code, "carrierRate.service.code"),
      name: requireText(service.name, "carrierRate.service.name"),
    },
    shippingAmount,
    lineAllocations: parseJpyLineAllocations(
      object.lineAllocations,
      "carrierRate.lineAllocations",
      shippingAmount.amountMinor,
    ),
  };
}

function parseCarrierEstimatedDelivery(
  value: unknown,
): EstimatedDeliverySnapshot {
  const object = requireRecord(value, "carrierRate.estimatedDelivery");
  requireExactKeys(object, ["kind", "earliest", "latest"]);
  if (object.kind !== "window") {
    throw new Error("Stored carrier rate delivery promise is invalid");
  }
  return {
    kind: "window",
    earliest: requireTimestamp(
      object.earliest,
      "carrierRate.estimatedDelivery.earliest",
    ),
    latest: requireTimestamp(
      object.latest,
      "carrierRate.estimatedDelivery.latest",
    ),
  };
}

function parseTaxQuotedResult(
  value: unknown,
  base: ChargeQuoteAttemptBase,
): TaxQuotedResult {
  const object = requireRecord(value, "chargeQuoteAttempt.result");
  requireExactKeys(object, ["kind", "quote", "inputDigest", "expiresAt"]);
  if (object.kind !== "quoted")
    throw new Error("Stored tax quote result kind is invalid");
  const result: TaxQuotedResult = {
    kind: "quoted",
    quote: parseTaxQuoteSnapshot(object.quote),
    inputDigest: requireDigest(
      object.inputDigest,
      "chargeQuoteAttempt.result.inputDigest",
    ),
    expiresAt: requireTimestamp(
      object.expiresAt,
      "chargeQuoteAttempt.result.expiresAt",
    ),
  };
  if (
    !taxQuotedResultMatchesAttempt(result, {
      ...base,
      componentKind: "tax",
      state: "pending",
    })
  ) {
    throw new Error("Stored tax quote result identity is invalid");
  }
  return result;
}

function parseDutyQuotedResult(
  value: unknown,
  base: ChargeQuoteAttemptBase,
): DutyQuotedResult {
  const object = requireRecord(value, "chargeQuoteAttempt.result");
  requireExactKeys(object, ["kind", "quote", "inputDigest", "expiresAt"]);
  if (object.kind !== "quoted")
    throw new Error("Stored duty quote result kind is invalid");
  const result: DutyQuotedResult = {
    kind: "quoted",
    quote: parseDutyQuoteSnapshot(object.quote),
    inputDigest: requireDigest(
      object.inputDigest,
      "chargeQuoteAttempt.result.inputDigest",
    ),
    expiresAt: requireTimestamp(
      object.expiresAt,
      "chargeQuoteAttempt.result.expiresAt",
    ),
  };
  if (
    !dutyQuotedResultMatchesAttempt(result, {
      ...base,
      componentKind: "duty",
      state: "pending",
    })
  ) {
    throw new Error("Stored duty quote result identity is invalid");
  }
  return result;
}

function parseTaxQuoteSnapshot(value: unknown): TaxQuoteSnapshot {
  const object = requireRecord(value, "taxQuote");
  requireExactKeys(object, [
    "providerAccountReference",
    "registrationPolicyReference",
    "quoteReference",
    "taxAmount",
    "lineAllocations",
  ]);
  const taxAmount = parseJpyMoney(object.taxAmount, "taxQuote.taxAmount");
  return {
    providerAccountReference: requireText(
      object.providerAccountReference,
      "taxQuote.providerAccountReference",
    ),
    registrationPolicyReference: requireText(
      object.registrationPolicyReference,
      "taxQuote.registrationPolicyReference",
    ),
    quoteReference: requireText(
      object.quoteReference,
      "taxQuote.quoteReference",
    ),
    taxAmount,
    lineAllocations: parseJpyLineAllocations(
      object.lineAllocations,
      "taxQuote.lineAllocations",
      taxAmount.amountMinor,
    ),
  };
}

function parseDutyQuoteSnapshot(value: unknown): DutyQuoteSnapshot {
  const object = requireRecord(value, "dutyQuote");
  requireExactKeys(object, [
    "providerAccountReference",
    "quoteReference",
    "incoterm",
    "dutyAmount",
    "lineAllocations",
  ]);
  const dutyAmount = parseJpyMoney(object.dutyAmount, "dutyQuote.dutyAmount");
  return {
    providerAccountReference: requireText(
      object.providerAccountReference,
      "dutyQuote.providerAccountReference",
    ),
    quoteReference: requireText(
      object.quoteReference,
      "dutyQuote.quoteReference",
    ),
    incoterm: requireIncoterm(object.incoterm),
    dutyAmount,
    lineAllocations: parseJpyLineAllocations(
      object.lineAllocations,
      "dutyQuote.lineAllocations",
      dutyAmount.amountMinor,
    ),
  };
}

function parseJpyLineAllocations(
  value: unknown,
  field: string,
  expectedTotalMinor: number,
): TaxQuoteSnapshot["lineAllocations"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  const allocations: TaxQuoteSnapshot["lineAllocations"] = [];
  const lineIds = new Set<string>();
  let allocatedMinor = 0;
  for (const raw of value) {
    const object = requireRecord(raw, `${field}[]`);
    requireExactKeys(object, ["checkoutLineId", "amount"]);
    const checkoutLineId = requireText(
      object.checkoutLineId,
      `${field}[].checkoutLineId`,
    );
    const amount = parseJpyMoney(object.amount, `${field}[].amount`);
    if (lineIds.has(checkoutLineId))
      throw new Error(`${field} contains duplicate lines`);
    lineIds.add(checkoutLineId);
    allocatedMinor += amount.amountMinor;
    if (!Number.isSafeInteger(allocatedMinor))
      throw new Error(`${field} total is too large`);
    allocations.push({ checkoutLineId, amount });
  }
  if (allocatedMinor !== expectedTotalMinor) {
    throw new Error(`${field} must sum to the component total`);
  }
  return allocations;
}

function parseJpyMoney(
  value: unknown,
  field: string,
): Readonly<{
  amountMinor: number;
  currency: string;
}> {
  const object = requireRecord(value, field);
  requireExactKeys(object, ["amountMinor", "currency"]);
  if (
    typeof object.amountMinor !== "number" ||
    !Number.isSafeInteger(object.amountMinor) ||
    object.amountMinor < 0 ||
    object.currency !== "JPY"
  ) {
    throw new Error(`${field} must be a non-negative JPY amount`);
  }
  return { amountMinor: object.amountMinor, currency: object.currency };
}

function chargeQuoteAttemptBaseKeys(): readonly string[] {
  return [
    "attemptId",
    "componentKind",
    "merchantId",
    "parentAttemptId",
    "checkoutId",
    "checkoutRevision",
    "buyerSessionDigest",
    "providerAccountReference",
    "inputDigest",
    "createdAt",
    "expiresAt",
  ];
}

function requireComponentKind(
  value: unknown,
): CheckoutChargeQuoteAttempt["componentKind"] {
  if (value === "carrier_rate" || value === "tax" || value === "duty")
    return value;
  throw new Error("Stored charge quote component kind is invalid");
}

function requireLifecycleState(
  value: unknown,
): "pending" | "quoted" | "unavailable" | "indeterminate" {
  if (
    value === "pending" ||
    value === "quoted" ||
    value === "unavailable" ||
    value === "indeterminate"
  )
    return value;
  throw new Error("Stored charge quote lifecycle is invalid");
}

function requireIncoterm(value: unknown): DutyIncoterm {
  if (value === "not_applicable" || value === "ddp" || value === "dap")
    return value;
  throw new Error("Stored duty quote incoterm is invalid");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function requireExactKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
): void {
  if (!hasExactKeys(object, keys))
    throw new Error("Stored charge quote fields are invalid");
}

function requireText(value: unknown, field: string): string {
  if (!isNormalizedText(value)) {
    throw new Error(`${field} must be normalized text`);
  }
  return value;
}

function requireDigest(value: unknown, field: string): string {
  const digest = requireText(value, field);
  if (!/^[0-9a-f]{64}$/u.test(digest))
    throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const timestamp = requireText(value, field);
  if (!Number.isFinite(Date.parse(timestamp)))
    throw new Error(`${field} must be a timestamp`);
  return timestamp;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
