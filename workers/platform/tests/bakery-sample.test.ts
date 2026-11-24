import { expect, it, type TestContext } from "vitest";
import { isCustomCommerceEntity } from "@purin-labs/commerce-contracts";
import {
  parseCommerceGraphQuery,
  parseCommerceSnapshotRevision,
  parseEntityPlaneCommand,
  CommerceAdminClient,
  CommerceEntityPlaneClient,
} from "@purin-labs/commerce-client";
import type {
  CommerceGraphQuery,
  CommerceGraphQueryResult,
  CustomCommerceEntityRef,
} from "@purin-labs/commerce-contracts";
import {
  createFinancierSample,
  entityType,
  FINANCIER_SAMPLE_ID,
} from "@purin-labs/area-kitchen/server/bakery/sample";
import {
  parseOperationEdit,
  saveOperationDuration,
} from "@purin-labs/area-kitchen/server/bakery/operation";
import { commerceGraphResponseBody } from "@purin-labs/area-commerce/server/entity-plane/routes";
import {
  parseCommerceGraphQueryResult,
} from "@purin-labs/commerce-control-api/portal/entity-plane-boundary";
import {
  bakeryFingerprint,
  fields,
  sampleSettings,
  parseSettings,
} from "@purin-labs/bakery-model/bakery";
import { parsePersistentCell } from "@purin-labs/bakery-model/bakery-physics";
import pinnedOvenCell from "./fixtures/persistent-oven-cell.json";
import { compileSavedOvenFinancier } from "../../../packages/production-simulation/src/recipes/bakery/financier.ts";
import {
  compileBakeryGraph,
  readBakeryProcedure,
  type CompiledProcedure,
} from "@purin-labs/bakery-model/bakery-procedure";
import {
  parseScenarioCopy,
  scenarioFromEntity,
} from "@purin-labs/bakery-model/bakery-scenario";
import { saveScenarioCopy } from "@purin-labs/area-kitchen/server/bakery/scenario";
import {
  parseProductionScenario,
  productionDefinitionFingerprint,
  productionScenarioFromGraph,
  type ProductionAssignment,
  type ProductionScenario,
} from "@purin-labs/bakery-model/bakery-production-scenario";
import { saveProductionScenario } from "@purin-labs/area-kitchen/server/bakery/production-scenario";
import {
  startCommerceWorker,
  type CommerceWorker,
} from "./commerce-fixture-worker";
import {
  saveProductionScenario as saveProductionScenarioFromPortal,
  type ProductionScenarioRead,
} from "@purin-labs/area-kitchen/ui/features/workflow-simulator/production-scenario-api";
import { readScenarioPage } from "@purin-labs/area-kitchen/ui/features/workflow-simulator/scenario-api";
import type { CommerceGraphFetch } from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";
import { customEntityRef } from "@purin-labs/area-commerce-contract/ui/features/commerce/entity-plane/api";

const NOW = "2026-09-08T00:00:00.000Z";
const ORGANISATION = "organisation_bakery_sample",
  MERCHANT = "merchant_bakery_sample";

it(
  "browses an empty scenario catalogue before its type has been published",
  emptyScenarioCatalogue,
);
async function emptyScenarioCatalogue(): Promise<void> {
  const commerceEngine = await startCommerceWorker({ now: NOW });
  try {
    const client = await fixture(commerceEngine);
    const fetcher = readScenarioGraph.bind(null, client);
    expect(await readScenarioPage(ORGANISATION, "", null, fetcher)).toEqual({
      choices: [],
      nextCursor: null,
    });
    expect(
      await readScenarioPage(ORGANISATION, "financier", null, fetcher),
    ).toEqual({
      choices: [],
      nextCursor: null,
    });
    await expect(
      readScenarioPage(ORGANISATION, "", null, unavailableMetadata),
    ).rejects.toThrow();
  } finally {
    await commerceEngine.dispose();
  }
}
async function unavailableMetadata(): Promise<Response> {
  return Response.json({ error: "unavailable" }, { status: 500 });
}

it(
  "resumes interrupted sample creation, replays without duplicates, and decodes saved integer attributes",
  verifySample,
);
async function verifySample(): Promise<void> {
  const commerceEngine = await startCommerceWorker({ now: NOW });
  try {
    const client = await fixture(commerceEngine),
      interrupted = new InterruptedClient(client);
    const input = {
      client: interrupted,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      principalId: "bakery_admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect(await createFinancierSample(input)).toEqual({
      ok: false,
      code: "commerce_unavailable",
    });
    expect(await createFinancierSample(input)).toEqual({
      ok: true,
      procedureId: FINANCIER_SAMPLE_ID,
    });
    const before = await client.publishedResourceMetadata({
      kind: "enumerate",
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
    });
    expect(await createFinancierSample(input)).toEqual({
      ok: true,
      procedureId: FINANCIER_SAMPLE_ID,
    });
    expect(
      await client.publishedResourceMetadata({
        kind: "enumerate",
        organisationId: ORGANISATION,
        merchantId: MERCHANT,
      }),
    ).toEqual(before);
    const query = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_procedure",
        entityId: FINANCIER_SAMPLE_ID,
      },
      traversal: { maxDepth: 2, resultLimit: 100 },
      filter: null,
    });
    const graph = await client.query(MERCHANT, query);
    if (!graph.ok) throw new Error(graph.error.message);
    expect(graph.value.entities).toHaveLength(13);
    expect(graph.value.relationships).toHaveLength(20);
    const wire = commerceGraphResponseBody(graph.value);
    const parsed = parseCommerceGraphQueryResult(
      JSON.parse(JSON.stringify(wire)),
    );
    expect(parsed).toEqual({ ok: true, value: graph.value });
    const malformed = JSON.stringify(wire).replace(
      '"value":"16"',
      '"value":"16.5"',
    );
    expect(parseCommerceGraphQueryResult(JSON.parse(malformed)).ok).toBe(false);
  } finally {
    await commerceEngine.dispose();
  }
}

