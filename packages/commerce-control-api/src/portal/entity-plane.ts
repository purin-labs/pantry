import {
  parseCommerceGraphQuery,
  parseCommerceListEntryRef,
  parseCustomCommerceRelationshipRef,
  parseCommerceEntityPlaneCommand,
  parseEntityPlaneCommandResult,
} from "@purin-labs/commerce-client";
import type { ActionState } from "@purin-labs/contracts";
import type {
  CommerceEntityPlaneEffect,
  CommerceEntityRef,
  CommerceMutationReceiptV1,
} from "@purin-labs/commerce-contracts";
import { sameRelationshipDefinitionRef } from "@purin-labs/commerce-contracts/commerce-relationship-references";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever, isRecord } from "@purin-labs/std";
import type {
  CommerceActivityResource,
  CommerceActivitySourceName,
  CommerceBoardDragPreview,
  CommerceBoardPresenceEntry,
  CommerceBoardPresenceSelection,
  CommerceObservationDisposition,
} from "../commerce.ts";

export type CommerceListEntryPatchApprovalAction = Readonly<{
  nonce: string;
  caseId: string;
  proposalId: string;
  state: "approval_requested";
  verb: "commerce.list_entry.patch";
  resourceKey: string;
}>;

export type CommerceListEntryPatchOutcome =
  | Readonly<{
      kind: "executed";
      receipt: CommerceMutationReceiptV1;
    }>
  | Readonly<{
      kind: "approval_requested";
      action: CommerceListEntryPatchApprovalAction;
      approval: Readonly<{ kind: "required"; next: "approve_action" }>;
      requestedAt: number;
    }>;

export type CommerceActivityEventKind =
  | "blotter_history"
  | "case"
  | "proposal"
  | "approval"
  | "entity_plane_effect"
  | "underclerk_observation"
  | "underclerk_receipt"
  | "action_ledger";

export type CommerceActivityActionState = ActionState;

export type CommerceActivityCaseState =
  "open" | "waiting" | "completing" | "completed" | "quarantined" | "archived";

export type CommerceActivityApprovalState = "waiting" | "decided" | "lapsed";

export type CommerceActivityReceiptOutcome =
  | "settled"
  | "accepted"
  | "failed"
  | "indeterminate"
  | "applied"
  | "already_applied";

export type CommerceActivityEvent =
  | Readonly<{
      kind: "blotter_history";
      resource: CommerceActivityResource;
      eventId: string;
      disposition: CommerceObservationDisposition;
      revision: number;
      occurredAt: string;
      processedAt: number;
      deliveryCount: number;
    }>
  | Readonly<{
      kind: "case";
      resource: CommerceActivityResource;
      caseId: string;
      state: CommerceActivityCaseState;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "proposal";
      resource: CommerceActivityResource;
      proposalId: string;
      state: CommerceActivityActionState;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "approval";
      resource: CommerceActivityResource;
      approvalId: string;
      state: CommerceActivityApprovalState;
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
      observationId: string;
      deliveryId: string;
      merchantRevision: number;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "underclerk_receipt";
      resource: CommerceActivityResource;
      receiptId: string;
      outcome: CommerceActivityReceiptOutcome;
      occurredAt: string;
    }>
  | Readonly<{
      kind: "action_ledger";
      resource: CommerceActivityResource;
      actionNonce: string;
      caseId: string;
      proposalId: string;
      state: CommerceActivityActionState;
      occurredAt: string;
      providerResult: string | null;
    }>;

export type CommerceActivityResult = Readonly<{
  events: readonly CommerceActivityEvent[];
  unsupportedSources: readonly CommerceActivitySourceName[];
}>;

