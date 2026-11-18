// Plan 76 phase 7 exit journey: a flash sale on one merchant, in workerd. The
// café has 40 tins of tea; more buyers than tins arrive at once, each wants
// one tin, and other buyers keep reading the catalog during the sale. Every
// tin is sold once. Every other buyer is refused: at the cart once the tea
// shows as sold out, or at checkout when another buyer took the last tin
// first. No stock goes negative, and the catalog reads stay fast: the Worker
// serves them from a snapshot that lags the stock by at most a few seconds,
// and a token that the snapshot cannot confirm is still refused. Set
// FLASH_SALE_BUYERS to change the crowd, and FLASH_SALE_ARTIFACT_DIR to keep
// the measurements (they vary from run to run; the outcomes do not).
// Plan 77 step 4: the sale runs a second time with a merchant plugin that
// checks every checkout. The outcomes stay the same, and a cart that breaks
// the plugin's rule is refused.
import { performance } from "node:perf_hooks";

import type { CommerceAdminClient } from "@seams/commerce-client";
import type { PluginDefinition } from "@seams/commerce-contracts";
import { expect, it } from "vitest";

import {
  Buyer,
  STOREFRONT,
  StaffDesk,
  catalogLine,
  merchantId,
  required,
  writeEvidence,
} from "./journey-support.ts";
import { CATALOG_SNAPSHOT_SECONDS } from "../src/catalog-snapshots.ts";
import { startWorkerdBackend } from "./workerd-backend.ts";

const BUYERS = Number(process.env.FLASH_SALE_BUYERS ?? 100);
const READERS = 10;
const TIN = "position_tea_tin_cafe";
const SENCHA = "variant_tea_small_sencha";

it(
  "sells a limited item to a crowd once each, and keeps catalog reads fast",
  { timeout: 600_000 },
  () => flashSale(false),
);

it(
  "keeps the same outcomes with a merchant plugin that checks every checkout",
  { timeout: 600_000 },
  () => flashSale(true),
);

async function flashSale(plugin: boolean) {
  {
    const backend = await startWorkerdBackend();
    let selling = true;
    try {
      await new StaffDesk(backend.admin, "flash").createTea();
      if (plugin) {
        await new PluginDesk(backend.admin).install();
        const greedy = await Buyer.start(backend.buyer, "flash_greedy");
        expect(
          await greedy.tryQuote([{ ...catalogLine(SENCHA), quantity: 3 }]),
        ).toMatchObject({
          kind: "refused",
          error: { code: "checkout_refused", pluginId: "tin_limit" },
        });
      }
      const before = await tins(backend.admin);
      expect(before.available).toBeLessThan(BUYERS);

      // Readers load the catalog again and again while the sale runs.
      const reads: number[] = [];
      const readers = Array.from({ length: READERS }, async (_, index) => {
        const reader = await Buyer.start(
          backend.buyer,
          `flash_reader_${index}`,
        );
        while (selling) {
          const started = performance.now();
          await required(
            backend.buyer.readCatalog(merchantId, STOREFRONT, reader.token),
          );
          reads.push(performance.now() - started);
        }
      });

      await backend.takeRequestCounts();
      const saleStarted = performance.now();
      const outcomes = await Promise.all(
        Array.from({ length: BUYERS }, async (_, index) => {
          const started = performance.now();
          const buyer = await Buyer.start(
            backend.buyer,
            `flash_buyer_${index}`,
          );
          const quoted = await buyer.tryQuote([catalogLine(SENCHA)]);
          if (quoted.kind === "refused")
            return {
              outcome:
                quoted.error?.code === "resource_relationship_invalid" &&
                quoted.error.field === "cart.lines.catalog"
                  ? "sold_out_at_cart"
                  : (quoted.error?.code ?? "refused"),
              ms: performance.now() - started,
            };
          await buyer.pay(quoted.checkout);
          return {
            outcome: "placed",
            ms: performance.now() - started,
          };
        }),
      );
      const saleMs = performance.now() - saleStarted;
      selling = false;
      await Promise.all(readers);
      const reachedObject = await backend.takeRequestCounts();

      const placed = outcomes.filter((item) => item.outcome === "placed");
      const refused = outcomes.filter((item) => item.outcome !== "placed");
      const after = await tins(backend.admin);
      const orders = (await required(backend.admin.readSnapshot(merchantId)))
        .resources.orders;
      expect(placed).toHaveLength(before.available);
      for (const item of refused)
        expect(["sold_out_at_cart", "insufficient_inventory"]).toContain(
          item.outcome,
        );
      expect(after).toEqual({
        onHand: before.onHand,
        allocated: before.available,
        available: 0,
      });
      expect(orders).toHaveLength(before.available);
      // The Worker answered the catalog reads and issued the guest sessions:
      // none reached the merchant object. When a snapshot expires, each reader
      // that has a read in flight asks the object for a new one, so a slow sale
      // sees all the readers again at each expiry. A cache that does not hold
      // the snapshot also sends each buyer's session here, above this limit.
      expect(reachedObject.read_buyer_catalog ?? 0).toBe(0);
      expect(reachedObject.create_buyer_session ?? 0).toBe(0);
      expect(reachedObject.read_catalog_snapshot ?? 0).toBeLessThanOrEqual(
        READERS * (Math.ceil(saleMs / 1_000 / CATALOG_SNAPSHOT_SECONDS) + 1),
      );

      // A forged session is refused; once the snapshot has turned over, a
      // new buyer sees the tea as sold out.
      const forged = await backend.fetch(
        `https://underclerk.test/v1/public/merchants/${merchantId}/storefronts/${STOREFRONT}/catalog`,
        { headers: { authorization: "Bearer ucbs.forged.token" } },
      );
      expect(forged.status).toBe(401);
      await new Promise((resolve) =>
        setTimeout(resolve, (CATALOG_SNAPSHOT_SECONDS + 1) * 1_000),
      );
      const late = await Buyer.start(backend.buyer, "flash_late");
      const catalog = await required(
        backend.buyer.readCatalog(merchantId, STOREFRONT, late.token),
      );
      expect(
        catalog.listings.find(
          (listing) => listing.variantId === "variant_tea_small_sencha",
        )?.availability,
      ).toBe("unavailable");
      // Search answers from the same snapshot, at the Worker.
      const found = await required(
        backend.buyer.searchCatalog(
          merchantId,
          STOREFRONT,
          late.token,
          "sencha",
        ),
      );
      expect(
        found.listings.map((listing) => [
          listing.variantTitle,
          listing.availability,
        ]),
      ).toEqual([
        ["Large sencha", "unavailable"],
        ["Small sencha", "unavailable"],
      ]);
      expect(
        (await backend.takeRequestCounts()).search_buyer_catalog ?? 0,
      ).toBe(0);

      const evidence = {
        plugin,
        buyers: BUYERS,
        tins: before.available,
        placed: placed.length,
        soldOutAtCart: refused.filter(
          (item) => item.outcome === "sold_out_at_cart",
        ).length,
        lostAtCheckout: refused.filter(
          (item) => item.outcome === "insufficient_inventory",
        ).length,
        saleSeconds: round(saleMs / 1_000),
        buyerMs: percentiles(outcomes.map((item) => item.ms)),
        catalogReads: reads.length,
        reachedObject,
        catalogReadMs: percentiles(reads),
      };
      console.log("flash sale", JSON.stringify(evidence));
      writeEvidence(
        "FLASH_SALE_ARTIFACT_DIR",
        plugin ? "flash-sale-with-plugin" : "flash-sale",
        evidence,
      );
    } finally {
      selling = false;
      await backend.close();
    }
  }
}

