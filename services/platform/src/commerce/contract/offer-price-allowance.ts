import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import { createCommerceClient } from "./client";
import { readOrganisationEnvironment } from "../../control/organisation-runtime";
import { resolveOrganisationCommerceMerchantBinding } from "../../data/commerce-merchant-binding";
import { commerceProviderResourceId } from "./resource-ids";

/**
 * One change to how far an Offer's price may move without a fresh decision.
 *
 * The allowance is commerce state, so it keeps its own typed boundary rather
 * than becoming an arm of the agent configuration union: it is stored per
 * Offer in Commerce with a reference price captured at a named Offer
 * revision, and it binds every change to that Offer's price, not only an
 * agent's.
 */
export type OfferPriceAllowanceCommand =
  | Readonly<{
      kind: "set_offer_price_allowance";
      /** The canonical id, as every Portal commerce address names a record. */
      offerId: string;
      /** Null when no allowance exists yet. */
      expectedRevision: number | null;
      maxMovementBps: number;
      /**
       * The Offer revision whose price the operator was shown. When present,
       * applying refuses if the Offer has moved since, so the band is never
       * measured from a price nobody approved. Absent only for a caller with
       * no way to have seen a price.
       */
      expectedOfferRevision?: number;
      /** The price shown alongside it, carried so a preview can name it. */
      referencePriceMinor?: number;
      currency?: string;
    }>
  | Readonly<{
      kind: "withdraw_offer_price_allowance";
      offerId: string;
      expectedRevision: number;
    }>;

export type OfferPriceAllowanceError = Readonly<{
  code:
    | "offer_price_allowance_invalid"
    | "offer_price_allowance_stale"
    /** The Offer's price moved after the operator was shown it. */
    | "offer_price_allowance_price_moved"
    | "offer_price_allowance_unavailable";
}>;

/** Ten thousand basis points is the whole price; a wider band is not a band. */
const MAX_MOVEMENT_BPS = 10_000;

export function parseOfferPriceAllowanceCommand(
  raw: unknown,
): Result<OfferPriceAllowanceCommand, OfferPriceAllowanceError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return invalid();
  const body = raw as Readonly<Record<string, unknown>>;
  const offerId = body.offerId;
  if (typeof offerId !== "string" || offerId.length === 0) return invalid();
  if (body.kind === "withdraw_offer_price_allowance") {
    return positiveInteger(body.expectedRevision)
      ? {
          ok: true,
          value: {
            kind: "withdraw_offer_price_allowance",
            offerId,
            expectedRevision: body.expectedRevision as number,
          },
        }
      : invalid();
  }
  if (body.kind !== "set_offer_price_allowance") return invalid();
  const maxMovementBps = body.maxMovementBps;
  if (
    !positiveInteger(maxMovementBps) ||
    (maxMovementBps as number) > MAX_MOVEMENT_BPS
  ) {
    return invalid();
  }
  const expectedRevision = body.expectedRevision ?? null;
  if (expectedRevision !== null && !positiveInteger(expectedRevision))
    return invalid();
  const reference = parseReference(body);
  if (!reference.ok) return invalid();
  return {
    ok: true,
    value: {
      kind: "set_offer_price_allowance",
      offerId,
      expectedRevision: expectedRevision as number | null,
      maxMovementBps: maxMovementBps as number,
      ...reference.value,
    },
  };
}

type AllowanceContext = Readonly<{
  client: NonNullable<ReturnType<typeof createCommerceClient>>;
  merchantId: string;
  offerId: string;
}>;

/**
 * Carries out one allowance change, for whichever surface asked.
 *
 * The Portal route and a confirmed Slack draft both call this, so the two
 * surfaces cannot apply an allowance differently.
 */
