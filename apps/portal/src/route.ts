import type { FileContextProvider } from "@purin-labs/contracts";
import { assertNever } from "@purin-labs/std";
import { surfaceAreaTitle } from "@purin-labs/control-api";

export type WorkspaceDetailPage =
  | "overview"
  | "chat"
  | "inbox"
  | "checkout"
  | "products"
  | "menus"
  | "order-queue"
  | "register"
  | "terminals"
  | "recipes"
  | "costs"
  | "inventory"
  | "production-requests"
  | "orders"
  | "payments"
  | "payouts"
  | "suppliers"
  | "workflow-simulator"
  | "devices"
  | "bakes"
  | "agents"
  | "brain"
  | "knowledge"
  | "activity"
  | "tests"
  | "integrations"
  | "vault"
  | "api-keys"
  | "jev"
  | "billing"
  | "access"
  | "settings";

export type WorkspaceSystem = "AgentCommerce" | "CafeOS" | "BakeryOS";

export type WorkspaceNavigationGroupName =
  WorkspaceSystem | "Workspace" | "Agents" | "Settings";

/** The name that people see for a navigation group or a surface area. */
export function navigationGroupTitle(
  group: WorkspaceNavigationGroupName,
): string {
  // The group names are the surface areas: one title map serves both.
  return surfaceAreaTitle(group);
}

export type AccessSubview = "access" | "capabilities" | "data_flow";

type WorkspacePageResource =
  | { readonly kind: "none" }
  | {
      readonly kind: "detail";
      readonly resource: "product" | "customer_order" | "supplier";
      readonly detailSegment: string;
      readonly title: string;
      readonly description: string;
    };

export type WorkspacePageDescriptor = {
  readonly page: WorkspaceDetailPage;
  readonly segment: string;
  readonly navigationLabel: string;
  readonly title: string;
  readonly description: string;
  readonly group: WorkspaceNavigationGroupName;
  readonly resource: WorkspacePageResource;
};

export type WorkspaceNavigationGroup = {
  readonly label: WorkspaceNavigationGroupName;
  readonly pages: readonly WorkspaceDetailPage[];
};

const WORKSPACE_PAGE_DESCRIPTORS: Record<
  WorkspaceDetailPage,
  WorkspacePageDescriptor