class InterruptedClient {
  private count = 0;
  readonly query: CommerceEntityPlaneClient["query"];
  constructor(
    private readonly client: CommerceEntityPlaneClient,
    private readonly failAt = 20,
  ) {
    this.query = client.query.bind(client);
  }
  publishedResourceMetadata: CommerceEntityPlaneClient["publishedResourceMetadata"] =
    this.metadata.bind(this);
  private metadata(
    request: Parameters<
      CommerceEntityPlaneClient["publishedResourceMetadata"]
    >[0],
  ): ReturnType<CommerceEntityPlaneClient["publishedResourceMetadata"]> {
    return this.client.publishedResourceMetadata(request);
  }
  async command(
    request: Parameters<CommerceEntityPlaneClient["command"]>[0],
  ): ReturnType<CommerceEntityPlaneClient["command"]> {
    this.count++;
    if (this.count === this.failAt)
      return { ok: false, error: { kind: "network", message: "Interrupted" } };
    return this.client.command(request);
  }
}
type CommandInterruption = { commandId: string | null };

async function fixture(
  commerceEngine: CommerceWorker,
  interruption: CommandInterruption = { commandId: null },
): Promise<CommerceEntityPlaneClient> {
  const config = {
    baseUrl: commerceEngine.baseUrl,
    serviceToken: commerceEngine.serviceToken,
    fetch: commerceEngine.fetch,
  };
  const provisioned = await new CommerceAdminClient(config).provisionMerchant(
    {
      schemaVersion: "commerce.provision-merchant.v2",
      externalReference: ORGANISATION,
      merchantId: MERCHANT,
      createdAt: NOW,
    },
  );
  if (!provisioned.ok) throw new Error(JSON.stringify(provisioned.error));
  return new CommerceEntityPlaneClient({
    ...config,
    fetch: interruptingFetch(commerceEngine.fetch, interruption),
  });
}

function interruptingFetch(
  fetch: CommerceWorker["fetch"],
  interruption: CommandInterruption,
): CommerceWorker["fetch"] {
  return async (input, init) => {
    const request = new Request(input, init);
    if (
      interruption.commandId !== null &&
      request.method === "POST" &&
      new URL(request.url).pathname.endsWith("/entity-plane/commands")
    ) {
      const body: unknown = await request.clone().json();
      if (namesCommand(body, interruption.commandId))
        return Response.json({ message: "interrupted" }, { status: 500 });
    }
    return fetch(request);
  };
}

// Commerce stores an entity-plane command's commandId as its idempotency key.
function namesCommand(value: unknown, commandId: string): boolean {
  if (Array.isArray(value))
    return value.some((item) => namesCommand(item, commandId));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([name, item]) =>
      (name === "commandId" && item === commandId) ||
      namesCommand(item, commandId),
  );
}

