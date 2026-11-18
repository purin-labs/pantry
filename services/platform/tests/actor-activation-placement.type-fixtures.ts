import type { ActorRestoreManifest } from "../src/actors/actor-restore-manifest";
import type { ActorPlacementAdmission } from "../src/actors/actor-placement-admission";
import type {
  ActorActivationIdentity,
  ActorActivationRequest,
} from "../src/actors/actor-registry";

declare const identity: ActorActivationIdentity;
declare const execution: Extract<
  ActorPlacementAdmission,
  { kind: "execution" }
>;
declare const relocation: Extract<
  ActorPlacementAdmission,
  { kind: "relocation" }
>;
const { identity: copiedIdentity, ...unboundCopy } = relocation;

// @ts-expect-error Identity alone cannot authorize an Actor activation.
const missingAdmission: ActorActivationRequest = { ...identity };
// @ts-expect-error Execution admission cannot carry a relocation operation.
const mixedExecution: ActorPlacementAdmission = {
  ...relocation,
  kind: "execution",
};
// @ts-expect-error A staged restore requires its own operation and frozen source fence.
const missingRestore: ActorPlacementAdmission = {
  ...execution,
  kind: "restore",
};
// @ts-expect-error A relocation admission spread cannot become a restore admission.
const mixedCopy: ActorPlacementAdmission = { ...relocation, kind: "restore" };
// @ts-expect-error A staged copy requires the identity of its journaled Actor.
const missingCopyIdentity: ActorPlacementAdmission = unboundCopy;

void missingAdmission;
void mixedExecution;
void missingRestore;
void mixedCopy;
void copiedIdentity;
void missingCopyIdentity;

declare const recovery: Extract<ActorRestoreManifest, { version: 2 }>;
const { retiredActors, ...recoveryWithoutRetirements } = recovery;
// @ts-expect-error Version two requires an explicit retirement inventory.
const missingRetirements: ActorRestoreManifest = recoveryWithoutRetirements;
// @ts-expect-error Version one cannot carry retirement records through a broad spread.
const downgradedRecovery: ActorRestoreManifest = { ...recovery, version: 1 };
void retiredActors;
void missingRetirements;
void downgradedRecovery;
