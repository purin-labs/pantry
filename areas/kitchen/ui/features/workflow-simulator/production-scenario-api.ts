import { bakeryFingerprint, fields } from "@purin-labs/bakery-model/bakery";
import {
  parseProductionScenario,
  productionAssignmentId,
  productionDefinitionFingerprint,
  productionScenarioFromGraph,
  productionSettingsMatchProcedure,
  type ProductionScenario,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import type { CompiledProcedure } from "@purin-labs/bakery-model/bakery-procedure";
import type { CustomCommerceEntity } from "@purin-labs/commerce-contracts";
import { parseCommerceGraphQuery } from "@purin-labs/commerce-client";
import {
  customEntityRef,
  readCommerceGraph,
} from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import type { CommerceMutationTransport } from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import { readProcedure } from "./procedure-api.ts";
import { scenarioSaveRejection } from "./workspace-commands.ts";
import { isRecord, sameJson } from "@purin-labs/std";

export type ProductionScenarioRead =
  | Readonly<{
      kind: "ready";
      definition: ProductionScenario;
      procedure: CompiledProcedure;
    }>
  | Readonly<{ kind: "invalid"; message: string }>;

export async function readProductionScenario(
  organisationId: string,
  scenarioId: string,
): Promise<ProductionScenarioRead> {
  const reference = customEntityRef("bakery_production_scenario", scenarioId);
  const membership = await readCommerceGraph(
    organisationId,
    parseCommerceGraphQuery({
      kind: "relationship_traversal",
      seeds: [reference],
      relationshipDefinition: {
        origin: "custom",
        definitionId: "bakery_production_task_member",
        revision: 1,
      },
      traversal: { maxDepth: 1, resultLimit: 100 },
      filter: null,
    }),
  );
  const tasks = membership.entities.filter(isProductionTask);
  if (membership.nextCursor !== null || tasks.length > 16)
    return invalid("The saved production definition is incomplete.");
  const parent = await readCommerceGraph(
    organisationId,
    parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference,
      traversal: { maxDepth: 1, resultLimit: 100 },
      filter: null,
    }),
  );
  if (parent.merchantRevision !== membership.merchantRevision)
    return invalid(
      "The workspace changed while reading this production scenario. Reload and try again.",
    );
  if (parent.nextCursor !== null)
    return invalid("The saved production definition is incomplete.");
  // The parent read holds the scenario's links, and the membership read holds
  // its tasks. Task dependencies are in the task_dependencies attribute.
  const graph = {
    ...parent,
    entities: [...parent.entities, ...membership.entities],
  };
  const definition = productionScenarioFromGraph(graph, scenarioId);
  if (definition === null)
    return invalid("The saved production definition is invalid or incomplete.");
  const source = await readProcedure(
    organisationId,
    definition.procedureId,
    definition.settings,
  );
  if (source.kind !== "ready") return invalid(source.message);
  if (
    (await bakeryFingerprint(source.procedure.revisionKey)) !==
    definition.sourceFingerprint
  )
    return invalid(
      "The saved production definition is stale because its procedure changed.",
    );
  if (
    (await productionDefinitionFingerprint(
      definition.sourceFingerprint,
      definition.settings,
      definition.variant,
      definition.assignments,
      definition.manualTasks,
      definition,
    )) !== definition.definitionFingerprint
  )
    return invalid("The saved production definition fingerprint is invalid.");
  if (!productionSettingsMatchProcedure(definition, source.procedure.settings))
    return invalid("The saved production inputs differ from the procedure.");
  return { kind: "ready", definition, procedure: source.procedure };
}

type ProductionScenarioSave =
  | Readonly<{ kind: "verified"; definition: ProductionScenario }>
  | Readonly<{
      kind: "saved-readback-failed";
      id: string;
      message: string;
    }>
  | Readonly<{
      kind: "outcome-unknown";
      id: string;
      message: string;
    }>
  | Readonly<{ kind: "failed-before-save"; message: string }>;

export async function saveProductionScenario(
  organisationId: string,
  mutate: CommerceMutationTransport,
  definition: ProductionScenario,
  read: typeof readProductionScenario = readProductionScenario,
): Promise<ProductionScenarioSave> {
  return savePreparedProductionScenario(
    organisationId,
    mutate,
    definition,
    { kind: "manual" },
    read,
  );
}

