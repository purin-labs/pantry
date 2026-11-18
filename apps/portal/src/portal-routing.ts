import {
  brainAddress,
  brainAddressSearch,
  brainViewSection,
  readBrainAddress,
  type BrainView,
} from "./features/brain/address";
import {
  workspaceResourcePath,
  type AccessSubview,
  type PortalRoute,
  type WorkspaceDetailPage,
} from "./route";
import {
  MutationLedger,
  type OrganisationMutation,
} from "./mutation-state";
import type { CommerceActionRecord } from "@seams/control-api/portal/commerce-actions";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

export type WorkspaceRouteSelection = {
  readonly organisationId: string;
  readonly page: WorkspaceDetailPage;
  readonly resourceId: string | null;
  readonly accessSubview: AccessSubview;
};

export function mutationKindActive(
  mutations: MutationLedger,
  kind: OrganisationMutation["kind"],
): boolean {
  return mutations.toArray().some(mutationHasKind.bind(null, kind));
}

export function commerceActionRefreshKey(action: CommerceActionRecord | null): string {
  return action === null ? "none" : `${action.nonce}:${action.state}`;
}

function mutationHasKind(
  kind: OrganisationMutation["kind"],
  mutation: OrganisationMutation,
): boolean {
  return mutation.kind === kind;
}

export function workspaceRouteSelection(
  route: Variant<PortalRoute, "workspace">,
  organisationId: string,
): WorkspaceRouteSelection {
  switch (route.destination.kind) {
    case "page":
      return {
        organisationId,
        page: route.destination.page,
        resourceId: null,
        accessSubview: "access",
      };
    case "access_subview":
      return {
        organisationId,
        page: "access",
        resourceId: null,
        accessSubview: route.destination.subview,
      };
    case "resource":
      return {
        organisationId,
        page: route.destination.page,
        resourceId: route.destination.resourceId,
        accessSubview: "access",
      };
    default:
      return assertNever(route.destination, "Unexpected portal state");
  }
}

export function currentWorkspaceRouteSelection(
  route: PortalRoute,
  organisationId: string,
  organisationHandle: string,
  workspaceHandle: string,
  page: WorkspaceDetailPage,
): WorkspaceRouteSelection {
  if (route.kind !== "workspace") {
    return { organisationId, page, resourceId: null, accessSubview: "access" };
  }
  const selection = workspaceRouteSelection(route, organisationId);
  return route.organisationHandle === organisationHandle &&
    route.workspaceHandle === workspaceHandle &&
    selection.page === page
    ? selection
    : { organisationId, page, resourceId: null, accessSubview: "access" };
}

export function isCommercePage(
  page: WorkspaceDetailPage,
): page is "products" | "orders" | "suppliers" {
  return page === "products" || page === "orders" || page === "suppliers";
}

/** Where an old Brain address opens: the page that holds its view. */
export function brainLegacyPath(
  knowledgePath: string,
  search: string,
  firstView: BrainView,
): string {
  const query = new URLSearchParams(search);
  if (!query.has("view")) query.set("view", firstView);
  const address = readBrainAddress(`?${query.toString()}`);
  const slash = knowledgePath.lastIndexOf("/");
  const section = brainViewSection(address.view);
  return `${knowledgePath.slice(0, slash + 1)}${section}${brainAddressSearch(address, search)}`;
}

/** The Knowledge page with one Memory open in its Knowledge view. */
export function brainMemoryPath(brainPath: string, memoryId: string): string {
  return `${brainPath}${brainAddressSearch(brainAddress("knowledge", { memoryId }), "")}`;
}

export function commerceResourceHref(
  organisationHandle: string,
  workspaceHandle: string,
  resourceId: string,
  kind: "product" | "order" | "supplier",
): string {
  return workspaceResourcePath(
    organisationHandle,
    workspaceHandle,
    kind === "product"
      ? "product"
      : kind === "order"
        ? "customer_order"
        : "supplier",
    resourceId,
  );
}
