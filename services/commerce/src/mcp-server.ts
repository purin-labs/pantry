// The Commerce MCP server for operators' own sites (Plan 40B phase 6). An
// operator's coding agent (Claude Code, Codex) builds a shop site against
// Commerce: it reads the storefronts, the catalog and the menu, makes a
// pickup checkout as a guest buyer, and reads an order.
//
// The server answers MCP's Streamable HTTP transport without a session: each
// POST holds one JSON-RPC message and gets one JSON answer. It takes the
// merchant's own credential, an API key `uck_...` (Plan 80) or the operator
// token, and each tool needs one scope of that credential. A tool calls the
// same HTTP API that a site calls, through `dispatch`, so every route keeps
// its own checks, its idempotency and its receipts. Admin calls carry the
// caller's credential, so a receipt names the key; buyer calls carry only a
// guest buyer session that the tool makes.
import {
  CommerceAdminClient,
  CommerceStorefrontClient,
  type CommerceApiScope,
  type CommerceClientResult,
} from "@purin-labs/commerce-client";
import { isRecord } from "@purin-labs/std";

import type { ApiAccess, ApiCaller } from "./api-access.ts";

/** The MCP path of one merchant. */
const MCP_PATH = /^\/v1\/admin\/merchants\/([^/]+)\/mcp$/u;

/** The newest first; an unknown version gets the newest. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

const INSTRUCTIONS =
  "Commerce is the commerce backend of this shop. Use list_storefronts " +
  "to find the storefront ID, read_catalog for the products, the menus and " +
  "the live prices, create_checkout to make a pickup checkout as a guest " +
  "buyer, and read_order for the state of an order. A site pays a checkout " +
  "with the buyer session token that create_checkout returns, through the " +
  "storefront routes of @purin-labs/commerce-client.";

type Dispatch = (request: Request) => Promise<Response>;

type Tool = Readonly<{
  name: string;
  title: string;
  description: string;
  scope: CommerceApiScope;
  inputSchema: Readonly<Record<string, unknown>>;
  run: (context: ToolContext, input: Record<string, unknown>) => Promise<Out>;
}>;

type ToolContext = Readonly<{
  merchantId: string;
  admin: CommerceAdminClient;
  storefront: CommerceStorefrontClient;
}>;

/** A tool's answer: a value, or a refusal that the agent reads. */
type Out =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; message: string }>;

const text = (description: string) => ({ type: "string", description });

const TOOLS: readonly Tool[] = [
  {
    name: "list_storefronts",
    title: "List storefronts",
    description:
      "The shop's storefronts: each one's ID, sales channel, pickup or " +
      "shipping, and checkout settings.",
    scope: "settings:read",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    run: async ({ merchantId, admin }) => {
      const ids = await admin.listStorefrontIds(merchantId);
      if (!ids.ok) return refusal(ids);
      const storefronts = [];
      for (const id of ids.value) {
        const storefront = await admin.readStorefront(merchantId, id);
        if (!storefront.ok) return refusal(storefront);
        storefronts.push(storefront.value);
      }
      return { ok: true, value: { storefronts } };
    },
  },
  {
    name: "read_catalog",
    title: "Read the catalog and the menu",
    description:
      "What a buyer sees on one storefront: the product listings and the " +
      "café menus, with live prices, compare-at prices and availability. " +
      "With `query`, the matching listings only (20 at most).",
    scope: "catalog:read",
    inputSchema: {
      type: "object",
      properties: {
        storefrontId: text("The storefront, from list_storefronts."),
        query: text("Optional search words."),
      },
      required: ["storefrontId"],
      additionalProperties: false,
    },
    run: async ({ merchantId, storefront }, input) => {
      const storefrontId = field(input, "storefrontId");
      if (storefrontId === undefined) return invalid("storefrontId");
      const query = input.query;
      if (query !== undefined && typeof query !== "string")
        return invalid("query");
      const session = await guestSession(storefront, merchantId, storefrontId);
      if (!session.ok) return refusal(session);
      const token = session.value.token;
      const read =
        query === undefined || query.trim() === ""
          ? await storefront.readCatalog(merchantId, storefrontId, token)
          : await storefront.searchCatalog(
              merchantId,
              storefrontId,
              token,
              query,
            );
      return read.ok ? { ok: true, value: read.value } : refusal(read);
    },
  },
  {
    name: "create_checkout",
    title: "Create a pickup checkout",
    description:
      "Makes a guest buyer's cart and pickup checkout, as the shop site " +
      "does. The quote holds the stock until it expires. Returns the " +
      "checkout, its quote and the buyer session token, which pays it " +
      "through the storefront routes. A buyer's keys belong to its " +
      "session: to retry safely, send the same idempotencyKey with the " +
      "buyerSessionToken of the first answer. Lines are catalog lines " +
      '({"kind":"catalog","variantId","quantity"}) or menu lines ' +
      '({"kind":"menu","menuId","menuEntryId","modifierOptionIds","quantity"}).',
    scope: "orders:write",
    inputSchema: {
      type: "object",
      properties: {
        storefrontId: text("A pickup storefront, from list_storefronts."),
        idempotencyKey: text(
          "Your own key for this checkout; the same key and lines give the same checkout.",
        ),
        email: text("The buyer's email address."),
        lines: { type: "array", minItems: 1, items: { type: "object" } },
        pickupAt: text(
          "Optional UTC time to collect, at least the shop's lead time ahead.",
        ),
        buyerSessionToken: text(
          "Optional: the buyer session of an earlier answer, to retry it.",
        ),
      },
      required: ["storefrontId", "idempotencyKey", "email", "lines"],
      additionalProperties: false,
    },
    run: createCheckout,
  },
  {
    name: "read_order",
    title: "Read an order",
    description:
      "One order with its state, lines, totals, payments and fulfilment.",
    scope: "orders:read",
    inputSchema: {
      type: "object",
      properties: { orderId: text("The order ID.") },
      required: ["orderId"],
      additionalProperties: false,
    },
    run: async ({ merchantId, admin }, input) => {
      const orderId = field(input, "orderId");
      if (orderId === undefined) return invalid("orderId");
      const order = await admin.readOrderRecord(merchantId, orderId);
      return order.ok ? { ok: true, value: order.value } : refusal(order);
    },
  },
];

