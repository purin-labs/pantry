import type { OrganisationDatabase } from "../database-handles";
import { prepareCommerceCueLogDelete } from "../cues/cue-log";
import { OrganisationExecutionScope } from "../organisation-execution-scope";
import type {
  LabCatalogOptionV1,
  LabEventEnvelopeV1,
  LabEventV1,
} from "@purin-labs/commerce-contracts";

import {
  COMMERCE_LAB_CATALOG_VERSION,
  COMMERCE_LAB_CUSTOMERS,
  COMMERCE_LAB_PRODUCTS,
  commerceLabVariantCount,
} from "./catalog";
import { verifyCommerceLabSignature } from "./ingress";
import {
  beginCommerceLabRun,
  COMMERCE_LAB_INTEGRATION_ACCOUNT_ID,
  completeCommerceLabRun,
  listCommerceLabRuns,
  markCommerceLabOrganisation,
  requireCommerceLabOrganisationMarker,
  type CommerceLabRunEvidence,
} from "./lab-metadata";
import {
  createCommerceLabScenarioRun,
  parseCommerceLabIdempotencyKey,
  parseCommerceLabScenarioId,
  type CommerceLabIdempotencyKey,
  type CommerceLabScenarioId,
} from "./scenarios";
import {
  deriveLabCommerceCueFacts,
  normalizeLabCommerceDelivery,
} from "../commerce/commerce-wasm";
import type {
  ApplyCommerceDeliveryInput,
  CommerceLabRunVerification,
  CommerceLabVerification,
} from "../actors/commerce-projection";
import type { Env } from "../env";
import { authorizeConfiguredBearer } from "../fault-injection-auth";
import {
  errorResponse,
  jsonResponse,
  methodNotAllowed,
  notFound,
  readJsonObject,
  type JsonObject,
} from "../http";
import { cueSnapshotKey, parseCueSnapshot } from "../cues/engine";
import { createCommerceDeliveryQueueMessage } from "../commerce/contract/queue-messages";
import {
  newRequestId,
  parseIntegrationAccountId,
  parseOrganisationId,
  type IntegrationAccountId,
  type OrganisationId,
} from "../ids";
import { requireActiveOrganisationActorAtPlacement } from "../actors/actor-router";
import { ensureCreatedOrganisationActor } from "../control/organisation-runtime";
import type { Variant } from "@purin-labs/type-utils";
import { isRecord } from "@purin-labs/std";

type CommerceLabRoute =
  | {
      readonly kind: "admin";
      readonly operation: "reset" | "seed" | "verify";
      readonly organisationIdRaw: string;
    }
  | {
      readonly kind: "admin";
      readonly operation: "scenario";
      readonly organisationIdRaw: string;
      readonly scenarioIdRaw: string;
    }
  | {
      readonly kind: "ingress";
      readonly organisationIdRaw: string;
    };

type LabMarker = {
  readonly organisationId: OrganisationId;
  readonly labNamespace: string;
  readonly catalogVersion: string;
};

type CueLogRow = {
  readonly cueId: unknown;
  readonly nativeId: unknown;
  readonly reason: unknown;
  readonly surfaceKind: unknown;
  readonly surfaceThreadId: unknown;
  readonly at: unknown;
};

type ParsedCueLogIdentity = {
  readonly cueId: string;
  readonly nativeId: string;
  readonly at: number;
};

type ParsedCommerceProposalCue = ParsedCueLogIdentity &
  (
    | { readonly target: { readonly kind: "slack"; readonly slackTs: string } }
    | { readonly target: { readonly kind: "case"; readonly caseId: string } }
  );

type ParsedIngressEnvelope = {
  readonly schemaVersion: typeof LAB_EVENT_SCHEMA_VERSION;
  readonly namespace: string;
  readonly runId: string;
  readonly scenarioId: CommerceLabScenarioId;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly observedAt: string;
  readonly event: JsonObject & { readonly eventId: string };
};

const LAB_EVENT_SCHEMA_VERSION = "satyr.commerce.lab.event.v1";
const SEED_TIMESTAMP = "2026-07-26T00:00:00.000Z";
const SEED_RUN_ID = `commerce_lab_seed_${COMMERCE_LAB_CATALOG_VERSION.replaceAll(
  "-",
  "_",
)}`;

export function matchCommerceLabRoute(url: URL): CommerceLabRoute | null {
  const segments = url.pathname.split("/");
  const operation = segmentAt(segments, 5);

  if (
    segments.length === 6 &&
    segmentAt(segments, 1) === "v1" &&
    segmentAt(segments, 2) === "hooks" &&
    segmentAt(segments, 3) === "commerce-lab" &&
    segmentAt(segments, 5) === "events"
  ) {
    return { kind: "ingress", organisationIdRaw: segmentAt(segments, 4) };
  }

  if (
    segments.length === 6 &&
    segmentAt(segments, 1) === "v1" &&
    segmentAt(segments, 2) === "admin" &&
    segmentAt(segments, 3) === "commerce-lab" &&
    isAdminOperation(operation)
  ) {
    return {
      kind: "admin",
      operation,
      organisationIdRaw: segmentAt(segments, 4),
    };
  }

  if (
    segments.length === 7 &&
    segmentAt(segments, 1) === "v1" &&
    segmentAt(segments, 2) === "admin" &&
    segmentAt(segments, 3) === "commerce-lab" &&
    segmentAt(segments, 5) === "scenarios"
  ) {
    return {
      kind: "admin",
      operation: "scenario",
      organisationIdRaw: segmentAt(segments, 4),
      scenarioIdRaw: segmentAt(segments, 6),
    };
  }

  return null;
}