it(
  "saves and reloads a typed production definition with a native predecessor",
  verifyProductionScenario,
  30_000,
);
async function verifyProductionScenario(): Promise<void> {
  const commerceEngine = await startCommerceWorker({ now: NOW });
  try {
    const client = await fixture(commerceEngine);
    const input = {
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      principalId: "bakery_admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect((await createFinancierSample(input)).ok).toBe(true);
    const sourceQuery = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_procedure",
        entityId: FINANCIER_SAMPLE_ID,
      },
      traversal: { maxDepth: 2, resultLimit: 100 },
      filter: null,
    });
    const sourceGraph = await client.query(MERCHANT, sourceQuery);
    if (
      !sourceGraph.ok ||
      sourceQuery.kind !== "entity_by_ref" ||
      sourceQuery.reference.origin !== "custom"
    )
      throw new Error("Unable to read fixture procedure");
    const source = compileBakeryGraph(
      sourceGraph.value,
      sourceQuery.reference,
      sampleSettings(),
    );
    if (source.kind !== "ready") throw new Error(source.message);
    const sourceFingerprint = await bakeryFingerprint(
      source.procedure.revisionKey,
    );
    const assignments: ProductionAssignment[] = [
      {
        batchId: "A",
        tray: 1,
        workerId: "human-1",
        dependsOn: [],
        earliestStartSeconds: 0,
      },
      {
        batchId: "B",
        tray: 1,
        workerId: "human-1",
        dependsOn: ["batch:A:native:1"],
        earliestStartSeconds: 3300,
      },
      {
        batchId: "C",
        tray: 1,
        workerId: "human-1",
        dependsOn: ["batch:A:native:1", "batch:B:native:1"],
        earliestStartSeconds: 0,
      },
    ];
    const definitionFingerprint = await productionDefinitionFingerprint(
      sourceFingerprint,
      source.procedure.settings,
      "normal",
      assignments,
      [],
      { route: "cold-racking" },
    );
    const copy = parseProductionScenario({
      id: "financier-production",
      name: "Financier production",
      note: "Assumed timing",
      procedureId: FINANCIER_SAMPLE_ID,
      sourceFingerprint,
      definitionFingerprint,
      settings: source.procedure.settings,
      variant: "normal",
      assignments,
      presentation: {
        "batch:A:native:1": { x: 84, y: 54 },
        "batch:B:native:1": { x: 319, y: 194 },
        "batch:C:native:1": { x: 554, y: 334 },
      },
    });
    if (copy === null) throw new Error("Invalid production fixture");
    expect(
      parseProductionScenario({
        ...copy,
        presentation: {
          ...copy.presentation,
          "batch:A:native:1": { x: -1, y: 54 },
        },
      }),
    ).toBeNull();
    expect(
      await productionDefinitionFingerprint(
        copy.sourceFingerprint,
        copy.settings,
        copy.variant,
        copy.assignments,
        [],
        copy,
      ),
    ).toBe(copy.definitionFingerprint);
    await publishPriorProductionSchemas(client);
    expect(
      parseProductionScenario({
        ...copy,
        assignments: [
          assignments[0],
          { ...assignments[1], dependsOn: ["batch:C:native:1"] },
        ],
      }),
    ).toBeNull();
    expect(await saveProductionScenario({ ...input, copy })).toEqual({
      ok: true,
      scenarioId: copy.id,
    });
    const reopenedSource = await readBakeryProcedure(
      readProcedureGraph.bind(null, client),
      sourceQuery.reference,
      copy.settings,
    );
    if (reopenedSource.kind !== "ready")
      throw new Error(reopenedSource.message);
    expect(await bakeryFingerprint(reopenedSource.procedure.revisionKey)).toBe(
      sourceFingerprint,
    );
    const savedQuery = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_production_scenario",
        entityId: copy.id,
      },
      traversal: { maxDepth: 2, resultLimit: 100 },
      filter: null,
    });
    const saved = await client.query(MERCHANT, savedQuery);
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.nextCursor).toBeNull();
    expect(productionScenarioFromGraph(saved.value, copy.id)).toEqual(copy);
    const procedureLink = saved.value.relationships.find(
      (edge) =>
        edge.origin === "custom" &&
        edge.definition.definitionId === "bakery_production_procedure",
    );
    if (procedureLink === undefined)
      throw new Error("Missing production procedure link");
    const sourceWithBacklink = compileBakeryGraph(
      {
        ...sourceGraph.value,
        relationships: [...sourceGraph.value.relationships, procedureLink],
      },
      sourceQuery.reference,
      sampleSettings(),
    );
    if (sourceWithBacklink.kind !== "ready")
      throw new Error(sourceWithBacklink.message);
    expect(
      await bakeryFingerprint(sourceWithBacklink.procedure.revisionKey),
    ).toBe(sourceFingerprint);
    if (
      savedQuery.kind !== "entity_by_ref" ||
      savedQuery.reference.origin !== "custom"
    )
      throw new Error("Invalid saved scenario query");
    const membershipQuery = parseCommerceGraphQuery({
      kind: "relationship_traversal",
      seeds: [savedQuery.reference],
      relationshipDefinition: {
        origin: "custom",
        definitionId: "bakery_production_task_member",
        revision: 1,
      },
      traversal: { maxDepth: 1, resultLimit: 100 },
      filter: null,
    });
    const membership = await client.query(MERCHANT, membershipQuery);
    if (!membership.ok) throw new Error(membership.error.message);
    const taskRefs: CustomCommerceEntityRef[] = [];
    for (const entity of membership.value.entities)
      if (
        entity.reference.origin === "custom" &&
        entity.reference.typeId === "bakery_production_task"
      )
        taskRefs.push(entity.reference);
    expect(taskRefs).toHaveLength(3);
    const parentQuery = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: savedQuery.reference,
      traversal: { maxDepth: 1, resultLimit: 100 },
      filter: null,
    });
    const parent = await client.query(MERCHANT, parentQuery);
    if (!parent.ok) throw new Error(parent.error.message);
    expect(parent.value.merchantRevision).toBe(
      membership.value.merchantRevision,
    );
    expect(
      productionScenarioFromGraph(
        {
          ...parent.value,
          entities: [...parent.value.entities, ...membership.value.entities],
        },
        copy.id,
      ),
    ).toEqual(copy);
    expect(
      await saveProductionScenarioFromPortal(
        ORGANISATION,
        acceptedProductionMutation,
        copy,
        readProductionFixture.bind(null, copy, source.procedure),
      ),
    ).toEqual({ kind: "verified", definition: copy });
    expect(
      await saveProductionScenarioFromPortal(
        ORGANISATION,
        offlineProductionMutation,
        copy,
        readProductionFixture.bind(null, copy, source.procedure),
      ),
    ).toEqual({ kind: "verified", definition: copy });
    expect(
      await saveProductionScenarioFromPortal(
        ORGANISATION,
        offlineProductionMutation,
        copy,
        missingProductionScenario,
      ),
    ).toMatchObject({
      kind: "outcome-unknown",
      id: copy.id,
    });
    const wrong = parseProductionScenario({ ...copy, note: "Changed note" });
    if (wrong === null) throw new Error("Invalid readback fixture");
    const moved = parseProductionScenario({
      ...copy,
      presentation: {
        ...copy.presentation,
        "batch:A:native:1": { x: 94, y: 54 },
      },
    });
    if (moved === null) throw new Error("Invalid moved layout fixture");
    expect(moved.definitionFingerprint).toBe(copy.definitionFingerprint);
    expect(
      (
        await saveProductionScenarioFromPortal(
          ORGANISATION,
          acceptedProductionMutation,
          copy,
          readProductionFixture.bind(null, moved, source.procedure),
        )
      ).kind,
    ).toBe("saved-readback-failed");
    expect((await saveProductionScenario({ ...input, copy: wrong })).ok).toBe(
      false,
    );
    expect(
      (
        await saveProductionScenarioFromPortal(
          ORGANISATION,
          acceptedProductionMutation,
          copy,
          readProductionFixture.bind(null, wrong, source.procedure),
        )
      ).kind,
    ).toBe("saved-readback-failed");
    expect(await saveProductionScenario({ ...input, copy })).toEqual({
      ok: true,
      scenarioId: copy.id,
    });
  } finally {
    await commerceEngine.dispose();
  }
}