async function createCheckout(
  { merchantId, storefront }: ToolContext,
  input: Record<string, unknown>,
): Promise<Out> {
  const storefrontId = field(input, "storefrontId");
  if (storefrontId === undefined) return invalid("storefrontId");
  const key = field(input, "idempotencyKey");
  if (key === undefined) return invalid("idempotencyKey");
  const email = field(input, "email");
  if (email === undefined) return invalid("email");
  const pickupAt = input.pickupAt;
  if (pickupAt !== undefined && typeof pickupAt !== "string")
    return invalid("pickupAt");
  if (!Array.isArray(input.lines)) return invalid("lines");
  const given = input.buyerSessionToken;
  if (given !== undefined && typeof given !== "string")
    return invalid("buyerSessionToken");
  let token = given;
  let expiresAt: string | null = null;
  if (token === undefined) {
    const session = await guestSession(storefront, merchantId, storefrontId);
    if (!session.ok) return refusal(session);
    token = session.value.token;
    expiresAt = session.value.expiresAt;
  }
  // The route's own parser checks each line; this only passes them on.
  const lines = input.lines as Parameters<
    CommerceStorefrontClient["createCart"]
  >[3]["lines"];
  let cart;
  try {
    cart = await storefront.createCart(merchantId, storefrontId, token, {
      schemaVersion: "commerce.create-buyer-cart.v1",
      idempotencyKey: `${key}.cart`,
      lines,
    });
  } catch {
    return invalid("lines");
  }
  if (!cart.ok) return refusal(cart);
  let checkout;
  try {
    checkout = await storefront.createPickupCheckout(
      merchantId,
      storefrontId,
      token,
      {
        schemaVersion: "commerce.create-buyer-pickup-checkout.v1",
        idempotencyKey: `${key}.checkout`,
        cartId: cart.value.cartId,
        cartRevision: cart.value.revision,
        buyer: { kind: "guest", contact: { kind: "email", email } },
        ...(pickupAt === undefined ? {} : { pickupAt }),
      },
    );
  } catch {
    return invalid(pickupAt === undefined ? "email" : "email or pickupAt");
  }
  if (!checkout.ok) return refusal(checkout);
  return {
    ok: true,
    value: {
      buyerSessionToken: token,
      ...(expiresAt === null ? {} : { buyerSessionExpiresAt: expiresAt }),
      checkout: checkout.value,
    },
  };
}

function guestSession(
  storefront: CommerceStorefrontClient,
  merchantId: string,
  storefrontId: string,
) {
  return storefront.createSession(merchantId, storefrontId, {
    schemaVersion: "commerce.create-buyer-session.v1",
    buyer: { kind: "guest" },
  });
}

