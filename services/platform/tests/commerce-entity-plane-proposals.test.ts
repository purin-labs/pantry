import { describe, expect, it } from "vitest";

import {
  parseCommerceEntityPlaneEffect,
  parseCommerceEntityPlaneProposal,
} from "../src/commerce/entity-plane/proposals";
import { assertNever } from "@seams/std";

type ProposalKind =
  | "patch_custom_entity"
  | "create_custom_relationship"
  | "delete_custom_relationship"
  | "replace_custom_relationship"
  | "add_commerce_list_entry"
  | "patch_commerce_list_entry"
  | "remove_commerce_list_entry";
type ProposalFixture = Record<string, unknown> & { kind: ProposalKind };

describe("commerce entity-plane proposals and effects", () => {
  it("parses every exact proposal branch", () => {
    for (const proposal of proposals()) {
      expect(parseCommerceEntityPlaneProposal(proposal)).toMatchObject({
        kind: proposal.kind,
      });
    }
  });

  it("rejects malformed revisions and effect target drift", () => {
    const patch = proposals()[0];
    if (!patch) throw new Error("missing patch fixture");
    expect(
      parseCommerceEntityPlaneProposal({ ...patch, expectedRevision: 0 }),
    ).toBeNull();

    const effect = effectFor(patch);
    const receipt = record(effect.receipt);
    expect(
      parseCommerceEntityPlaneEffect({
        ...effect,
        receipt: { ...receipt, deliveryId: null },
      }),
    ).toBeNull();
    const target = record(receipt.target);
    const entityRef = record(target.entityRef);
    expect(
      parseCommerceEntityPlaneEffect({
        ...effect,
        receipt: {
          ...receipt,
          target: {
            ...target,
            entityRef: { ...entityRef, entityId: "entity_other" },
          },
        },
      }),
    ).toBeNull();
  });

  it("retains receipt evidence for each proposal branch", () => {
    for (const proposal of proposals()) {
      const parsed = parseCommerceEntityPlaneEffect(effectFor(proposal));
      expect(parsed).toMatchObject({
        kind: proposal.kind,
        receipt: { commandId: "command_1" },
      });
    }
  });

  it("rejects unknown fields at proposal, effect, and receipt boundaries", () => {
    const proposal = proposals()[0];
    if (!proposal) throw new Error("missing patch fixture");
    expect(
      parseCommerceEntityPlaneProposal({ ...proposal, unexpected: true }),
    ).toBeNull();

    const effect = effectFor(proposal);
    expect(
      parseCommerceEntityPlaneEffect({ ...effect, unexpected: true }),
    ).toBeNull();
    const receipt = record(effect.receipt);
    expect(
      parseCommerceEntityPlaneEffect({
        ...effect,
        receipt: { ...receipt, unexpected: true },
      }),
    ).toBeNull();
    const signer = record(receipt.signer);
    expect(
      parseCommerceEntityPlaneEffect({
        ...effect,
        receipt: { ...receipt, signer: { ...signer, unexpected: true } },
      }),
    ).toBeNull();
    expect(
      parseCommerceEntityPlaneEffect({ ...effect, attributes: [] }),
    ).toBeNull();
    expect(
      parseCommerceEntityPlaneEffect({ ...effect, displayName: null }),
    ).toBeNull();

    const addEffect = effectFor(proposals()[3] ?? proposal);
    expect(
      parseCommerceEntityPlaneEffect({ ...addEffect, attributeValues: [] }),
    ).toBeNull();
    const patchEntryEffect = effectFor(proposals()[4] ?? proposal);
    expect(
      parseCommerceEntityPlaneEffect({
        ...patchEntryEffect,
        attributeValues: [],
      }),
    ).toBeNull();
  });
});