async function offlineProductionMutation(): Promise<never> {
  throw new Error("Network response lost");
}

it(
  "saves a pinned oven route through commerce, reopens it for persistent compilation, and refuses changed pins",
  verifyOvenScenario,
  30_000,
);

async function verifyOvenScenario({ task }: TestContext): Promise<void> {
  const commerceEngine = await startCommerceWorker({ now: NOW });
  try {
    const client = await fixture(commerceEngine);
    const input = {
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      principalId: "bakery_admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect((await createFinancierSample(input)).ok).toBe(true);
    const parsed = parseSettings({
      ...sampleSettings(),
      traysPerBatch: 1,
      ovenTrays: 1,
    });
    if (parsed.kind !== "valid") throw new Error(parsed.message);
    const source = await readBakeryProcedure(
      readProcedureGraph.bind(null, client),
      customEntityRef("bakery_procedure", FINANCIER_SAMPLE_ID),
      parsed.settings,
    );
    if (source.kind !== "ready") throw new Error(source.message);
    const sourceFingerprint = await bakeryFingerprint(
      source.procedure.revisionKey,
    );
    const cell = parsePersistentCell(pinnedOvenCell);
    if (cell === null || cell.fixture !== "persistent-oven-rack/1")
      throw new Error("Invalid oven cell fixture");
    const route = {
      route: "oven-rack" as const,
      cell,
      executionBundleId:
        "0dfc48575c54c058c2bcea9e6527842397585a4cc40900836d2818fee8d85f3a",
    };
    const manualTasks = [
      {
        bakeryTaskId: "batch:B:process:stage",
        workerId: "human-2" as const,
        earliestStartSeconds: 600,
        dependsOn: ["batch:A:native:oven-rack"],
      },
    ];
    const copy = parseProductionScenario({
      id: "physical-oven-recipe",
      name: "Physical oven recipe",
      note: "One pinned oven cell",
      procedureId: FINANCIER_SAMPLE_ID,
      sourceFingerprint,
      definitionFingerprint: await productionDefinitionFingerprint(
        sourceFingerprint,
        parsed.settings,
        "normal",
        [],
        manualTasks,
        route,
      ),
      settings: parsed.settings,
      variant: "normal",
      assignments: [],
      manualTasks,
      presentation: {},
      route: route.route,
      cell,
      executionBundleId: route.executionBundleId,
    });
    if (copy?.route !== "oven-rack") throw new Error("Invalid oven scenario");
    expect(source.procedure.settings.ovenTrays).toBe(4);
    expect(copy.settings.ovenTrays).toBe(1);
    for (let attempt = 0; attempt < 2; attempt++)
      expect(await saveProductionScenario({ ...input, copy })).toEqual({
        ok: true,
        scenarioId: copy.id,
      });
    const saved = await client.query(
      MERCHANT,
      parseCommerceGraphQuery({
        kind: "entity_by_ref",
        reference: {
          origin: "custom",
          typeId: "bakery_production_scenario",
          entityId: copy.id,
        },
        traversal: { maxDepth: 2, resultLimit: 100 },
        filter: null,
      }),
    );
    if (!saved.ok) throw new Error(saved.error.message);
    const reopened = productionScenarioFromGraph(saved.value, copy.id);
    expect(reopened).toEqual(copy);
    if (reopened?.route !== "oven-rack")
      throw new Error("Oven route lost during readback");
    expect(reopened.assignments).toEqual([]);
    const compiled = await compileSavedOvenFinancier(reopened);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
    expect(compiled.value.cells).toHaveLength(1);
    expect(compiled.value.dependencies).toContainEqual({
      task: { source: "batch-B", sequence: 0, key: "stage" },
      prerequisite: { source: "batch-A", sequence: 0, key: "oven-rack" },
    });
    expect(
      parseProductionScenario({
        ...copy,
        manualTasks: [
          {
            bakeryTaskId: "batch:A:process:stage",
            workerId: null,
            earliestStartSeconds: 0,
            dependsOn: ["batch:A:native:oven-load"],
          },
        ],
      }),
    ).toBeNull();
    const changed = parseProductionScenario({
      ...copy,
      cell: { ...copy.cell, clampForceN: 20 },
    });
    if (changed?.route !== "oven-rack")
      throw new Error("Invalid changed pin fixture");
    expect(await saveProductionScenario({ ...input, copy: changed })).toEqual({
      ok: false,
      code: "bakery_production_scenario_invalid",
    });
    expect((await compileSavedOvenFinancier(changed)).ok).toBe(false);
    expect(parseProductionScenario({ ...copy, cell: undefined })).toBeNull();
    expect(
      parseProductionScenario({ ...copy, route: "cold-racking" }),
    ).toBeNull();
    Object.assign(task.meta, {
      ovenRouteEvidence: {
        definition: reopened,
        compiled: compiled.value,
        graph: commerceGraphResponseBody(saved.value),
        repeatedSave: true,
        changedPinRefused: true,
      },
    });
  } finally {
    await commerceEngine.dispose();
  }
}

async function missingProductionScenario() {
  return { kind: "invalid" as const, message: "Scenario unavailable" };
}

function priorTimingField(field: (typeof fields)[number]): boolean {
  return field.key !== "finishCooling";
}

async function publishPriorProductionSchemas(
  client: CommerceEntityPlaneClient,
): Promise<void> {
  const scenarioType = "bakery_production_scenario";
  const scenarioAttributes = fields.filter(priorTimingField).map((field) =>
    priorAttribute(scenarioType, field.key, {
      kind: "integer",
      minimum: field.min,
      maximum: field.max,
    }),
  );
  scenarioAttributes.push(
    priorAttribute(scenarioType, "timing_note", {
      kind: "long_text",
      maxLength: 2000,
    }),
    priorAttribute(scenarioType, "source_fingerprint", {
      kind: "short_text",
      maxLength: 64,
    }),
    priorAttribute(scenarioType, "definition_fingerprint", {
      kind: "short_text",
      maxLength: 64,
    }),
    priorAttribute(scenarioType, "variant", {
      kind: "short_text",
      maxLength: 16,
    }),
  );
  await publishPriorProductionSchema(
    client,
    scenarioType,
    "Bakery production scenario",
    scenarioAttributes,
  );
  const taskType = "bakery_production_task";
  await publishPriorProductionSchema(
    client,
    taskType,
    "Bakery production task",
    [
      priorAttribute(taskType, "batch_index", {
        kind: "integer",
        minimum: 0,
        maximum: 5,
      }),
      priorAttribute(taskType, "tray", {
        kind: "integer",
        minimum: 1,
        maximum: 4,
      }),
      priorAttribute(taskType, "worker_index", {
        kind: "integer",
        minimum: 1,
        maximum: 3,
      }),
    ],
  );
}

async function publishPriorProductionSchema(
  client: CommerceEntityPlaneClient,
  typeId: string,
  label: string,
  attributes: readonly unknown[],
): Promise<void> {
  const metadata = await client.publishedResourceMetadata({
    kind: "enumerate",
    organisationId: ORGANISATION,
    merchantId: MERCHANT,
  });
  if (!metadata.ok || metadata.value.kind !== "enumerated")
    throw new Error("Unable to read merchant revision");
  let revision = metadata.value.merchantRevision;
  for (const step of entityType(typeId, label, attributes)) {
    const commandId = `bakery-production-scenario:v1:${step.id}`;
    const request = parseEntityPlaneCommand({
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      expectedMerchantRevision: revision,
      commandId,
      command: step.command,
      authority: {
        ...step.authority,
        context: {
          organisationId: ORGANISATION,
          merchantId: MERCHANT,
          principalId: "bakery_admin",
          sensitivityCeiling: "restricted",
          expiresAt: "2099-01-01T00:00:00.000Z",
          causation: { kind: "command", commandId },
        },
      },
    });
    const result = await client.command(request);
    if (!result.ok || result.value.status !== "accepted")
      throw new Error(`Unable to publish prior ${typeId} schema`);
    revision = parseCommerceSnapshotRevision(
      Math.max(Number(revision), Number(result.value.receipt.merchantRevision)),
    );
  }
}

function priorAttribute(typeId: string, id: string, kind: unknown) {
  return {
    id,
    scope: {
      kind: "custom",
      entityTypeId: typeId,
      typeRevision: 1,
    },
    label: id,
    helpText: null,
    required: true,
    sensitivity: "internal",
    kind,
    revision: 1,
  };
}

async function acceptedProductionMutation(): Promise<unknown> {
  return { ok: true, scenarioId: "financier-production" };
}
async function readProductionFixture(
  definition: ProductionScenario,
  procedure: CompiledProcedure,
): Promise<ProductionScenarioRead> {
  return { kind: "ready", definition, procedure };
}

it(
  "resumes scenario copies and reloads a procedure beyond 100 backlinks without accepting changed revisions",
  verifyScenarioCopy,
  60_000,
);
async function verifyScenarioCopy({ task }: TestContext): Promise<void> {
  const startedAt = performance.now();
  const commerceEngine = await startCommerceWorker({ now: NOW });
  try {
    const client = await fixture(commerceEngine);
    const input = {
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      principalId: "bakery_admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect((await createFinancierSample(input)).ok).toBe(true);
    const query = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_procedure",
        entityId: FINANCIER_SAMPLE_ID,
      },
      traversal: { maxDepth: 2, resultLimit: 100 },
      filter: null,
    });
    if (query.kind !== "entity_by_ref" || query.reference.origin !== "custom")
      throw new Error("Invalid fixture query");
    const before = await client.query(MERCHANT, query);
    if (!before.ok) throw new Error(before.error.message);
    const compiled = compileBakeryGraph(
      before.value,
      query.reference,
      sampleSettings(),
    );
    if (compiled.kind !== "ready") throw new Error(compiled.message);
    const body = {
      id: "financier-baseline",
      name: "Financier baseline",
      note: "Assumed timings; calibrate with a measured shift.",
      procedureId: FINANCIER_SAMPLE_ID,
      fingerprint: await bakeryFingerprint(compiled.procedure.revisionKey),
      settings: compiled.procedure.settings,
    };
    for (const invalid of [
      { ...body, note: " " },
      { ...body, extra: true },
      { ...body, fingerprint: "unknown" },
      { ...body, settings: { ...body.settings, bake: "15" } },
      { ...body, settings: { ...body.settings, traysPerBatch: 5 } },
    ])
      expect(parseScenarioCopy(invalid)).toBeNull();
    const copy = parseScenarioCopy(body);
    if (copy === null) throw new Error("Invalid scenario fixture");
    const interrupted = {
      ...input,
      client: new InterruptedClient(client, 8),
      copy,
    };
    expect(await saveScenarioCopy(interrupted)).toEqual({
      ok: false,
      code: "commerce_unavailable",
    });
    const copyQuery = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_scenario",
        entityId: copy.id,
      },
      traversal: { maxDepth: 1, resultLimit: 20 },
      filter: null,
    });
    const incomplete = await client.query(MERCHANT, copyQuery);
    if (!incomplete.ok) throw new Error(incomplete.error.message);
    expect(incomplete.value.entities).toHaveLength(1);
    expect(incomplete.value.relationships).toHaveLength(0);
    expect(await saveScenarioCopy(interrupted)).toEqual({
      ok: true,
      scenarioId: copy.id,
    });
    const stored = await client.query(MERCHANT, copyQuery);
    if (!stored.ok) throw new Error(stored.error.message);
    expect(stored.value.relationships).toHaveLength(1);
    const link = stored.value.relationships[0];
    if (
      !link ||
      link.target.origin !== "custom" ||
      link.target.typeId !== "bakery_procedure"
    )
      throw new Error("Missing procedure link");
    const entity = stored.value.entities.find(isScenario);
    if (!entity || !isCustomCommerceEntity(entity))
      throw new Error("Missing scenario");
    const decoded = scenarioFromEntity(entity, link.target.entityId);
    expect(decoded).toEqual(copy);
    if (decoded === null) throw new Error("Invalid saved copy");
    expect(await saveScenarioCopy(interrupted)).toEqual({
      ok: true,
      scenarioId: copy.id,
    });
    expect(await client.query(MERCHANT, copyQuery)).toEqual(stored);
    const fetcher = readScenarioGraph.bind(null, client);
    const page = await readScenarioPage(ORGANISATION, "", null, fetcher);
    expect(page).toEqual({
      choices: [{ reference: entity.reference, name: copy.name }],
      nextCursor: null,
    });
    expect(
      await readScenarioPage(ORGANISATION, " baseline ", null, fetcher),
    ).toEqual(page);
    expect(
      await readScenarioPage(
        ORGANISATION,
        "missing-scenario-name",
        null,
        fetcher,
      ),
    ).toEqual({ choices: [], nextCursor: null });
    const alternativesStartedAt = performance.now();
    for (let index = 1; index <= 25; index++) {
      const alternative = parseScenarioCopy({
        ...body,
        id: `financier-alternative-${String(index).padStart(2, "0")}`,
      });
      if (alternative === null) throw new Error("Invalid alternative scenario");
      expect(await saveScenarioCopy({ ...input, copy: alternative })).toEqual({
        ok: true,
        scenarioId: alternative.id,
      });
    }
    const firstBatchCompletedAt = performance.now();
    const firstPage = await readScenarioPage(
      ORGANISATION,
      "baseline",
      null,
      fetcher,
    );
    expect(firstPage.choices).toHaveLength(25);
    if (firstPage.nextCursor === null)
      throw new Error("Missing scenario cursor");
    const secondPage = await readScenarioPage(
      ORGANISATION,
      "baseline",
      firstPage.nextCursor,
      fetcher,
    );
    expect(secondPage.choices).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    const listedIds = new Set<string>();
    for (const choice of [...firstPage.choices, ...secondPage.choices]) {
      expect(choice.name).toBe(copy.name);
      listedIds.add(choice.reference.entityId);
    }
    expect(listedIds.size).toBe(26);
    const secondBatchStartedAt = performance.now();
    for (let index = 26; index <= 110; index++) {
      const alternative = parseScenarioCopy({
        ...body,
        id: `financier-alternative-${index}`,
      });
      if (alternative === null) throw new Error("Invalid alternative scenario");
      expect(await saveScenarioCopy({ ...input, copy: alternative })).toEqual({
        ok: true,
        scenarioId: alternative.id,
      });
    }
    const backlinksCompletedAt = performance.now();
    const withBacklink = await client.query(MERCHANT, query);
    if (!withBacklink.ok) throw new Error(withBacklink.error.message);
    expect(
      compileBakeryGraph(withBacklink.value, query.reference, decoded.settings)
        .kind,
    ).toBe("invalid");
    const replay = await readBakeryProcedure(
      readProcedureGraph.bind(null, client),
      query.reference,
      decoded.settings,
    );
    if (replay.kind !== "ready") throw new Error(replay.message);
    expect(await bakeryFingerprint(replay.procedure.revisionKey)).toBe(
      copy.fingerprint,
    );
    expect(replay.procedure.settings).toEqual(compiled.procedure.settings);
    expect(replay.procedure.operations).toEqual(compiled.procedure.operations);
    const reloadCompletedAt = performance.now();
    expect(
      (
        await readBakeryProcedure(
          readChangedProcedureGraph.bind(null, client),
          query.reference,
          decoded.settings,
        )
      ).kind,
    ).toBe("invalid");
    const operation = replay.procedure.operations.find(isBake);
    if (!operation) throw new Error("Missing bake operation");
    const edit = parseOperationEdit({
      entityId: operation.reference.entityId,
      expectedRevision: operation.revision,
      snapshot: replay.procedure.snapshotRevision,
      minutes: 16,
    });
    if (edit === null) throw new Error("Invalid operation edit");
    expect(
      await saveOperationDuration({
        ...input,
        commandId: "change-scenario-source",
        edit,
      }),
    ).toEqual({ ok: true });
    const current = await readBakeryProcedure(
      readProcedureGraph.bind(null, client),
      query.reference,
      decoded.settings,
    );
    if (current.kind !== "ready") throw new Error(current.message);
    expect(await bakeryFingerprint(current.procedure.revisionKey)).not.toBe(
      decoded.fingerprint,
    );
    expect(await saveScenarioCopy({ ...input, copy })).toEqual({
      ok: false,
      code: "bakery_scenario_stale",
    });
    await expect(
      readScenarioPage(ORGANISATION, "baseline", firstPage.nextCursor, fetcher),
    ).rejects.toThrow();
    Object.assign(task.meta, {
      bakeryGraphFixtureEvidence: {
        alternativeScenariosSavedThroughHttp: 110,
        pagination: {
          firstPageCount: firstPage.choices.length,
          secondPageCount: secondPage.choices.length,
          uniqueScenarioCount: listedIds.size,
        },
        procedure: {
          reference: query.reference,
          operationCount: replay.procedure.operations.length,
          fingerprint: copy.fingerprint,
          changedFingerprint: await bakeryFingerprint(
            current.procedure.revisionKey,
          ),
        },
        boundaries: {
          interruptedSaveResumed: true,
          replayWithoutDuplicates: true,
          completeProcedureBeyond100Backlinks: true,
          mixedSnapshotRejected: true,
          staleSaveRejected: true,
          stalePageCursorRejected: true,
        },
        elapsedMs: {
          setupAndRecovery: alternativesStartedAt - startedAt,
          first25Alternatives: firstBatchCompletedAt - alternativesStartedAt,
          pagination: secondBatchStartedAt - firstBatchCompletedAt,
          remaining85Alternatives: backlinksCompletedAt - secondBatchStartedAt,
          procedureReload: reloadCompletedAt - backlinksCompletedAt,
          staleRevisionChecks: performance.now() - reloadCompletedAt,
          total: performance.now() - startedAt,
        },
      },
    });
  } finally {
    await commerceEngine.dispose();
  }
}
async function readProcedureGraph(
  client: CommerceEntityPlaneClient,
  query: CommerceGraphQuery,
): Promise<CommerceGraphQueryResult> {
  const result = await client.query(MERCHANT, query);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}
