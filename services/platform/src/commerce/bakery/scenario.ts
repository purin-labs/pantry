import {
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseEntityPlaneCommand,
  type CommerceEntityPlaneClient,
} from "@seams/commerce-client";
import { bakeryFingerprint, fields } from "@seams/bakery-model/bakery";
import {
  readBakeryProcedure,
  type ProcedureResult,
} from "@seams/bakery-model/bakery-procedure";
import type {
  CommerceGraphQuery,
  CommerceGraphQueryResult,
} from "@seams/contracts";
import type { ScenarioCopy } from "@seams/bakery-model/bakery-scenario";
import { entityType, type CommandStep } from "./sample";

export async function saveScenarioCopy(
  input: Readonly<{
    client: Pick<CommerceEntityPlaneClient, "query" | "command">;
    organisationId: string;
    merchantId: string;
    principalId: string;
    expiresAt: string;
    copy: ScenarioCopy;
  }>,
): Promise<
  | Readonly<{ ok: true; scenarioId: string }>
  | Readonly<{ ok: false; code: string }>
> {
  const copy = input.copy;
  const query = parseCommerceGraphQuery({
    kind: "entity_by_ref",
    reference: {
      origin: "custom",
      typeId: "bakery_procedure",
      entityId: copy.procedureId,
    },
    traversal: { maxDepth: 0, resultLimit: 1 },
    filter: null,
  });
  if (query.kind !== "entity_by_ref" || query.reference.origin !== "custom") {
    return { ok: false, code: "bakery_scenario_invalid" };
  }
  let source: ProcedureResult;
  try {
    source = await readBakeryProcedure(
      readScenarioSource.bind(null, input.client, input.merchantId),
      query.reference,
      copy.settings,
    );
  } catch {
    return { ok: false, code: "underclerk_unavailable" };
  }
  if (
    source.kind !== "ready" ||
    (await bakeryFingerprint(source.procedure.revisionKey)) !== copy.fingerprint
  ) {
    return { ok: false, code: "bakery_scenario_stale" };
  }
  for (const field of fields) {
    if (source.procedure.settings[field.key] !== copy.settings[field.key]) {
      return { ok: false, code: "bakery_scenario_invalid" };
    }
  }
  let revision = source.procedure.snapshotRevision;
  for (const step of scenarioCommands(copy)) {
    const commandId = `bakery-scenario:v1:${step.id}`;
    const request = parseEntityPlaneCommand({
      organisationId: input.organisationId,
      merchantId: input.merchantId,
      expectedMerchantRevision: revision,
      commandId,
      command: step.command,
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
    });
    const result = await input.client.command(request);
    if (!result.ok) {
      return { ok: false, code: "underclerk_unavailable" };
    }
    if (result.value.status !== "accepted") {
      return { ok: false, code: result.value.error.code };
    }
    revision = parseCommerceSnapshotRevision(
      Math.max(Number(revision), Number(result.value.receipt.merchantRevision)),
    );
  }
  return { ok: true, scenarioId: copy.id };
}

