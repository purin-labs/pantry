import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createMemoryRouter } from "react-router";
import "@purin-labs/surface-portal/ui/styles.css";
import { PortalFrame } from "@purin-labs/surface-portal/ui/shell";
import { PageHeader } from "@purin-labs/ui/page-components";
import {
  workspacePageDescriptor,
  workspacePageHeader,
  type WorkspaceDetailPage,
} from "@purin-labs/ui/route";
import { MenuDraftRoute } from "@purin-labs/area-cafe/ui/features/content-studio/route";
import { OrderQueueRoute } from "@purin-labs/area-cafe/ui/features/order-queue/route";
import { RegisterRoute } from "@purin-labs/area-cafe/ui/features/register/route";
import { TerminalOperationsPanel } from "@purin-labs/area-cafe/ui/features/terminals/route";
import {
  MENU_ITEMS,
  installPreviewRooms,
  savedMenu,
} from "./cafe-preview-rooms";

/*
 * The Café pages with example data, in the Portal frame. The page answers
 * every control read itself and runs the shared rooms of the menu and the
 * boards, so no Worker is needed. Choices:
 *   ?page=menus            the board canvas (the default)
 *   ?page=menus&scenario=start   a shop with no board: the start screen
 *   ?page=menus&tab=items  or &tab=screens: a sheet over the canvas
 *   ?page=order-queue
 *   ?page=register         &sale=card or &sale=cash: a paid sale
 *   ?page=terminals        &counterSale=card: one counter sale below
 */
const root = document.getElementById("root");
if (root === null || !import.meta.env.DEV)
  throw new Error("Café preview is development-only.");

const query = new URLSearchParams(window.location.search);
const PAGES = ["menus", "order-queue", "register", "terminals"] as const;
type CafePage = (typeof PAGES)[number];
const page: CafePage =
  PAGES.find((candidate) => candidate === query.get("page")) ?? "menus";
const noBoards = query.get("scenario") === "start";
const ORGANISATION = "organisation_cafe_preview";
const NOW = Date.now();
const minutesAgo = (minutes: number): string =>
  new Date(NOW - minutes * 60_000).toISOString();

const PRICES: Readonly<Record<string, number>> = {
  item_latte: 620,
  item_cappuccino: 600,
  item_matcha: 680,
  item_hojicha: 650,
  item_croissant: 420,
  item_pain: 460,
  item_financier: 380,
  item_canele: 400,
};

const BOARDS = noBoards
  ? []
  : [
      {
        boardId: "board_morning",
        title: "Morning menu",
        layout: "canvas_landscape",
        documentRevision: 4,
        release: {
          releaseRevision: 3,
          documentRevision: 4,
          publishedAt: NOW - 3_600_000,
        },
        screens: 2,
      },
      {
        boardId: "board_pickup",
        title: "Pickup board",
        layout: "canvas_landscape",
        documentRevision: 4,
        release: {
          releaseRevision: 1,
          documentRevision: 2,
          publishedAt: NOW - 86_400_000,
        },
        screens: 1,
      },
    ];

function menuBoards(): unknown {
  return {
    ok: true,
    boards: BOARDS,
    archivedBoards: [
      {
        boardId: "board_autumn",
        title: "Autumn specials",
        archivedAt: NOW - 20 * 86_400_000,
      },
    ],
  };
}

function facts(): unknown {
  return {
    ok: true,
    facts: {
      observedAt: NOW,
      entries: MENU_ITEMS.map((item) => ({
        menuEntryId: item.id,
        price: { amountMinor: PRICES[item.id] ?? 500, currency: "JPY" },
        availability: item.id === "item_canele" ? "unavailable" : "available",
      })),
      orderUrl: "https://kissa-purin.order.purin.io/",
    },
  };
}

function menuPublication(): unknown {
  return {
    ok: true,
    products: [
      ...MENU_ITEMS.map((item) => ({
        productId: item.productId,
        title: item.displayName,
        image: null,
      })),
      { productId: "product_espresso", title: "Espresso", image: null },
      { productId: "product_scone", title: "Earl Grey scone", image: null },
    ],
    published: { revision: 5, entries: 8 },
    hours: null,
    shopUrl: "https://kissa-purin.order.purin.io/",
    shopName: {
      name: "kissa-purin",
      prefix: "https://",
      suffix: ".order.purin.io",
    },
  };
}

