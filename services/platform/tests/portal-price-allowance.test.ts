/// <reference types="@cloudflare/workers-types" />

// The portal owns its browser-only React runtime; the platform test harness renders it through the app-local package.
// @ts-expect-error React runtime declarations are scoped to apps/portal.
import React from "../../../apps/portal/node_modules/react";
// @ts-expect-error React DOM runtime declarations are scoped to apps/portal.
import { renderToStaticMarkup } from "../../../apps/portal/node_modules/react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  OfferPriceAllowanceControl,
  mergeRefreshedView,
  offerPriceAllowanceTransport,
  submitAllowance,
  withdrawAllowance,
  allowanceSummary,
  // @ts-expect-error The portal build checks this JSX module with its app-local configuration.
} from "../../../apps/portal/src/features/commerce/price-allowance";
import {
  parseOfferPriceAllowanceView,
  parsePricedOffers,
  type OfferPriceAllowanceView,
  type PricedOffer,
} from "@seams/control-api/portal/price-allowance";

const ORGANISATION = "organisation_price_allowance";

const OFFER: PricedOffer = {
  offerId: "underclerk:merchant_cafe:offer_coffee",
  variantId: "underclerk:merchant_cafe:variant_coffee",
  salesChannelId: "underclerk:merchant_cafe:channel_online",
  revision: 4,
  priceMinor: 1_000,
  currency: "JPY",
};

