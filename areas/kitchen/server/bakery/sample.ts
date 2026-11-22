import {
  financierOperations,
  sampleSettings,
} from "@purin-labs/bakery-model/bakery";
import {
  parseCommerceSnapshotRevision,
  parseEntityPlaneCommand,
  type CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";

export const FINANCIER_SAMPLE_ID = "financier-finishing-cooling-sample";

type SampleInput = Readonly<{
  client: Pick<
    CommerceEntityPlaneClient,
    "command" | "publishedResourceMetadata"
  >;
  organisationId: string;
  merchantId: string;
  principalId: string;
  expiresAt: string;
}>;

type SampleResult =
  | Readonly<{ ok: true; procedureId: string }>
  | Readonly<{ ok: false; code: string }>;

export type CommandStep = Readonly<{
  id: string;
  command: unknown;
  authority: Readonly<Record<string, unknown>>;
}>;

export async function createFinancierSample(
  input: SampleInput,
): Promise<SampleResult> {
  const metadata = await input.client.publishedResourceMetadata({
    kind: "enumerate",
    organisationId: input.organisationId,
    merchantId: input.merchantId,
  });
  if (
    !metadata.ok ||
    metadata.value.kind !== "enumerated" ||
    metadata.value.organisationId !== input.organisationId ||
    metadata.value.merchantId !== input.merchantId
  ) {
    return { ok: false, code: "commerce_unavailable" };
  }
  let revision = metadata.value.merchantRevision;
  for (const step of sampleCommands()) {
    const prefix =
      step.id.startsWith("entity:") || step.id.startsWith("relationship:")
        ? `bakery-sample:${FINANCIER_SAMPLE_ID}`
        : "bakery-sample:v1";
    const commandId = `${prefix}:${step.id}`;
    const request = parseEntityPlaneCommand({
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      expectedMerchantRevision: revision,
      commandId,
      authority: {
        ...step.authority,
        context: {
          organisationId: input.organisationId,
          merchantId: input.merchantId,
          principalId: input.principalId,
          sensitivityCeiling: "restricted",
          expiresAt: input.expiresAt,
          causation: { kind: "command", commandId },
        },
      },
      command: step.command,
    });
    const result = await input.client.command(request);
    if (!result.ok) {
      return { ok: false, code: "commerce_unavailable" };
    }
    if (result.value.status !== "accepted") {
      return { ok: false, code: result.value.error.code };
    }
    // Replayed creates retain their original receipt revision; subsequent new commands need the current revision.
    revision = parseCommerceSnapshotRevision(
      Math.max(Number(revision), Number(result.value.receipt.merchantRevision)),
    );
  }
  return { ok: true, procedureId: FINANCIER_SAMPLE_ID };
}

function sampleCommands(): readonly CommandStep[] {
  const result: CommandStep[] = [];
  result.push(...entityType("bakery_procedure", "Bakery procedure", []));
  result.push(
    ...entityType("bakery_operation", "Bakery operation", [
      attributeDefinition("bakery_operation", "operation", {
        kind: "short_text",
        maxLength: 32,
      }),
      attributeDefinition("bakery_operation", "minutes", {
        kind: "integer",
        minimum: 1,
        maximum: 60,
      }),
    ]),
  );
  result.push(
    ...entityType("bakery_equipment", "Bakery equipment", [
      attributeDefinition("bakery_equipment", "station", {
        kind: "short_text",
        maxLength: 32,
      }),
      attributeDefinition("bakery_equipment", "capacity_trays", {
        kind: "integer",
        minimum: 1,
        maximum: 16,
      }),
    ]),
  );
  result.push(
    ...relationshipDefinition(
      "bakery_procedure_operation",
      "bakery_procedure",
      "bakery_operation",
    ),
  );
  result.push(
    ...relationshipDefinition(
      "bakery_operation_equipment",
      "bakery_operation",
      "bakery_equipment",
    ),
  );
  result.push(
    ...relationshipDefinition(
      "bakery_operation_next",
      "bakery_operation",
      "bakery_operation",
    ),
  );
  result.push(
    entity(
      "bakery_procedure",
      FINANCIER_SAMPLE_ID,
      "Financier finishing · assumed timings",
      [],
    ),
  );
  for (const station of ["stage", "portion", "bake", "cool", "pack"]) {
    result.push(
      entity(
        "bakery_equipment",
        equipmentId(station),
        `${station} · sample equipment`,
        [
          attributeValue("bakery_equipment", "station", station),
          attributeValue(
            "bakery_equipment",
            "capacity_trays",
            station === "cool" ? 8 : 4,
          ),
        ],
      ),
    );
  }
  for (const item of financierOperations) {
    result.push(
      entity(
        "bakery_operation",
        operationId(item.operation),
        `${item.operation} financiers`,
        [
          attributeValue("bakery_operation", "operation", item.operation),
          attributeValue(
            "bakery_operation",
            "minutes",
            sampleSettings()[item.operation],
          ),
        ],
      ),
    );
  }
  let previous: string | null = null;
  for (const item of financierOperations) {
    result.push(
      relationship(
        `member:${item.operation}`,
        "bakery_procedure_operation",
        reference("bakery_procedure", FINANCIER_SAMPLE_ID),
        reference("bakery_operation", operationId(item.operation)),
      ),
    );
    result.push(
      relationship(
        `equipment:${item.operation}`,
        "bakery_operation_equipment",
        reference("bakery_operation", operationId(item.operation)),
        reference("bakery_equipment", equipmentId(item.station)),
      ),
    );
    if (previous !== null) {
      result.push(
        relationship(
          `next:${item.operation}`,
          "bakery_operation_next",
          reference("bakery_operation", operationId(previous)),
          reference("bakery_operation", operationId(item.operation)),
        ),
      );
    }
    previous = item.operation;
  }
  return result;
}

export function entityType(
  typeId: string,
  label: string,
  attributes: readonly unknown[],
  revision = 1,
): readonly CommandStep[] {
  const scope = {
    kind: "entity_type",
    entityTypeId: { origin: "custom", typeId },
  };
  return [
    {
      id: revision === 1 ? `${typeId}:create` : `${typeId}:create:${revision}`,
      command: {
        kind: "create_custom_entity_type",
        command: {
          draft: {
            typeId,
            revision,
            label,
            description: "Bakery workflow simulation objects",
            attributes,
          },
        },
      },
      authority: {
        kind: "custom_entity_type_create",
        scope,
        target: { typeId },
      },
    },
    {
      id:
        revision === 1 ? `${typeId}:publish` : `${typeId}:publish:${revision}`,
      command: {
        kind: "publish_custom_entity_type",
        command: { target: { typeId, revision } },
      },
      authority: {
        kind: "custom_entity_type_publish",
        scope,
        target: { typeId, revision },
      },
    },
  ];
}

function attributeDefinition(
  typeId: string,
  id: string,
  kind: unknown,
): unknown {
  return {
    id,
    scope: { kind: "custom", entityTypeId: typeId, typeRevision: 1 },
    label: id.replaceAll("_", " "),
    helpText: null,
    required: true,
    sensitivity: "internal",
    kind,
    revision: 1,
  };
}

function relationshipDefinition(
  definitionId: string,
  sourceType: string,
  targetType: string,
): readonly CommandStep[] {
  const definition = { origin: "custom", definitionId, revision: 1 };
  const scope = {
    kind: "relationship_definition",
    relationshipDefinition: definition,
  };
  return [
    {
      id: `${definitionId}:create`,
      command: {
        kind: "create_custom_relationship_definition",
        command: {
          draft: {
            ...definition,
            sourceType: { origin: "custom", typeId: sourceType },
            targetType: { origin: "custom", typeId: targetType },
            sourceLabel: definitionId,
            inverseLabel: `inverse ${definitionId}`,
            cardinality: "many_to_many",
            deletionBehavior: "detach",
            sensitivity: "internal",
          },
        },
      },
      authority: {
        kind: "custom_relationship_definition_create",
        scope,
        target: { definitionId },
      },
    },
    {
      id: `${definitionId}:publish`,
      command: {
        kind: "publish_custom_relationship_definition",
        command: { target: { definitionId, revision: 1 } },
      },
      authority: {
        kind: "custom_relationship_definition_publish",
        scope,
        target: { definitionId, revision: 1 },
      },
    },
  ];
}

function entity(
  typeId: string,
  entityId: string,
  displayName: string,
  attributes: readonly unknown[],
): CommandStep {
  return {
    id: `entity:${entityId}`,
    command: {
      kind: "create_custom_entity",
      command: {
        entityId,
        typeId,
        typeRevision: 1,
        displayName,
        attributes,
        sensitivity: "internal",
      },
    },
    authority: {
      kind: "entity_create",
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "custom", typeId },
      },
      target: { typeId, entityId },
    },
  };
}