export async function handleCommerceLabRoute(
  request: Request,
  env: Env,
  route: CommerceLabRoute,
): Promise<Response> {
  if (route.kind === "ingress") {
    return handleIngress(request, env, route);
  }

  if (
    !authorizeConfiguredBearer({
      authorization: request.headers.get("authorization"),
      configuredToken: env.ORGANISATION_ADMIN_TOKEN,
    })
  ) {
    return notFound();
  }

  switch (route.operation) {
    case "reset":
      return handleReset(request, env, route.organisationIdRaw);
    case "seed":
      return handleSeed(request, env, route.organisationIdRaw);
    case "scenario":
      return handleScenario(
        request,
        env,
        route.organisationIdRaw,
        route.scenarioIdRaw,
      );
    case "verify":
      return handleVerify(request, env, route.organisationIdRaw);
  }
}

function buildCommerceLabSeedEnvelopes(input: {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly labNamespace: string;
}): readonly LabEventEnvelopeV1[] {
  const envelopes: LabEventEnvelopeV1[] = [];

  for (const product of COMMERCE_LAB_PRODUCTS) {
    const event: LabEventV1 = {
      kind: "catalog_item_prepared",
      eventId: `commerce_lab_seed_catalog_${product.productId}`,
      revision: 1,
      occurredAt: SEED_TIMESTAMP,
      payload: {
        resourceId: product.productId,
        title: product.title,
        description: product.description,
        variants: product.variants.map(
          buildLabCatalogVariant.bind(null, product.imageUrl, product.title),
        ),
      },
    };
    envelopes.push(seedEnvelope(input, event));

    for (const variant of product.variants) {
      if (variant.variantId === "variant_field_watch_black") {
        continue;
      }
      envelopes.push(
        seedEnvelope(input, {
          kind: "inventory_observed",
          eventId: `commerce_lab_seed_inventory_${variant.variantId}`,
          revision: 1,
          occurredAt: SEED_TIMESTAMP,
          payload: {
            resourceId: `inventory_${variant.variantId}`,
            variantId: variant.variantId,
            sku: variant.sku,
            locationId: "location_lab_main",
            available: variant.initialQuantity,
          },
        }),
      );
    }
  }

  return envelopes;
}

async function handleReset(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  const organisationId = parseOrganisationPath(organisationIdRaw);
  if (organisationId instanceof Response) {
    return organisationId;
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  const scope = execution.value;
  const development = await requireDevelopmentOrganisation(
    scope.database,
    organisationId,
  );
  if (development instanceof Response) {
    return development;
  }
  const body = await readJsonObject(request);
  if (!body.ok) {
    return invalidBody();
  }
  const labNamespace = parseNamespaceBody(body.value, ["labNamespace"]);
  if (labNamespace instanceof Response) {
    return labNamespace;
  }
  const marker = await requireCommerceLabOrganisationMarker({
    db: scope.database,
    organisationId,
    labNamespace,
  });
  if (!marker.ok) {
    return labMetadataError(marker.error.code);
  }
  await ensureCreatedOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: scope.placement,
    now: Date.now(),
  });
  const resetAt = Date.now();
  const reset = await organisation.resetCommerceLab({
    organisationId,
    labNamespace,
    resetAt,
  });
  if (!reset.ok) {
    return labOperationError(reset.error.code);
  }
  await deleteRunEvidence(scope.database, organisationId, labNamespace);
  return jsonResponse({
    ok: true,
    result: { organisationId, labNamespace, resetAt },
  });
}

async function handleSeed(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  const organisationId = parseOrganisationPath(organisationIdRaw);
  if (organisationId instanceof Response) {
    return organisationId;
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  const scope = execution.value;
  const development = await requireDevelopmentOrganisation(
    scope.database,
    organisationId,
  );
  if (development instanceof Response) {
    return development;
  }
  const body = await readJsonObject(request);
  if (!body.ok) {
    return invalidBody();
  }
  const labNamespace = parseNamespaceBody(body.value, ["labNamespace"]);
  if (labNamespace instanceof Response) {
    return labNamespace;
  }
  const integrationAccountId = COMMERCE_LAB_INTEGRATION_ACCOUNT_ID;
  const seededAt = Date.now();
  const marked = await markCommerceLabOrganisation({
    db: scope.database,
    organisationId,
    labNamespace,
    markedAt: seededAt,
  });
  if (!marked.ok) {
    return labMetadataError(marked.error.code);
  }
  const normalized = normalizeSeedEvents({
    organisationId,
    integrationAccountId,
    labNamespace,
    seededAt,
  });
  if (normalized instanceof Response) {
    return normalized;
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: scope.placement,
    now: seededAt,
  });
  const seeded = await organisation.seedCommerceLab({
    organisationId,
    labNamespace,
    catalogVersion: COMMERCE_LAB_CATALOG_VERSION,
    seededAt,
    events: normalized,
  });
  if (!seeded.ok) {
    return labOperationError(seeded.error.code);
  }

  return jsonResponse({
    ok: true,
    result: {
      organisationId,
      labNamespace,
      catalogVersion: COMMERCE_LAB_CATALOG_VERSION,
      integrationAccountId,
      productCount: COMMERCE_LAB_PRODUCTS.length,
      variantCount: commerceLabVariantCount(),
      customerCount: COMMERCE_LAB_CUSTOMERS.length,
    },
  });
}