> = {
  overview: {
    page: "overview",
    segment: "",
    navigationLabel: "Home",
    title: "Home",
    description:
      "See what needs attention today and what is blocking the workspace.",
    group: "Workspace",
    resource: { kind: "none" },
  },
  chat: {
    page: "chat",
    segment: "chat",
    navigationLabel: "Chat",
    title: "Chat",
    description: "Talk to your connected AI and connect the apps you need.",
    group: "Workspace",
    resource: { kind: "none" },
  },
  inbox: {
    page: "inbox",
    segment: "inbox",
    navigationLabel: "Inbox",
    title: "Inbox",
    description: "Read your connected mail in the workspace.",
    group: "Workspace",
    resource: { kind: "none" },
  },
  checkout: {
    page: "checkout",
    segment: "checkout",
    navigationLabel: "Checkout",
    title: "Checkout",
    description: "How do customers buy from this storefront?",
    group: "AgentCommerce",
    resource: { kind: "none" },
  },
  products: {
    page: "products",
    segment: "products",
    navigationLabel: "Products",
    title: "Products",
    description:
      "Manage products for sale online and review finished-product availability.",
    group: "AgentCommerce",
    resource: {
      kind: "detail",
      resource: "product",
      detailSegment: "products",
      title: "Product detail",
      description:
        "See this product's status, availability, sales channels, and recent changes.",
    },
  },
  menus: {
    page: "menus",
    segment: "menus",
    navigationLabel: "Menus",
    title: "Menus",
    description: "Build and review the menu for in-store service.",
    group: "CafeOS",
    resource: { kind: "none" },
  },
  "order-queue": {
    page: "order-queue",
    segment: "order-queue",
    navigationLabel: "Order queue",
    title: "Order queue",
    description: "Prepare open orders, mark them ready and hand them over.",
    group: "CafeOS",
    resource: { kind: "none" },
  },
  register: {
    page: "register",
    segment: "register",
    navigationLabel: "Register",
    title: "Register",
    description:
      "Ring up counter orders from the published menu and take cash or terminal payments.",
    group: "CafeOS",
    resource: { kind: "none" },
  },
  terminals: {
    page: "terminals",
    segment: "terminals",
    navigationLabel: "Counters & payments",
    title: "Counters & payments",
    description: "Manage in-store payment terminals and card-present payments.",
    group: "CafeOS",
    resource: { kind: "none" },
  },
  recipes: {
    page: "recipes",
    segment: "recipes",
    navigationLabel: "Recipes",
    title: "Recipes",
    description:
      "Browse recipes, set ingredient quantities, and define each batch yield.",
    group: "BakeryOS",
    resource: { kind: "none" },
  },
  costs: {
    page: "costs",
    segment: "costs",
    navigationLabel: "Costs & margins",
    title: "Costs & margins",
    description:
      "Model daily production batches, supplier pack prices, waste, and net product margins.",
    group: "BakeryOS",
    resource: { kind: "none" },
  },
  inventory: {
    page: "inventory",
    segment: "inventory",
    navigationLabel: "Ingredients & supplies",
    title: "Ingredients & supplies",
    description:
      "See what’s available, what’s running low, and what needs replenishing.",
    group: "BakeryOS",
    resource: { kind: "none" },
  },
  payouts: {
    page: "payouts",
    segment: "payouts",
    navigationLabel: "Payouts",
    title: "Payouts",
    description: "See when your card sales reach the bank.",
    group: "AgentCommerce",
    resource: { kind: "none" },
  },
  payments: {
    page: "payments",
    segment: "payments",
    navigationLabel: "Payments",
    title: "Payments",
    description:
      "See card payments, the declined ones, and whether the buyer paid later.",
    group: "AgentCommerce",
    resource: { kind: "none" },
  },
  orders: {
    page: "orders",
    segment: "orders",
    navigationLabel: "Orders",
    title: "Customer orders",
    description:
      "Track payment, fulfillment, and problems for customer orders.",
    group: "AgentCommerce",
    resource: {
      kind: "detail",
      resource: "customer_order",
      detailSegment: "orders",
      title: "Customer order detail",
      description:
        "See this order's status, payment, fulfillment, and recent changes.",
    },
  },
  suppliers: {
    page: "suppliers",
    segment: "suppliers",
    navigationLabel: "Purchasing",
    title: "Suppliers",
    description:
      "Manage suppliers, supplied items, and purchasing work for low stock.",
    group: "BakeryOS",
    resource: {
      kind: "detail",
      resource: "supplier",
      detailSegment: "suppliers",
      title: "Supplier detail",
      description:
        "See contacts, purchasing terms, supplied items, and current replenishment work.",
    },
  },
  "production-requests": {
    page: "production-requests",
    segment: "production-requests",
    navigationLabel: "Production requests",
    title: "Production requests",
    description:
      "Accept and schedule product demand and review confirmed output.",
    group: "BakeryOS",
    resource: { kind: "none" },
  },
  "workflow-simulator": {
    page: "workflow-simulator",
    segment: "workflow-simulator",
    navigationLabel: "Production",
    title: "Workflow simulator",
    description:
      "Replay a bakery shift, inspect resource queues, and compare an oven outage.",
    group: "BakeryOS",
    resource: { kind: "none" },
  },
  devices: {
    page: "devices",
    segment: "devices",
    navigationLabel: "Devices",
    title: "Devices",
    description: "See each device in the shop and which ones need attention.",
    group: "BakeryOS",
    resource: { kind: "none" },
  },
  bakes: {
    page: "bakes",
    segment: "bakes",
    navigationLabel: "Bakes",
    title: "Bakes",
    description:
      "Set the counter stock level of each fresh product, and decide the bake proposals.",
    group: "BakeryOS",
    resource: { kind: "none" },
  },
  agents: {
    page: "agents",
    segment: "agents",
    navigationLabel: "Agents",
    title: "Agents",
    description:
      "Delegate café work. Choose when agents run and which actions need your approval.",
    group: "Agents",
    resource: { kind: "none" },
  },
  integrations: {
    page: "integrations",
    segment: "integrations",
    navigationLabel: "Integrations",
    title: "Integrations",
    description: "Connect the apps your shop uses.",
    group: "Settings",
    resource: { kind: "none" },
  },
  vault: {
    page: "vault",
    segment: "vault",
    navigationLabel: "Vault",
    title: "Vault",
    description:
      "Save logins and contact info for agents. Agents never see a saved password.",
    group: "Settings",
    resource: { kind: "none" },
  },
  "api-keys": {
    page: "api-keys",
    segment: "api-keys",
    navigationLabel: "API keys",
    title: "API keys",
    description:
      "Give your own systems a key to read and change the shop. Each change records the key that made it.",
    group: "Settings",
    resource: { kind: "none" },
  },
  jev: {
    page: "jev",
    segment: "jev",
    navigationLabel: "Jev",
    title: "Jev",
    description:
      "Choose which Seams Pantry features may send data to TypeSafe Jev.",
    group: "Settings",
    resource: { kind: "none" },
  },
  billing: {
    page: "billing",
    segment: "billing",
    navigationLabel: "Billing",
    title: "Billing",
    description:
      "See the Jev use of this month, paid use and the monthly spending limit.",
    group: "Settings",
    resource: { kind: "none" },
  },
  brain: {
    page: "brain",
    segment: "brain",
    navigationLabel: "Brain",
    title: "Brain",
    description:
      "Review what the agents have learned and decide what they may use.",
    group: "Agents",
    resource: { kind: "none" },
  },
  knowledge: {
    page: "knowledge",
    segment: "knowledge",
    navigationLabel: "Knowledge",
    title: "Knowledge",
    description:
      "Review what the agents have learned and decide what they may use.",
    group: "Agents",
    resource: { kind: "none" },
  },
  activity: {
    page: "activity",
    segment: "activity",
    navigationLabel: "Activity",
    title: "Activity",
    description: "See what the agents did in each case, step by step.",
    group: "Agents",
    resource: { kind: "none" },
  },
  tests: {
    page: "tests",
    segment: "tests",
    navigationLabel: "Tests",
    title: "Tests",
    description: "Check that the agents still give the right answers.",
    group: "Agents",
    resource: { kind: "none" },
  },
  access: {
    page: "access",
    segment: "access",
    navigationLabel: "Access and data flow",
    title: "Access and data flow",
    description:
      "Choose who can use your connected data and where it can be shared.",
    group: "Settings",
    resource: { kind: "none" },
  },
  settings: {
    page: "settings",
    segment: "settings",
    navigationLabel: "Workspace settings",
    title: "Workspace settings",
    description: "Manage members, roles, and workspace access.",
    group: "Settings",
    resource: { kind: "none" },
  },
};

