import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/credential-vault/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/credential-vault/service")>()),
  resolveVaultHandle: vi.fn().mockResolvedValue({
    ok: true,
    value: { kind: "bearer", value: "apikey_organisation-owned-test-key" },
  }),
}));

import { OrganisationDO } from "../src/actors/organisation";
import { parseOrganisationId } from "../src/ids";
import { platformEnv } from "./worker-fakes";
import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "../src/data/shared-rows/placement-row";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { activateOrganisationFixture } from "./fixtures/organisation-activation";
import type { OrganisationId } from "../src/ids";
import {
  recordCaseContextCollectionSuggestion,
  type CaseContextCollectionScope,
} from "../src/case-context-discovery/relationships";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("Cue CaseContextCollection Actor boundary", suite);

function suite(): void {
  afterEach(vi.unstubAllGlobals);
  it("requires the owning organisation and explicit opt-in", guardsActorInputs);
  it(
    "reads and rejects stored suggestions through the organisation boundary",
    reviewsStoredSuggestions,
  );
}

async function guardsActorInputs(): Promise<void> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const organisationId = parseOrganisationId(
    "organisation_case_context_collection_actor",
  );
  const foreignOrganisationId = parseOrganisationId("organisation_foreign");
  if (!organisationId.ok || !foreignOrganisationId.ok)
    throw new Error("invalid fixture");
  const env = await caseContextCollectionEnvironment(organisationId.value);
  const actor = new OrganisationDO(
    {
      storage: {
        sql,
        setAlarm: vi.fn().mockResolvedValue(undefined),
        deleteAlarm: vi.fn().mockResolvedValue(undefined),
        transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
      },
    } as unknown as DurableObjectState,
    env,
  );
  sql.exec(
    "INSERT INTO organisation_meta VALUES (?, 'CaseContextCollection test', 'beta', 'active', 1)",
    organisationId.value,
  );
  await activateOrganisationFixture(actor, env, organisationId.value);
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    actor.readCaseContextDiscoveryConfiguration({
      organisationId: foreignOrganisationId.value,
    }),
  ).resolves.toMatchObject({ ok: false });
  await expect(
    actor.readCaseContextDiscoveryConfiguration({
      organisationId: organisationId.value,
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      revision: 0,
      policy: { mode: "disabled" },
      rollout: "operational_shadow_and_admin_metadata_review",
    },
  });
  await expect(
    actor.readTypeSafeConnectionConfiguration({
      organisationId: organisationId.value,
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      connection: { kind: "disconnected", revision: 0 },
      credentialConfigured: false,
      authority: null,
    },
  });
  await expect(
    actor.readTypeSafeConnectionConfiguration({
      organisationId: foreignOrganisationId.value,
    }),
  ).resolves.toMatchObject({ ok: false });
  await expect(
    actor.readCaseContextDiscoverySourceReadiness({
      organisationId: organisationId.value,
      source: "gmail",
      integrationAccountId: "account-1",
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: { kind: "inactive", reason: "disabled" },
  });
  const policy = {
    mode: "shadow",
    route: {
      provider: "typesafe",
      connectionRevision: 1,
      funding: "organisation_byo",
      credentialRef: "organisation_typesafe",
    },
    sources: [{ source: "commerce", integrationAccountId: "account-1" }],
    limits: {
      maxEvaluations: 1,
      maxConcurrentEvaluations: 1,
      maxInputBytes: 24_576,
      maxInputTokens: 65_536,
      maxWallMs: 10_000,
      maxCostMicrousd: 10_000,
      reservationMicrousd: 10_000,
      requestTimeoutMs: 10_000,
    },
  };
  const request = {
    organisationId: organisationId.value,
    actorId: "control-admin",
    body: { commandId: "publish-1", expectedRevision: 0, policy },
  };
  await expect(
    actor.publishCaseContextDiscoveryConfiguration(request),
  ).resolves.toMatchObject({
    ok: false,
    error: { code: "case_context_discovery_activation_unavailable" },
  });
  sql.exec(
    `INSERT INTO typesafe_connection (organisation_id, revision, provider, vault_handle, tested_at, updated_by)
    VALUES (?, 1, 'typesafe', ?, 1, 'admin')`,
    organisationId.value,
    `vault:${organisationId.value}:jev:test`,
  );
  await expect(
    actor.readTypeSafeConnectionConfiguration({
      organisationId: organisationId.value,
    }),
  ).resolves.toEqual({
    ok: true,
    value: {
      connection: {
        kind: "connected",
        provider: "typesafe",
        revision: 1,
        testedAt: 1,
      },
      credentialConfigured: true,
      authority: { kind: "organisation_byo", connectionRevision: 1 },
    },
  });
  await expect(
    actor.publishCaseContextDiscoveryConfiguration(request),
  ).resolves.toEqual({
    ok: true,
    value: { revision: 1 },
  });
  await expect(
    actor.readCaseContextDiscoverySourceReadiness({
      organisationId: organisationId.value,
      source: "commerce",
      integrationAccountId: "account-1",
    }),
  ).resolves.toMatchObject({ ok: true, value: { kind: "ready" } });
  const readiness = await actor.readCaseContextDiscoverySourceReadiness({
    organisationId: organisationId.value,
    source: "commerce",
    integrationAccountId: "account-1",
  });
  expect(JSON.stringify(readiness)).not.toContain("apikey_");
  expect(JSON.stringify(readiness)).not.toContain("apiKey");
  await expect(
    actor.publishCaseContextDiscoveryConfiguration(request),
  ).resolves.toEqual({
    ok: true,
    value: { revision: 1 },
  });
  await expect(
    actor.publishCaseContextDiscoveryConfiguration({
      ...request,
      body: {
        commandId: "publish-2",
        expectedRevision: 1,
        policy: { ...policy, mode: "metadata_only" },
      },
    }),
  ).resolves.toEqual({
    ok: true,
    value: { revision: 2 },
  });
  await expect(
    actor.publishCaseContextDiscoveryConfiguration({
      ...request,
      body: {
        commandId: "publish-3",
        expectedRevision: 2,
        policy: { ...policy, mode: "party_context" },
      },
    }),
  ).resolves.toEqual({
    ok: false,
    error: { code: "case_context_discovery_activation_unavailable" },
  });
  expect(fetcher).not.toHaveBeenCalled();
  fixture.database.close();
}