export function parseCommerceListEntryPatchResponse(
  value: unknown,
): CommerceListEntryPatchOutcome {
  if (!isRecord(value) || value.ok !== true) {
    throw new Error("The list-entry patch response is invalid.");
  }
  if (hasExactObjectFields(value, ["ok", "receipt"])) {
    const result = parseEntityPlaneCommandResult({
      status: "accepted",
      receipt: value.receipt,
    });
    if (result.status !== "accepted") {
      throw new Error("The list-entry patch response receipt is invalid.");
    }
    return { kind: "executed", receipt: result.receipt };
  }
  if (
    !hasExactObjectFields(value, [
      "ok",
      "effect",
      "action",
      "approval",
      "requestedAt",
    ]) ||
    value.effect !== "approval_requested"
  ) {
    throw new Error("The list-entry patch response is invalid.");
  }
  return {
    kind: "approval_requested",
    action: parseCommerceListEntryPatchApprovalAction(value.action),
    approval: parseCommerceListEntryPatchApproval(value.approval),
    requestedAt: requiredMutationNonNegativeInteger(
      value.requestedAt,
      "requestedAt",
    ),
  };
}

export function parseCommerceBoardPresenceEntry(
  value: unknown,
  resourceKey: string,
): CommerceBoardPresenceEntry {
  if (
    !isRecord(value) ||
    !hasExactObjectFields(value, [
      "userId",
      "displayName",
      "resourceKey",
      "selection",
      "dragPreview",
      "observedAt",
    ]) ||
    typeof value.userId !== "string" ||
    value.userId.length === 0 ||
    typeof value.displayName !== "string" ||
    value.displayName.length === 0 ||
    value.resourceKey !== resourceKey ||
    typeof value.observedAt !== "number" ||
    !Number.isSafeInteger(value.observedAt)
  ) {
    throw new Error("The board presence entry is invalid.");
  }
  return {
    userId: value.userId,
    displayName: value.displayName,
    resourceKey,
    selection: parseCommerceBoardPresenceSelection(value.selection),
    dragPreview: parseCommerceBoardDragPreview(value.dragPreview),
    observedAt: value.observedAt,
  };
}

function parseCommerceBoardPresenceSelection(
  value: unknown,
): CommerceBoardPresenceSelection {
  if (!isRecord(value) || typeof value.kind !== "string")
    throw new Error("The board presence selection is invalid.");
  if (value.kind === "none" && hasExactObjectFields(value, ["kind"]))
    return { kind: value.kind };
  if (
    value.kind === "list_entry" &&
    hasExactObjectFields(value, ["kind", "entryId", "listId"]) &&
    typeof value.entryId === "string" &&
    value.entryId.length > 0 &&
    typeof value.listId === "string" &&
    value.listId.length > 0
  ) {
    return { kind: value.kind, entryId: value.entryId, listId: value.listId };
  }
  throw new Error("The board presence selection is invalid.");
}

function parseCommerceBoardDragPreview(
  value: unknown,
): CommerceBoardDragPreview {
  if (!isRecord(value) || typeof value.kind !== "string")
    throw new Error("The board drag preview is invalid.");
  if (value.kind === "idle" && hasExactObjectFields(value, ["kind"]))
    return { kind: value.kind };
  if (
    value.kind === "moving" &&
    hasExactObjectFields(value, ["kind", "entryId", "desiredStatusId"]) &&
    typeof value.entryId === "string" &&
    value.entryId.length > 0 &&
    (value.desiredStatusId === null ||
      (typeof value.desiredStatusId === "string" &&
        value.desiredStatusId.length > 0))
  ) {
    return {
      kind: value.kind,
      entryId: value.entryId,
      desiredStatusId: value.desiredStatusId,
    };
  }
  throw new Error("The board drag preview is invalid.");
}

function hasExactObjectFields(
  value: Readonly<Record<string, unknown>>,
  expectedFields: readonly string[],
): boolean {
  const actualFields = Object.keys(value);
  if (actualFields.length !== expectedFields.length) return false;
  for (const field of actualFields) {
    if (!expectedFields.includes(field)) return false;
  }
  return true;
}

function parseCommerceListEntryPatchApprovalAction(
  value: unknown,
): CommerceListEntryPatchApprovalAction {
  if (
    !isRecord(value) ||
    !hasExactObjectFields(value, [
      "nonce",
      "caseId",
      "proposalId",
      "state",
      "verb",
      "resourceKey",
    ]) ||
    !isRecord(value.nonce) ||
    !hasExactObjectFields(value.nonce, ["value"]) ||
    value.state !== "approval_requested" ||
    value.verb !== "commerce.list_entry.patch"
  ) {
    throw new Error("The list-entry patch approval action is invalid.");
  }
  return {
    nonce: requiredMutationText(value.nonce.value, "action.nonce.value"),
    caseId: requiredMutationText(value.caseId, "action.caseId"),
    proposalId: requiredMutationText(value.proposalId, "action.proposalId"),
    state: value.state,
    verb: value.verb,
    resourceKey: requiredMutationText(value.resourceKey, "action.resourceKey"),
  };
}

