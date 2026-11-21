// The ports that the Worker registers (worker-ports.ts).
import "../src/worker-ports";
import type { CapabilityDefinition } from "@purin-labs/contracts";
import { describe, expect, it } from "vitest";

import { ACTION_REGISTRY } from "../action-registry/registry";
import { harnessBaseCapabilities } from "../src/agent-tools/catalog/selection";
import { TOOL_REGISTRY } from "../src/agent-tools/registry";
import {
  CONTEXT_CASE_READ_CAPABILITY,
  CASE_CONTEXT_COLLECTION_METADATA_READ_CAPABILITY,
} from "../src/authorization/access-grants/turn-authority";
import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_KEYS,
  compileCapabilityCatalogue,
} from "../src/authorization/capability-catalogue";
import { PROVIDER_ADAPTERS } from "../src/provider-adapters/catalogue";
import { CUSTOM_CONNECTOR_CAPABILITY_IDS } from "../src/custom-connectors";

describe("capability catalogue", capabilityCatalogueSuite);

function capabilityCatalogueSuite(): void {
  it(
    "covers executable harness and provider action definitions",
    coversExecutableDefinitions,
  );
  it(
    "binds provider dependencies to adapter metadata",
    bindsProviderDependencies,
  );
  it(
    "keeps CaseContextCollection metadata out of the agent tool surface",
    hidesCaseContextCollections,
  );
  it("rejects duplicate keys", rejectsDuplicateKeys);
  it("rejects resource definitions without a provider", rejectsMissingProvider);
}

function hidesCaseContextCollections(): void {
  expect(harnessBaseCapabilities(TOOL_REGISTRY)).not.toContain(
    CASE_CONTEXT_COLLECTION_METADATA_READ_CAPABILITY,
  );
}

/**
 * Commands Commerce implements and no provider does.
 *
 * These have no entry in PROVIDER_ADAPTERS because there is no provider to
 * carry them: Commerce is the executor. Listing them here keeps the
 * ownership check exhaustive rather than loosening it.
 */
const COMMERCE_NATIVE_CAPABILITIES: readonly string[] = [
  CAPABILITY_KEYS.commerceRelationshipReplace,
  CAPABILITY_KEYS.commerceOfferAdjustPrice,
  CAPABILITY_KEYS.commercePluginInstall,
  CAPABILITY_KEYS.commerceCatalogUpdateDescription,
  // Supplier payables, payouts and destinations are Pantry's own records. No
  // provider carries them, and the two provider-side transfer submissions are
  // deliberately absent until an adapter exists to execute them.
  CAPABILITY_KEYS.commerceSupplierPayoutRead,
  CAPABILITY_KEYS.commerceSupplierPayoutPropose,
  CAPABILITY_KEYS.commerceSupplierPayoutSubmit,
  CAPABILITY_KEYS.commerceSupplierDestinationPropose,
  CAPABILITY_KEYS.commerceSupplierDestinationActivate,
];

function coversExecutableDefinitions(): void {
  const catalogueIds = new Set(CAPABILITY_CATALOGUE.map(readCapabilityId));
  const ownedIds = new Set<string>([
    CONTEXT_CASE_READ_CAPABILITY,
    CASE_CONTEXT_COLLECTION_METADATA_READ_CAPABILITY,
    ...COMMERCE_NATIVE_CAPABILITIES,
    ...CUSTOM_CONNECTOR_CAPABILITY_IDS,
    // The voice routes check this one; no agent tool runs it.
    CAPABILITY_KEYS.voiceTranscription,
  ]);
  for (const capabilityId of COMMERCE_NATIVE_CAPABILITIES) {
    expect(catalogueIds.has(capabilityId)).toBe(true);
  }
  expect(catalogueIds.has(CONTEXT_CASE_READ_CAPABILITY)).toBe(true);
  expect(
    catalogueIds.has(CASE_CONTEXT_COLLECTION_METADATA_READ_CAPABILITY),
  ).toBe(true);
  for (const capabilityId of harnessBaseCapabilities(TOOL_REGISTRY)) {
    expect(catalogueIds.has(capabilityId)).toBe(true);
    ownedIds.add(capabilityId);
  }
  for (const action of ACTION_REGISTRY) {
    expect(catalogueIds.has(action.capabilityId)).toBe(true);
  }
  for (const adapter of Object.values(PROVIDER_ADAPTERS)) {
    for (const capabilityId of adapter.capabilityIds)
      ownedIds.add(capabilityId);
  }
  expect([...ownedIds].sort()).toEqual([...catalogueIds].sort());
}

function bindsProviderDependencies(): void {
  const advertised = new Map<string, Set<string>>();
  for (const adapter of Object.values(PROVIDER_ADAPTERS)) {
    for (const capabilityId of adapter.capabilityIds) {
      const providers = advertised.get(capabilityId) ?? new Set<string>();
      providers.add(adapter.provider);
      advertised.set(capabilityId, providers);
    }
  }
  for (const definition of CAPABILITY_CATALOGUE) {
    switch (definition.providerDependency.kind) {
      case "none":
        expect(advertised.has(definition.capabilityId)).toBe(false);
        break;
      case "provider": {
        const providers = advertised.get(definition.capabilityId);
        expect(providers).toBeDefined();
        expect(providers === undefined ? [] : [...providers].sort()).toEqual(
          [...definition.providerDependency.providers].sort(),
        );
        break;
      }
      case "commerce_system": {
        // A capability available on Shopify is advertised by its adapter; one
        // that only Commerce implements is advertised by no provider.
        const systems = [...definition.providerDependency.systems].sort();
        const providers = [...(advertised.get(definition.capabilityId) ?? [])];
        if (systems.includes("shopify")) {
          expect(systems).toEqual(["builtin_commerce", "shopify"]);
          expect(providers).toEqual(["shopify"]);
        } else {
          expect(systems).toEqual(["builtin_commerce"]);
          expect(providers).toEqual([]);
        }
        break;
      }
    }
  }
  expect(
    CAPABILITY_CATALOGUE.find(
      (definition) =>
        definition.capabilityId === CAPABILITY_KEYS.commerceListEntryPatch,
    )?.providerDependency,
  ).toEqual({
    kind: "commerce_system",
    systems: ["builtin_commerce", "shopify"],
  });
}

function rejectsDuplicateKeys(): void {
  const definition = CAPABILITY_CATALOGUE[0];
  if (definition === undefined)
    throw new Error("Capability catalogue is empty");
  expect(() => compileCapabilityCatalogue([definition, definition])).toThrow(
    "Duplicate capability catalogue key",
  );
}

function rejectsMissingProvider(): void {
  const invalid: CapabilityDefinition = {
    capabilityId: "file.read",
    capabilityVersion: 1,
    label: "Read connected files",
    description: "Read approved connected files.",
    category: "customer_data",
    risk: "read",
    target: "file_resource",
    providerDependency: { kind: "provider", providers: [] },
    policyModes: "enabled_disabled",
  };
  expect(() => compileCapabilityCatalogue([invalid])).toThrow(
    "Resource capability lacks a provider dependency",
  );
}

function readCapabilityId(definition: CapabilityDefinition): string {
  return definition.capabilityId;
}
