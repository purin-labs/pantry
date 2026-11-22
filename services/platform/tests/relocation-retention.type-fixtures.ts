import type {
  ActorRelocation,
  ActorRelocationId,
  RelocationPreflightInventory,
} from "../src/actors/actor-relocation";
import type { OrganisationId } from "@purin-labs/kernel/ids";

declare const relocationId: ActorRelocationId;
declare const organisationId: OrganisationId;
declare const preflight: RelocationPreflightInventory;
const retained: ActorRelocation = {
  preflight,
  relocationId,
  organisationId,
  sourcePlacementEpoch: 1,
  targetPlacementEpoch: 2,
  createdAt: 1,
  frozenAt: 2,
  publishedAt: 3,
  resumedAt: 4,
  retainUntil: 604800004,
  status: "retained",
};
// @ts-expect-error A retained source has no cleanup-completion timestamp.
const prematureCompletion: ActorRelocation = { ...retained, completedAt: 5 };
// @ts-expect-error Cleanup completion must retain the resumption and retention evidence.
const missingEvidence: ActorRelocation = {
  preflight,
  relocationId,
  organisationId,
  sourcePlacementEpoch: 1,
  targetPlacementEpoch: 2,
  createdAt: 1,
  frozenAt: 2,
  publishedAt: 3,
  completedAt: 7,
  status: "complete",
};
void prematureCompletion;
void missingEvidence;

const abandoned: ActorRelocation = {
  preflight,
  relocationId,
  organisationId,
  sourcePlacementEpoch: 1,
  targetPlacementEpoch: 2,
  createdAt: 1,
  frozenAt: 2,
  abandonedAt: 3,
  recoveryRelocationId: relocationId,
  status: "abandoned",
};
// @ts-expect-error An abandoned move cannot have published its target.
const publishedAbandonment: ActorRelocation = { ...abandoned, publishedAt: 4 };
// @ts-expect-error Recovery must have a durable successor operation.
const missingRecovery: ActorRelocation = {
  preflight,
  relocationId,
  organisationId,
  sourcePlacementEpoch: 1,
  targetPlacementEpoch: 2,
  createdAt: 1,
  frozenAt: 2,
  abandonedAt: 3,
  status: "abandoned",
};
import type { OrganisationPlacementRecord } from "@purin-labs/tenancy/data/organisation-placement";
declare const abandonedPlacement: Extract<
  OrganisationPlacementRecord,
  { status: "abandoned" }
>;
// @ts-expect-error A never-published target has no activation timestamp.
const activatedAbandonedPlacement: OrganisationPlacementRecord = {
  ...abandonedPlacement,
  activatedAt: 4,
};
void publishedAbandonment;
void missingRecovery;
void activatedAbandonedPlacement;