function parseCommerceListEntryPatchApproval(
  value: unknown,
): Readonly<{ kind: "required"; next: "approve_action" }> {
  if (
    !isRecord(value) ||
    !hasExactObjectFields(value, ["kind", "next"]) ||
    value.kind !== "required" ||
    value.next !== "approve_action"
  ) {
    throw new Error("The list-entry patch approval requirement is invalid.");
  }
  return { kind: value.kind, next: value.next };
}

function requiredMutationText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(`The list-entry patch ${field} is invalid.`);
  }
  return value;
}

function requiredMutationNonNegativeInteger(
  value: unknown,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`The list-entry patch ${field} is invalid.`);
  }
  return Number(value);
}

export function parseCommerceActivityResponse(
  value: unknown,
): CommerceActivityResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.events) ||
    !Array.isArray(value.unsupportedSources)
  ) {
    throw new Error("Commerce activity response is invalid.");
  }
  return {
    events: value.events.map(parseCommerceActivityEvent),
    unsupportedSources: value.unsupportedSources.map(
      parseCommerceActivitySource,
    ),
  };
}

function parseCommerceActivityEvent(value: unknown): CommerceActivityEvent {
  if (
    !isRecord(value) ||
    !isCommerceActivityEventKind(value.kind) ||
    !isIsoTimestamp(value.occurredAt)
  ) {
    throw new Error("Commerce activity event is invalid.");
  }
  const resource = parseCommerceActivityResource(value.resource);
  switch (value.kind) {
    case "blotter_history":
      return {
        kind: value.kind,
        resource,
        eventId: requiredText(value.eventId, "eventId"),
        disposition: parseBlotterDisposition(value.disposition),
        revision: requiredNonNegativeInteger(value.revision, "revision"),
        occurredAt: value.occurredAt,
        processedAt: requiredNonNegativeInteger(
          value.processedAt,
          "processedAt",
        ),
        deliveryCount: requiredNonNegativeInteger(
          value.deliveryCount,
          "deliveryCount",
        ),
      };
    case "case":
      return {
        kind: value.kind,
        resource,
        caseId: requiredText(value.caseId, "caseId"),
        state: parseCaseState(value.state),
        occurredAt: value.occurredAt,
      };
    case "proposal":
      return {
        kind: value.kind,
        resource,
        proposalId: requiredText(value.proposalId, "proposalId"),
        state: parseActionState(value.state),
        occurredAt: value.occurredAt,
      };
    case "approval":
      return {
        kind: value.kind,
        resource,
        approvalId: requiredText(value.approvalId, "approvalId"),
        state: parseApprovalState(value.state),
        occurredAt: value.occurredAt,
      };
    case "entity_plane_effect":
      return {
        kind: value.kind,
        resource,
        effect: parseCommerceActivityEffect(value.effect),
        occurredAt: value.occurredAt,
      };
    case "underclerk_observation":
      return {
        kind: value.kind,
        resource,
        observationId: requiredText(value.observationId, "observationId"),
        deliveryId: requiredText(value.deliveryId, "deliveryId"),
        merchantRevision: requiredPositiveInteger(
          value.merchantRevision,
          "merchantRevision",
        ),
        occurredAt: value.occurredAt,
      };
    case "underclerk_receipt":
      return {
        kind: value.kind,
        resource,
        receiptId: requiredText(value.receiptId, "receiptId"),
        outcome: parseReceiptOutcome(value.outcome),
        occurredAt: value.occurredAt,
      };
    case "action_ledger":
      return {
        kind: value.kind,
        resource,
        actionNonce: requiredText(value.actionNonce, "actionNonce"),
        caseId: requiredText(value.caseId, "caseId"),
        proposalId: requiredText(value.proposalId, "proposalId"),
        state: parseActionState(value.state),
        occurredAt: value.occurredAt,
        providerResult:
          value.providerResult === null
            ? null
            : requiredText(value.providerResult, "providerResult"),
      };
    default:
      return assertNever(value.kind, "Unhandled commerce activity value");
  }
}

