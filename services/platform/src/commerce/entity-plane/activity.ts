import type {
  CommerceEntityPlaneEffect,
  CommerceCommandId,
  MerchantRevision,
  CommerceEntityPlaneDeliveryId,
  CommerceMutationReceiptOutcome,
} from "@purin-labs/commerce-contracts";
import { sameRelationshipDefinitionRef } from "@purin-labs/commerce-contracts/commerce-relationship-references";
import { parseCommerceProviderReceipt } from "../action-model";
import { assertCommerceGraphQueryWithLexicon } from "../commerce-wasm";
import type {
  CaseCommerceApprovalRecord,
  CaseSnapshot,
} from "../../actors/case/types";
import type { ActionLedgerActivity as OrganisationActionLedgerActivity } from "../../actors/action-ledger";
import type { OrganisationCommerce } from "../../actors/organisation/organisation-commerce";
import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import type { CommerceProjectionHistoryEntry } from "../../actors/commerce-projection";
import { projectionKindForEntityType } from "./blotter-source";
import { assertNever } from "@purin-labs/std";
import type {
  CommerceActivityResource,
  CommerceActivitySourceName,
  CommerceProviderReceipt,
} from "@purin-labs/control-api";

export type CommerceActivityEvent =
  | Readonly<{
      kind: "blotter_history";
      resource: CommerceActivityResource;
      eventId: string;
      disposition: CommerceProjectionHistoryEntry["disposition"];
      revision: number;
      occurredAt: string;
      processedAt: number;
      deliveryCount: number;
    }>
  | Readonly<{
      kind: "case";
      resource: CommerceActivityResource;
      caseId: string;
      state: CaseSnapshot["lifecycle"]["kind"];
      occurredAt: string;
    }>
  | Readonly<{
      kind: "proposal";
      resource: CommerceActivityResource;
      proposalId: string;
      state: OrganisationActionLedgerActivity["state"];
      occurredAt: string;
    }>
  | Readonly<{
      kind: "approval";
      resource: CommerceActivityResource;
      approvalId: string;
      state: CaseCommerceApprovalRecord["kind"];
      occurredAt: string;
    }>
  | Readonly<{
      kind: "entity_plane_effect";
      resource: CommerceActivityResource;
      effect: CommerceEntityPlaneEffect;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "underclerk_observation";
      resource: CommerceActivityResource;
      observationId: CommerceCommandId;
      deliveryId: CommerceEntityPlaneDeliveryId;
      merchantRevision: MerchantRevision;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "underclerk_receipt";
      resource: CommerceActivityResource;
      receiptId: string;
      outcome:
        CommerceProviderReceipt["status"] | CommerceMutationReceiptOutcome;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "action_ledger";
      resource: CommerceActivityResource;
      actionNonce: string;
      caseId: string;
      proposalId: string;
      state: OrganisationActionLedgerActivity["state"];
      occurredAt: string;
      providerResult: string | null;
    }>;

type CommerceActivitySources = Readonly<{
  blotterHistory: readonly BlotterHistoryActivity[];
  cases: readonly CaseActivity[];
  proposals: readonly ProposalActivity[];
  approvals: readonly ApprovalActivity[];
  effects: readonly EntityPlaneEffectActivity[];
  underclerkReceipts: readonly CommerceReceiptActivity[];
  actionLedger: readonly ActionLedgerActivity[];
}>;

type BlotterHistoryActivity = Readonly<{
  resource: CommerceActivityResource;
  entry: CommerceProjectionHistoryEntry;
}>;

type CaseActivity = Readonly<{
  resource: CommerceActivityResource;
  caseId: string;
  state: CaseSnapshot["lifecycle"]["kind"];
  occurredAt: string;
}>;

type ProposalActivity = Readonly<{
  resource: CommerceActivityResource;
  proposalId: string;
  state: OrganisationActionLedgerActivity["state"];
  occurredAt: string;
}>;

type ApprovalActivity = Readonly<{
  resource: CommerceActivityResource;
  approvalId: string;
  state: CaseCommerceApprovalRecord["kind"];
  occurredAt: string;
}>;

type CommerceReceiptActivity = Readonly<{
  resource: CommerceActivityResource;
  receiptId: string;
  outcome: CommerceProviderReceipt["status"] | CommerceMutationReceiptOutcome;
  occurredAt: string;
}>;

type EntityPlaneEffectActivity = Readonly<{
  resource: CommerceActivityResource;
  effect: CommerceEntityPlaneEffect;
  occurredAt: string;
}>;

type ActionLedgerActivity = Readonly<{
  resource: CommerceActivityResource;
  actionNonce: string;
  caseId: string;
  proposalId: string;
  state: OrganisationActionLedgerActivity["state"];
  occurredAt: string;
  providerResult: string | null;
  commerceEffect: CommerceEntityPlaneEffect | null;
}>;

