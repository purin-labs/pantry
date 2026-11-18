import type { TypeSafeConnectionView } from "../src/integrations/typesafe/connection";
import type { EnabledCaseContextDiscoveryPolicy } from "../src/case-context-discovery/policy";

const connected = {
  kind: "connected" as const,
  revision: 1,
  provider: "typesafe" as const,
  testedAt: 1,
};
const disconnected = { kind: "disconnected" as const, revision: 2 };

export const leakedKey: TypeSafeConnectionView = {
  ...connected,
  // @ts-expect-error Public connection views cannot carry credentials through a spread.
  apiKey: "secret",
};
export const leakedHandle: TypeSafeConnectionView = {
  ...connected,
  // @ts-expect-error Vault handles remain inside the organisation Actor.
  handle: "vault:organisation:jev:secret",
};
// @ts-expect-error Disconnected connections cannot carry a provider identity.
export const mixedState: TypeSafeConnectionView = {
  ...disconnected,
  provider: "typesafe",
};
// @ts-expect-error Connection generation is required to fence provider changes.
export const unpinned: EnabledCaseContextDiscoveryPolicy["route"] = {
  provider: "typesafe",
  funding: "organisation_byo",
  credentialRef: "organisation_typesafe",
};
export const sharedFunding: EnabledCaseContextDiscoveryPolicy["route"] = {
  provider: "typesafe",
  connectionRevision: 1,
  // @ts-expect-error CaseContextCollection discovery cannot spend Pantry's shared account funds.
  funding: "platform",
  credentialRef: "organisation_typesafe",
};