/**
 * Retired pages (Online overview, Content studio, Operations); their old links
 * open Home.
 */
const RETIRED_PAGE_SEGMENTS: readonly string[] = [
  "commerce",
  "content",
  "operations",
];

/** Renamed pages; their old links open the page under its new name. */
const RENAMED_PAGE_SEGMENTS: ReadonlyMap<string, WorkspaceDetailPage> = new Map(
  [["takings", "payouts"]],
);

const WORKSPACE_PAGE_DESCRIPTOR_LIST = Object.values(
  WORKSPACE_PAGE_DESCRIPTORS,
);
export const WORKSPACE_PAGE_ROUTES: readonly WorkspacePageDescriptor[] =
  WORKSPACE_PAGE_DESCRIPTOR_LIST;
const WORKSPACE_ROUTE_PATTERN = buildWorkspaceRoutePattern(
  WORKSPACE_PAGE_DESCRIPTOR_LIST,
);

export const WORKSPACE_NAVIGATION_GROUPS: readonly WorkspaceNavigationGroup[] =
  [
    { label: "Workspace", pages: ["overview", "inbox"] },
    {
      label: "AgentCommerce",
      pages: ["orders", "payments", "payouts", "products", "checkout"],
    },
    {
      label: "CafeOS",
      pages: ["register", "menus", "order-queue", "terminals"],
    },
    {
      label: "BakeryOS",
      pages: [
        "recipes",
        "costs",
        "workflow-simulator",
        "production-requests",
        "inventory",
        "suppliers",
        "devices",
        "bakes",
      ],
    },
    { label: "Agents", pages: ["agents", "knowledge"] },
    {
      label: "Settings",
      pages: [
        "integrations",
        "vault",
        "api-keys",
        "jev",
        "billing",
        "access",
        "settings",
      ],
    },
  ];