async function handleScenario(
  request: Request,
  env: Env,
  organisationIdRaw: string,
  scenarioIdRaw: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  const organisationId = parseOrganisationPath(organisationIdRaw);
  if (organisationId instanceof Response) {
    return organisationId;
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  const scope = execution.value;
  const development = await requireDevelopmentOrganisation(
    scope.database,
    organisationId,
  );
  if (development instanceof Response) {
    return development;
  }
  const scenarioId = parseCommerceLabScenarioId(scenarioIdRaw);
  if (!scenarioId.ok) {
    return errorResponse("scenario_id_invalid", "Scenario is invalid.", 422);
  }
  const body = await readJsonObject(request);
  if (!body.ok) {
    return invalidBody();
  }
  const scenarioBody = parseScenarioBody(body.value);
  if (scenarioBody instanceof Response) {
    return scenarioBody;
  }
  const marker = await requireCommerceLabOrganisationMarker({
    db: scope.database,
    organisationId,
    labNamespace: scenarioBody.labNamespace,
  });
  if (!marker.ok) {
    return labMetadataError(marker.error.code);
  }
  const integrationAccountId = COMMERCE_LAB_INTEGRATION_ACCOUNT_ID;
  const existingRuns = await listCommerceLabRuns({
    db: scope.database,
    organisationId,
    limit: 50,
  });
  if (!existingRuns.ok) {
    return labMetadataError(existingRuns.error.code);
  }
  const existing = existingRuns.value.find(
    runMatchesIdempotencyKey.bind(null, scenarioBody.idempotencyKey),
  );
  const startedAt = existing?.startedAt ?? Date.now();
  const run = createCommerceLabScenarioRun({
    scenarioId: scenarioId.value,
    idempotencyKey: scenarioBody.idempotencyKey,
    startedAt,
  });
  if (!run.ok) {
    return errorResponse(run.error.code, "Scenario run is invalid.", 422);
  }
  const cuePreflight = await requireCommerceLabCueSubscription(
    env,
    organisationId,
    run.value.expectedSlackEffect,
  );
  if (cuePreflight !== null) {
    return cuePreflight;
  }
  const evidence: CommerceLabRunEvidence = {
    runId: run.value.runId,
    organisationId,
    labNamespace: scenarioBody.labNamespace,
    scenarioId: run.value.scenarioId,
    scenarioVersion: run.value.scenarioVersion,
    catalogVersion: run.value.catalogVersion,
    idempotencyKey: run.value.idempotencyKey,
    result: "running",
    startedAt,
    completedAt: null,
    providerEventIds: run.value.providerEventIds,
    expectedProjections: run.value.expectedProjections,
    expectedSlackEffect: run.value.expectedSlackEffect,
    publicationProposal: run.value.publicationProposal,
    failureStage: null,
    failureCode: null,
    failureProviderEventId: null,
    failureProjectionId: null,
    failureSlackEffectId: null,
  };
  const begun = await beginCommerceLabRun({
    db: scope.database,
    run: evidence,
  });
  if (!begun.ok) {
    return labMetadataError(begun.error.code);
  }
  return jsonResponse({
    ok: true,
    run: {
      ...run.value,
      integrationAccountId,
    },
  });
}

async function requireCommerceLabCueSubscription(
  env: Env,
  organisationId: OrganisationId,
  effect: CommerceLabRunEvidence["expectedSlackEffect"],
): Promise<Response | null> {
  if (effect.kind === "none") {
    return null;
  }
  const raw = await env.POLICY_KV.get(cueSnapshotKey(organisationId), "json");
  if (raw !== null) {
    const snapshot = parseCueSnapshot(raw);
    if (snapshot.ok) {
      for (const subscription of snapshot.value.subscriptions) {
        if (
          subscription.source === "commerce" &&
          subscription.eventType === effect.eventType
        ) {
          return null;
        }
      }
    }
  }
  return errorResponse(
    "commerce_lab_cue_subscription_missing",
    "The active cue setup cannot deliver this scenario.",
    409,
  );
}

async function handleVerify(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return methodNotAllowed(["GET"]);
  }
  const organisationId = parseOrganisationPath(organisationIdRaw);
  if (organisationId instanceof Response) {
    return organisationId;
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  const scope = execution.value;
  const development = await requireDevelopmentOrganisation(
    scope.database,
    organisationId,
  );
  if (development instanceof Response) {
    return development;
  }
  const marker = await readLabMarker(scope.database, organisationId);
  if (marker instanceof Response) {
    return marker;
  }
  const runs = await listCommerceLabRuns({
    db: scope.database,
    organisationId,
    limit: 50,
  });
  if (!runs.ok) {
    return labMetadataError(runs.error.code);
  }
  const organisation = await requireActiveOrganisationActorAtPlacement({
    env,
    organisationId,
    placement: scope.placement,
    now: Date.now(),
  });
  const verified = await organisation.verifyCommerceLab({
    organisationId,
    labNamespace: marker.labNamespace,
    limit: 50,
  });
  if (!verified.ok) {
    return labOperationError(verified.error.code);
  }
  const cueRows = await readProposalCueRows(scope.database, organisationId);
  if (cueRows instanceof Response) {
    return cueRows;
  }
  const completed = await completeReadyCommerceLabRuns({
    db: scope.database,
    organisationId,
    verification: verified.value,
    runs: runs.value,
    cueRows,
    completedAt: Date.now(),
  });
  if (completed instanceof Response) {
    return completed;
  }
  const authoritativeRuns = completed
    ? await listCommerceLabRuns({
        db: scope.database,
        organisationId,
        limit: 50,
      })
    : runs;
  if (!authoritativeRuns.ok) {
    return labMetadataError(authoritativeRuns.error.code);
  }
  const authoritativeVerification = completed
    ? await organisation.verifyCommerceLab({
        organisationId,
        labNamespace: marker.labNamespace,
        limit: 50,
      })
    : verified;
  if (!authoritativeVerification.ok) {
    return labOperationError(authoritativeVerification.error.code);
  }
  return jsonResponse({
    ok: true,
    verification: mapVerification(
      authoritativeVerification.value,
      authoritativeRuns.value,
      cueRows,
    ),
  });
}

export function commerceLabRunReadyForCompletion(
  run: Pick<
    CommerceLabRunVerification,
    "result" | "projectionReceipts" | "terminalProjectionIdentities"
  >,
  evidence: Pick<
    CommerceLabRunEvidence,
    "providerEventIds" | "expectedProjections" | "expectedSlackEffect"
  >,
  slackEffectReceiptCount: number,
): boolean {
  return (
    run.result === "running" &&
    evidence.providerEventIds.every(
      providerEventHasReceipt.bind(null, run.projectionReceipts),
    ) &&
    evidence.expectedProjections.every(
      expectedProjectionHasTerminalState.bind(
        null,
        run.terminalProjectionIdentities,
      ),
    ) &&
    slackEffectReceiptCount >=
      expectedSlackEffectCount(evidence.expectedSlackEffect)
  );
}

async function completeReadyCommerceLabRuns(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly verification: CommerceLabVerification;
  readonly runs: readonly CommerceLabRunEvidence[];
  readonly cueRows: readonly ParsedCommerceProposalCue[];
  readonly completedAt: number;
}): Promise<boolean | Response> {
  const evidenceByRun = new Map(input.runs.map(indexRunEvidence));
  let changed = false;

  for (const run of input.verification.runs) {
    const evidence = evidenceByRun.get(run.runId);
    if (
      evidence === undefined ||
      !commerceLabRunReadyForCompletion(
        run,
        evidence,
        proposalCueCount(evidence, input.cueRows),
      )
    ) {
      continue;
    }
    const completed = await completeCommerceLabRun({
      db: input.db,
      organisationId: input.organisationId,
      runId: run.runId,
      completedAt: input.completedAt,
    });
    if (!completed.ok) {
      return labMetadataError(completed.error.code);
    }
    changed = true;
  }

  return changed;
}