export type CommerceActivityReadResult = Readonly<{
  events: readonly CommerceActivityEvent[];
  unsupportedSources: readonly CommerceActivitySourceName[];
}>;

type CommerceActivityOrganisationReader = Pick<
  OrganisationCommerce,
  "readCommerceProjectionHistory" | "readActionActivity"
>;

type CommerceActivityCaseReader = Readonly<{
  read: (caseId: string) => Promise<CaseSnapshot | null>;
}>;

export type CommerceActivityReadRequest = Readonly<{
  resource: CommerceActivityResource;
  limit: number;
}>;

type CommerceActivityReadInput = CommerceActivityReadRequest &
  Readonly<{
    organisationId: OrganisationId;
    organisation: CommerceActivityOrganisationReader;
    caseReader: CommerceActivityCaseReader | null;
  }>;

type CommerceActivityReadError = Readonly<{
  code: "activity_source_unavailable";
  source: "blotter_history" | "action_ledger";
}>;

/** Reads retained operational sources and composes them by exact resource reference. */
export async function readCommerceActivity(
  input: CommerceActivityReadInput,
): Promise<Result<CommerceActivityReadResult, CommerceActivityReadError>> {
  const unsupportedSources: CommerceActivitySourceName[] = [];
  const blotterHistory: BlotterHistoryActivity[] = [];
  if (
    input.resource.kind === "entity" &&
    input.resource.reference.origin === "system"
  ) {
    const history = await input.organisation.readCommerceProjectionHistory({
      organisationId: input.organisationId,
      kind: projectionKindForEntityType(input.resource.reference.typeId),
      canonicalId: input.resource.reference.entityId,
      limit: input.limit,
    });
    if (!history.ok) {
      return {
        ok: false,
        error: {
          code: "activity_source_unavailable",
          source: "blotter_history",
        },
      };
    }
    blotterHistory.push(
      ...history.value.map(historyActivity.bind(null, input.resource)),
    );
  } else {
    unsupportedSources.push("blotter_history");
  }

  const actionLedger = await input.organisation.readActionActivity({
    organisationId: input.organisationId,
    resourceKey: null,
    limit: input.limit,
  });
  if (!actionLedger.ok) {
    return {
      ok: false,
      error: { code: "activity_source_unavailable", source: "action_ledger" },
    };
  }

  const cases: CaseActivity[] = [];
  const proposals: ProposalActivity[] = [];
  const approvals: ApprovalActivity[] = [];
  const effects: EntityPlaneEffectActivity[] = [];
  const commerceEngineReceipts: CommerceReceiptActivity[] = [];
  const actionEvents: ActionLedgerActivity[] = [];
  const seenCases = new Set<string>();
  const seenProposals = new Set<string>();
  for (const action of actionLedger.value) {
    const resource = resourceForAction(action);
    if (resource === null || !matches(resource, input.resource)) continue;
    actionEvents.push(actionActivity(resource, action));
    if (action.commerceEffect !== null) {
      effects.push({
        resource,
        effect: action.commerceEffect,
        occurredAt: action.commerceEffect.receipt.committedAt,
      });
    }
    if (action.proposalId.length > 0 && !seenProposals.has(action.proposalId)) {
      seenProposals.add(action.proposalId);
      proposals.push({
        resource,
        proposalId: action.proposalId,
        state: action.state,
        occurredAt: new Date(action.updatedAt).toISOString(),
      });
    }
    if (input.caseReader === null) {
      unsupportedSources.push("cases", "approvals");
    } else if (!seenCases.has(action.caseId)) {
      seenCases.add(action.caseId);
      const snapshot = await input.caseReader.read(action.caseId);
      if (snapshot !== null) {
        cases.push({
          resource,
          caseId: snapshot.identity.caseId,
          state: snapshot.lifecycle.kind,
          occurredAt: new Date(action.updatedAt).toISOString(),
        });
        approvals.push(...approvalActivities(resource, action, snapshot));
      }
    }
    const receipt = commerceReceipt(
      resource,
      action.providerResult,
      action.commerceEffect,
    );
    if (receipt !== null) commerceEngineReceipts.push(receipt);
  }

  const composed = composeCommerceActivity({
    resource: input.resource,
    sources: {
      blotterHistory,
      cases,
      proposals,
      approvals,
      effects,
      underclerkReceipts: commerceEngineReceipts,
      actionLedger: actionEvents,
    },
    limit: input.limit,
  });
  return {
    ok: true,
    value: {
      events: composed,
      unsupportedSources: uniqueSources(unsupportedSources),
    },
  };
}