export type PortalRoute =
  | { readonly kind: "organisation_list" }
  | { readonly kind: "organisation"; readonly organisationHandle: string }
  | {
      readonly kind: "not_found";
      readonly organisationHandle: string | null;
      readonly workspaceHandle: string | null;
    }
  | {
      readonly kind: "workspace";
      readonly organisationHandle: string;
      readonly workspaceHandle: string;
      readonly destination:
        | { readonly kind: "page"; readonly page: WorkspaceDetailPage }
        | {
            readonly kind: "access_subview";
            readonly page: "access";
            readonly subview: AccessSubview;
          }
        | {
            readonly kind: "resource";
            readonly page: "products" | "orders" | "suppliers";
            readonly resourceId: string;
          };
    };

type DecodedRouteSegment =
  { readonly ok: true; readonly value: string } | { readonly ok: false };

export function workspacePageDescriptor(
  page: WorkspaceDetailPage,
): WorkspacePageDescriptor {
  return WORKSPACE_PAGE_DESCRIPTORS[page];
}

export function workspacePageHeader(
  descriptor: WorkspacePageDescriptor,
  resourceId: string | null,
): { readonly title: string; readonly description: string } {
  if (resourceId === null || descriptor.resource.kind === "none") {
    return { title: descriptor.title, description: descriptor.description };
  }
  return {
    title: descriptor.resource.title,
    description: descriptor.resource.description,
  };
}

export function workspacePageDocumentTitle(
  descriptor: WorkspacePageDescriptor,
  workspaceName: string,
  resourceId: string | null,
): string {
  return `${workspacePageHeader(descriptor, resourceId).title} · ${workspaceName} · Seams Pantry`;
}

export function organisationPath(organisationHandle: string): string {
  return `/portal/${encodeURIComponent(organisationHandle)}`;
}

export function workspacePagePath(
  organisationHandle: string,
  workspaceHandle: string,
  page: WorkspaceDetailPage,
): string {
  const base = `${organisationPath(organisationHandle)}/${encodeURIComponent(workspaceHandle)}`;
  const segment = workspacePageDescriptor(page).segment;
  return segment.length === 0 ? base : `${base}/${segment}`;
}

export function workspaceAccessSubviewPath(
  organisationHandle: string,
  workspaceHandle: string,
  subview: AccessSubview,
): string {
  const base = workspacePagePath(organisationHandle, workspaceHandle, "access");
  switch (subview) {
    case "access":
      return base;
    case "capabilities":
      return `${base}/capabilities`;
    case "data_flow":
      return `${base}/data-flow`;
    default:
      return assertNever(subview, "Unhandled portal route value");
  }
}

export function workspaceResourcePath(
  organisationHandle: string,
  workspaceHandle: string,
  resource: "product" | "customer_order" | "supplier",
  resourceId: string,
): string {
  const page =
    resource === "product"
      ? "products"
      : resource === "customer_order"
        ? "orders"
        : "suppliers";
  const descriptor = workspacePageDescriptor(page);
  if (descriptor.resource.kind !== "detail") {
    return `${workspacePagePath(organisationHandle, workspaceHandle, page)}/${encodeResourceRouteSegment(resourceId)}`;
  }
  return `${organisationPath(organisationHandle)}/${encodeURIComponent(workspaceHandle)}/${descriptor.resource.detailSegment}/${encodeResourceRouteSegment(resourceId)}`;
}

