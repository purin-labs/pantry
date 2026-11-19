import { createOrganisationExecutionFixture } from "./organisation-execution-fixture";
import { createMigratedDatabase } from "./sqlite-d1";
import { TEST_ORGANISATION_PLACEMENT_PROFILE } from "./fixtures/organisation-placement";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({ createCommerceClient: vi.fn() }));
const bindingMocks = vi.hoisted(() => ({
  resolveOrganisationCommerceMerchantBinding: vi.fn(),
}));
const organisationMocks = vi.hoisted(() => ({ readOrganisationEnvironment: vi.fn() }));
vi.mock("../src/commerce/outbox-worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/commerce/outbox-worker")>()),
  createCommerceClient: clientMocks.createCommerceClient,
}));
vi.mock("../src/data/commerce-merchant-binding", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/data/commerce-merchant-binding")
  >()),
  resolveOrganisationCommerceMerchantBinding:
    bindingMocks.resolveOrganisationCommerceMerchantBinding,
}));
vi.mock("../src/control/organisation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/control/organisation-runtime")>()),
  readOrganisationEnvironment: organisationMocks.readOrganisationEnvironment,
}));

import {
  applyOfferPriceAllowance,
  offerPriceAllowanceAlreadyApplied,
} from "../src/data/offer-price-allowance";
import { requireOrganisationId } from "./test-ids";

const ORGANISATION = requireOrganisationId("organisation_allowance");
const OFFER = "underclerk:merchant_cafe:offer_coffee";
let ENV: UnitTestEnv;

describe("the price allowance boundary", () => {
  beforeEach(async () => {
    const db = createMigratedDatabase();
    await createOrganisationExecutionFixture(db, ORGANISATION);
    ENV = platformEnv({ DB: db, PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE });
    vi.clearAllMocks();
    organisationMocks.readOrganisationEnvironment.mockResolvedValue("development");
    bindingMocks.resolveOrganisationCommerceMerchantBinding.mockResolvedValue({
      ok: true,
      value: { merchantId: "merchant_cafe" },
    });
  });

  it("refuses to set a band around a price the owner never saw", async () => {
    const client = commerceEngine({ currentOfferRevision: 5 });
    const result = await applyOfferPriceAllowance(
      ENV,
      ORGANISATION,
      {
        kind: "set_offer_price_allowance",
        offerId: OFFER,
        expectedRevision: 2,
        maxMovementBps: 500,
        expectedOfferRevision: 4,
      },
      1_000,
    );
    // The preview named revision 4's price; the Offer is at 5 now. Writing
    // anyway would measure the band from a price nobody approved.
    expect(result).toEqual({
      ok: false,
      error: { code: "offer_price_allowance_price_moved" },
    });
    expect(client.setOfferPricePolicy).not.toHaveBeenCalled();
  });

  it("sets the band when the price is the one that was shown", async () => {
    const client = commerceEngine({ currentOfferRevision: 4 });
    const result = await applyOfferPriceAllowance(
      ENV,
      ORGANISATION,
      {
        kind: "set_offer_price_allowance",
        offerId: OFFER,
        expectedRevision: 2,
        maxMovementBps: 500,
        expectedOfferRevision: 4,
      },
      1_000,
    );
    expect(result.ok).toBe(true);
    expect(client.setOfferPricePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: "merchant_cafe",
        offerId: "offer_coffee",
        expectedRevision: 2,
        maxMovementBps: 500,
      }),
    );
  });

  it("knows its own earlier write from the revision and value it left behind", async () => {
    // A confirmation interrupted after the write but before its record must
    // not re-drive. The policy carries revision and value, so the question
    // "did mine land" has an exact answer: the revision after the one I named,
    // holding the value I asked for.
    commerceEngine({
      currentOfferRevision: 4,
      policy: { kind: "enabled", revision: 3, maxMovementBps: 500 },
    });
    const mine = {
      kind: "set_offer_price_allowance" as const,
      offerId: OFFER,
      expectedRevision: 2,
      maxMovementBps: 500,
    };
    expect(await offerPriceAllowanceAlreadyApplied(ENV, ORGANISATION, mine)).toBe(
      true,
    );
    expect(
      await offerPriceAllowanceAlreadyApplied(ENV, ORGANISATION, {
        ...mine,
        maxMovementBps: 700,
      }),
    ).toBe(false);
    expect(
      await offerPriceAllowanceAlreadyApplied(ENV, ORGANISATION, {
        ...mine,
        expectedRevision: 1,
      }),
    ).toBe(false);
  });
});

function commerceEngine(
  view: Readonly<{
    currentOfferRevision: number;
    policy?: Readonly<{
      kind: string;
      revision: number;
      maxMovementBps?: number;
    }>;
  }>,
) {
  const client = {
    readOfferPricePolicy: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        outcome: "accepted",
        value: {
          policy: view.policy ?? {
            kind: "enabled",
            revision: 2,
            maxMovementBps: 300,
          },
          allowedRange: null,
          currentOfferRevision: view.currentOfferRevision,
          currentPriceMinor: 1_000,
          currency: "JPY",
        },
      },
    }),
    setOfferPricePolicy: vi.fn().mockResolvedValue({
      ok: true,
      value: { outcome: "accepted", value: {} },
    }),
    disableOfferPricePolicy: vi.fn(),
  };
  clientMocks.createCommerceClient.mockReturnValue(client);
  return client;
}
