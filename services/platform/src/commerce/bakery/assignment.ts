import type {
  CommerceEntity,
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CommerceRelationship,
  CommerceSnapshotRevision,
  CustomCommerceEntityRef,
  CustomCommerceRelationshipRef,
} from "@seams/contracts";
import {
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseCustomCommerceRelationshipRef,
  parseEntityPlaneCommand,
  type CommerceEntityPlaneClient,
} from "@seams/commerce-client";
import { parseSettings, type Settings } from "@seams/bakery-model/bakery";
import {
  compileBakeryGraph,
  readBakeryProcedureGraph,
} from "@seams/bakery-model/bakery-procedure";
import { isRecord } from "@seams/std";

const validated: unique symbol = Symbol("bakery oven assignment");
export type OvenAssignmentEdit = Readonly<{
  [validated]: true;
  procedure: CustomCommerceEntityRef;
  relationship: CustomCommerceRelationshipRef;
  replacement: CustomCommerceEntityRef;
  snapshot: CommerceSnapshotRevision;
  settings: Settings;
}>;

export function parseOvenAssignmentEdit(
  body: Readonly<Record<string, unknown>>,
): OvenAssignmentEdit | null {
  if (Object.keys(body).length !== 5 || !isRecord(body.settings)) return null;
  try {
    const settings = parseSettings(body.settings);
    const procedure = reference("bakery_procedure", body.procedureId);
    const replacement = reference("bakery_equipment", body.equipmentId);
    const relationship = parseCustomCommerceRelationshipRef(body.relationship);
    if (
      settings.kind !== "valid" ||
      relationship.definition.definitionId !== "bakery_operation_equipment" ||
      relationship.definition.revision !== 1
    )
      return null;
    return {
      [validated]: true,
      procedure,
      replacement,
      relationship,
      snapshot: parseCommerceSnapshotRevision(body.snapshot),
      settings: settings.settings,
    };
  } catch {
    return null;
  }
}

type Input = Readonly<{
  client: CommerceEntityPlaneClient;
  organisationId: string;
  merchantId: string;
  principalId: string;
  commandId: string;
  expiresAt: string;
  edit: OvenAssignmentEdit;
}>;
type OvenAssignmentResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | "revision_conflict"
        | "bakery_assignment_invalid"
        | "underclerk_unavailable";
    }>;

export async function saveOvenAssignment(
  input: Input,
): Promise<OvenAssignmentResult> {
  const { edit } = input;
  const current = await readGraph(
    input,
    parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: edit.procedure,
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    }),
  );
  // A committed command can outlive the control receipt. An old snapshot can
  // only replay its exact command or fail Commerce's merchant revision fence.
  if (current.merchantRevision > edit.snapshot) return commit(input);
  if (current.merchantRevision < edit.snapshot)
    return { ok: false, code: "revision_conflict" };
  const loaded = await readBakeryProcedureGraph(
    readGraph.bind(null, input),
    edit.procedure,
  );
  if (loaded.kind !== "ready")
    return { ok: false, code: "bakery_assignment_invalid" };
  if (loaded.graph.merchantRevision !== edit.snapshot)
    return { ok: false, code: "revision_conflict" };
  const original = compileBakeryGraph(
    loaded.graph,
    edit.procedure,
    edit.settings,
  );
  if (original.kind !== "ready")
    return { ok: false, code: "bakery_assignment_invalid" };
  const bake = original.procedure.operations.find(isBake);
  if (
    !bake ||
    bake.assignment.relationshipId !== edit.relationship.relationshipId ||
    bake.assignment.revision !== edit.relationship.revision
  )
    return { ok: false, code: "revision_conflict" };
  if (bake.equipment.entityId === edit.replacement.entityId)
    return { ok: false, code: "bakery_assignment_invalid" };
  const replacement = await readGraph(
    input,
    parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: edit.replacement,
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    }),
  );
  if (replacement.merchantRevision !== edit.snapshot)
    return { ok: false, code: "revision_conflict" };
  const equipment = replacement.entities[0];
  if (
    replacement.entities.length !== 1 ||
    !equipment ||
    equipment.reference.entityId !== edit.replacement.entityId
  )
    return { ok: false, code: "bakery_assignment_invalid" };
  const candidate: CommerceGraphQueryResult = {
    ...loaded.graph,
    entities: loaded.graph.entities.map(
      replaceEquipment.bind(null, bake.equipment, equipment),
    ),
    relationships: loaded.graph.relationships.map(
      replaceAssignment.bind(null, edit),
    ),
  };
  const compiled = compileBakeryGraph(candidate, edit.procedure, edit.settings);
  if (compiled.kind !== "ready")
    return { ok: false, code: "bakery_assignment_invalid" };
  return commit(input);
}

async function commit(input: Input): Promise<OvenAssignmentResult> {
  const target = {
    relationship: input.edit.relationship,
    replacementTarget: input.edit.replacement,
  };
  const request = parseEntityPlaneCommand({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    commandId: input.commandId,
    expectedMerchantRevision: input.edit.snapshot,
    authority: {
      kind: "relationship_replacement",
      context: {
        organisationId: input.organisationId,
        merchantId: input.merchantId,
        principalId: input.principalId,
        sensitivityCeiling: "restricted",
        expiresAt: input.expiresAt,
        causation: { kind: "command", commandId: input.commandId },
      },
      scope: { kind: "relationship", relationship: input.edit.relationship },
      target,
    },
    command: { kind: "replace_custom_relationship", command: { target } },
  });
  const result = await input.client.command(request);
  if (!result.ok) return { ok: false, code: "underclerk_unavailable" };
  if (result.value.status === "accepted") return { ok: true };
  return {
    ok: false,
    code:
      result.value.error.code === "revision_conflict"
        ? "revision_conflict"
        : "bakery_assignment_invalid",
  };
}

async function readGraph(
  input: Input,
  query: CommerceGraphQuery,
): Promise<CommerceGraphQueryResult> {
  const result = await input.client.query(input.merchantId, query);
  if (!result.ok) throw new Error("Underclerk graph unavailable");
  return result.value;
}
function reference(typeId: string, entityId: unknown): CustomCommerceEntityRef {
  const query = parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: { origin: "custom", typeId, entityId },
    traversal: { maxDepth: 0, resultLimit: 1 },
    filter: null,
  });
  if (query.kind !== "entity_by_ref" || query.reference.origin !== "custom")
    throw new Error("Invalid reference");
  return query.reference;
}
function isBake(operation: Readonly<{ operation: string }>): boolean {
  return operation.operation === "bake";
}
function replaceEquipment(
  previous: CustomCommerceEntityRef,
  replacement: CommerceEntity,
  entity: CommerceEntity,
): CommerceEntity {
  return entity.reference.origin === previous.origin &&
    entity.reference.typeId === previous.typeId &&
    entity.reference.entityId === previous.entityId
    ? replacement
    : entity;
}
function replaceAssignment(
  edit: OvenAssignmentEdit,
  relationship: CommerceRelationship,
): CommerceRelationship {
  if (
    relationship.origin !== "custom" ||
    relationship.relationshipId !== edit.relationship.relationshipId
  )
    return relationship;
  return { ...relationship, target: edit.replacement };
}