/** The current path of a renamed page, or null when the path is current. */
export function renamedPagePath(pathname: string): string | null {
  const match = WORKSPACE_ROUTE_PATTERN.exec(pathname);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  if (match[3] === undefined || match[4] !== undefined) return null;
  const page = RENAMED_PAGE_SEGMENTS.get(match[3]);
  if (page === undefined) return null;
  return `/portal/${match[1]}/${match[2]}/${workspacePageDescriptor(page).segment}`;
}

export function readPortalRoute(pathname: string): PortalRoute {
  if (
    pathname === "/" ||
    pathname === "/sign-in" ||
    pathname === "/sign-in/" ||
    pathname === "/portal" ||
    pathname === "/portal/"
  ) {
    return { kind: "organisation_list" };
  }
  const match = WORKSPACE_ROUTE_PATTERN.exec(pathname);
  if (match?.[1] === undefined) {
    return routeNotFound(pathname);
  }
  const organisationHandle = decodeHandle(match[1]);
  if (!organisationHandle.ok) {
    return {
      kind: "not_found",
      organisationHandle: null,
      workspaceHandle: null,
    };
  }
  if (match[2] === undefined) {
    return {
      kind: "organisation",
      organisationHandle: organisationHandle.value,
    };
  }
  const workspaceHandle = decodeHandle(match[2]);
  if (!workspaceHandle.ok) {
    return {
      kind: "not_found",
      organisationHandle: organisationHandle.value,
      workspaceHandle: null,
    };
  }
  const page = parseWorkspaceDetailPage(match[3]);
  if (page === null) {
    return {
      kind: "not_found",
      organisationHandle: organisationHandle.value,
      workspaceHandle: workspaceHandle.value,
    };
  }
  const descriptor = workspacePageDescriptor(page);
  switch (descriptor.resource.kind) {
    case "detail":
      if (
        descriptor.segment !== descriptor.resource.detailSegment &&
        match[3] === descriptor.resource.detailSegment &&
        match[4] === undefined
      ) {
        return {
          kind: "not_found",
          organisationHandle: organisationHandle.value,
          workspaceHandle: workspaceHandle.value,
        };
      }
      if (
        match[4] !== undefined &&
        match[3] !== descriptor.resource.detailSegment
      ) {
        return {
          kind: "not_found",
          organisationHandle: organisationHandle.value,
          workspaceHandle: workspaceHandle.value,
        };
      }
      return readResourceRoute(
        descriptor.resource.resource,
        organisationHandle.value,
        workspaceHandle.value,
        match[4],
      );
    case "none":
      if (page === "access") {
        return readAccessSubviewRoute(
          organisationHandle.value,
          workspaceHandle.value,
          match[4],
        );
      }
      return match[4] === undefined
        ? {
            kind: "workspace",
            organisationHandle: organisationHandle.value,
            workspaceHandle: workspaceHandle.value,
            destination: { kind: "page", page },
          }
        : {
            kind: "not_found",
            organisationHandle: organisationHandle.value,
            workspaceHandle: workspaceHandle.value,
          };
    default:
      return assertNever(descriptor.resource, "Unhandled portal route value");
  }
}

function readAccessSubviewRoute(
  organisationHandle: string,
  workspaceHandle: string,
  segment: string | undefined,
): PortalRoute {
  const subview: AccessSubview | null =
    segment === undefined
      ? "access"
      : segment === "capabilities"
        ? "capabilities"
        : segment === "data-flow"
          ? "data_flow"
          : null;
  return subview === null
    ? { kind: "not_found", organisationHandle, workspaceHandle }
    : {
        kind: "workspace",
        organisationHandle,
        workspaceHandle,
        destination: { kind: "access_subview", page: "access", subview },
      };
}

function encodeResourceRouteSegment(resourceId: string): string {
  return encodeURIComponent(encodeURIComponent(resourceId));
}