describe("Offer price allowance control", () => {
  it("tells a reviewer the band a proposed change is judged against", () => {
    const markup = renderToStaticMarkup(
      React.createElement(OfferPriceAllowanceControl, {
        organisationId: ORGANISATION,
        offer: OFFER,
        view: enabledView(),
        canConfigure: false,
        transport: undefined,
        busy: false,
      }),
    );

    expect(markup).toContain("950");
    expect(markup).toContain("1,050");
    // A reviewer gets the numbers and no way to change them.
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("Save allowance");
  });

  it("does not offer withdrawal when there is no allowance to withdraw", () => {
    const markup = renderToStaticMarkup(
      React.createElement(OfferPriceAllowanceControl, {
        organisationId: ORGANISATION,
        offer: OFFER,
        view: disabledView(),
        canConfigure: true,
        transport: { save: vi.fn(), withdraw: vi.fn() },
        busy: false,
      }),
    );

    expect(markup).toContain("Save allowance");
    expect(markup).not.toContain("Withdraw allowance");
    expect(markup).toContain("cannot be changed automatically");
  });

  it("measures the band from the approved reference, not today's price", () => {
    // The whole point of the fixed reference: repeated small changes must not
    // walk the price away from what the owner approved.
    const moved: OfferPriceAllowanceView = {
      ...enabledView(),
      currentPriceMinor: 960,
    };
    const summary = allowanceSummary(moved);
    expect(summary).toContain("960");
    expect(summary).toContain("measured from");
    expect(summary).toContain("1,000");
    expect(summary).toContain("950");
  });

  it("reads the priced-offer list the route serves", () => {
    expect(
      parsePricedOffers({
        ok: true,
        offers: [
          {
            offerId: OFFER.offerId,
            variantId: OFFER.variantId,
            salesChannelId: OFFER.salesChannelId,
            revision: 4,
            priceMinor: 1_000,
            currency: "JPY",
          },
        ],
      }),
    ).toEqual([OFFER]);
  });

  it("refuses an allowance view that names no policy", () => {
    expect(() =>
      parseOfferPriceAllowanceView({ ok: true, pricePolicy: {} }),
    ).toThrow("Offer price allowance response is invalid.");
  });

  it("carries an idempotency key derived from what the write changes", async () => {
    const calls: Array<
      Readonly<{ url: string; init: RequestInit | undefined }>
    > = [];
    const transport = offerPriceAllowanceTransport(
      "csrf-token",
      async (url: string, init: RequestInit | undefined) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, pricePolicy: {} }), {
          status: 200,
        });
      },
    );

    await transport.save("organisation_x", "offer_1", {
      expectedRevision: 2,
      maxMovementBps: 500,
    });
    await transport.withdraw("organisation_x", "offer_1", 2);

    // Without a key the route refuses the retry as stale for a change its own
    // first attempt landed.
    const keys = calls.map((call) =>
      new Headers(call.init?.headers).get("idempotency-key"),
    );
    expect(keys).toEqual([
      "allowance:offer_1:2:500",
      "allowance:offer_1:2:withdraw",
    ]);
    expect(calls.map((call) => call.init?.method)).toEqual(["PUT", "DELETE"]);
  });

  it("explains a refused write in words an operator can act on", async () => {
    const transport = offerPriceAllowanceTransport(
      "csrf-token",
      async () =>
        new Response(
          JSON.stringify({ ok: false, error: "offer_price_policy_stale" }),
          { status: 409 },
        ),
    );

    await expect(
      transport.withdraw("organisation_x", "offer_1", 2),
    ).rejects.toThrow("Someone changed this allowance first.");
  });

  it("binds a save to the revision and price the form showed", async () => {
    const save = vi.fn().mockResolvedValue({});
    const states: unknown[] = [];
    await submitAllowance({
      transport: { save, withdraw: vi.fn() },
      organisationId: ORGANISATION,
      offerId: OFFER.offerId,
      view: enabledView(),
      movement: 600,
      setState: (s: unknown) => states.push(s),
      onApplied: undefined,
    });
    expect(save).toHaveBeenCalledWith(ORGANISATION, OFFER.offerId, {
      expectedRevision: 2,
      maxMovementBps: 600,
      expectedOfferRevision: 4,
    });
    expect(states).toEqual([{ kind: "saving" }, { kind: "saved" }]);
  });

  it("tells the view's owner to re-read only after a write has landed", async () => {
    const onApplied = vi.fn();
    await submitAllowance({
      transport: { save: vi.fn().mockResolvedValue({}), withdraw: vi.fn() },
      organisationId: ORGANISATION,
      offerId: OFFER.offerId,
      view: enabledView(),
      movement: 600,
      setState: () => undefined,
      onApplied,
    });
    expect(onApplied).toHaveBeenCalledTimes(1);

    // A refused write changed nothing; re-reading would only find the same
    // revision, and the form must keep showing why it was refused.
    const failed = vi.fn();
    const states: unknown[] = [];
    await withdrawAllowance({
      transport: {
        save: vi.fn(),
        withdraw: vi
          .fn()
          .mockRejectedValue(
            new Error("Someone changed this allowance first."),
          ),
      },
      organisationId: ORGANISATION,
      offerId: OFFER.offerId,
      view: enabledView(),
      setState: (s: unknown) => states.push(s),
      onApplied: failed,
    });
    expect(failed).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({
      kind: "failed",
      message: "Someone changed this allowance first.",
    });
  });

  it("refuses an out-of-range band before touching the transport", async () => {
    const save = vi.fn();
    const states: unknown[] = [];
    await submitAllowance({
      transport: { save, withdraw: vi.fn() },
      organisationId: ORGANISATION,
      offerId: OFFER.offerId,
      view: enabledView(),
      movement: 10_001,
      setState: (s: unknown) => states.push(s),
      onApplied: vi.fn(),
    });
    expect(save).not.toHaveBeenCalled();
    expect(states).toEqual([
      {
        kind: "failed",
        message: "Enter an allowance between 1 and 10000 basis points.",
      },
    ]);
  });

  it("replaces one offer's view after a write and leaves the others alone", () => {
    const other = { ...OFFER, offerId: "underclerk:merchant_cafe:offer_tea" };
    const ready = {
      kind: "ready" as const,
      offers: [OFFER, other],
      views: {
        [OFFER.offerId]: enabledView(),
        [other.offerId]: disabledView(),
      },
    };
    const fresh = enabledView({ revision: 3, maxMovementBps: 600 });
    const merged = mergeRefreshedView(ready, OFFER.offerId, fresh);
    if (merged.kind !== "ready") throw new Error("expected ready");
    // The next save now binds revision 3, not the 2 the form was born with.
    expect(merged.views[OFFER.offerId]?.policy.revision).toBe(3);
    expect(merged.views[other.offerId]).toEqual(disabledView());
    expect(
      mergeRefreshedView({ kind: "loading" }, OFFER.offerId, fresh),
    ).toEqual({ kind: "loading" });
  });

  it("reads an enabled allowance and its range", () => {
    expect(
      parseOfferPriceAllowanceView({
        ok: true,
        pricePolicy: {
          policy: {
            kind: "enabled",
            revision: 2,
            referenceOfferRevision: 4,
            referencePriceMinor: 1_000,
            currency: "JPY",
            maxMovementBps: 500,
          },
          allowedRange: { minimumMinor: 950, maximumMinor: 1_050 },
          currentPriceMinor: 1_000,
          currentOfferRevision: 4,
          currency: "JPY",
        },
      }),
    ).toEqual(enabledView());
  });
});

function enabledView(
  policy: Readonly<{ revision?: number; maxMovementBps?: number }> = {},
): OfferPriceAllowanceView {
  return {
    policy: {
      kind: "enabled",
      revision: policy.revision ?? 2,
      referenceOfferRevision: 4,
      referencePriceMinor: 1_000,
      currency: "JPY",
      maxMovementBps: policy.maxMovementBps ?? 500,
    },
    allowedRange: { minimumMinor: 950, maximumMinor: 1_050 },
    currentPriceMinor: 1_000,
    currentOfferRevision: 4,
    currency: "JPY",
  };
}

function disabledView(): OfferPriceAllowanceView {
  return {
    policy: { kind: "disabled", revision: 0 },
    allowedRange: null,
    currentPriceMinor: 1_000,
    currentOfferRevision: 4,
    currency: "JPY",
  };
}
