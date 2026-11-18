import type {
  AttributeValueAssignment,
  CommerceEntityRevision,
  CommerceSnapshotRevision,
  CustomCommerceEntityRef,
} from "@seams/contracts";
import {
  parseCommerceEntityRevision,
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseEntityPlaneCommand,
  type CommerceEntityPlaneClient,
} from "@seams/commerce-client";

const validated: unique symbol = Symbol("bakery operation edit");

export type OperationEdit = Readonly<{
  [validated]: true;
  reference: CustomCommerceEntityRef;
  expectedRevision: CommerceEntityRevision;
  snapshot: CommerceSnapshotRevision;
  minutes: number;
}>;

export type OperationEditResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code:
        | "revision_conflict"
        | "bakery_operation_invalid"
        | "underclerk_unavailable";
    }>;

export function parseOperationEdit(
  body: Readonly<Record<string, unknown>>,
): OperationEdit | null {
  if (
    Object.keys(body).length !== 4 ||
    !["entityId", "expectedRevision", "snapshot", "minutes"].every(
      hasField.bind(null, body),
    )
  ) {
    return null;
  }
  if (
    typeof body.entityId !== "string" ||
    body.entityId.length > 128 ||
    typeof body.minutes !== "number" ||
    !Number.isInteger(body.minutes) ||
    body.minutes < 1 ||
    body.minutes > 60
  ) {
    return null;
  }
  try {
    const query = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_operation",
        entityId: body.entityId,
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    });
    if (query.kind !== "entity_by_ref" || query.reference.origin !== "custom") {
      return null;
    }
    return {
      [validated]: true,
      reference: query.reference,
      expectedRevision: parseCommerceEntityRevision(body.expectedRevision),
      snapshot: parseCommerceSnapshotRevision(body.snapshot),
      minutes: body.minutes,
    };
  } catch {
    return null;
  }
}

export async function saveOperationDuration(
  input: Readonly<{
    client: CommerceEntityPlaneClient;
    organisationId: string;
    merchantId: string;
    principalId: string;
    commandId: string;
    expiresAt: string;
    edit: OperationEdit;
  }>,
): Promise<OperationEditResult> {
  const edit = input.edit;
  const result = await input.client.query(input.merchantId, {
    kind: "entity_by_ref",
    reference: edit.reference,
    traversal: { maxDepth: 0, resultLimit: 1 },
    filter: null,
  });
  if (!result.ok) {
    return { ok: false, code: "underclerk_unavailable" };
  }
  if (result.value.merchantRevision !== edit.snapshot) {
    return { ok: false, code: "revision_conflict" };
  }
  const entity = result.value.entities[0];
  if (
    !entity ||
    result.value.entities.length !== 1 ||
    !("typeRevision" in entity) ||
    entity.typeRevision !== 1 ||
    entity.state.state !== "active" ||
    entity.reference.entityId !== edit.reference.entityId ||
    entity.reference.typeId !== "bakery_operation"
  ) {
    return { ok: false, code: "bakery_operation_invalid" };
  }
  if (entity.revision !== edit.expectedRevision) {
    return { ok: false, code: "revision_conflict" };
  }
  const request = parseEntityPlaneCommand({
    organisationId: input.organisationId,
    merchantId: input.merchantId,
    commandId: input.commandId,
    expectedMerchantRevision: edit.snapshot,
    authority: {
      kind: "entity_command",
      context: {
        organisationId: input.organisationId,
        merchantId: input.merchantId,
        principalId: input.principalId,
        sensitivityCeiling: "restricted",
        expiresAt: input.expiresAt,
        causation: { kind: "command", commandId: input.commandId },
      },
      scope: { kind: "entity", entityRef: edit.reference },
      target: {
        entityRef: edit.reference,
        expectedRevision: edit.expectedRevision,
      },
    },
    command: {
      kind: "patch_custom_entity",
      command: {
        entityRef: edit.reference,
        typeRevision: 1,
        expectedRevision: edit.expectedRevision,
        displayName: null,
        attributes: entity.attributes.map(
          replaceMinutes.bind(null, edit.minutes),
        ),
      },
    },
  });
  const saved = await input.client.command(request);
  if (!saved.ok) {
    return { ok: false, code: "underclerk_unavailable" };
  }
  if (saved.value.status === "accepted") {
    return { ok: true };
  }
  return {
    ok: false,
    code:
      saved.value.error.code === "revision_conflict"
        ? "revision_conflict"
        : "bakery_operation_invalid",
  };
}

function hasField(
  body: Readonly<Record<string, unknown>>,
  field: string,
): boolean {
  return Object.hasOwn(body, field);
}

function replaceMinutes(
  minutes: number,
  attribute: AttributeValueAssignment,
): AttributeValueAssignment {
  return attribute.attributeId === "minutes"
    ? {
        attributeId: attribute.attributeId,
        scope: attribute.scope,
        definitionRevision: attribute.definitionRevision,
        sensitivity: attribute.sensitivity,
        value: { kind: "integer", value: BigInt(minutes) },
      }
    : attribute;
}
