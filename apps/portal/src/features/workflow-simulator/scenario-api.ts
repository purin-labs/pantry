import { bakeryFingerprint, fields } from "@purin-labs/bakery-model/bakery";
import type { CompiledProcedure } from "@purin-labs/bakery-model/bakery-procedure";
import {
  scenarioFromEntity,
  type ScenarioCopy,
} from "@purin-labs/bakery-model/bakery-scenario";
import {
  customEntityRef,
  readCommerceGraph,
  readPublishedCommerceResources,
  type CommerceGraphFetch,
} from "../commerce/entity-plane/api";
import { readProcedure } from "./procedure-api";
import { parseCommerceGraphQuery } from "@purin-labs/commerce-client";
import { isCustomCommerceEntity } from "@purin-labs/contracts";
import type {
  CommerceCursor,
  CommerceEntityType,
  CustomCommerceEntityRef,
} from "@purin-labs/contracts";

export type ScenarioChoice = Readonly<{
  reference: CustomCommerceEntityRef;
  name: string;
}>;

export type ScenarioPage = Readonly<{
  choices: readonly ScenarioChoice[];
  nextCursor: CommerceCursor | null;
}>;

/** A saved record type that a picker lists by name. */
export type SavedEntityKind = Readonly<{
  typeId: "bakery_scenario" | "bakery_procedure" | "bakery_production_scenario";
  typeRevisions: readonly number[];
}>;

export const SAVED_SCENARIOS: SavedEntityKind = {
  typeId: "bakery_scenario",
  typeRevisions: [2],
};
export const SAVED_PROCEDURES: SavedEntityKind = {
  typeId: "bakery_procedure",
  typeRevisions: [1],
};
export const SAVED_PRODUCTION_SCENARIOS: SavedEntityKind = {
  typeId: "bakery_production_scenario",
  typeRevisions: [4, 5],
};

export async function readScenarioPage(
  organisationId: string,
  text: string,
  cursor: CommerceCursor | null,
  fetcher?: CommerceGraphFetch,
): Promise<ScenarioPage> {
  return readSavedEntityPage(
    organisationId,
    SAVED_SCENARIOS,
    text,
    cursor,
    fetcher,
  );
}

export async function readSavedEntityPage(
  organisationId: string,
  kind: SavedEntityKind,
  text: string,
  cursor: CommerceCursor | null,
  fetcher?: CommerceGraphFetch,
): Promise<ScenarioPage> {
  const metadata = await readPublishedCommerceResources(
    organisationId,
    fetcher,
  );
  if (!metadata.entityTypes.some(isEntityType.bind(null, kind)))
    return { choices: [], nextCursor: null };
  const queryText = text.trim();
  const entityTypeId = { origin: "custom", typeId: kind.typeId };
  const pagination = { limit: 25, cursor };
  const traversal = { maxDepth: 0, resultLimit: 25 };
  let query: ReturnType<typeof parseCommerceGraphQuery>;
  if (queryText === "") {
    query = parseCommerceGraphQuery({
      kind: "entity_type_page",
      entityTypeId,
      filter: { kind: "all" },
      sorts: [],
      pagination,
      traversal,
    });
  } else {
    query = parseCommerceGraphQuery({
      kind: "search",
      text: queryText,
      entityTypeId,
      pagination,
      traversal,
    });
  }
  const graph = await readCommerceGraph(organisationId, query, fetcher);
  const choices: ScenarioChoice[] = [];
  for (const entity of graph.entities) {
    if (
      isCustomCommerceEntity(entity) &&
      entity.reference.typeId === kind.typeId &&
      kind.typeRevisions.includes(entity.typeRevision) &&
      entity.state.state === "active"
    ) {
      choices.push({ reference: entity.reference, name: entity.displayName });
    }
  }
  return { choices, nextCursor: graph.nextCursor };
}

function isEntityType(
  kind: SavedEntityKind,
  type: CommerceEntityType,
): boolean {
  return type.origin === "custom" && type.typeId === kind.typeId;
}

export type ScenarioRead =
  | Readonly<{
      kind: "ready";
      copy: ScenarioCopy;
      procedure: CompiledProcedure;
    }>
  | Readonly<{ kind: "invalid"; message: string }>;

export async function readScenario(
  organisationId: string,
  scenarioId: string,
): Promise<ScenarioRead> {
  const reference = customEntityRef("bakery_scenario", scenarioId.trim());
  const graph = await readCommerceGraph(organisationId, {
    kind: "entity_by_ref",
    reference,
    traversal: { maxDepth: 1, resultLimit: 20 },
    filter: null,
  });
  const entity = graph.entities.find(
    scenarioEntity.bind(null, reference.entityId),
  );
  if (!entity || !isCustomCommerceEntity(entity) || graph.nextCursor !== null) {
    return invalid(
      "No complete scenario copy was found. Check the entity ID and your workspace access.",
    );
  }
  const links = graph.relationships.filter(
    scenarioLink.bind(null, reference.entityId),
  );
  const link = links[0];
  if (links.length !== 1 || link === undefined) {
    return invalid(
      "This scenario is missing its procedure connection. Retry the original save to finish it.",
    );
  }
  if (
    link.origin !== "custom" ||
    link.definition.revision !== 1 ||
    link.target.origin !== "custom" ||
    link.target.typeId !== "bakery_procedure"
  ) {
    return invalid("This scenario has an unsupported procedure connection.");
  }
  const copy = scenarioFromEntity(entity, link.target.entityId);
  if (copy === null) {
    return invalid(
      "The saved scenario inputs are invalid. Your current replay is unchanged.",
    );
  }
  const result = await readProcedure(
    organisationId,
    copy.procedureId,
    copy.settings,
  );
  if (result.kind !== "ready") {
    return result;
  }
  if (
    (await bakeryFingerprint(result.procedure.revisionKey)) !== copy.fingerprint
  ) {
    return invalid(
      "This scenario is stale because its procedure or equipment changed. Load the current procedure and save a new copy. The current replay is unchanged.",
    );
  }
  for (const field of fields) {
    if (copy.settings[field.key] !== result.procedure.settings[field.key]) {
      return invalid(
        "This scenario's inputs do not match its referenced procedure. Your current replay is unchanged.",
      );
    }
  }
  return { kind: "ready", copy, procedure: result.procedure };
}

function invalid(message: string): ScenarioRead {
  return { kind: "invalid", message };
}

function scenarioEntity(
  id: string,
  entity: Awaited<ReturnType<typeof readCommerceGraph>>["entities"][number],
): boolean {
  return (
    entity.reference.origin === "custom" &&
    entity.reference.typeId === "bakery_scenario" &&
    entity.reference.entityId === id
  );
}

function scenarioLink(
  id: string,
  edge: Awaited<ReturnType<typeof readCommerceGraph>>["relationships"][number],
): boolean {
  return (
    edge.origin === "custom" &&
    edge.definition.definitionId === "bakery_scenario_procedure" &&
    edge.source.origin === "custom" &&
    edge.source.typeId === "bakery_scenario" &&
    edge.source.entityId === id
  );
}