function expectedSlackEffectCount(
  effect: CommerceLabRunEvidence["expectedSlackEffect"],
): number {
  return effect.kind === "proposal" ? 1 : 0;
}

function proposalCueCount(
  run: CommerceLabRunEvidence,
  cueRows: readonly ParsedCommerceProposalCue[],
): number {
  return cueRows
    .filter(cueBelongsToRun.bind(null, run))
    .filter(cueMatchesExpectedEffect.bind(null, run)).length;
}

function providerEventHasReceipt(
  receipts: CommerceLabRunVerification["projectionReceipts"],
  eventId: string,
): boolean {
  return receipts.some(receiptMatchesEventId.bind(null, eventId));
}

function receiptMatchesEventId(
  eventId: string,
  receipt: CommerceLabRunVerification["projectionReceipts"][number],
): boolean {
  return receipt.providerDeliveryId === eventId;
}

function expectedProjectionHasTerminalState(
  projections: CommerceLabRunVerification["terminalProjectionIdentities"],
  expected: CommerceLabRunEvidence["expectedProjections"][number],
): boolean {
  return projections.some(
    terminalProjectionMatchesExpectation.bind(null, expected),
  );
}

function terminalProjectionMatchesExpectation(
  expected: CommerceLabRunEvidence["expectedProjections"][number],
  projection: CommerceLabRunVerification["terminalProjectionIdentities"][number],
): boolean {
  return (
    projection.kind === expected.kind &&
    projection.canonicalId === expected.canonicalId &&
    projection.lifecycle === expected.lifecycle
  );
}