async function tins(
  admin: Awaited<ReturnType<typeof startWorkerdBackend>>["admin"],
) {
  const snapshot = await required(admin.readSnapshot(merchantId));
  const position = snapshot.resources.inventoryPositions.find(
    (item) => item.id === TIN,
  );
  if (position === undefined || position.balance.kind !== "accounted")
    throw new Error("The tea tins have no accounted position");
  return {
    onHand: position.balance.onHand.amount,
    allocated: position.balance.allocated.amount,
    available: position.balance.available.amount,
  };
}

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (share: number) =>
    round(
      sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ??
        0,
    );
  return { p50: at(0.5), p95: at(0.95), max: round(sorted.at(-1) ?? 0) };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// A buyer may take at most two tins in one checkout. Each buyer in the sale
// takes one, so the plugin passes every sale checkout.
const TIN_LIMIT = `
function run(input) {
  const refusals = [];
  for (const line of input.checkout.lines)
    if (line.variantId === input.settings.variantId &&
        line.quantity > input.settings.maxTins)
      refusals.push({ message: "A buyer can buy at most " +
        input.settings.maxTins + " tins." });
  return { refusals };
}
`;

class PluginDesk extends StaffDesk {
  constructor(admin: CommerceAdminClient) {
    super(admin, "flash_plugin");
  }

  install() {
    return this.edit(
      this.admin.installMerchantPlugin({
        ...this.editBase("install_tin_limit"),
        definition: tinLimit(),
        settings: { variantId: SENCHA, maxTins: 2 },
        expectedRevision: null,
      }),
    );
  }
}

function tinLimit(): PluginDefinition {
  return {
    pluginId: "tin_limit",
    version: 1,
    kind: "merchant",
    title: "Tin limit",
    purpose: "A buyer buys at most two tins of tea in one checkout.",
    requirements: {
      hookPoints: ["checkout.validate"],
      reads: [],
      commands: [],
      dependsOn: [],
    },
    contributions: {
      routes: [],
      pipelineSteps: [],
      entityTypes: [],
      settings: [
        { key: "variantId", valueKind: "text", description: "The tea tin" },
        {
          key: "maxTins",
          valueKind: "integer",
          description: "Tins for one checkout",
        },
      ],
      functions: [
        {
          functionId: "limit_tins",
          hookPoint: "checkout.validate",
          required: false,
          source: TIN_LIMIT,
        },
      ],
    },
    limits: {
      instructionBudget: 100,
      memoryBytes: 8 * 1024 * 1024,
      outputBytes: 16 * 1024,
    },
  };
}