export async function applyOfferPriceAllowance(
  env: Env,
  organisationId: OrganisationId,
  command: OfferPriceAllowanceCommand,
  now: number,
): Promise<Result<unknown, OfferPriceAllowanceError>> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok) return unavailable();
  const context = await resolveAllowanceContext(
    execution.value.database,
    createCommerceClient(env, undefined, {
      kind: "organisation",
      organisationId: String(organisationId),
    }),
    organisationId,
    command.offerId,
  );
  if (!context.ok) return context;
  if (
    command.kind === "set_offer_price_allowance" &&
    command.expectedOfferRevision !== undefined
  ) {
    const view = await readViewIn(context.value);
    if (view === null) return unavailable();
    if (view.currentOfferRevision !== command.expectedOfferRevision) {
      return {
        ok: false,
        error: { code: "offer_price_allowance_price_moved" },
      };
    }
  }
  const occurredAt = new Date(now).toISOString();
  const result =
    command.kind === "withdraw_offer_price_allowance"
      ? await context.value.client.disableOfferPricePolicy({
          merchantId: context.value.merchantId,
          offerId: context.value.offerId,
          expectedRevision: command.expectedRevision,
          occurredAt,
        })
      : await context.value.client.setOfferPricePolicy({
          merchantId: context.value.merchantId,
          offerId: context.value.offerId,
          expectedRevision: command.expectedRevision,
          maxMovementBps: command.maxMovementBps,
          occurredAt,
        });
  if (!result.ok)
    return { ok: false, error: { code: "offer_price_allowance_unavailable" } };
  if (result.value.outcome === "rejected") {
    return {
      ok: false,
      error: {
        code:
          result.value.refusal.code === "offer_price_policy_stale"
            ? "offer_price_allowance_stale"
            : "offer_price_allowance_invalid",
      },
    };
  }
  return { ok: true, value: result.value.value };
}

/**
 * Whether the allowance already stands as this command asks.
 *
 * A confirmation interrupted after the write but before its record must not
 * re-drive: the retry would bind a revision its own first attempt advanced and
 * report a stale conflict for a change that landed. Commerce's policy
 * commands carry no idempotency key, so recovery reads the current allowance
 * and compares it instead — which the policy's own revision and value make
 * exact.
 */
export async function offerPriceAllowanceAlreadyApplied(
  env: Env,
  organisationId: OrganisationId,
  command: OfferPriceAllowanceCommand,
): Promise<boolean> {
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok) return false;
  const context = await resolveAllowanceContext(
    execution.value.database,
    createCommerceClient(env, undefined, {
      kind: "organisation",
      organisationId: String(organisationId),
    }),
    organisationId,
    command.offerId,
  );
  if (!context.ok) return false;
  const view = await readViewIn(context.value);
  if (view === null) return false;
  const policy = view.policy;
  // The command named the revision it expected to replace, so the write it
  // asked for lands at exactly one revision higher.
  const expected = (command.expectedRevision ?? 0) + 1;
  if (policy.revision !== expected) return false;
  return command.kind === "withdraw_offer_price_allowance"
    ? policy.kind === "disabled"
    : policy.kind === "enabled" &&
        policy.maxMovementBps === command.maxMovementBps;
}

async function resolveAllowanceContext(
  db: OrganisationDatabase,
  client: AllowanceContext["client"] | null,
  organisationId: OrganisationId,
  canonicalOfferId: string,
): Promise<Result<AllowanceContext, OfferPriceAllowanceError>> {
  const environment = await readOrganisationEnvironment(db, organisationId);
  if (environment === null) return unavailable();
  const binding = await resolveOrganisationCommerceMerchantBinding({
    db,
    organisationId,
    environment,
  });
  if (!binding.ok) return unavailable();
  if (client === null) return unavailable();
  const offerId = commerceProviderResourceId(
    binding.value.merchantId,
    canonicalOfferId,
  );
  if (offerId === null) return invalid();
  return {
    ok: true,
    value: { client, merchantId: binding.value.merchantId, offerId },
  };
}