async function handleIngress(
  request: Request,
  env: Env,
  route: Variant<CommerceLabRoute, "ingress">,
): Promise<Response> {
  if (request.method !== "POST") {
    return methodNotAllowed(["POST"]);
  }
  if (env.COMMERCE_LAB_SIGNING_SECRET === undefined) {
    return errorResponse(
      "commerce_lab_signing_unavailable",
      "Commerce lab signing is unavailable.",
      503,
    );
  }
  const rawBody = await request.text();
  const verified = await verifyCommerceLabSignature({
    headers: request.headers,
    rawBody,
    signingSecret: env.COMMERCE_LAB_SIGNING_SECRET,
    nowMs: Date.now(),
  });
  if (!verified.ok) {
    return errorResponse(
      verified.error.code,
      "Commerce lab signature is invalid.",
      401,
    );
  }
  const organisationId = parseOrganisationPath(route.organisationIdRaw);
  if (organisationId instanceof Response) {
    return organisationId;
  }
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId,
  );
  if (!execution.ok)
    return errorResponse(
      execution.error.code,
      "The organisation region is unavailable.",
      503,
    );
  const scope = execution.value;
  const development = await requireDevelopmentOrganisation(
    scope.database,
    organisationId,
  );
  if (development instanceof Response) {
    return development;
  }
  const envelope = parseIngressEnvelope(rawBody, organisationId);
  if (envelope instanceof Response) {
    return envelope;
  }
  const marker = await requireCommerceLabOrganisationMarker({
    db: scope.database,
    organisationId,
    labNamespace: envelope.namespace,
  });
  if (!marker.ok) {
    return labMetadataError(marker.error.code);
  }
  const runs = await listCommerceLabRuns({
    db: scope.database,
    organisationId,
    limit: 50,
  });
  if (!runs.ok) {
    return labMetadataError(runs.error.code);
  }
  const run = runs.value.find(runMatchesId.bind(null, envelope.runId));
  if (
    run === undefined ||
    run.scenarioId !== envelope.scenarioId ||
    !run.providerEventIds.includes(envelope.event.eventId)
  ) {
    return errorResponse(
      "commerce_lab_run_mismatch",
      "Lab run does not match.",
      409,
    );
  }
  const integrationAccountId = COMMERCE_LAB_INTEGRATION_ACCOUNT_ID;
  if (integrationAccountId !== envelope.integrationAccountId) {
    return errorResponse(
      "commerce_lab_integration_account_mismatch",
      "Lab integration account does not match.",
      409,
    );
  }
  const canonical = normalizeLabCommerceDelivery(envelope);
  const cueFacts = deriveLabCommerceCueFacts(envelope);
  if (!canonical.ok || !cueFacts.ok) {
    return errorResponse(
      "commerce_lab_event_invalid",
      "Commerce lab event is invalid.",
      422,
    );
  }
  const requestId = newRequestId();
  await env.EVENT_Q.send(
    createCommerceDeliveryQueueMessage({
      requestId,
      receivedAt: Date.now(),
      organisationId,
      integrationAccountId,
      labRunId: run.runId,
      canonicalDeliveryJson: JSON.stringify(canonical.value),
      canonicalCueFactsJson: JSON.stringify(cueFacts.value),
    }),
  );
  return jsonResponse(
    {
      ok: true,
      requestId,
      eventId: envelope.event.eventId,
      queued: true,
    },
    202,
  );
}

function normalizeSeedEvents(input: {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly labNamespace: string;
  readonly seededAt: number;
}): readonly ApplyCommerceDeliveryInput[] | Response {
  const events: ApplyCommerceDeliveryInput[] = [];
  const envelopes = buildCommerceLabSeedEnvelopes(input);

  for (const envelope of envelopes) {
    const canonical = normalizeLabCommerceDelivery(envelope);
    const cueFacts = deriveLabCommerceCueFacts(envelope);
    if (!canonical.ok || !cueFacts.ok) {
      return errorResponse(
        "commerce_lab_seed_invalid",
        "Commerce lab seed is invalid.",
        500,
      );
    }
    events.push({
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      delivery: canonical.value,
      cueFacts: cueFacts.value,
      labRunId: null,
      processedAt: input.seededAt,
    });
  }
  return events;
}

function seedEnvelope(
  input: {
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: IntegrationAccountId;
    readonly labNamespace: string;
  },
  event: LabEventV1,
): LabEventEnvelopeV1 {
  return {
    schemaVersion: LAB_EVENT_SCHEMA_VERSION,
    namespace: input.labNamespace,
    runId: SEED_RUN_ID,
    scenarioId: "product-listing",
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    observedAt: SEED_TIMESTAMP,
    event,
  };
}

function buildLabCatalogVariant(
  imageUrl: string,
  altText: string,
  variant: (typeof COMMERCE_LAB_PRODUCTS)[number]["variants"][number],
) {
  return {
    variantId: variant.variantId,
    sku: variant.sku,
    title: variant.title,
    amountMinor: variant.price.amountMinor,
    currency: variant.price.currency,
    available: variant.initialQuantity > 0,
    options: buildCatalogOptions(variant.optionValues),
    media: [{ kind: "image" as const, url: imageUrl, altText }],
  };
}

function buildCatalogOptions(
  values: Readonly<Record<string, string>>,
): LabCatalogOptionV1[] {
  const options: LabCatalogOptionV1[] = [];
  for (const [name, value] of Object.entries(values)) {
    options.push({ name, value });
  }
  return options;
}

