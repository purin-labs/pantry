import { expect, it } from "vitest";
import {
  parseCommerceGraphQuery,
  parseEntityPlaneObservation,
} from "@seams/commerce-client";
import {
  commerceEntityPlaneCueSelectors,
  createCommerceEntityPlaneCueEvents,
  createCueQueueMessage,
  parseCueQueueMessage,
} from "../src/cues/engine";
import {
  matchesEntityPlaneScope,
  matchesEntityPlaneScopeAtAdmission,
} from "../src/data/agent-operations/automation";
import type {
  AgentResponsibilityScope,
  SavedSelectorCueResolverInput,
} from "../src/data/agent-operations";
import {
  parseIntegrationAccountId,
  parseRequestId,
  parseOrganisationId,
} from "../src/ids";

it("derives exact entity-plane selectors and rejects a nonmatching responsibility scope", () => {
  const organisationId = parseOrganisationId("organisation_entity_plane_cue");
  const integrationAccountId = parseIntegrationAccountId(
    "integration_entity_plane_cue",
  );
  if (!organisationId.ok || !integrationAccountId.ok)
    throw new Error("invalid cue fixture identity");
  const observation = parseEntityPlaneObservation({
    kind: "commerce_list_entry_changed",
    observationId: "observation_list_entry",
    entry: { entryId: "entry_a", listId: "list_a", revision: 2 },
    entityRef: {
      origin: "custom",
      typeId: "trade_partner",
      entityId: "partner_a",
    },
    revision: 2,
    merchantRevision: 7,
  });
  const event = createCommerceEntityPlaneCueEvents({
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    deliveryId: "delivery_entity_plane_cue",
    merchantId: "merchant_entity_plane_cue",
    merchantRevision: 7,
    observedAt: "2026-08-09T10:00:00Z",
    observations: [observation],
    at: Date.parse("2026-08-09T10:00:00Z"),
  })[0];
  if (event === undefined) throw new Error("missing cue event");
  const requestId = parseRequestId("23eb2c7a-c3a3-4bfb-a61c-4cbf1adb7046");
  if (!requestId.ok) throw new Error("invalid cue request identity");
  const queueMessage = createCueQueueMessage({
    requestId: requestId.value,
    receivedAt: Date.parse("2026-08-09T10:00:00Z"),
    event,
  });
  const parsedQueueMessage = parseCueQueueMessage(
    JSON.parse(JSON.stringify(queueMessage)),
  );
  expect(parsedQueueMessage.ok).toBe(true);
  const malformedQueueMessage = {
    ...queueMessage,
    event: {
      ...queueMessage.event,
      payload: { ...queueMessage.event.payload, selectors: [] },
    },
  };
  expect(parseCueQueueMessage(malformedQueueMessage).ok).toBe(false);
  expect(
    commerceEntityPlaneCueSelectors(observation).map(
      (selector) => selector.kind,
    ),
  ).toEqual(["entity_type", "commerce_list", "commerce_list_entry"]);

  for (const selector of event.payload.selectors) {
    let scope: AgentResponsibilityScope;
    switch (selector.kind) {
      case "entity_type":
        scope = { kind: "entity_type", entityTypeId: selector.entityTypeId };
        break;
      case "commerce_list":
        scope = { kind: "commerce_list", listId: selector.listId };
        break;
      case "commerce_list_entry":
        scope = { kind: "commerce_list_entry", entry: selector.entry };
        break;
      case "relationship":
      case "saved_selector":
        throw new Error("unexpected selector fixture");
    }
    expect(
      matchesEntityPlaneScope(scope, selector, event.payload.observation),
    ).toBe(true);
  }

  const nonmatchingScope: AgentResponsibilityScope = {
    kind: "entity_type",
    entityTypeId: { origin: "custom", typeId: "other_type" },
  };
  const entityTypeSelector = event.payload.selectors[0];
  if (entityTypeSelector?.kind !== "entity_type")
    throw new Error("missing entity type selector");
  expect(
    matchesEntityPlaneScope(
      nonmatchingScope,
      entityTypeSelector,
      event.payload.observation,
    ),
  ).toBe(false);

  const relationshipObservation = parseEntityPlaneObservation({
    kind: "relationship_changed",
    observationId: "observation_relationship",
    relationship: {
      origin: "custom",
      relationshipId: "relationship_a",
      definition: {
        origin: "custom",
        definitionId: "relationship_definition_a",
        revision: 1,
      },
      sensitivity: "public",
      source: {
        origin: "custom",
        typeId: "trade_partner",
        entityId: "partner_a",
      },
      target: {
        origin: "custom",
        typeId: "export_document",
        entityId: "document_a",
      },
      revision: 1,
    },
    definition: {
      origin: "custom",
      definitionId: "relationship_definition_a",
      sourceType: { origin: "custom", typeId: "trade_partner" },
      targetType: { origin: "custom", typeId: "export_document" },
      sourceLabel: "exports",
      inverseLabel: "partner",
      cardinality: "one_to_many",
      deletionBehavior: "detach",
      sensitivity: "public",
      revision: 1,
    },
    merchantRevision: 7,
  });
  const relationshipEvent = createCommerceEntityPlaneCueEvents({
    organisationId: organisationId.value,
    integrationAccountId: integrationAccountId.value,
    deliveryId: "delivery_entity_plane_cue",
    merchantId: "merchant_entity_plane_cue",
    merchantRevision: 7,
    observedAt: "2026-08-09T10:00:00Z",
    observations: [relationshipObservation],
    at: Date.parse("2026-08-09T10:00:00Z"),
  })[0];
  if (relationshipEvent === undefined)
    throw new Error("missing relationship cue event");
  const relationshipSelector = relationshipEvent.payload.selectors[0];
  if (relationshipSelector?.kind !== "relationship")
    throw new Error("missing relationship selector");
  expect(
    matchesEntityPlaneScope(
      { kind: "relationship", relationship: relationshipSelector.relationship },
      relationshipSelector,
      relationshipEvent.payload.observation,
    ),
  ).toBe(true);
});