/** The merchant whose MCP path this is, or undefined for another path. */
export function mcpMerchantId(request: Request): string | undefined {
  const match = MCP_PATH.exec(new URL(request.url).pathname);
  if (match?.[1] === undefined) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/**
 * Answers one MCP request of `merchantId`. `dispatch` is the merchant's HTTP
 * API; the tools call it as a site would.
 */
export async function handleMcpRequest(
  request: Request,
  merchantId: string,
  options: Readonly<{ access: ApiAccess; dispatch: Dispatch }>,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  const identified = options.access.identify(request, merchantId);
  if (identified.kind === "refused")
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="commerce"',
      },
    });
  const caller = identified.caller;
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return rpc(null, { error: { code: -32700, message: "Parse error" } });
  }
  if (
    !isRecord(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  )
    return rpc(null, { error: { code: -32600, message: "Invalid request" } });
  const id = message.id;
  // A notification (no id) gets no answer.
  if (id === undefined) return new Response(null, { status: 202 });
  if (typeof id !== "string" && typeof id !== "number")
    return rpc(null, { error: { code: -32600, message: "Invalid request" } });
  const params = isRecord(message.params) ? message.params : {};
  switch (message.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion =
        PROTOCOL_VERSIONS.find((version) => version === asked) ??
        PROTOCOL_VERSIONS[0];
      return rpc(id, {
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "commerce", title: "Commerce", version: "1" },
          instructions: INSTRUCTIONS,
        },
      });
    }
    case "ping":
      return rpc(id, { result: {} });
    case "tools/list":
      return rpc(id, {
        result: {
          tools: TOOLS.filter((tool) => holds(caller, tool.scope)).map(
            (tool) => ({
              name: tool.name,
              title: tool.title,
              description: `${tool.description} Needs the scope ${tool.scope}.`,
              inputSchema: tool.inputSchema,
            }),
          ),
        },
      });
    case "tools/call":
      return rpc(
        id,
        await callTool(request, merchantId, caller, params, options.dispatch),
      );
    default:
      return rpc(id, {
        error: { code: -32601, message: `Method not found: ${message.method}` },
      });
  }
}

async function callTool(
  request: Request,
  merchantId: string,
  caller: ApiCaller,
  params: Record<string, unknown>,
  dispatch: Dispatch,
): Promise<RpcAnswer> {
  const tool = TOOLS.find((item) => item.name === params.name);
  if (tool === undefined)
    return {
      error: { code: -32602, message: `Unknown tool: ${String(params.name)}` },
    };
  const input = params.arguments ?? {};
  if (!isRecord(input))
    return { error: { code: -32602, message: "Arguments must be an object" } };
  if (!holds(caller, tool.scope))
    return toolResult({
      ok: false,
      message: `This key does not have the scope ${tool.scope}, so it cannot use ${tool.name}.`,
    });
  const origin = new URL(request.url).origin;
  const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    dispatch(new Request(input, init));
  const credential = request.headers.get("authorization")?.slice(7) ?? "";
  const context: ToolContext = {
    merchantId,
    admin: new CommerceAdminClient({
      baseUrl: origin,
      serviceToken: credential,
      fetch,
    }),
    storefront: new CommerceStorefrontClient({ baseUrl: origin, fetch }),
  };
  return toolResult(await tool.run(context, input));
}

function holds(caller: ApiCaller, scope: CommerceApiScope): boolean {
  return caller.kind === "operator" || caller.scopes.includes(scope);
}

type RpcAnswer =
  | Readonly<{ result: unknown }>
  | Readonly<{ error: Readonly<{ code: number; message: string }> }>;

function toolResult(out: Out): RpcAnswer {
  if (!out.ok)
    return {
      result: { content: [{ type: "text", text: out.message }], isError: true },
    };
  const structured = isRecord(out.value) ? out.value : { value: out.value };
  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(structured) }],
      structuredContent: structured,
    },
  };
}

function rpc(id: string | number | null, answer: RpcAnswer): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function field(input: Record<string, unknown>, name: string) {
  const value = input[name];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function invalid(name: string): Out {
  return { ok: false, message: `The argument ${name} is missing or invalid.` };
}

/** Commerce's own answer, for the agent to read. */
function refusal(result: CommerceClientResult<unknown>): Out {
  if (result.ok) return { ok: true, value: result.value };
  const error = result.error;
  return {
    ok: false,
    message:
      error.kind === "rejected"
        ? `Commerce refused: ${JSON.stringify(error.error)}`
        : `Commerce answered: ${error.message}`,
  };
}