function parseIngressEnvelope(
  rawBody: string,
  pathOrganisationId: OrganisationId,
): ParsedIngressEnvelope | Response {
  let raw: unknown;
  try {
    raw = JSON.parse(rawBody);
  } catch {
    return invalidBody();
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== LAB_EVENT_SCHEMA_VERSION ||
    !isLabNamespace(raw.namespace) ||
    typeof raw.runId !== "string" ||
    raw.runId.length === 0 ||
    typeof raw.scenarioId !== "string" ||
    typeof raw.organisationId !== "string" ||
    typeof raw.integrationAccountId !== "string" ||
    typeof raw.observedAt !== "string" ||
    !isRecord(raw.event) ||
    typeof raw.event.eventId !== "string"
  ) {
    return invalidBody();
  }
  const scenarioId = parseCommerceLabScenarioId(raw.scenarioId);
  const bodyOrganisationId = parseOrganisationId(raw.organisationId);
  const accountId = parseIntegrationAccountId(raw.integrationAccountId);
  if (
    !scenarioId.ok ||
    !bodyOrganisationId.ok ||
    bodyOrganisationId.value !== pathOrganisationId ||
    !accountId.ok
  ) {
    return errorResponse(
      "commerce_lab_envelope_mismatch",
      "Commerce lab envelope does not match the route.",
      409,
    );
  }
  return {
    schemaVersion: raw.schemaVersion,
    namespace: raw.namespace,
    runId: raw.runId,
    scenarioId: scenarioId.value,
    organisationId: bodyOrganisationId.value,
    integrationAccountId: accountId.value,
    observedAt: raw.observedAt,
    event: { ...raw.event, eventId: raw.event.eventId },
  };
}

function parseScenarioBody(body: JsonObject):
  | {
      readonly labNamespace: string;
      readonly idempotencyKey: CommerceLabIdempotencyKey;
    }
  | Response {
  if (!hasOnlyFields(body, ["labNamespace", "idempotencyKey"])) {
    return invalidBody();
  }
  const labNamespace = readLabNamespace(body.labNamespace);
  const idempotencyKey =
    typeof body.idempotencyKey === "string"
      ? parseCommerceLabIdempotencyKey(body.idempotencyKey)
      : {
          ok: false as const,
          error: { code: "idempotency_key_invalid" as const },
        };
  if (labNamespace === null || !idempotencyKey.ok) {
    return invalidBody();
  }
  return { labNamespace, idempotencyKey: idempotencyKey.value };
}

function parseNamespaceBody(
  body: JsonObject,
  fields: readonly string[],
): string | Response {
  if (!hasOnlyFields(body, fields)) {
    return invalidBody();
  }
  const namespace = readLabNamespace(body.labNamespace);
  return namespace ?? invalidBody();
}

function readLabNamespace(raw: unknown): string | null {
  return typeof raw === "string" && isLabNamespace(raw) ? raw : null;
}

function isLabNamespace(raw: unknown): raw is string {
  return typeof raw === "string" && /^lab_[A-Za-z0-9_-]{4,124}$/u.test(raw);
}

function hasOnlyFields(body: JsonObject, allowed: readonly string[]): boolean {
  const allowedFields = new Set(allowed);
  return Object.keys(body).every(allowedFields.has.bind(allowedFields));
}