async function readScenarioSource(
  client: Pick<CommerceEntityPlaneClient, "query">,
  merchantId: string,
  query: CommerceGraphQuery,
): Promise<CommerceGraphQueryResult> {
  const result = await client.query(merchantId, query);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

function scenarioCommands(copy: ScenarioCopy): readonly CommandStep[] {
  const previousAttributes = fields
    .filter(priorSetting)
    .map(settingDefinition.bind(null, 1));
  previousAttributes.push(
    definition("timing_note", { kind: "long_text", maxLength: 2000 }, 1),
    definition("source_fingerprint", { kind: "short_text", maxLength: 64 }, 1),
  );
  const attributes = fields.map(settingDefinition.bind(null, 2));
  attributes.push(
    definition("timing_note", { kind: "long_text", maxLength: 2000 }),
    definition("source_fingerprint", { kind: "short_text", maxLength: 64 }),
  );
  const result = [
    ...entityType("bakery_scenario", "Bakery scenario", previousAttributes),
    ...entityType("bakery_scenario", "Bakery scenario", attributes, 2),
  ];
  const relationshipDefinition = {
    origin: "custom",
    definitionId: "bakery_scenario_procedure",
    revision: 1,
  };
  const scope = { kind: "relationship_definition", relationshipDefinition };
  const draft = {
    ...relationshipDefinition,
    sourceType: { origin: "custom", typeId: "bakery_scenario" },
    targetType: { origin: "custom", typeId: "bakery_procedure" },
    sourceLabel: "Procedure",
    inverseLabel: "Scenarios",
    cardinality: "many_to_one",
    deletionBehavior: "restrict",
    sensitivity: "internal",
  };
  result.push({
    id: "relationship-definition:create",
    command: {
      kind: "create_custom_relationship_definition",
      command: { draft },
    },
    authority: {
      kind: "custom_relationship_definition_create",
      scope,
      target: { definitionId: relationshipDefinition.definitionId },
    },
  });
  result.push({
    id: "relationship-definition:publish",
    command: {
      kind: "publish_custom_relationship_definition",
      command: {
        target: {
          definitionId: relationshipDefinition.definitionId,
          revision: 1,
        },
      },
    },
    authority: {
      kind: "custom_relationship_definition_publish",
      scope,
      target: {
        definitionId: relationshipDefinition.definitionId,
        revision: 1,
      },
    },
  });
  const values: unknown[] = [];
  for (const field of fields) {
    values.push(
      value(field.key, { kind: "integer", value: copy.settings[field.key] }),
    );
  }
  values.push(
    value("timing_note", { kind: "long_text", value: copy.note }),
    value("source_fingerprint", {
      kind: "short_text",
      value: copy.fingerprint,
    }),
  );
  result.push({
    id: `${copy.id}:entity`,
    command: {
      kind: "create_custom_entity",
      command: {
        entityId: copy.id,
        typeId: "bakery_scenario",
        typeRevision: 2,
        displayName: copy.name,
        attributes: values,
        sensitivity: "internal",
      },
    },
    authority: {
      kind: "entity_create",
      scope: {
        kind: "entity_type",
        entityTypeId: { origin: "custom", typeId: "bakery_scenario" },
      },
      target: { entityId: copy.id, typeId: "bakery_scenario" },
    },
  });
  const target = {
    relationshipId: `${copy.id}:procedure`,
    definition: relationshipDefinition,
    source: { origin: "custom", typeId: "bakery_scenario", entityId: copy.id },
    target: {
      origin: "custom",
      typeId: "bakery_procedure",
      entityId: copy.procedureId,
    },
  };
  result.push({
    id: `${copy.id}:relationship`,
    command: { kind: "create_custom_relationship", command: { target } },
    authority: { kind: "relationship_create", scope, target },
  });
  return result;
}

function definition(id: string, kind: unknown, typeRevision = 2): unknown {
  return {
    id,
    scope: { kind: "custom", entityTypeId: "bakery_scenario", typeRevision },
    label: id,
    helpText: null,
    required: true,
    sensitivity: "internal",
    kind,
    revision: 1,
  };
}

function priorSetting(field: (typeof fields)[number]): boolean {
  return field.key !== "finishCooling";
}

function settingDefinition(
  typeRevision: number,
  field: (typeof fields)[number],
): unknown {
  return definition(
    field.key,
    {
      kind: "integer",
      minimum: field.min,
      maximum: field.max,
    },
    typeRevision,
  );
}

function value(attributeId: string, attributeValue: unknown): unknown {
  return {
    attributeId,
    scope: { kind: "custom", entityTypeId: "bakery_scenario", typeRevision: 2 },
    definitionRevision: 1,
    sensitivity: "internal",
    value: attributeValue,
  };
}