function parseCommerceActivityResource(
  value: unknown,
): CommerceActivityResource {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !isRecord(value.reference)
  ) {
    throw new Error("Commerce activity resource is invalid.");
  }
  if (value.kind === "entity") {
    const query = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: value.reference,
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    });
    if (query.kind !== "entity_by_ref")
      throw new Error("Commerce activity entity reference changed shape.");
    return { kind: "entity", reference: query.reference };
  }
  if (value.kind === "relationship") {
    return {
      kind: "relationship",
      reference: parseCustomCommerceRelationshipRef(value.reference),
    };
  }
  if (value.kind !== "list_entry")
    throw new Error("Commerce activity resource kind is invalid.");
  return {
    kind: "list_entry",
    reference: parseCommerceListEntryRef(value.reference),
  };
}

function parseCommerceActivitySource(
  value: unknown,
): CommerceActivitySourceName {
  if (
    value === "blotter_history" ||
    value === "cases" ||
    value === "proposals" ||
    value === "approvals" ||
    value === "underclerk_receipts" ||
    value === "action_ledger"
  ) {
    return value;
  }
  throw new Error("Commerce activity source is invalid.");
}

function isCommerceActivityEventKind(
  value: unknown,
): value is CommerceActivityEventKind {
  return (
    value === "blotter_history" ||
    value === "case" ||
    value === "proposal" ||
    value === "approval" ||
    value === "entity_plane_effect" ||
    value === "underclerk_observation" ||
    value === "underclerk_receipt" ||
    value === "action_ledger"
  );
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Commerce activity ${field} is invalid.`);
  return value;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`Commerce activity ${field} is invalid.`);
  return Number(value);
}

function requiredPositiveInteger(value: unknown, field: string): number {
  const result = requiredNonNegativeInteger(value, field);
  if (result === 0) throw new Error(`Commerce activity ${field} is invalid.`);
  return result;
}

function parseBlotterDisposition(
  value: unknown,
): CommerceObservationDisposition {
  if (value === "applied" || value === "duplicate" || value === "out_of_order")
    return value;
  throw new Error("Commerce activity blotter disposition is invalid.");
}

function parseCaseState(value: unknown): CommerceActivityCaseState {
  if (
    value === "open" ||
    value === "waiting" ||
    value === "completing" ||
    value === "completed" ||
    value === "quarantined" ||
    value === "archived"
  )
    return value;
  throw new Error("Commerce activity Case state is invalid.");
}

function parseActionState(value: unknown): CommerceActivityActionState {
  if (
    value === "proposed" ||
    value === "approval_requested" ||
    value === "signed" ||
    value === "executing" ||
    value === "indeterminate" ||
    value === "confirmed" ||
    value === "failed" ||
    value === "rejected" ||
    value === "expired"
  )
    return value;
  throw new Error("Commerce activity action state is invalid.");
}

function parseApprovalState(value: unknown): CommerceActivityApprovalState {
  if (value === "waiting" || value === "decided" || value === "lapsed")
    return value;
  throw new Error("Commerce activity approval state is invalid.");
}

function parseReceiptOutcome(value: unknown): CommerceActivityReceiptOutcome {
  if (
    value === "settled" ||
    value === "accepted" ||
    value === "failed" ||
    value === "indeterminate" ||
    value === "applied" ||
    value === "already_applied"
  )
    return value;
  throw new Error("Commerce activity receipt outcome is invalid.");
}

function parseCommerceActivityEffect(
  value: unknown,
): CommerceEntityPlaneEffect {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !isRecord(value.receipt)
  )
    throw new Error("Commerce activity effect is invalid.");
  const effectFields = commerceActivityEffectFields(value.kind);
  if (
    effectFields.length === 0 ||
    Object.keys(value).some((key) => !effectFields.includes(key))
  )
    throw new Error("Commerce activity effect has unsupported fields.");
  const receiptResult = parseEntityPlaneCommandResult({
    status: "accepted",
    receipt: value.receipt,
  });
  if (receiptResult.status !== "accepted")
    throw new Error("Commerce activity receipt is invalid.");
  const receipt = receiptResult.receipt;
  if (receipt.deliveryId === null)
    throw new Error(
      "Commerce activity effect receipt has no observation delivery.",
    );
  switch (value.kind) {
    case "patch_custom_entity": {
      const command = parseCommerceEntityPlaneCommand({
        kind: value.kind,
        command: {
          entityRef: value.entityRef,
          typeRevision: value.typeRevision,
          expectedRevision: value.expectedRevision,
          attributes: [],
          displayName: null,
        },
      });
      if (command.kind !== value.kind)
        throw new Error("Commerce activity effect command changed shape.");
      return ensureCommerceActivityEffectReceipt(
        {
          kind: value.kind,
          entityRef: command.command.entityRef,
          typeRevision: command.command.typeRevision,
          expectedRevision: command.command.expectedRevision,
          receipt,
        },
        receipt,
      );
    }
    case "create_custom_relationship": {
      const command = parseCommerceEntityPlaneCommand({
        kind: value.kind,
        command: {
          target: {
            relationshipId: value.relationshipId,
            definition: value.definition,
            source: value.source,
            target: value.target,
          },
        },
      });
      if (command.kind !== value.kind)
        throw new Error("Commerce activity effect command changed shape.");
      return ensureCommerceActivityEffectReceipt(
        {
          kind: value.kind,
          relationshipId: command.command.target.relationshipId,
          definition: command.command.target.definition,
          source: command.command.target.source,
          target: command.command.target.target,
          receipt,
        },
        receipt,
      );
    }
    case "delete_custom_relationship": {
      const command = parseCommerceEntityPlaneCommand({
        kind: value.kind,
        command: { target: { relationship: value.relationship } },
      });
      if (command.kind !== value.kind)
        throw new Error("Commerce activity effect command changed shape.");
      return ensureCommerceActivityEffectReceipt(
        {
          kind: value.kind,
          relationship: command.command.target.relationship,
          receipt,
        },
        receipt,
      );
    }
    case "add_commerce_list_entry": {
      const command = parseCommerceEntityPlaneCommand({
        kind: value.kind,
        command: {
          entryId: value.entryId,
          listId: value.listId,
          expectedListRevision: value.expectedListRevision,
          entityRef: value.entityRef,
          attributeValues: [],
          revision: value.revision,
        },
      });
      if (command.kind !== value.kind)
        throw new Error("Commerce activity effect command changed shape.");
      return ensureCommerceActivityEffectReceipt(
        {
          kind: value.kind,
          entryId: command.command.entryId,
          listId: command.command.listId,
          expectedListRevision: command.command.expectedListRevision,
          entityRef: command.command.entityRef,
          revision: command.command.revision,
          receipt,
        },
        receipt,
      );
    }
    case "patch_commerce_list_entry": {
      const command = parseCommerceEntityPlaneCommand({
        kind: value.kind,
        command: {
          target: value.entry,
          expectedListRevision: value.expectedListRevision,
          attributeValues: [],
        },
      });
      if (command.kind !== value.kind)
        throw new Error("Commerce activity effect command changed shape.");
      return ensureCommerceActivityEffectReceipt(
        {
          kind: value.kind,
          entry: command.command.target,
          expectedListRevision: command.command.expectedListRevision,
          receipt,
        },
        receipt,
      );
    }
    case "remove_commerce_list_entry": {
      const command = parseCommerceEntityPlaneCommand({
        kind: value.kind,
        command: { target: value.entry },
      });
      if (command.kind !== value.kind)
        throw new Error("Commerce activity effect command changed shape.");
      return ensureCommerceActivityEffectReceipt(
        { kind: value.kind, entry: command.command.target, receipt },
        receipt,
      );
    }
    default:
      throw new Error("Commerce activity effect kind is unsupported.");
  }
}

function commerceActivityEffectFields(kind: string): readonly string[] {
  switch (kind) {
    case "patch_custom_entity":
      return [
        "kind",
        "entityRef",
        "typeRevision",
        "expectedRevision",
        "receipt",
      ];
    case "create_custom_relationship":
      return [
        "kind",
        "relationshipId",
        "definition",
        "source",
        "target",
        "receipt",
      ];
    case "delete_custom_relationship":
      return ["kind", "relationship", "receipt"];
    case "add_commerce_list_entry":
      return [
        "kind",
        "entryId",
        "listId",
        "expectedListRevision",
        "entityRef",
        "revision",
        "receipt",
      ];
    case "patch_commerce_list_entry":
      return ["kind", "entry", "expectedListRevision", "receipt"];
    case "remove_commerce_list_entry":
      return ["kind", "entry", "receipt"];
    default:
      return [];
  }
}

function ensureCommerceActivityEffectReceipt(
  effect: CommerceEntityPlaneEffect,
  receipt: CommerceMutationReceiptV1,
): CommerceEntityPlaneEffect {
  if (!commerceActivityEffectReceiptMatches(effect, receipt))
    throw new Error(
      "Commerce activity effect receipt does not match its effect.",
    );
  return effect;
}

function commerceActivityEffectReceiptMatches(
  effect: CommerceEntityPlaneEffect,
  receipt: CommerceMutationReceiptV1,
): boolean {
  switch (effect.kind) {
    case "patch_custom_entity":
      return (
        receipt.target.kind === "custom_entity" &&
        sameCommerceEntityRef(receipt.target.entityRef, effect.entityRef) &&
        receipt.target.revision === effect.expectedRevision + 1
      );
    case "create_custom_relationship":
      return (
        receipt.target.kind === "custom_relationship" &&
        receipt.target.relationship.relationshipId === effect.relationshipId &&
        sameRelationshipDefinitionRef(
          receipt.target.relationship.definition,
          effect.definition,
        ) &&
        receipt.target.relationship.revision === 1
      );
    case "delete_custom_relationship":
    case "replace_custom_relationship":
      return (
        receipt.target.kind === "custom_relationship" &&
        sameCommerceRelationshipRefIgnoringRevision(
          receipt.target.relationship,
          effect.relationship,
        ) &&
        receipt.target.relationship.revision ===
          effect.relationship.revision + 1
      );
    case "add_commerce_list_entry":
      return (
        receipt.target.kind === "commerce_list_entry" &&
        effect.revision === 1 &&
        receipt.target.entry.entryId === effect.entryId &&
        receipt.target.entry.listId === effect.listId &&
        receipt.target.entry.revision === effect.revision &&
        receipt.target.revision === effect.revision
      );
    case "patch_commerce_list_entry":
      return (
        receipt.target.kind === "commerce_list_entry" &&
        receipt.target.entry.entryId === effect.entry.entry.entryId &&
        receipt.target.entry.listId === effect.entry.entry.listId &&
        receipt.target.entry.revision === effect.entry.entry.revision + 1 &&
        receipt.target.revision === effect.entry.entry.revision + 1
      );
    case "remove_commerce_list_entry":
      return (
        receipt.target.kind === "commerce_list_entry" &&
        receipt.target.entry.entryId === effect.entry.entry.entryId &&
        receipt.target.entry.listId === effect.entry.entry.listId &&
        receipt.target.entry.revision === effect.entry.entry.revision + 1 &&
        receipt.target.revision === effect.entry.entry.revision + 1
      );
    default:
      return assertNever(effect, "Unhandled commerce activity value");
  }
}

function sameCommerceEntityRef(
  left: CommerceEntityRef,
  right: CommerceEntityRef,
): boolean {
  return (
    left.origin === right.origin &&
    left.typeId === right.typeId &&
    left.entityId === right.entityId
  );
}

function sameCommerceRelationshipRefIgnoringRevision(
  left: Variant<
    CommerceEntityPlaneEffect,
    "delete_custom_relationship"
  >["relationship"],
  right: Variant<
    CommerceEntityPlaneEffect,
    "delete_custom_relationship"
  >["relationship"],
): boolean {
  return (
    left.origin === right.origin &&
    left.relationshipId === right.relationshipId &&
    sameRelationshipDefinitionRef(left.definition, right.definition)
  );
}