function screens(): unknown {
  return {
    ok: true,
    screens: [
      {
        screenId: "screen_counter",
        name: "Counter TV",
        boardId: "board_morning",
        pairedAt: NOW - 30 * 86_400_000,
        lastSeenAt: NOW,
        connected: true,
      },
      {
        screenId: "screen_window",
        name: "Window TV",
        boardId: "board_morning",
        pairedAt: NOW - 30 * 86_400_000,
        lastSeenAt: NOW - 5_400_000,
        connected: false,
      },
      {
        screenId: "screen_pickup",
        name: "Pickup screen",
        boardId: "board_pickup",
        pairedAt: NOW - 9 * 86_400_000,
        lastSeenAt: NOW,
        connected: true,
      },
    ],
  };
}

function orderQueue(): unknown {
  const line = (title: string, quantity = 1, modifiers: string[] = []) => ({
    title,
    quantity,
    modifiers,
  });
  return {
    ok: true,
    entries: [
      {
        fulfillmentId: "pickup_1",
        orderId: "order_1",
        code: "A12",
        channel: "online",
        stage: "preparing",
        since: minutesAgo(6),
        preparation: "preparing",
        lines: [line("Café latte", 2, ["Oat milk"]), line("Butter croissant")],
      },
      {
        fulfillmentId: "pickup_2",
        orderId: "order_2",
        code: "A13",
        channel: "counter",
        stage: "preparing",
        since: minutesAgo(3),
        preparation: "not_started",
        lines: [line("Matcha latte", 1, ["Less sweet"])],
      },
      {
        fulfillmentId: "pickup_3",
        orderId: "order_3",
        code: "A14",
        channel: "online",
        stage: "preparing",
        since: minutesAgo(0),
        preparation: "not_needed",
        lines: [line("Brown butter financier", 3)],
      },
      {
        fulfillmentId: "pickup_4",
        orderId: "order_4",
        code: "A10",
        channel: "online",
        stage: "ready",
        since: minutesAgo(2),
        preparation: "completed",
        lines: [line("Cappuccino"), line("Pain au chocolat", 2)],
      },
    ],
  };
}

function soldOut(): unknown {
  return {
    ok: true,
    items: [
      { variantId: "variant_latte", title: "Café latte", soldOutUntil: null },
      {
        variantId: "variant_matcha",
        title: "Matcha latte",
        soldOutUntil: null,
      },
      {
        variantId: "variant_hojicha",
        title: "Hojicha latte",
        soldOutUntil: new Date(NOW + 6 * 3_600_000).toISOString(),
      },
    ],
  };
}

function registerSnapshot(): unknown {
  const entry = (
    id: string,
    title: string,
    sectionId: string,
    modifiers = false,
  ) => ({
    menuEntryId: id,
    sectionId,
    offerId: `offer_${id}`,
    variantId: `variant_${id}`,
    title,
    description: null,
    unitPrice: { amountMinor: PRICES[id] ?? 500, currency: "JPY" },
    soldOutUntil:
      id === "item_canele" ? new Date(NOW + 3_600_000).toISOString() : null,
    available: id !== "item_canele",
    modifierGroups: modifiers
      ? [
          {
            modifierGroupId: "milk",
            revision: 1,
            name: "Milk",
            minimumSelections: 1,
            maximumSelections: 1,
            options: [
              {
                modifierOptionId: "milk_whole",
                name: "Whole milk",
                priceDeltaMinor: 0,
                currency: "JPY",
              },
              {
                modifierOptionId: "milk_oat",
                name: "Oat milk",
                priceDeltaMinor: 60,
                currency: "JPY",
              },
            ],
          },
        ]
      : [],
  });
  return {
    ok: true,
    register: {
      schemaVersion: "pantry.counter-register.v1",
      merchantId: "merchant_preview",
      pantryLocationId: "Front counter",
      currency: "JPY",
      policy: {
        revision: 2,
        currency: "JPY",
        cashEnabled: true,
        catalogScope: {
          kind: "published_menu",
          menuId: "menu_cafe_main",
          maxQuantityPerLine: 20,
        },
        tax: { kind: "percentage", basisPoints: 1000, inclusion: "included" },
      },
      menu: {
        menuId: "menu_cafe_main",
        name: "Café menu",
        sections: [
          {
            sectionId: "coffee",
            name: "Coffee",
            position: 0,
            entries: [
              entry("item_latte", "Café latte", "coffee", true),
              entry("item_cappuccino", "Cappuccino", "coffee", true),
              entry("item_matcha", "Matcha latte", "coffee", true),
              entry("item_hojicha", "Hojicha latte", "coffee"),
            ],
          },
          {
            sectionId: "pastries",
            name: "Pastries",
            position: 1,
            entries: [
              entry("item_croissant", "Butter croissant", "pastries"),
              entry("item_pain", "Pain au chocolat", "pastries"),
              entry("item_financier", "Brown butter financier", "pastries"),
              entry("item_canele", "Canelé", "pastries"),
            ],
          },
        ],
      },
      terminal: {
        assigned: true,
        provider: "square_terminal",
        assignmentRevision: 1,
        targetKind: "paired_physical",
        deviceId: "device_front",
        gatewayId: null,
        deviceSourceKey: null,
        ready: true,
        blockedReason: null,
        supportedMethods: ["card", "felica", "qr_code"],
      },
      openQueueCount: 4,
      openOrders: [],
    },
  };
}