function readResourceRoute(
  resource: "product" | "customer_order" | "supplier",
  organisationHandle: string,
  workspaceHandle: string,
  rawResourceId: string | undefined,
): PortalRoute {
  if (rawResourceId === undefined) {
    return {
      kind: "workspace",
      organisationHandle,
      workspaceHandle,
      destination: {
        kind: "page",
        page:
          resource === "product"
            ? "products"
            : resource === "customer_order"
              ? "orders"
              : "suppliers",
      },
    };
  }
  const resourceId = decodeResourceRouteSegment(rawResourceId);
  if (!resourceId.ok) {
    return { kind: "not_found", organisationHandle, workspaceHandle };
  }
  return {
    kind: "workspace",
    organisationHandle,
    workspaceHandle,
    destination: {
      kind: "resource",
      page:
        resource === "product"
          ? "products"
          : resource === "customer_order"
            ? "orders"
            : "suppliers",
      resourceId: resourceId.value,
    },
  };
}

function routeNotFound(pathname: string): PortalRoute {
  const prefix = /^\/portal(?:\/([^/]+))?(?:\/([^/]+))?/u.exec(pathname);
  const organisationHandle = decodeOptionalHandle(prefix?.[1]);
  const workspaceHandle = decodeOptionalHandle(prefix?.[2]);
  return { kind: "not_found", organisationHandle, workspaceHandle };
}

function decodeOptionalHandle(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  const decoded = decodeHandle(segment);
  return decoded.ok ? decoded.value : null;
}

function decodeHandle(segment: string): DecodedRouteSegment {
  const decoded = decodeRouteSegment(segment);
  if (
    !decoded.ok ||
    decoded.value.length > 63 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(decoded.value)
  ) {
    return { ok: false };
  }
  return decoded;
}

function decodeResourceRouteSegment(segment: string): DecodedRouteSegment {
  const first = decodeRouteSegment(segment);
  return first.ok ? decodeRouteSegment(first.value) : first;
}

function decodeRouteSegment(segment: string): DecodedRouteSegment {
  try {
    return { ok: true, value: decodeURIComponent(segment) };
  } catch {
    return { ok: false };
  }
}

function parseWorkspaceDetailPage(
  raw: string | undefined,
): WorkspaceDetailPage | null {
  if (raw === undefined || RETIRED_PAGE_SEGMENTS.includes(raw))
    return "overview";
  const renamed = RENAMED_PAGE_SEGMENTS.get(raw);
  if (renamed !== undefined) return renamed;
  for (const descriptor of WORKSPACE_PAGE_DESCRIPTOR_LIST) {
    if (
      descriptor.segment === raw ||
      (descriptor.resource.kind === "detail" &&
        descriptor.resource.detailSegment === raw)
    ) {
      return descriptor.page;
    }
  }
  return null;
}

function buildWorkspaceRoutePattern(
  descriptors: readonly WorkspacePageDescriptor[],
): RegExp {
  const segments = descriptors
    .flatMap(routeSegments)
    .filter(nonEmptySegment)
    .filter(uniqueSegment)
    .concat(RETIRED_PAGE_SEGMENTS, [...RENAMED_PAGE_SEGMENTS.keys()])
    .map(escapeRegularExpression)
    .join("|");
  return new RegExp(
    `^/portal/([^/]+)(?:/([^/]+)(?:/(${segments})(?:/([^/]+))?)?)?/?$`,
    "u",
  );
}

function routeSegments(descriptor: WorkspacePageDescriptor): readonly string[] {
  return descriptor.resource.kind === "detail"
    ? [descriptor.segment, descriptor.resource.detailSegment]
    : [descriptor.segment];
}

function uniqueSegment(
  segment: string,
  index: number,
  values: readonly string[],
): boolean {
  return values.indexOf(segment) === index;
}

function nonEmptySegment(segment: string): boolean {
  return segment.length > 0;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function initialFileAccessPath(
  organisationHandle: string,
  workspaceHandle: string,
  provider: FileContextProvider,
): string {
  const path = workspacePagePath(organisationHandle, workspaceHandle, "access");
  return `${path}?setup=files&provider=${provider}`;
}
