import type { AccessTargetRef } from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import type {
  AccessGrantTarget,
  CommerceReadGrantScope,
} from "../authorization/access-grants/types";
import type { Env } from "../env";
import type { OrganisationId } from "../ids";
import { definePort } from "../port";
import type { Result } from "../result";

type CommerceCommandTarget = Variant<AccessGrantTarget, "commerce_command">;
type CommerceProviderTarget = Variant<AccessGrantTarget, "provider_resource">;

/** A commerce record that the Access page can grant, with its grant targets. */
export type PublishedCommerceTarget =
  | Readonly<{
      kind: "list_entry";
      target: CommerceCommandTarget;
      providerTarget: CommerceProviderTarget;
      targetRef: AccessTargetRef;
      label: string;
      detail: "Published commerce list entry";
    }>
  | Readonly<{
      kind: "product";
      target?: never;
      providerTarget: CommerceProviderTarget;
      targetRef: AccessTargetRef;
      label: string;
      detail: "Seams Checkout product";
    }>;

/** The record type of a commerce read grant. */
export type CommerceGrantEntityTypeId = Variant<
  CommerceReadGrantScope,
  "entity_type"
>["entityTypeId"];

/** The list of a commerce list read grant. */
type CommerceGrantListId = Variant<
  CommerceReadGrantScope,
  "commerce_list"
>["listId"];

/**
 * The commerce parts of the access-control routes: the published commerce
 * records that a grant can name, and the checks of a record type and a list
 * of a new read grant. Commerce gives the implementation, and the Worker
 * registers it (`worker-ports.ts`).
 */
export type CommerceAccessTargets = Readonly<{
  listPublishedTargets(
    input: Readonly<{ env: Env; organisationId: OrganisationId }>,
  ): Promise<Result<readonly PublishedCommerceTarget[], "unavailable">>;
  resolvePublishedTarget(
    input: Readonly<{
      env: Env;
      organisationId: OrganisationId;
      targetRef: AccessTargetRef;
    }>,
  ): Promise<Result<PublishedCommerceTarget, "unavailable" | "not_found">>;
  /** The record type of a grant request, or null when it is not one. */
  parseEntityTypeId(raw: unknown): CommerceGrantEntityTypeId | null;
  /** The list of a list read, checked as a list page query, or null. */
  parseListReadId(listId: string): CommerceGrantListId | null;
}>;

export const commerceAccessTargets = definePort<CommerceAccessTargets>(
  "commerce_access_targets",
);