const SALES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  card: {
    paymentMethod: "felica",
    tenderBrand: "Suica",
    providerRefundable: false,
    manualTender: null,
  },
  cash: {
    paymentMethod: null,
    tenderBrand: null,
    providerRefundable: null,
    manualTender: {
      cashReceivedMinor: 2_000,
      changeDueMinor: 760,
      currency: "JPY",
    },
  },
};

function counterSale(kind: string): unknown {
  return {
    ok: true,
    counterSale: {
      schemaVersion: "pantry.counter-sale.v1",
      checkoutId: kind,
      pantryLocationId: "Front counter",
      revision: 4,
      state: "complete",
      collectable: false,
      recoverable: null,
      quote: {
        quoteDigest: `quote_${"b".repeat(64)}`,
        checkoutRevision: 4,
        lineCount: 2,
        amount: { amountMinor: 1_240, currency: "JPY" },
      },
      orderId: "order_counter_1042",
      capturedPaymentReference: "payment_counter_1042",
      pickupCode: "C07",
      afterSale: {
        order: { id: "order_counter_1042", revision: 1, state: "confirmed" },
        payment: { id: "payment_counter_1042", revision: 1, state: "captured" },
        fulfillment: {
          id: "pickup_counter_1042",
          revision: 1,
          state: "requested",
        },
        refundState: "none",
      },
      ...(SALES[kind] ?? SALES.card),
    },
  };
}

function terminalOperations(): unknown {
  const assignment = (targetKind: string, healthIsObservable: boolean) => ({
    assignmentId: `assignment_${targetKind}`,
    revision: 1,
    merchantId: "merchant_preview",
    integrationAccountId: "integration_square",
    capabilityRevision: 1,
    capabilityCurrent: true,
    providerLocationId: "square_location_tokyo",
    targetKind,
    deviceId: `device_${targetKind}`,
    adapterVersion: "1",
    environment: "production",
    healthIsObservable,
  });
  return {
    ok: true,
    terminalOperations: {
      schemaVersion: "pantry.terminal-operations.v2",
      organisationId: ORGANISATION,
      generatedAt: new Date(NOW).toISOString(),
      counters: [
        {
          pantryLocationId: "Front counter",
          blockedReason: null,
          assignment: assignment("paired_physical", true),
          credentialHealth: "active",
          webhook: { kind: "unconfigured" },
          paymentsLinked: true,
        },
        {
          pantryLocationId: "Window counter",
          blockedReason: null,
          assignment: assignment("square_pos_app", false),
          credentialHealth: "active",
          webhook: { kind: "unconfigured" },
          paymentsLinked: false,
        },
      ],
      unreadableAssignments: 0,
    },
    configuration: {
      kind: "ready",
      merchantId: "merchant_preview",
      environment: "production",
      pantryLocations: [
        {
          pantryLocationId: "Front counter",
          currency: "JPY",
          supportedItems: [],
        },
        {
          pantryLocationId: "Window counter",
          currency: "JPY",
          supportedItems: [],
        },
      ],
      squareAccounts: [
        {
          integrationAccountId: "integration_square",
          providerAccountId: "square_merchant",
          displayName: "Kissa Purin",
          locations: [
            {
              providerLocationId: "square_location_tokyo",
              displayName: "Kissa Purin Tokyo",
              country: "JP",
              currency: "JPY",
            },
          ],
        },
      ],
      testDevices: [],
    },
  };
}

