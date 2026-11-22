import type { ActorRelocationId } from "../src/actors/actor-relocation";
import type { ActorRestoreId } from "../src/actors/actor-restore";
import type { OrganisationPlacementPublication } from "@purin-labs/tenancy/data/organisation-placement";

declare const relocationId: ActorRelocationId;
declare const restoreId: ActorRestoreId;
declare const restore: { readonly operationId: ActorRestoreId };

({
  kind: "relocation",
  operationId: relocationId,
}) satisfies OrganisationPlacementPublication;
({
  kind: "restore",
  operationId: restoreId,
}) satisfies OrganisationPlacementPublication;

// @ts-expect-error A relocation cannot publish a restore journal.
const invalidRelocation: OrganisationPlacementPublication = {
  kind: "relocation",
  operationId: restoreId,
};
// @ts-expect-error Spreading restore identity cannot create relocation authority.
({ ...restore, kind: "relocation" }) satisfies OrganisationPlacementPublication;
// @ts-expect-error Publication always requires an operation identity.
({ kind: "restore" }) satisfies OrganisationPlacementPublication;
