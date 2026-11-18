// Plan 40B phase 6: an operator's coding agent builds the café's own site
// against Commerce's MCP server. The owner gives the agent a key with four
// scopes. The agent connects, finds the pickup storefront, reads the menu
// with its live price, and makes a checkout for two lattes as a guest buyer.
// The site pays it with the buyer session that the tool returned, and the
// agent reads the placed order. A key with only `catalog:read` sees one tool
// and cannot make a checkout; no key, a buyer session, another shop's key or
// a revoked key opens nothing. Set MCP_SERVER_ARTIFACT_DIR to keep the run's
// evidence; the file repeats byte for byte for the same commit.
import { CommerceAdminClient } from "@seams/commerce-client";
import { expect, it } from "vitest";

import {
  BASE_URL,
  NOW,
  STOREFRONT,
  merchantId,
  required,
  startBackend,
  writeEvidence,
  type Evidence,
} from "./journey-support.ts";

const SECOND_MERCHANT = "merchant_second_shop";
const MENU = "menu_cafe_main";
const LATTE_ENTRY = "menu_entry_sesame_latte";
const TWO_LATTES = {
  kind: "menu",
  menuId: MENU,
  menuEntryId: LATTE_ENTRY,
  modifierOptionIds: [],
  quantity: 2,
};

type Backend = Awaited<ReturnType<typeof startBackend>>;
type Rpc = Readonly<{
  status: number;
  body: Record<string, unknown> | null;
  sessionHeader: string | null;
}>;

it(
  "lets a coding agent read the menu, make a checkout and read the order through MCP",
  { timeout: 60_000 },
  mcpServerJourney,
);

