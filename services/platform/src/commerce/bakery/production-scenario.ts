import {
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseEntityPlaneCommand,
  type CommerceEntityPlaneClient,
} from "@seams/commerce-client";
import { bakeryFingerprint, fields } from "@seams/bakery-model/bakery";
import {
  productionAssignmentId,
  productionDefinitionFingerprint,
  productionSettingsMatchProcedure,
  type ProductionAssignment,
  type ProductionScenario,
} from "@seams/bakery-model/bakery-production-scenario";
import { readBakeryProcedure } from "@seams/bakery-model/bakery-procedure";
import type {
  CommerceGraphQuery,
  CommerceGraphQueryResult,
} from "@seams/contracts";
import { entityType, type CommandStep } from "./sample";

const scenarioType = "bakery_production_scenario";
const taskType = "bakery_production_task";

type Input = Readonly<{
  client: Pick<CommerceEntityPlaneClient, "query" | "command">;
  organisationId: string;
  merchantId: string;
  principalId: string;
  expiresAt: string;
  copy: ProductionScenario;
}>;

export async function saveProductionScenario(
  input: Input,
): Promise<
  | Readonly<{ ok: true; scenarioId: string }>
  | Readonly<{ ok: false; code: string }>
> {
  const copy = input.copy;
  try {
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
    if (query.kind !== "entity_by_ref" || query.reference.origin !== "custom")
      return { ok: false, code: "bakery_production_scenario_invalid" };
    const source = await readBakeryProcedure(
      readGraph.bind(null, input.client, input.merchantId),
      query.reference,
      copy.settings,
    );
    if (source.kind !== "ready")
      return { ok: false, code: "bakery_production_scenario_invalid" };
    if (
      (await bakeryFingerprint(source.procedure.revisionKey)) !==
      copy.sourceFingerprint
    )
      return { ok: false, code: "bakery_scenario_stale" };
    if (
      (await productionDefinitionFingerprint(
        copy.sourceFingerprint,
        copy.settings,
        copy.variant,
        copy.assignments,
        copy.manualTasks,
        copy,
      )) !== copy.definitionFingerprint
    )
      return { ok: false, code: "bakery_production_scenario_invalid" };
    if (!productionSettingsMatchProcedure(copy, source.procedure.settings))
      return { ok: false, code: "bakery_production_scenario_invalid" };
    let revision = source.procedure.snapshotRevision;
    for (const step of commands(copy)) {
      const commandId = `bakery-production-scenario:v1:${step.id}`;
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
      if (!result.ok) return { ok: false, code: "underclerk_unavailable" };
      if (result.value.status !== "accepted")
        return { ok: false, code: result.value.error.code };
      revision = parseCommerceSnapshotRevision(
        Math.max(
          Number(revision),
          Number(result.value.receipt.merchantRevision),
        ),
      );
    }
    return { ok: true, scenarioId: copy.id };
  } catch {
    return { ok: false, code: "underclerk_unavailable" };
  }
}