function json(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

const ANSWERS: readonly (readonly [RegExp, () => unknown])[] = [
  [/\/menu-boards\/facts$/u, facts],
  [/\/menu-boards$/u, menuBoards],
  [/\/menu-boards\/[^/]+\/comments$/u, () => ({ ok: true, threads: [] })],
  [/\/menu-screens$/u, screens],
  [/\/collaboration\/menu-draft$/u, () => ({ ok: true, value: savedMenu() })],
  [/\/commerce\/menu-publication$/u, menuPublication],
  [
    /\/commerce\/media$/u,
    () => ({ ok: true, images: [], mediaBase: "/v1/screens/media/preview/" }),
  ],
  [/\/commerce\/order-queue$/u, orderQueue],
  [/\/commerce\/sold-out$/u, soldOut],
  [/\/commerce\/counter-register(\?.*)?$/u, registerSnapshot],
  [/\/commerce\/terminal-operations$/u, terminalOperations],
];

window.fetch = function previewFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const url = new URL(
    String(input instanceof Request ? input.url : input),
    window.location.origin,
  );
  const path = `${url.pathname}${url.search}`;
  const sale = /\/commerce\/counter-sales\/([^/]+)$/u.exec(url.pathname)?.[1];
  if (sale !== undefined && (init?.method ?? "GET") === "GET")
    return json(counterSale(decodeURIComponent(sale)));
  for (const [pattern, answer] of ANSWERS)
    if (pattern.test(path) && (init?.method ?? "GET") === "GET")
      return json(answer());
  return json({ ok: false, error: "not_in_preview" }, 404);
};

installPreviewRooms(
  new Map(BOARDS.map((board) => [board.boardId, board.title])),
);

function previewLogout(): Promise<void> {
  return Promise.resolve();
}
function ignore(): void {}
function refused(): Promise<unknown> {
  return Promise.reject(new Error("Changes are off in this preview."));
}

function CafePage(): React.ReactNode {
  const descriptor = workspacePageDescriptor(page);
  const header = workspacePageHeader(descriptor, null);
  return (
    <PortalFrame
      identity={{
        kind: "ready",
        displayName: "Owner",
        logout: previewLogout,
        permissionRequests: { open: ignore, count: null },
      }}
      organisation={{
        organisationHandle: "kissa",
        name: "Kissa Purin",
        choices: [],
      }}
      workspace={{
        organisationHandle: "kissa",
        workspaceHandle: "cafe",
        name: "Café",
        choices: [],
      }}
      sidebar={{
        activePage: page satisfies WorkspaceDetailPage,
        chatOpen: false,
        footer: null,
      }}
    >
      <PageHeader title={header.title} description={header.description} />
      {page === "menus" ? (
        <MenuDraftRoute organisationId={ORGANISATION} />
      ) : null}
      {page === "order-queue" ? (
        <OrderQueueRoute organisationId={ORGANISATION} />
      ) : null}
      {page === "register" ? (
        <RegisterRoute organisationId={ORGANISATION} />
      ) : null}
      {page === "terminals" ? (
        <TerminalOperationsPanel
          organisationId={ORGANISATION}
          canManage
          mutate={refused}
        />
      ) : null}
    </PortalFrame>
  );
}

const tab = query.get("tab");
const router = createMemoryRouter([{ path: "*", element: <CafePage /> }], {
  initialEntries: [
    `/portal/kissa/cafe/${page}${tab === null ? "" : `?tab=${encodeURIComponent(tab)}`}`,
  ],
});
createRoot(root).render(<RouterProvider router={router} />);