async function readChangedProcedureGraph(
  client: CommerceEntityPlaneClient,
  query: CommerceGraphQuery,
): Promise<CommerceGraphQueryResult> {
  const graph = await readProcedureGraph(client, query);
  if (query.kind === "relationship_traversal" && query.seeds.length === 7)
    return {
      ...graph,
      merchantRevision: parseCommerceSnapshotRevision(
        Number(graph.merchantRevision) + 1,
      ),
    };
  return graph;
}
function isScenario(
  entity: import("@purin-labs/commerce-contracts").CommerceEntity,
): boolean {
  return (
    entity.reference.origin === "custom" &&
    entity.reference.typeId === "bakery_scenario"
  );
}
function isBake(
  operation: import("@purin-labs/bakery-model/bakery-procedure").ProcedureOperation,
): boolean {
  return operation.operation === "bake";
}
async function readScenarioGraph(
  client: CommerceEntityPlaneClient,
  url: Parameters<CommerceGraphFetch>[0],
  init?: RequestInit,
): Promise<Response> {
  if (
    String(url) ===
    `/v1/control/organisations/${ORGANISATION}/commerce/published-resources`
  ) {
    expect(init?.method).toBe("GET");
    const metadata = await client.publishedResourceMetadata({
      kind: "enumerate",
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
    });
    if (!metadata.ok) throw new Error(metadata.error.message);
    return Response.json({ ok: true, metadata: metadata.value });
  }
  expect(String(url)).toBe(
    `/v1/control/organisations/${ORGANISATION}/commerce/graph`,
  );
  if (typeof init?.body !== "string")
    throw new Error("Missing graph query body");
  const raw: unknown = JSON.parse(init.body);
  if (typeof raw !== "object" || raw === null || !("query" in raw))
    throw new Error("Missing graph query");
  const query = parseCommerceGraphQuery(raw.query);
  const result = await client.query(MERCHANT, query);
  if (!result.ok) throw new Error(result.error.message);
  return Response.json(commerceGraphResponseBody(result.value));
}