export async function savePreparedProductionScenario(
  organisationId: string,
  mutate: CommerceMutationTransport,
  definition: ProductionScenario,
  origin:
    | Readonly<{ kind: "manual" }>
    | Readonly<{ kind: "agent_effect"; effectId: string }>,
  read: typeof readProductionScenario = readProductionScenario,
): Promise<ProductionScenarioSave> {
  const body = {
    id: definition.id,
    name: definition.name,
    note: definition.note,
    procedureId: definition.procedureId,
    sourceFingerprint: definition.sourceFingerprint,
    definitionFingerprint: definition.definitionFingerprint,
    settings: definition.settings,
    variant: definition.variant,
    assignments: definition.assignments,
    manualTasks: definition.manualTasks,
    presentation: definition.presentation,
    route: definition.route,
    ...(definition.route === "oven-rack"
      ? {
          cell: definition.cell,
          executionBundleId: definition.executionBundleId,
        }
      : {}),
    ...(origin.kind === "agent_effect"
      ? { agentEffectId: origin.effectId }
      : {}),
  };
  if (parseProductionScenario(definition) === null)
    return {
      kind: "failed-before-save",
      message: "Review the production assignments before saving.",
    };
  let result: unknown;
  try {
    result = await mutate(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/bakery/production-scenario`,
      body,
      "Save production scenario",
    );
  } catch (error) {
    const rejection = scenarioSaveRejection(error);
    if (rejection !== null) return rejection;
    return reconcileUnconfirmedProductionScenario(
      organisationId,
      definition,
      origin,
      read,
    );
  }
  if (
    !isRecord(result) ||
    result.ok !== true ||
    result.scenarioId !== definition.id
  )
    return reconcileUnconfirmedProductionScenario(
      organisationId,
      definition,
      origin,
      read,
    );
  try {
    const opened = await read(organisationId, definition.id);
    if (
      opened.kind !== "ready" ||
      !sameDefinition(opened.definition, definition)
    )
      return {
        kind: "saved-readback-failed",
        id: definition.id,
        message: `Saved ${definition.id}, but readback could not be verified. Retry opening that ID.`,
      };
    return { kind: "verified", definition: opened.definition };
  } catch {
    return {
      kind: "saved-readback-failed",
      id: definition.id,
      message: `Saved ${definition.id}, but readback failed. Retry opening that ID.`,
    };
  }
}

async function reconcileUnconfirmedProductionScenario(
  organisationId: string,
  definition: ProductionScenario,
  origin:
    | Readonly<{ kind: "manual" }>
    | Readonly<{ kind: "agent_effect"; effectId: string }>,
  read: typeof readProductionScenario,
): Promise<ProductionScenarioSave> {
  try {
    const opened = await read(organisationId, definition.id);
    if (
      opened.kind === "ready" &&
      sameDefinition(opened.definition, definition) &&
      origin.kind === "manual"
    )
      return { kind: "verified", definition: opened.definition };
  } catch {
    return unknownProductionScenarioOutcome(definition.id);
  }
  return unknownProductionScenarioOutcome(definition.id);
}

function unknownProductionScenarioOutcome(id: string): ProductionScenarioSave {
  return {
    kind: "outcome-unknown",
    id,
    message: `The save outcome for ${id} is uncertain. Open that scenario ID to check it before another save.`,
  };
}

function invalid(message: string): ProductionScenarioRead {
  return { kind: "invalid", message };
}
function isProductionTask(
  entity: Awaited<ReturnType<typeof readCommerceGraph>>["entities"][number],
): entity is CustomCommerceEntity {
  return (
    entity.reference.origin === "custom" &&
    entity.reference.typeId === "bakery_production_task"
  );
}
export function sameDefinition(
  left: ProductionScenario,
  right: ProductionScenario,
): boolean {
  if (
    left.route !== right.route ||
    left.executionBundleId !== right.executionBundleId ||
    (left.route === "oven-rack" &&
      (right.route !== "oven-rack" || !sameJson(left.cell, right.cell))) ||
    JSON.stringify(left.manualTasks) !== JSON.stringify(right.manualTasks) ||
    left.id !== right.id ||
    left.name !== right.name ||
    left.note !== right.note ||
    left.procedureId !== right.procedureId ||
    left.sourceFingerprint !== right.sourceFingerprint ||
    left.definitionFingerprint !== right.definitionFingerprint ||
    left.variant !== right.variant ||
    left.assignments.length !== right.assignments.length
  )
    return false;
  for (const field of fields)
    if (left.settings[field.key] !== right.settings[field.key]) return false;
  for (let index = 0; index < left.assignments.length; index++) {
    const saved = left.assignments[index];
    const submitted = right.assignments[index];
    if (
      saved === undefined ||
      submitted === undefined ||
      saved.batchId !== submitted.batchId ||
      saved.tray !== submitted.tray ||
      saved.workerId !== submitted.workerId ||
      saved.dependsOn.join("\u0000") !== submitted.dependsOn.join("\u0000") ||
      saved.earliestStartSeconds !== submitted.earliestStartSeconds
    )
      return false;
    const id = productionAssignmentId(saved);
    if (
      left.presentation[id]?.x !== right.presentation[id]?.x ||
      left.presentation[id]?.y !== right.presentation[id]?.y
    )
      return false;
  }
  return true;
}