it("requires authoritative resolution for published saved-view responsibility", async () => {
  const organisationId = parseOrganisationId(
    "organisation_entity_plane_saved_view",
  );
  if (!organisationId.ok)
    throw new Error("invalid saved-view organisation fixture");
  const observation = parseEntityPlaneObservation({
    kind: "custom_entity_changed",
    observationId: "observation_saved_view",
    entityRef: {
      origin: "custom",
      typeId: "trade_partner",
      entityId: "partner_a",
    },
    revision: 3,
    merchantRevision: 7,
  });
  const selector = commerceEntityPlaneCueSelectors(observation)[0];
  if (selector === undefined)
    throw new Error("missing saved-view cue selector");
  const query = parseCommerceGraphQuery({
    kind: "saved_commerce_view",
    viewId: "export_board",
    pagination: { limit: 20, cursor: null },
  });
  const scope: AgentResponsibilityScope = {
    kind: "saved_selector",
    selector: { selectorId: "export_board", revision: 3, query },
  };

  expect(
    await matchesEntityPlaneScopeAtAdmission({
      organisationId: organisationId.value,
      scope,
      selector,
      observation,
      savedSelectorResolver: undefined,
    }),
  ).toEqual({
    ok: false,
    error: { code: "saved_selector_resolver_unavailable" },
  });
  expect(
    await matchesEntityPlaneScopeAtAdmission({
      organisationId: organisationId.value,
      scope,
      selector,
      observation,
      savedSelectorResolver: savedViewMembershipResolver,
    }),
  ).toEqual({ ok: true, value: true });
  expect(
    await matchesEntityPlaneScopeAtAdmission({
      organisationId: organisationId.value,
      scope,
      selector,
      observation,
      savedSelectorResolver: failedSavedViewResolver,
    }),
  ).toEqual({
    ok: false,
    error: { code: "saved_selector_resolver_failed" },
  });
});

function savedViewMembershipResolver(input: SavedSelectorCueResolverInput) {
  return Promise.resolve({
    ok: true as const,
    value:
      input.selector.selectorId === "export_board" &&
      input.selector.revision === 3,
  });
}

function failedSavedViewResolver(_input: SavedSelectorCueResolverInput) {
  return Promise.resolve({
    ok: false as const,
    error: { code: "saved_selector_resolver_failed" as const },
  });
}