async function mcpServerJourney(): Promise<void> {
  const backend = await startBackend();
  const evidence: Evidence = { clock: NOW, merchantId };
  try {
    const { admin } = backend;
    const issued = await required(
      admin.issueApiKey(merchantId, {
        label: "Site agent",
        scopes: [
          "settings:read",
          "catalog:read",
          "orders:write",
          "orders:read",
        ],
      }),
    );
    const readOnly = await required(
      admin.issueApiKey(merchantId, {
        label: "Menu reader",
        scopes: ["catalog:read"],
      }),
    );
    const agent = connection(backend, issued.key);

    // 1. The agent connects. The server keeps no session.
    const initialized = await agent("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "coding-agent", version: "1" },
    });
    const initializedNote = await agent(
      "notifications/initialized",
      undefined,
      null,
    );
    const init = result(initialized);
    expect({
      protocolVersion: init.protocolVersion,
      server: (init.serverInfo as Record<string, unknown>).name,
      session: initialized.sessionHeader,
      notification: initializedNote.status,
    }).toEqual({
      protocolVersion: "2025-06-18",
      server: "underclerk",
      session: null,
      notification: 202,
    });

    // 2. Each key sees the tools of its scopes.
    const toolNames = async (call: ReturnType<typeof connection>) =>
      (result(await call("tools/list")).tools as { name: string }[]).map(
        (tool) => tool.name,
      );
    const tools = {
      siteAgent: await toolNames(agent),
      menuReader: await toolNames(connection(backend, readOnly.key)),
    };
    expect(tools).toEqual({
      siteAgent: [
        "list_storefronts",
        "read_catalog",
        "create_checkout",
        "read_order",
      ],
      menuReader: ["read_catalog"],
    });

    // 3. The agent finds the storefront and reads the menu's live price.
    const storefronts = structured(
      await callTool(agent, "list_storefronts", {}),
    ).storefronts as { storefrontId?: string; id?: string }[];
    const storefrontIds = storefronts.map(
      (storefront) => storefront.storefrontId ?? storefront.id,
    );
    expect(storefrontIds).toContain(STOREFRONT);
    const catalog = structured(
      await callTool(agent, "read_catalog", { storefrontId: STOREFRONT }),
    );
    const latte = (catalog.menus as { menuId: string; entries: Entry[] }[])
      .find((menu) => menu.menuId === MENU)
      ?.entries.find((entry) => entry.menuEntryId === LATTE_ENTRY);
    if (latte === undefined) throw new Error("The menu has no latte");
    // A menu entry names its variant; the listing holds the item's title.
    const latteListing = (
      catalog.listings as { variantId: string; title?: string }[]
    ).find((listing) => listing.variantId === latte.variantId);
    const search = structured(
      await callTool(agent, "read_catalog", {
        storefrontId: STOREFRONT,
        query: "latte",
      }),
    );

    // 4. The menu reader cannot make a checkout.
    const readerCheckout = await callTool(
      connection(backend, readOnly.key),
      "create_checkout",
      {
        storefrontId: STOREFRONT,
        idempotencyKey: "reader_checkout",
        email: "reader@example.test",
        lines: [TWO_LATTES],
      },
    );
    expect(toolError(readerCheckout)).toContain("orders:write");

    // 5. The agent makes a checkout for two lattes. A wrong line is refused
    // by Commerce's own check.
    const made = structured(
      await callTool(agent, "create_checkout", {
        storefrontId: STOREFRONT,
        idempotencyKey: "site_test_1",
        email: "mika@example.test",
        lines: [TWO_LATTES],
      }),
    );
    const checkout = made.checkout as Checkout;
    expect(checkout.quote.totals.subtotal).toEqual({
      amountMinor: latte.price.amountMinor * 2,
      currency: latte.price.currency,
    });
    // A retry with the same key and buyer session gives the same checkout,
    // not a second hold.
    const repeated = structured(
      await callTool(agent, "create_checkout", {
        storefrontId: STOREFRONT,
        idempotencyKey: "site_test_1",
        email: "mika@example.test",
        lines: [TWO_LATTES],
        buyerSessionToken: made.buyerSessionToken,
      }),
    );
    expect((repeated.checkout as Checkout).checkoutId).toBe(
      checkout.checkoutId,
    );
    const wrongLine = await callTool(agent, "create_checkout", {
      storefrontId: STOREFRONT,
      idempotencyKey: "site_test_2",
      email: "mika@example.test",
      lines: [{ ...TWO_LATTES, menuEntryId: "menu_entry_not_on_menu" }],
    });

    // 6. The site pays with the buyer session, as a browser would.
    const token = String(made.buyerSessionToken);
    const payment = await required(
      backend.buyer.createPaymentSession(
        merchantId,
        STOREFRONT,
        checkout.checkoutId,
        token,
        {
          schemaVersion: "underclerk.create-buyer-payment-session.v1",
          idempotencyKey: "site_payment",
          checkoutRevision: checkout.revision,
          quoteDigest: checkout.quote.quoteDigest,
          returnUrl: `${BASE_URL}/store/cafe`,
        },
      ),
    );
    const placed = await required(
      backend.buyer.reconcilePayment(
        merchantId,
        STOREFRONT,
        checkout.checkoutId,
        token,
        {
          schemaVersion: "underclerk.reconcile-buyer-payment.v1",
          idempotencyKey: "site_payment",
          checkoutRevision: checkout.revision,
          quoteDigest: checkout.quote.quoteDigest,
          confirmation: { kind: "provider_ui_completed" },
        },
      ),
    );
    if (placed.state !== "placed") throw new Error(`Payment ${placed.state}`);

    // 7. The agent reads the order.
    const order = structured(
      await callTool(agent, "read_order", { orderId: placed.orderId }),
    );
    const orderText = JSON.stringify(order);
    expect(orderText).toContain(placed.orderId);
    expect(orderText).toContain(LATTE_ENTRY);

    // 8. What opens nothing.
    await required(
      admin.provisionMerchant({
        schemaVersion: "underclerk.provision-merchant.v2",
        externalReference: "organisation_second_shop",
        merchantId: SECOND_MERCHANT,
        createdAt: NOW,
      }),
    );
    const otherShopKey = await required(
      admin.issueApiKey(SECOND_MERCHANT, {
        label: "Other shop",
        scopes: ["catalog:read"],
      }),
    );
    const revocable = await required(
      admin.issueApiKey(merchantId, {
        label: "Old agent",
        scopes: ["catalog:read"],
      }),
    );
    await required(admin.revokeApiKey(merchantId, revocable.credentialId));
    const list = async (bearer: string | undefined) =>
      (await rpc(backend, bearer, "tools/list")).status;
    const refusals = {
      noKey: await list(undefined),
      buyerSession: await list(token),
      otherShopKey: await list(otherShopKey.key),
      revokedKey: await list(revocable.key),
      get: (
        await backend.fetch(mcpUrl(), {
          headers: { authorization: `Bearer ${issued.key}` },
        })
      ).status,
      unknownTool: rpcError(await callTool(agent, "delete_shop", {})),
      unknownMethod: rpcError(await agent("resources/list")),
    };
    expect(refusals).toEqual({
      noKey: 401,
      buyerSession: 401,
      otherShopKey: 401,
      revokedKey: 401,
      get: 405,
      unknownTool: -32602,
      unknownMethod: -32601,
    });

    Object.assign(evidence, {
      initialize: { protocolVersion: init.protocolVersion, session: null },
      tools,
      storefronts: storefrontIds,
      latte: { title: latteListing?.title ?? null, price: latte.price },
      searchFindsLatte: JSON.stringify(search).includes(latte.variantId),
      readerCheckout: toolError(readerCheckout),
      checkout: {
        state: checkout.state,
        subtotal: checkout.quote.totals.subtotal,
        total: checkout.quote.totals.total,
        expiresAt: checkout.quote.expiresAt ?? null,
      },
      repeatedKey: {
        sameCheckout:
          (repeated.checkout as Checkout).checkoutId === checkout.checkoutId,
      },
      wrongLine: toolError(wrongLine),
      payment: payment.state,
      order: {
        placed: placed.state,
        lifecycle: (order.order as { lifecycle: unknown }).lifecycle,
        lines: (order.order as { lineItems: unknown[] }).lineItems.length,
      },
      refusals,
    });
  } finally {
    writeEvidence("MCP_SERVER_ARTIFACT_DIR", "mcp-server", evidence);
    backend.close();
  }
}