function attributeValue(
  typeId: string,
  attributeId: string,
  value: string | number,
): unknown {
  return {
    attributeId,
    scope: { kind: "custom", entityTypeId: typeId, typeRevision: 1 },
    definitionRevision: 1,
    sensitivity: "internal",
    value:
      typeof value === "string"
        ? { kind: "short_text", value }
        : { kind: "integer", value },
  };
}

function relationship(
  id: string,
  definitionId: string,
  source: unknown,
  destination: unknown,
): CommandStep {
  const definition = { origin: "custom", definitionId, revision: 1 };
  const target = {
    relationshipId: `${FINANCIER_SAMPLE_ID}:${id}`,
    definition,
    source,
    target: destination,
  };
  return {
    id: `relationship:${id}`,
    command: { kind: "create_custom_relationship", command: { target } },
    authority: {
      kind: "relationship_create",
      scope: {
        kind: "relationship_definition",
        relationshipDefinition: definition,
      },
      target,
    },
  };
}

function reference(typeId: string, entityId: string): unknown {
  return { origin: "custom", typeId, entityId };
}

function operationId(operation: string): string {
  return `${FINANCIER_SAMPLE_ID}:${operation}`;
}

function equipmentId(station: string): string {
  return `${FINANCIER_SAMPLE_ID}:equipment:${station}`;
}