async function readGraph(
  client: Pick<CommerceEntityPlaneClient, "query">,
  merchantId: string,
  query: CommerceGraphQuery,
): Promise<CommerceGraphQueryResult> {
  const result = await client.query(merchantId, query);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function commands(copy: ProductionScenario): readonly CommandStep[] {
  const previousFields = fields.filter(priorSetting);
  const scenarioAttributes = previousFields.map((field) =>
    definition(scenarioType, field.key, {
      kind: "integer",
      minimum: field.min,
      maximum: field.max,
    }),
  );
  scenarioAttributes.push(
    definition(scenarioType, "timing_note", {
      kind: "long_text",
      maxLength: 2000,
    }),
    definition(scenarioType, "source_fingerprint", {
      kind: "short_text",
      maxLength: 64,
    }),
    definition(scenarioType, "definition_fingerprint", {
      kind: "short_text",
      maxLength: 64,
    }),
    definition(scenarioType, "variant", { kind: "short_text", maxLength: 16 }),
  );
  const scenarioAttributesRevisionTwo = previousFields.map((field) =>
    definition(
      scenarioType,
      field.key,
      { kind: "integer", minimum: field.min, maximum: field.max },
      2,
    ),
  );
  scenarioAttributesRevisionTwo.push(
    definition(
      scenarioType,
      "timing_note",
      { kind: "long_text", maxLength: 2000 },
      2,
    ),
    definition(
      scenarioType,
      "source_fingerprint",
      { kind: "short_text", maxLength: 64 },
      2,
    ),
    definition(
      scenarioType,
      "definition_fingerprint",
      { kind: "short_text", maxLength: 64 },
      2,
    ),
    definition(
      scenarioType,
      "variant",
      { kind: "short_text", maxLength: 16 },
      2,
    ),
    definition(
      scenarioType,
      "canvas_positions",
      { kind: "long_text", maxLength: 2000 },
      2,
    ),
  );
  const scenarioAttributesRevisionThree = previousFields.map(
    productionFieldDefinition.bind(null, 3),
  );
  const scenarioAttributesRevisionFour = fields.map(
    productionFieldDefinition.bind(null, 4),
  );
  const scenarioAttributesRevisionFive = fields.map(
    productionFieldDefinition.bind(null, 5),
  );
  for (const [id, length] of [
    ["timing_note", 2000],
    ["source_fingerprint", 64],
    ["definition_fingerprint", 64],
    ["variant", 16],
    ["canvas_positions", 2000],
    ["manual_tasks", 24000],
    ["task_dependencies", 24000],
  ] as const) {
    for (const [revision, attributes] of [
      [3, scenarioAttributesRevisionThree],
      [4, scenarioAttributesRevisionFour],
      [5, scenarioAttributesRevisionFive],
    ] as const) {
      attributes.push(
        definition(
          scenarioType,
          id,
          { kind: length > 80 ? "long_text" : "short_text", maxLength: length },
          revision,
        ),
      );
    }
  }

  scenarioAttributesRevisionFive.push(
    definition(
      scenarioType,
      "execution_route",
      { kind: "long_text", maxLength: 4096 },
      5,
    ),
  );

  const result: CommandStep[] = [
    ...entityType(
      scenarioType,
      "Bakery production scenario",
      scenarioAttributes,
    ),
    ...entityType(
      scenarioType,
      "Bakery production scenario",
      scenarioAttributesRevisionTwo,
      2,
    ),
    ...entityType(
      scenarioType,
      "Bakery production scenario",
      scenarioAttributesRevisionThree,
      3,
    ),
    ...entityType(
      scenarioType,
      "Bakery production scenario",
      scenarioAttributesRevisionFour,
      4,
    ),
    ...entityType(
      scenarioType,
      "Bakery production scenario",
      scenarioAttributesRevisionFive,
      5,
    ),
    ...entityType(taskType, "Bakery production task", [
      definition(taskType, "batch_index", {
        kind: "integer",
        minimum: 0,
        maximum: 5,
      }),
      definition(taskType, "tray", { kind: "integer", minimum: 1, maximum: 4 }),
      definition(taskType, "worker_index", {
        kind: "integer",
        minimum: 1,
        maximum: 3,
      }),
    ]),
    ...entityType(
      taskType,
      "Bakery production task",
      [
        definition(
          taskType,
          "batch_index",
          { kind: "integer", minimum: 0, maximum: 5 },
          2,
        ),
        definition(
          taskType,
          "tray",
          { kind: "integer", minimum: 1, maximum: 4 },
          2,
        ),
        definition(
          taskType,
          "worker_index",
          { kind: "integer", minimum: 1, maximum: 3 },
          2,
        ),
        definition(
          taskType,
          "earliest_start_seconds",
          { kind: "integer", minimum: 0, maximum: 43200 },
          2,
        ),
      ],
      2,
    ),
    ...relationshipDefinition(
      "bakery_production_procedure",
      scenarioType,
      "bakery_procedure",
      "many_to_one",
    ),
    ...relationshipDefinition(
      "bakery_production_task_member",
      scenarioType,
      taskType,
      "many_to_many",
    ),
    ...relationshipDefinition(
      "bakery_production_task_after",
      taskType,
      taskType,
      "many_to_many",
    ),
  ];
  const values = fields.map((field) =>
    value(scenarioType, field.key, "integer", copy.settings[field.key], 5),
  );
  values.push(
    value(scenarioType, "timing_note", "long_text", copy.note, 5),
    value(
      scenarioType,
      "source_fingerprint",
      "short_text",
      copy.sourceFingerprint,
      5,
    ),
    value(
      scenarioType,
      "definition_fingerprint",
      "short_text",
      copy.definitionFingerprint,
      5,
    ),
    value(scenarioType, "variant", "short_text", copy.variant, 5),
    value(
      scenarioType,
      "canvas_positions",
      "long_text",
      JSON.stringify(copy.presentation),
      5,
    ),
  );
  values.push(
    value(
      scenarioType,
      "manual_tasks",
      "long_text",
      JSON.stringify(copy.manualTasks),
      5,
    ),
    value(
      scenarioType,
      "task_dependencies",
      "long_text",
      JSON.stringify(
        Object.fromEntries(copy.assignments.map(assignmentDependencies)),
      ),
      5,
    ),
  );
  const route =
    copy.route === "oven-rack"
      ? {
          route: copy.route,
          cell: copy.cell,
          executionBundleId: copy.executionBundleId,
        }
      : { route: copy.route };
  values.push(
    value(
      scenarioType,
      "execution_route",
      "long_text",
      JSON.stringify(route),
      5,
    ),
  );
  result.push(entity(scenarioType, copy.id, copy.name, values, 5));
  result.push(
    link(
      `${copy.id}:procedure`,
      "bakery_production_procedure",
      reference(scenarioType, copy.id),
      reference("bakery_procedure", copy.procedureId),
    ),
  );
  for (const assignment of copy.assignments) {
    const id = bakeryTaskId(copy.id, assignment);
    const taskValues = [
      value(
        taskType,
        "batch_index",
        "integer",
        assignment.batchId.charCodeAt(0) - 65,
        2,
      ),
      value(taskType, "tray", "integer", assignment.tray, 2),
      value(
        taskType,
        "worker_index",
        "integer",
        Number(assignment.workerId.slice(6)),
        2,
      ),
      value(
        taskType,
        "earliest_start_seconds",
        "integer",
        assignment.earliestStartSeconds,
        2,
      ),
    ];
    result.push(
      entity(
        taskType,
        id,
        `${assignment.batchId} · tray ${assignment.tray}`,
        taskValues,
        2,
      ),
    );
    result.push(
      link(
        `${id}:member`,
        "bakery_production_task_member",
        reference(scenarioType, copy.id),
        reference(taskType, id),
      ),
    );
  }
  return result;
}

function bakeryTaskId(
  scenarioId: string,
  assignment: ProductionAssignment,
): string {
  return `${scenarioId}:task:${assignment.batchId}:${assignment.tray}`;
}
function reference(typeId: string, entityId: string) {
  return { origin: "custom", typeId, entityId } as const;
}
function priorSetting(field: (typeof fields)[number]): boolean {
  return field.key !== "finishCooling";
}

function productionFieldDefinition(
  revision: number,
  field: (typeof fields)[number],
): unknown {
  return definition(
    scenarioType,
    field.key,
    { kind: "integer", minimum: field.min, maximum: field.max },
    revision,
  );
}
function assignmentDependencies(
  assignment: ProductionAssignment,
): readonly [string, readonly string[]] {
  return [productionAssignmentId(assignment), assignment.dependsOn];
}

function definition(
  typeId: string,
  id: string,
  kind: unknown,
  revision = 1,
): unknown {
  return {
    id,
    scope: { kind: "custom", entityTypeId: typeId, typeRevision: revision },
    label: id,
    helpText: null,
    required: true,
    sensitivity: "internal",
    kind,
    revision: 1,
  };
}
function value(
  typeId: string,
  attributeId: string,
  kind: string,
  content: string | number,
  revision = 1,
): unknown {
  return {
    attributeId,
    scope: { kind: "custom", entityTypeId: typeId, typeRevision: revision },
    definitionRevision: 1,
    sensitivity: "internal",
    value: { kind, value: content },
  };
}
function entity(
  typeId: string,
  entityId: string,
  displayName: string,
  attributes: readonly unknown[],
  revision = 1,
): CommandStep {
  return {
    id: `${entityId}:entity`,
    command: {
      kind: "create_custom_entity",
      command: {
        entityId,
        typeId,
        typeRevision: revision,
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
      target: { entityId, typeId },
    },
  };
}
function relationshipDefinition(
  definitionId: string,
  sourceType: string,
  targetType: string,
  cardinality: "many_to_one" | "many_to_many",
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
            cardinality,
            deletionBehavior: "restrict",
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
        command: {
          target: { definitionId, revision: 1 },
        },
      },
      authority: {
        kind: "custom_relationship_definition_publish",
        scope,
        target: { definitionId, revision: 1 },
      },
    },
  ];
}
function link(
  relationshipId: string,
  definitionId: string,
  source: ReturnType<typeof reference>,
  target: ReturnType<typeof reference>,
): CommandStep {
  const definition = { origin: "custom", definitionId, revision: 1 };
  const relationship = { relationshipId, definition, source, target };
  return {
    id: `${relationshipId}:relationship`,
    command: {
      kind: "create_custom_relationship",
      command: { target: relationship },
    },
    authority: {
      kind: "relationship_create",
      scope: {
        kind: "relationship_definition",
        relationshipDefinition: definition,
      },
      target: relationship,
    },
  };
}
