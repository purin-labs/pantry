import { isRecord } from "@purin-labs/std";
import {
  type OfferPriceAllowanceView,
  type PricedOffer,
  parseOfferPriceAllowanceView,
  parsePricedOffers,
} from "@purin-labs/control-api/portal/price-allowance";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type OfferPriceAllowanceTransport = Readonly<{
  save: (
    organisationId: string,
    offerId: string,
    body: Readonly<{
      expectedRevision: number | null;
      maxMovementBps: number;
      expectedOfferRevision?: number;
    }>,
  ) => Promise<unknown>;
  withdraw: (
    organisationId: string,
    offerId: string,
    expectedRevision: number,
  ) => Promise<unknown>;
}>;

/** How the commerce page reads and writes the price allowances of its offers. */
export type OfferPriceAllowanceInteraction = Readonly<{
  canConfigure: boolean;
  transport: OfferPriceAllowanceTransport | undefined;
  fetcher?: Fetcher;
}>;

const BASE = (organisationId: string) =>
  `/v1/control/organisations/${encodeURIComponent(organisationId)}`;

export async function readPricedOffers(
  organisationId: string,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): Promise<readonly PricedOffer[]> {
  const response = await fetcher(
    `${BASE(organisationId)}/commerce/priced-offers`,
    {
      method: "GET",
      headers: { accept: "application/json" },
    },
  );
  return parsePricedOffers(await response.json());
}

export async function readOfferPriceAllowance(
  organisationId: string,
  offerId: string,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): Promise<OfferPriceAllowanceView> {
  const response = await fetcher(
    `${BASE(organisationId)}/commerce/offers/${encodeURIComponent(offerId)}/price-policy`,
    { method: "GET", headers: { accept: "application/json" } },
  );
  return parseOfferPriceAllowanceView(await response.json());
}

/**
 * The allowance transport, over the same route the Portal reads.
 *
 * Every write carries an idempotency key derived from what it is changing, so
 * a retried save reports what it did instead of re-driving into a refusal
 * about a revision its own first attempt advanced.
 */
export function offerPriceAllowanceTransport(
  csrfToken: string,
  fetcher: Fetcher = globalThis.fetch.bind(globalThis),
): OfferPriceAllowanceTransport {
  const write = async (
    organisationId: string,
    offerId: string,
    method: "PUT" | "DELETE",
    body: Readonly<Record<string, unknown>>,
    key: string,
  ): Promise<unknown> => {
    const response = await fetcher(
      `${BASE(organisationId)}/commerce/offers/${encodeURIComponent(offerId)}/price-policy`,
      {
        method,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-pantry-csrf": csrfToken,
          "idempotency-key": key,
        },
        body: JSON.stringify(body),
      },
    );
    const parsed: unknown = await response.json();
    if (!response.ok) throw new Error(allowanceRouteMessage(parsed));
    return parsed;
  };
  return {
    save: (organisationId, offerId, body) =>
      write(
        organisationId,
        offerId,
        "PUT",
        body,
        `allowance:${offerId}:${body.expectedRevision ?? "new"}:${body.maxMovementBps}`,
      ),
    withdraw: (organisationId, offerId, expectedRevision) =>
      write(
        organisationId,
        offerId,
        "DELETE",
        { expectedRevision },
        `allowance:${offerId}:${expectedRevision}:withdraw`,
      ),
  };
}

/** Says what the route refused, in words an operator can act on. */
function allowanceRouteMessage(body: unknown): string {
  const code =
    isRecord(body) && typeof body.error === "string"
      ? body.error
      : isRecord(body) && typeof body.code === "string"
        ? body.code
        : null;
  switch (code) {
    case "offer_price_policy_stale":
      return "Someone changed this allowance first. Reload and try again.";
    case "offer_price_moved":
      return "The price changed after this page loaded. Reload to see the new price, then set the allowance against it.";
    case "offer_price_policy_invalid":
      return "That allowance is not a value this offer can take.";
    case "offer_not_listed":
      return "This offer is not listed, so it has no price to govern.";
    case "commerce_binding_missing":
    case "commerce_unavailable":
      return "Commerce is unavailable right now.";
    case null:
      return "The allowance could not be saved.";
    default:
      return `The allowance could not be saved (${code}).`;
  }
}