/** What one Offer's allowance currently is, beside the price it governs. */
type OfferPriceAllowanceState = Readonly<{
  policy: Readonly<{ kind: string; revision: number; maxMovementBps?: number }>;
  /** The prices that the allowance permits now, or null without one. */
  allowedRange: Readonly<{ minimumMinor: number; maximumMinor: number }> | null;
  currentOfferRevision: number;
  currentPriceMinor: number;
  currency: string;
}>;

/** Reads the current allowance for one canonical Offer id, or null. */
export async function readOfferPriceAllowanceView(
  env: Env,
  scope: OrganisationExecutionScope,
  authorizeRead: () => Promise<void>,
  fetcher: typeof fetch,
  canonicalOfferId: string,
): Promise<OfferPriceAllowanceState | null> {
  await authorizeRead();
  const context = await resolveAllowanceContext(
    scope.database,
    createCommerceClient(env, fetcher, {
      kind: "organisation",
      organisationId: String(scope.organisationId),
    }),
    scope.organisationId,
    canonicalOfferId,
  );
  await authorizeRead();
  const view = context.ok ? await readViewIn(context.value) : null;
  await authorizeRead();
  return view;
}

async function readViewIn(
  context: AllowanceContext,
): Promise<OfferPriceAllowanceState | null> {
  const current = await context.client.readOfferPricePolicy(
    context.merchantId,
    context.offerId,
  );
  if (!current.ok || current.value.outcome !== "accepted") return null;
  const value = current.value.value;
  if (typeof value !== "object" || value === null) return null;
  const view = value as Readonly<Record<string, unknown>>;
  const policy = view.policy;
  if (typeof policy !== "object" || policy === null) return null;
  const record = policy as Readonly<Record<string, unknown>>;
  if (
    typeof record.kind !== "string" ||
    typeof record.revision !== "number" ||
    typeof view.currentOfferRevision !== "number" ||
    typeof view.currentPriceMinor !== "number" ||
    typeof view.currency !== "string"
  ) {
    return null;
  }
  return {
    policy: {
      kind: record.kind,
      revision: record.revision,
      ...(typeof record.maxMovementBps === "number"
        ? { maxMovementBps: record.maxMovementBps }
        : {}),
    },
    allowedRange: parseAllowedRange(view.allowedRange),
    currentOfferRevision: view.currentOfferRevision,
    currentPriceMinor: view.currentPriceMinor,
    currency: view.currency,
  };
}

function parseAllowedRange(
  value: unknown,
): OfferPriceAllowanceState["allowedRange"] {
  if (typeof value !== "object" || value === null) return null;
  const range = value as Readonly<Record<string, unknown>>;
  return typeof range.minimumMinor === "number" &&
    typeof range.maximumMinor === "number"
    ? { minimumMinor: range.minimumMinor, maximumMinor: range.maximumMinor }
    : null;
}

function parseReference(body: Readonly<Record<string, unknown>>): Result<
  Readonly<{
    expectedOfferRevision?: number;
    referencePriceMinor?: number;
    currency?: string;
  }>,
  OfferPriceAllowanceError
> {
  const out: {
    expectedOfferRevision?: number;
    referencePriceMinor?: number;
    currency?: string;
  } = {};
  if (body.expectedOfferRevision !== undefined) {
    if (!positiveInteger(body.expectedOfferRevision)) return invalid();
    out.expectedOfferRevision = body.expectedOfferRevision as number;
  }
  if (body.referencePriceMinor !== undefined) {
    if (!positiveInteger(body.referencePriceMinor)) return invalid();
    out.referencePriceMinor = body.referencePriceMinor as number;
  }
  if (body.currency !== undefined) {
    if (typeof body.currency !== "string" || !/^[A-Z]{3}$/u.test(body.currency))
      return invalid();
    out.currency = body.currency;
  }
  return { ok: true, value: out };
}

function positiveInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalid(): Result<never, OfferPriceAllowanceError> {
  return { ok: false, error: { code: "offer_price_allowance_invalid" } };
}

function unavailable(): Result<never, OfferPriceAllowanceError> {
  return { ok: false, error: { code: "offer_price_allowance_unavailable" } };
}