/**
 * Composes operational records beside a commerce resource. Every source is
 * filtered by the parsed reference before sorting, so a caller cannot receive
 * activity belonging to a neighboring entity or list entry.
 */
export function composeCommerceActivity(
  input: Readonly<{
    resource: CommerceActivityResource;
    sources: CommerceActivitySources;
    limit?: number;
  }>,
): readonly CommerceActivityEvent[] {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return [];
  const events: CommerceActivityEvent[] = [
    ...input.sources.blotterHistory.flatMap((item) =>
      historyEvent(item, input.resource),
    ),
    ...input.sources.cases.flatMap((item) =>
      matches(item.resource, input.resource) ? [caseEvent(item)] : [],
    ),
    ...input.sources.proposals.flatMap((item) =>
      matches(item.resource, input.resource) ? [proposalEvent(item)] : [],
    ),
    ...input.sources.approvals.flatMap((item) =>
      matches(item.resource, input.resource) ? [approvalEvent(item)] : [],
    ),
    ...input.sources.effects.flatMap((item) =>
      matches(item.resource, input.resource) ? [effectEvent(item)] : [],
    ),
    ...input.sources.effects.flatMap((item) =>
      observationEvent(item, input.resource),
    ),
    ...input.sources.underclerkReceipts.flatMap((item) =>
      matches(item.resource, input.resource) ? [receiptEvent(item)] : [],
    ),
    ...input.sources.actionLedger.flatMap((item) =>
      matches(item.resource, input.resource) ? [actionEvent(item)] : [],
    ),
  ];
  return events
    .sort(
      (left, right) =>
        timestampMillis(right.occurredAt) - timestampMillis(left.occurredAt),
    )
    .slice(0, limit);
}

function historyActivity(
  resource: CommerceActivityResource,
  entry: CommerceProjectionHistoryEntry,
): BlotterHistoryActivity {
  return { resource, entry };
}

function actionActivity(
  resource: CommerceActivityResource,
  action: OrganisationActionLedgerActivity,
): ActionLedgerActivity {
  return {
    resource,
    actionNonce: action.action.nonce.value,
    caseId: action.caseId,
    proposalId: action.proposalId,
    state: action.state,
    occurredAt: new Date(action.updatedAt).toISOString(),
    providerResult: action.providerResult,
    commerceEffect: action.commerceEffect,
  };
}

function approvalActivities(
  resource: CommerceActivityResource,
  action: OrganisationActionLedgerActivity,
  snapshot: CaseSnapshot,
): readonly ApprovalActivity[] {
  return snapshot.commerceApprovals.flatMap((approval) =>
    approval.request.actionNonce === action.action.nonce.value
      ? [
          {
            resource,
            approvalId: approval.request.actionNonce,
            state: approval.kind,
            occurredAt: new Date(action.updatedAt).toISOString(),
          },
        ]
      : [],
  );
}

function resourceForAction(
  action: OrganisationActionLedgerActivity,
): CommerceActivityResource | null {
  if (action.commerceEffect !== null)
    return resourceForEntityPlaneEffect(action.commerceEffect);
  const resource = actionResource(
    action.action.resourceKey,
    "commerce:cancel_order:",
    "order",
  );
  if (resource !== null) return resource;
  const offer = actionResource(
    action.action.resourceKey,
    "commerce:publish_catalog_listing:",
    "offer",
  );
  if (offer !== null) return offer;
  return actionResource(
    action.action.resourceKey,
    "commerce:attach_tracking:",
    "fulfillment",
  );
}

function resourceForEntityPlaneEffect(
  effect: CommerceEntityPlaneEffect,
): CommerceActivityResource {
  switch (effect.receipt.target.kind) {
    case "custom_entity":
      return { kind: "entity", reference: effect.receipt.target.entityRef };
    case "custom_relationship":
      return {
        kind: "relationship",
        reference: effect.receipt.target.relationship,
      };
    case "commerce_list_entry":
      return { kind: "list_entry", reference: effect.receipt.target.entry };
    case "commerce_list":
    case "saved_commerce_view":
    case "custom_entity_type":
    case "custom_relationship_definition":
    case "system_entity_extension_schema":
      throw new Error(
        `Entity-plane effect has an invalid receipt target: ${effect.receipt.target.kind}`,
      );
    default:
      return assertNever(
        effect.receipt.target,
        "Unexpected commerce activity value",
      );
  }
}