function proposals(): readonly ProposalFixture[] {
  const entityRef = {
    origin: "custom",
    typeId: "customer",
    entityId: "customer_1",
  };
  const definition = {
    origin: "custom",
    definitionId: "customer_order",
    revision: 1,
  };
  const relationship = {
    origin: "custom",
    relationshipId: "relationship_1",
    definition,
    revision: 1,
  };
  const entry = {
    entryId: "entry_1",
    listId: "export_coordination",
    revision: 1,
  };
  return [
    {
      kind: "patch_custom_entity",
      entityRef,
      typeRevision: 1,
      expectedRevision: 1,
      attributes: [],
      displayName: null,
    },
    {
      kind: "create_custom_relationship",
      relationshipId: "relationship_1",
      definition,
      source: entityRef,
      target: { origin: "custom", typeId: "order", entityId: "order_1" },
    },
    { kind: "delete_custom_relationship", relationship },
    {
      kind: "replace_custom_relationship",
      relationship,
      replacementTarget: {
        origin: "custom",
        typeId: "order",
        entityId: "order_2",
      },
    },
    {
      kind: "add_commerce_list_entry",
      entryId: "entry_1",
      listId: "export_coordination",
      expectedListRevision: 1,
      entityRef,
      attributeValues: [],
      revision: 1,
    },
    {
      kind: "patch_commerce_list_entry",
      entry: { entry, expectedRevision: 1 },
      expectedListRevision: 1,
      attributeValues: [],
    },
    {
      kind: "remove_commerce_list_entry",
      entry: { entry, expectedRevision: 1 },
    },
  ];
}

function effectFor(proposal: ProposalFixture): Record<string, unknown> {
  const receiptTarget = receiptTargetFor(proposal);
  const receipt = {
    commandId: "command_1",
    outcome: "applied",
    target: receiptTarget,
    merchantRevision: 2,
    committedAt: "2026-08-25T00:00:00.000Z",
    deliveryId: "entity_plane:merchant_fixture:2:command_1",
    signer: { keyId: "key_1", algorithm: "ed25519", signature: "signature_1" },
  };
  switch (proposal.kind) {
    case "patch_custom_entity":
      return {
        kind: proposal.kind,
        entityRef: proposal.entityRef,
        typeRevision: proposal.typeRevision,
        expectedRevision: proposal.expectedRevision,
        receipt,
      };
    case "create_custom_relationship":
      return {
        kind: proposal.kind,
        relationshipId: proposal.relationshipId,
        definition: proposal.definition,
        source: proposal.source,
        target: proposal.target,
        receipt,
      };
    case "replace_custom_relationship":
      return {
        kind: proposal.kind,
        relationship: proposal.relationship,
        replacementTarget: proposal.replacementTarget,
        receipt,
      };
    case "delete_custom_relationship":
      return {
        kind: proposal.kind,
        relationship: proposal.relationship,
        receipt,
      };
    case "add_commerce_list_entry":
      return {
        kind: proposal.kind,
        entryId: proposal.entryId,
        listId: proposal.listId,
        expectedListRevision: proposal.expectedListRevision,
        entityRef: proposal.entityRef,
        revision: proposal.revision,
        receipt,
      };
    case "patch_commerce_list_entry":
      return {
        kind: proposal.kind,
        entry: proposal.entry,
        expectedListRevision: proposal.expectedListRevision,
        receipt,
      };
    case "remove_commerce_list_entry":
      return { kind: proposal.kind, entry: proposal.entry, receipt };
  }
}

function receiptTargetFor(proposal: ProposalFixture): Record<string, unknown> {
  switch (proposal.kind) {
    case "patch_custom_entity":
      return {
        kind: "custom_entity",
        entityRef: proposal.entityRef,
        revision: 2,
      };
    case "create_custom_relationship":
      return {
        kind: "custom_relationship",
        relationship: {
          origin: "custom",
          relationshipId: proposal.relationshipId,
          definition: proposal.definition,
          revision: 1,
        },
      };
    case "delete_custom_relationship":
    case "replace_custom_relationship":
      return {
        kind: "custom_relationship",
        relationship: {
          ...record(proposal.relationship),
          revision: number(record(proposal.relationship).revision) + 1,
        },
      };
    case "add_commerce_list_entry":
      return {
        kind: "commerce_list_entry",
        entry: {
          entryId: proposal.entryId,
          listId: proposal.listId,
          revision: proposal.revision,
        },
        revision: proposal.revision,
      };
    case "patch_commerce_list_entry": {
      const entry = record(proposal.entry);
      return {
        kind: "commerce_list_entry",
        entry: { ...record(entry.entry), revision: 2 },
        revision: 2,
      };
    }
    case "remove_commerce_list_entry": {
      const entry = record(proposal.entry);
      const currentRevision = number(record(entry.entry).revision);
      return {
        kind: "commerce_list_entry",
        entry: { ...record(entry.entry), revision: currentRevision + 1 },
        revision: currentRevision + 1,
      };
    }
    default:
      return assertNever(proposal.kind, "unexpected proposal kind");
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected record fixture");
  }
  return value as Record<string, unknown>;
}

function number(value: unknown): number {
  if (typeof value !== "number") throw new Error("expected numeric fixture");
  return value;
}
