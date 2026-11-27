// The Shopify part of the Organisation actor (Refactor 17, step A2.5): the
// observed locations of the selected shop in the Actor SQLite. The Worker
// registers the part (`worker-ports.ts`), and `OrganisationDO` has one RPC
// method for each command.
import { isOrganisationExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import { resolveOrganisationCommerceSystemAuthority } from "@purin-labs/connections/data/organisation-commerce-system";
import type { ProviderOrganisationPart } from "@purin-labs/area-integrations/server/contract/provider-modules";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationModuleHost } from "@purin-labs/tenancy/actors/organisation/module-host";
import {
  organisationPlacementConflict,
  validateActionOrganisation,
} from "@purin-labs/tenancy/actors/organisation/organisation-record";
import type { OrganisationStateError } from "@purin-labs/tenancy/actors/organisation/types";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import {
  acceptShopifyLocationObservation,
  assignShopifyLocationClassification,
  createShopifyLocationObservationSchema,
  shopifyLocationClassificationAuthority,
  shopifyLocationProjectionAuthority,
  type AssignShopifyLocationClassificationInput,
  type ShopifyLocationClassificationAssignmentError,
  type ShopifyLocationClassificationAssignmentResult,
  type ShopifyLocationObservationAcceptanceError,
  type ShopifyLocationObservationInput,
  type ShopifyLocationObservationResult,
} from "./location-observation";

/** The location commands of one Organisation actor. */
class ShopifyOrganisationLocations {
  constructor(private readonly host: OrganisationModuleHost) {}

  async acceptShopifyLocationObservation(
    input: ShopifyLocationObservationInput,
  ) {
    return this.host.command(
      input.organisationId,
      this.admittedAcceptShopifyLocationObservation.bind(this, input),
    );
  }

  async assignShopifyLocationClassification(
    input: AssignShopifyLocationClassificationInput,
  ) {
    return this.host.command(
      input.organisationId,
      this.admittedAssignShopifyLocationClassification.bind(this, input),
    );
  }

  private async admittedAcceptShopifyLocationObservation(
    input: ShopifyLocationObservationInput,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ShopifyLocationObservationResult,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | ShopifyLocationObservationAcceptanceError
    >
  > {
    const storage = this.host.ctx.storage;
    const organisation = validateActionOrganisation(
      storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const selected = await resolveOrganisationCommerceSystemAuthority({
      db: scope.database,
      organisationId: input.organisationId,
    });
    const projectionAuthority = shopifyLocationProjectionAuthority(
      selected,
      input.integrationAccountId,
    );
    if (!(await isOrganisationExecutionActive(storage.sql, scope)))
      return organisationPlacementConflict();
    return storage.transactionSync(
      acceptShopifyLocationObservation.bind(
        null,
        storage.sql,
        input,
        projectionAuthority,
      ),
    );
  }

  private async admittedAssignShopifyLocationClassification(
    input: AssignShopifyLocationClassificationInput,
    scope: OrganisationExecutionScope,
  ): Promise<
    Result<
      ShopifyLocationClassificationAssignmentResult,
      | OrganisationStateError
      | { readonly code: "organisation_placement_conflict" }
      | ShopifyLocationClassificationAssignmentError
    >
  > {
    const storage = this.host.ctx.storage;
    const organisation = validateActionOrganisation(
      storage.sql,
      input.organisationId,
    );
    if (!organisation.ok) {
      return organisation;
    }
    const selected = await resolveOrganisationCommerceSystemAuthority({
      db: scope.database,
      organisationId: input.organisationId,
    });
    const commerceSystem = shopifyLocationClassificationAuthority(
      selected,
      input.integrationAccountId,
    );
    if (!commerceSystem.ok) return commerceSystem;
    if (!(await isOrganisationExecutionActive(storage.sql, scope)))
      return organisationPlacementConflict();
    return storage.transactionSync(
      assignShopifyLocationClassification.bind(
        null,
        storage.sql,
        input,
        commerceSystem.value,
      ),
    );
  }
}

/** The RPC methods of this part. `OrganisationDO` has one method for each. */
export type ShopifyOrganisationRpc = Pick<
  ShopifyOrganisationLocations,
  "acceptShopifyLocationObservation" | "assignShopifyLocationClassification"
>;

export const SHOPIFY_ORGANISATION_PART: ProviderOrganisationPart<ShopifyOrganisationRpc> =
  {
    createSchema: createShopifyLocationObservationSchema,
    open: (host) => new ShopifyOrganisationLocations(host),
  };
