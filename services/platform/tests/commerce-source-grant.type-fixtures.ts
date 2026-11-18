import type { AccessGrantTargetSelection } from "@seams/control-api/portal/access-models";

const paymentRead = {
  kind: "commerce_entity_type",
  capabilityRef: { capabilityId: "commerce.entity.read", capabilityVersion: 1 },
  entityTypeId: { origin: "system", typeId: "payment" },
} satisfies AccessGrantTargetSelection;

// @ts-expect-error A commerce record grant requires its exact record type.
const missingScope: AccessGrantTargetSelection = {
  kind: "commerce_entity_type",
  capabilityRef: paymentRead.capabilityRef,
};

const platformWithScope = { ...paymentRead, kind: "platform" as const };
// @ts-expect-error Broad spreads cannot attach commerce scope to a platform grant.
const invalidPlatform: AccessGrantTargetSelection = platformWithScope;

const unknownType = {
  ...paymentRead,
  entityTypeId: { origin: "system" as const, typeId: "unknown" as const },
};
// @ts-expect-error Untrusted record names must pass the canonical type parser.
const invalidType: AccessGrantTargetSelection = unknownType;

void missingScope;
void invalidPlatform;
void invalidType;