async function requireDevelopmentOrganisation(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<true | Response> {
  const row = await db
    .prepare(
      "SELECT environment FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ readonly environment: unknown }>();
  if (row === null) {
    return errorResponse(
      "organisation_not_found",
      "Organisation does not exist.",
      404,
    );
  }
  return row.environment === "development"
    ? true
    : errorResponse(
        "commerce_lab_development_only",
        "Commerce lab routes require a development organisation.",
        409,
      );
}

async function readLabMarker(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<LabMarker | Response> {
  const row = await db
    .prepare(
      `SELECT organisation_id AS organisationId,
            lab_namespace AS labNamespace,
            scenario_catalog_version AS catalogVersion
     FROM commerce_lab_organisation
     WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<{
      readonly organisationId: unknown;
      readonly labNamespace: unknown;
      readonly catalogVersion: unknown;
    }>();
  if (
    row === null ||
    row.organisationId !== organisationId ||
    !isLabNamespace(row.labNamespace) ||
    typeof row.catalogVersion !== "string"
  ) {
    return errorResponse(
      "commerce_lab_not_marked",
      "Organisation is not marked for the commerce lab.",
      409,
    );
  }
  return {
    organisationId,
    labNamespace: row.labNamespace,
    catalogVersion: row.catalogVersion,
  };
}

async function deleteRunEvidence(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  labNamespace: string,
): Promise<void> {
  const runs = await listCommerceLabRuns({ db, organisationId, limit: 50 });
  if (runs.ok) {
    for (const run of runs.value) {
      for (const eventId of run.providerEventIds) {
        await deleteCommerceCueEvidence(db, organisationId, eventId);
      }
    }
  }
  await db
    .prepare(
      "DELETE FROM commerce_lab_run WHERE organisation_id = ? AND lab_namespace = ?",
    )
    .bind(organisationId, labNamespace)
    .run();
}

export async function deleteCommerceCueEvidence(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  providerEventId: string,
): Promise<void> {
  const prefix = `commerce:${providerEventId}:`;
  await prepareCommerceCueLogDelete(db, { organisationId, prefix }).run();
}

async function readProposalCueRows(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
): Promise<readonly ParsedCommerceProposalCue[] | Response> {
  const query = await db
    .prepare(
      `SELECT cue_id AS cueId, native_id AS nativeId, reason,
            surface_kind AS surfaceKind, surface_thread_id AS surfaceThreadId, at
     FROM cue_log
     WHERE organisation_id = ? AND source = 'commerce' AND decision = 'proposed'
     ORDER BY at, cue_id
     LIMIT 500`,
    )
    .bind(organisationId)
    .all<CueLogRow>();
  const rows: ParsedCommerceProposalCue[] = [];
  for (const row of query.results) {
    const parsed = parseCommerceProposalCue(row);
    if (parsed === null) {
      return errorResponse(
        "commerce_lab_cue_evidence_corrupt",
        "Commerce lab cue evidence is invalid.",
        500,
      );
    }
    rows.push(parsed);
  }
  return rows;
}

export function parseCommerceProposalCue(
  row: CueLogRow,
): ParsedCommerceProposalCue | null {
  const identity =
    typeof row.cueId === "string" &&
    typeof row.nativeId === "string" &&
    typeof row.at === "number" &&
    Number.isSafeInteger(row.at) &&
    row.at >= 0
      ? { cueId: row.cueId, nativeId: row.nativeId, at: row.at }
      : null;
  if (identity === null) return null;
  const slackTs = parseSlackCueTarget(row);
  if (slackTs !== null) {
    return { ...identity, target: { kind: "slack", slackTs } };
  }
  const caseId = parseCaseCueTarget(row);
  return caseId === null
    ? null
    : { ...identity, target: { kind: "case", caseId } };
}

function parseSlackCueTarget(row: CueLogRow): string | null {
  if (row.surfaceKind === "slack" && typeof row.surfaceThreadId === "string") {
    return row.surfaceThreadId.length > 0 ? row.surfaceThreadId : null;
  }
  if (
    row.surfaceKind !== null ||
    typeof row.reason !== "string" ||
    !row.reason.startsWith("slack:")
  ) {
    return null;
  }
  const slackTs = row.reason.slice("slack:".length);
  return slackTs.length > 0 ? slackTs : null;
}

function parseCaseCueTarget(row: CueLogRow): string | null {
  if (
    row.surfaceKind !== null ||
    row.surfaceThreadId !== null ||
    typeof row.reason !== "string" ||
    !row.reason.startsWith("case:")
  ) {
    return null;
  }
  const caseId = row.reason.slice("case:".length);
  return caseId.length > 0 ? caseId : null;
}

function mapVerification(
  raw: CommerceLabVerification,
  runs: readonly CommerceLabRunEvidence[],
  cueRows: readonly ParsedCommerceProposalCue[],
) {
  const evidenceByRun = new Map(runs.map(indexRunEvidence));
  return {
    organisationId: raw.organisationId,
    labNamespace: raw.labNamespace,
    catalogVersion: raw.catalogVersion,
    runs: raw.runs.map(mapRunVerification.bind(null, evidenceByRun, cueRows)),
  };
}

function mapRunVerification(
  evidenceByRun: ReadonlyMap<string, CommerceLabRunEvidence>,
  cueRows: readonly ParsedCommerceProposalCue[],
  run: CommerceLabRunVerification,
) {
  const evidence = evidenceByRun.get(run.runId);
  const expected = evidence?.expectedProjections ?? [];
  const projectionReceipts = run.terminalProjectionIdentities
    .filter(terminalProjectionExpected.bind(null, expected))
    .map(mapProjectionReceipt);
  const slackEffectReceipts =
    evidence === undefined
      ? []
      : cueRows
          .filter(cueBelongsToRun.bind(null, evidence))
          .filter(cueMatchesExpectedEffect.bind(null, evidence))
          .filter(isSlackProposalCue)
          .map(mapSlackReceipt.bind(null, evidence));
  const caseEffectReceipts =
    evidence === undefined
      ? []
      : cueRows
          .filter(cueBelongsToRun.bind(null, evidence))
          .filter(cueMatchesExpectedEffect.bind(null, evidence))
          .filter(isCaseProposalCue)
          .map(mapCaseReceipt.bind(null, evidence));
  const failure =
    run.result === "failed"
      ? {
          stage: run.failureStage ?? "commerce_event",
          code: run.failureCode ?? "commerce_lab_run_failed",
          providerEventId: run.failureProviderEventId,
          projectionId: run.failureProjectionId,
          slackEffectId: run.failureSlackEffectId,
        }
      : null;
  return {
    runId: run.runId,
    scenarioId: run.scenarioId,
    scenarioVersion: run.scenarioVersion,
    result:
      run.result === "completed"
        ? "success"
        : run.result === "failed"
          ? "failure"
          : "running",
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    providerEventIds: run.providerEventIds,
    publicationProposal: run.publicationProposal,
    projectionReceipts,
    slackEffectReceipts,
    caseEffectReceipts,
    approvalReceipts: run.approvalReceipts,
    interventionReceipts: run.interventionReceipts,
    providerEffectReceipts: run.providerEffectReceipts,
    duplicateEffectCount: duplicateSlackEffectCount(
      evidence?.expectedSlackEffect,
      slackEffectReceipts,
    ),
    unauthorizedEffectCount: run.unauthorizedEffectCount,
    failure,
  };
}

function duplicateSlackEffectCount(
  expected: CommerceLabRunEvidence["expectedSlackEffect"] | undefined,
  receipts: readonly ReturnType<typeof mapSlackReceipt>[],
): number {
  const expectedCount = expected?.kind === "proposal" ? 1 : 0;
  return Math.max(0, receipts.length - expectedCount);
}

function indexRunEvidence(
  run: CommerceLabRunEvidence,
): readonly [string, CommerceLabRunEvidence] {
  return [run.runId, run];
}

function terminalProjectionExpected(
  expected: CommerceLabRunEvidence["expectedProjections"],
  projection: CommerceLabRunVerification["terminalProjectionIdentities"][number],
): boolean {
  return expected.some(expectedProjectionMatches.bind(null, projection));
}

function expectedProjectionMatches(
  projection: CommerceLabRunVerification["terminalProjectionIdentities"][number],
  expected: CommerceLabRunEvidence["expectedProjections"][number],
): boolean {
  return (
    projection.kind === expected.kind &&
    projection.canonicalId === expected.canonicalId &&
    projection.lifecycle === expected.lifecycle
  );
}

function mapProjectionReceipt(
  projection: CommerceLabRunVerification["terminalProjectionIdentities"][number],
) {
  return {
    kind: projection.kind,
    resourceId: projection.canonicalId,
    revision: projection.revision,
    state: projection.lifecycle,
  };
}

function cueBelongsToRun(
  run: CommerceLabRunEvidence,
  cue: ParsedCommerceProposalCue,
): boolean {
  return run.providerEventIds.some(
    nativeIdIncludesEvent.bind(null, cue.nativeId),
  );
}

function nativeIdIncludesEvent(nativeId: string, eventId: string): boolean {
  return nativeId.startsWith(`commerce:${eventId}:`);
}

function cueMatchesExpectedEffect(
  run: CommerceLabRunEvidence,
  cue: ParsedCommerceProposalCue,
): boolean {
  return (
    run.expectedSlackEffect.kind === "proposal" &&
    cue.nativeId.includes(`:${run.expectedSlackEffect.eventType}:`)
  );
}

function mapSlackReceipt(
  run: CommerceLabRunEvidence,
  cue: Extract<
    ParsedCommerceProposalCue,
    { readonly target: { readonly kind: "slack" } }
  >,
) {
  return {
    effectId: cue.cueId,
    kind: "proposal" as const,
    outcome: proposalOutcome(run),
    createdAt: cue.at,
    slackTs: cue.target.slackTs,
  };
}

function mapCaseReceipt(
  run: CommerceLabRunEvidence,
  cue: Extract<
    ParsedCommerceProposalCue,
    { readonly target: { readonly kind: "case" } }
  >,
) {
  return {
    effectId: cue.cueId,
    kind: "proposal" as const,
    outcome: proposalOutcome(run),
    createdAt: cue.at,
    caseId: cue.target.caseId,
  };
}

function isSlackProposalCue(
  cue: ParsedCommerceProposalCue,
): cue is Extract<
  ParsedCommerceProposalCue,
  { readonly target: { readonly kind: "slack" } }
> {
  return cue.target.kind === "slack";
}

function isCaseProposalCue(
  cue: ParsedCommerceProposalCue,
): cue is Extract<
  ParsedCommerceProposalCue,
  { readonly target: { readonly kind: "case" } }
> {
  return cue.target.kind === "case";
}

function proposalOutcome(run: CommerceLabRunEvidence): string {
  if (run.expectedSlackEffect.kind === "none") {
    return "none";
  }
  switch (run.expectedSlackEffect.eventType) {
    case "payment_failed":
      return "payment_exception_proposed";
    case "inventory_shortage":
      return "inventory_exception_proposed";
    case "tracking_stalled":
    case "delivery_exception":
      return "shipment_delay_proposed";
    case "cancellation_refund_proposed":
      return "cancellation_refund_proposed";
  }
}

function runMatchesIdempotencyKey(
  idempotencyKey: string,
  run: CommerceLabRunEvidence,
): boolean {
  return run.idempotencyKey === idempotencyKey;
}

function runMatchesId(runId: string, run: CommerceLabRunEvidence): boolean {
  return run.runId === runId;
}

function parseOrganisationPath(raw: string): OrganisationId | Response {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return errorResponse(
      "invalid_organisation_id",
      "Organisation ID is invalid.",
      422,
    );
  }
  const organisationId = parseOrganisationId(decoded);
  return organisationId.ok
    ? organisationId.value
    : errorResponse(
        "invalid_organisation_id",
        "Organisation ID is invalid.",
        422,
      );
}

function invalidBody(): Response {
  return errorResponse("invalid_body", "Request body is invalid.", 422);
}

function labMetadataError(code: string): Response {
  return errorResponse(
    code,
    "Commerce lab metadata rejected the request.",
    409,
  );
}

function labOperationError(code: string): Response {
  return errorResponse(code, "Commerce lab operation failed.", 409);
}

function isAdminOperation(value: string): value is "reset" | "seed" | "verify" {
  return value === "reset" || value === "seed" || value === "verify";
}

function segmentAt(segments: readonly string[], index: number): string {
  return segments[index] ?? "";
}