function actionResource(
  resourceKey: string,
  prefix: string,
  typeId: "order" | "offer" | "fulfillment",
): CommerceActivityResource | null {
  if (!resourceKey.startsWith(prefix)) return null;
  const entityId = resourceKey.slice(prefix.length);
  if (entityId.length === 0 || entityId.includes(":")) return null;
  try {
    const query: unknown = {
      kind: "entity_by_ref",
      reference: { origin: "system", typeId, entityId },
      traversal: { maxDepth: 1, resultLimit: 1 },
      filter: null,
    };
    assertCommerceGraphQueryWithLexicon(query);
    return query.kind === "entity_by_ref"
      ? { kind: "entity", reference: query.reference }
      : null;
  } catch {
    return null;
  }
}

function commerceReceipt(
  resource: CommerceActivityResource,
  raw: string | null,
  commerceEffect: CommerceEntityPlaneEffect | null,
): CommerceReceiptActivity | null {
  if (commerceEffect !== null) {
    const effectResource = resourceForEntityPlaneEffect(commerceEffect);
    if (!matches(resource, effectResource)) return null;
    return {
      resource,
      receiptId: commerceEffect.receipt.commandId,
      outcome: commerceEffect.receipt.outcome,
      occurredAt: commerceEffect.receipt.committedAt,
    };
  }
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = parseCommerceProviderReceipt(decoded);
  if (!parsed.ok || parsed.value.provider !== "underclerk") return null;
  const expectedType =
    parsed.value.projectionKind === "offer"
      ? "offer"
      : parsed.value.projectionKind === "fulfillment"
        ? "fulfillment"
        : "order";
  if (
    resource.kind !== "entity" ||
    resource.reference.origin !== "system" ||
    resource.reference.typeId !== expectedType ||
    resource.reference.entityId !== parsed.value.resourceId
  ) {
    return null;
  }
  return {
    resource,
    receiptId: parsed.value.receiptId,
    outcome: parsed.value.status,
    occurredAt: parsed.value.observedAt,
  };
}

function uniqueSources(
  sources: readonly CommerceActivitySourceName[],
): readonly CommerceActivitySourceName[] {
  return [...new Set(sources)];
}

function historyEvent(
  item: BlotterHistoryActivity,
  resource: CommerceActivityResource,
): readonly [CommerceActivityEvent] | readonly [] {
  return matches(item.resource, resource)
    ? [
        {
          kind: "blotter_history",
          resource: item.resource,
          eventId: item.entry.eventId,
          disposition: item.entry.disposition,
          revision: item.entry.revision,
          occurredAt: item.entry.occurredAt,
          processedAt: item.entry.processedAt,
          deliveryCount: item.entry.deliveryCount,
        },
      ]
    : [];
}

function caseEvent(item: CaseActivity): CommerceActivityEvent {
  return { kind: "case", ...item };
}

function proposalEvent(item: ProposalActivity): CommerceActivityEvent {
  return { kind: "proposal", ...item };
}

function approvalEvent(item: ApprovalActivity): CommerceActivityEvent {
  return { kind: "approval", ...item };
}

function effectEvent(item: EntityPlaneEffectActivity): CommerceActivityEvent {
  return { kind: "entity_plane_effect", ...item };
}

function observationEvent(
  item: EntityPlaneEffectActivity,
  resource: CommerceActivityResource,
): readonly [CommerceActivityEvent] | readonly [] {
  if (
    !matches(item.resource, resource) ||
    item.effect.receipt.deliveryId === null
  )
    return [];
  return [
    {
      kind: "underclerk_observation",
      resource: item.resource,
      observationId: item.effect.receipt.commandId,
      deliveryId: item.effect.receipt.deliveryId,
      merchantRevision: item.effect.receipt.merchantRevision,
      occurredAt: item.effect.receipt.committedAt,
    },
  ];
}

function receiptEvent(item: CommerceReceiptActivity): CommerceActivityEvent {
  return { kind: "underclerk_receipt", ...item };
}

function actionEvent(item: ActionLedgerActivity): CommerceActivityEvent {
  return { kind: "action_ledger", ...item };
}

function matches(
  left: CommerceActivityResource,
  right: CommerceActivityResource,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "entity" && right.kind === "entity") {
    return (
      left.reference.origin === right.reference.origin &&
      left.reference.typeId === right.reference.typeId &&
      left.reference.entityId === right.reference.entityId
    );
  }
  if (left.kind === "list_entry" && right.kind === "list_entry") {
    return (
      left.reference.listId === right.reference.listId &&
      left.reference.entryId === right.reference.entryId &&
      left.reference.revision === right.reference.revision
    );
  }
  if (left.kind === "relationship" && right.kind === "relationship") {
    return (
      left.reference.origin === right.reference.origin &&
      left.reference.relationshipId === right.reference.relationshipId &&
      sameRelationshipDefinitionRef(
        left.reference.definition,
        right.reference.definition,
      ) &&
      left.reference.revision === right.reference.revision
    );
  }
  return false;
}

function timestampMillis(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