type Entry = Readonly<{
  menuEntryId: string;
  variantId: string;
  price: Readonly<{ amountMinor: number; currency: string }>;
}>;

type Checkout = Readonly<{
  checkoutId: string;
  revision: number;
  state: string;
  quote: Readonly<{
    quoteDigest: string;
    expiresAt?: string;
    totals: Readonly<{
      subtotal: Readonly<{ amountMinor: number; currency: string }>;
      total: Readonly<{ amountMinor: number; currency: string }>;
    }>;
  }>;
}>;

function mcpUrl(merchant: string = merchantId): string {
  return `${BASE_URL}/v1/admin/merchants/${merchant}/mcp`;
}

let nextId = 0;

async function rpc(
  backend: Backend,
  bearer: string | undefined,
  method: string,
  params?: unknown,
  id: number | null = (nextId += 1),
): Promise<Rpc> {
  const response = await backend.fetch(mcpUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      ...(id === null ? {} : { id }),
      ...(params === undefined ? {} : { params }),
    }),
  });
  const raw = await response.text();
  return {
    status: response.status,
    body: raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>),
    sessionHeader: response.headers.get("mcp-session-id"),
  };
}

function connection(backend: Backend, bearer: string) {
  return (method: string, params?: unknown, id?: number | null) =>
    rpc(backend, bearer, method, params, id);
}

function callTool(
  call: ReturnType<typeof connection>,
  name: string,
  args: Record<string, unknown>,
) {
  return call("tools/call", { name, arguments: args });
}

function result(answer: Rpc): Record<string, unknown> {
  const value = answer.body?.result;
  if (typeof value !== "object" || value === null)
    throw new Error(`No result: ${JSON.stringify(answer)}`);
  return value as Record<string, unknown>;
}

function structured(answer: Rpc): Record<string, unknown> {
  const value = result(answer);
  if (value.isError === true)
    throw new Error(`Tool error: ${JSON.stringify(value.content)}`);
  return value.structuredContent as Record<string, unknown>;
}

function toolError(answer: Rpc): string {
  const value = result(answer);
  if (value.isError !== true) throw new Error("The tool did not refuse");
  return (value.content as { text: string }[])[0]?.text ?? "";
}

function rpcError(answer: Rpc): number | undefined {
  const error = answer.body?.error as { code?: number } | undefined;
  return error?.code;
}

void CommerceAdminClient;