async function reviewsStoredSuggestions(): Promise<void> {
  const fixture = emptySqliteFixture();
  const sql = sqlStorage(fixture.storage);
  const organisationId = parseOrganisationId(
    "organisation_case_context_collection_review",
  );
  if (!organisationId.ok) throw new Error("invalid fixture");
  const env = await caseContextCollectionEnvironment(organisationId.value);
  const actor = new OrganisationDO(
    {
      storage: {
        sql,
        setAlarm: vi.fn().mockResolvedValue(undefined),
        deleteAlarm: vi.fn().mockResolvedValue(undefined),
        transactionSync: fixture.storage.transactionSync.bind(fixture.storage),
      },
    } as unknown as DurableObjectState,
    env,
  );
  sql.exec(
    "INSERT INTO organisation_meta VALUES (?, 'CaseContextCollection review', 'beta', 'active', 1)",
    organisationId.value,
  );
  await activateOrganisationFixture(actor, env, organisationId.value);
  const scope: CaseContextCollectionScope = {
    organisationId: organisationId.value,
    merchantId: "merchant_cafe",
    party: { kind: "supplier", id: "supplier_flour" },
    issueKind: "delivery_delay",
    issueInstance: "shipment_842_1",
  };
  expect(
    recordCaseContextCollectionSuggestion({
      sql,
      transaction: fixture.storage.transactionSync.bind(fixture.storage),
      organisationId: organisationId.value,
      commandId: "suggest_one",
      requestDigest: "a".repeat(64),
      caseContextCollectionId: "case_context_collection_delivery",
      relationshipId: "relationship_one",
      expectedRevision: 0,
      scope,
      sourceScope: scope,
      anchorSelection: {
        caseId: "case_delivery_anchor",
        source: "gmail",
        integrationAccountId: "integration_supplier_mailbox",
        reference: "message_anchor",
        sourceRevision: 1,
        verificationId: "verification_supplier",
        verificationRevision: 1,
      },
      selection: {
        caseId: "case_delivery_one",
        source: "gmail",
        integrationAccountId: "integration_supplier_mailbox",
        reference: "message_one",
        sourceRevision: 1,
        verificationId: "verification_supplier",
        verificationRevision: 1,
      },
      evaluationId: "evaluation_one",
      outcome: "same_issue",
      confidence: 0.98,
      expiresAt: Date.now() + 60_000,
      now: Date.now(),
    }),
  ).toMatchObject({ ok: true, value: { revision: 1 } });
  await expect(
    actor.readCaseContextCollectionsForCase({
      organisationId: organisationId.value,
      caseId: "case_delivery_one",
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      caseId: "case_delivery_one",
      caseContextCollections: [
        {
          caseContextCollectionId: "case_context_collection_delivery",
          revision: 1,
        },
      ],
    },
  });
  const decision = {
    organisationId: organisationId.value,
    actorId: "user_ec7e5384-b37e-590e-b920-f1de686e4ff7",
    caseContextCollectionId: "case_context_collection_delivery",
    body: {
      commandId: "reject_one",
      expectedRevision: 1,
      decision: { kind: "reject", relationshipId: "relationship_one" },
    },
  };
  await expect(
    actor.reviewCaseContextCollectionRelationship(decision),
  ).resolves.toEqual({
    ok: true,
    value: {
      caseContextCollectionId: "case_context_collection_delivery",
      revision: 2,
    },
  });
  await expect(
    actor.reviewCaseContextCollectionRelationship(decision),
  ).resolves.toEqual({
    ok: true,
    value: {
      caseContextCollectionId: "case_context_collection_delivery",
      revision: 2,
    },
  });
  await expect(
    actor.readCaseContextCollection({
      organisationId: organisationId.value,
      caseContextCollectionId: "case_context_collection_delivery",
    }),
  ).resolves.toMatchObject({
    ok: true,
    value: {
      revision: 2,
      relationships: [
        {
          kind: "rejected",
          decidedBy: "user_ec7e5384-b37e-590e-b920-f1de686e4ff7",
        },
      ],
    },
  });
  fixture.database.close();
}

async function caseContextCollectionEnvironment(
  organisationId: OrganisationId,
) {
  const db = createMigratedDatabase();
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'CaseContextCollection acceptance', 1)",
    )
    .bind(organisationId)
    .run();
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: 1,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  return platformEnv({
    DB: db,
    SATYR_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
  });
}