it(
  "saves an operation duration, preserves its identity and rejects stale edits",
  verifyOperationEdit,
);
async function verifyOperationEdit(): Promise<void> {
  const commerceEngine = await startCommerceWorker({ now: NOW });
  try {
    const client = await fixture(commerceEngine);
    const input = {
      client,
      organisationId: ORGANISATION,
      merchantId: MERCHANT,
      principalId: "bakery_admin",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    expect((await createFinancierSample(input)).ok).toBe(true);
    const query = parseCommerceGraphQuery({
      kind: "entity_by_ref",
      reference: {
        origin: "custom",
        typeId: "bakery_operation",
        entityId: `${FINANCIER_SAMPLE_ID}:bake`,
      },
      traversal: { maxDepth: 0, resultLimit: 1 },
      filter: null,
    });
    const before = await client.query(MERCHANT, query);
    if (!before.ok) throw new Error(before.error.message);
    const entity = before.value.entities[0];
    if (!entity || !("typeRevision" in entity))
      throw new Error("Missing operation");
    const body = {
      entityId: entity.reference.entityId,
      expectedRevision: entity.revision,
      snapshot: before.value.merchantRevision,
      minutes: 16,
    };
    for (const invalid of [
      { ...body, minutes: 0 },
      { ...body, minutes: 60.5 },
      { ...body, minutes: "16" },
      { ...body, snapshot: undefined },
      { ...body, extra: true },
    ])
      expect(parseOperationEdit(invalid)).toBeNull();
    const edit = parseOperationEdit(body);
    if (edit === null) throw new Error("Invalid edit fixture");
    expect(
      await saveOperationDuration({
        ...input,
        commandId: "save-bake-16",
        edit,
      }),
    ).toEqual({ ok: true });
    expect(
      await saveOperationDuration({
        ...input,
        commandId: "stale-bake-edit",
        edit,
      }),
    ).toEqual({ ok: false, code: "revision_conflict" });
    const after = await client.query(MERCHANT, query);
    if (!after.ok) throw new Error(after.error.message);
    expect(after.value.entities[0]).toMatchObject({
      reference: entity.reference,
      revision: Number(entity.revision) + 1,
      attributes: expect.arrayContaining([
        expect.objectContaining({
          attributeId: "operation",
          value: { kind: "short_text", value: "bake" },
        }),
        expect.objectContaining({
          attributeId: "minutes",
          value: { kind: "integer", value: 16n },
        }),
      ]),
    });
    const staleEntity = parseOperationEdit({
      ...body,
      snapshot: after.value.merchantRevision,
    });
    if (staleEntity === null) throw new Error("Invalid stale fixture");
    expect(
      await saveOperationDuration({
        ...input,
        commandId: "stale-entity-edit",
        edit: staleEntity,
      }),
    ).toEqual({ ok: false, code: "revision_conflict" });
    expect((await createFinancierSample(input)).ok).toBe(true);
    expect(await client.query(MERCHANT, query)).toEqual(after);
  } finally {
    await commerceEngine.dispose();
  }
}
