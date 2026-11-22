import { describe, expect, it, vi } from "vitest";

import {
  createCaseContextDiscoveryEvaluationSchema,
  publishCaseContextDiscoveryPolicy,
} from "../src/case-context-discovery/evaluation-store";
import { CASE_CONTEXT_DISCOVERY_JEV_MODEL } from "../src/case-context-discovery/jev";
import { evaluateOperationalCaseContextDiscovery } from "../src/case-context-discovery/operational-evaluation";
import { FlowLabel } from "@purin-labs/authority/policy/information-flow/labels";
import { buildAgentMailboxAuthority } from "@purin-labs/authority/request-authority/index";
import { parseCaseContextDiscoveryPolicy } from "../src/case-context-discovery/policy";
import {
  createCaseContextCollectionRelationshipSchema,
  decideCaseContextCollectionRelationship,
  listCaseContextCollectionIdsForCase,
  listMemberCaseContextCollectionIdsForCase,
  readCaseContextCollection,
  recordCaseContextCollectionSuggestion,
  type CaseContextCollectionSelection,
} from "../src/case-context-discovery/relationships";
import { parseOrganisationId, parseIntegrationAccountId } from "@purin-labs/kernel/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";
import { createTypeSafeConnectionSchema } from "../src/integrations/typesafe/connection";
import type { SchemaTransaction } from "@purin-labs/actor-runtime/actors/schema-migrations";
import { createMigratedDatabase } from "./sqlite-d1";
import { ensureInitialOrganisationPlacement } from "@purin-labs/tenancy/data/shared-rows/placement-row";
import { requireOrganisationExecutionScope } from "./organisation-execution-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";

const NOW = 1_789_000_000_000;
const KEY = "apikey_operational-test-key-never-a-real-credential";

describe("operational CaseContextCollection discovery", suite);

function suite(): void {
  it.each([200, 401])(
    "rejects stale credentials before dispatch and fences rotation during HTTP %s",
    fencesConnectionRotation,
  );
  it(
    "rechecks connection revision after preparing recovered relationships",
    fencesPendingRecovery,
  );
  it(
    "persists only bounded metadata for positive verified candidates",
    recordsMetadata,
  );
  it("keeps shadow evaluations out of the relationship store", keepsShadow);
  it("rolls back settlement when the metadata batch cannot commit", rollsBack);
  it(
    "merges a later Case through a confirmed CaseContextCollection member",
    growsCaseContextCollection,
  );
  it(
    "recovers a metadata commit without repeating the JEV call",
    recoversMetadataCommit,
  );
}

async function fencesConnectionRotation(status: number): Promise<void> {
  const fixture = await caseContextCollectionFixture("metadata_only");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(rotateDuringEvaluation.bind(null, fixture, status));
  expect(await evaluate(fixture, fetcher)).toMatchObject({
    ok: true,
    value: { receipt: { kind: "stale" }, decisions: [], recorded: [] },
  });
  expect(
    fixture.sql.exec("SELECT * FROM case_context_collection").toArray(),
  ).toEqual([]);
  expect(
    fixture.sql
      .exec(
        "SELECT settlement_state, estimated_cost_microusd FROM typesafe_evaluation",
      )
      .toArray(),
  ).toEqual([
    {
      settlement_state: "settled",
      estimated_cost_microusd: status === 200 ? 5 : null,
    },
  ]);
  expect(await evaluate(fixture, fetcher)).toMatchObject({
    ok: true,
    value: { receipt: { kind: "stale" } },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fixture.sql.exec("DELETE FROM typesafe_evaluation");
  expect(await evaluate(fixture, fetcher)).toEqual({
    ok: false,
    error: { code: "case_context_collection_inactive" },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    fixture.sql
      .exec("SELECT revision FROM case_context_discovery_policy")
      .toArray(),
  ).toEqual([{ revision: 1 }]);
  fixture.sqlite.database.close();
}

async function rotateDuringEvaluation(
  fixture: Awaited<ReturnType<typeof caseContextCollectionFixture>>,
  status: number,
): Promise<Response> {
  fixture.sql.exec("UPDATE typesafe_connection SET revision = revision + 1");
  if (status === 200) return jevResponse();
  return new Response(null, { status });
}

async function fencesPendingRecovery(): Promise<void> {
  const fixture = await caseContextCollectionFixture("metadata_only");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jevResponse());
  fixture.sqlite.storage.failOnceWhen({
    queryIncludes: "INSERT INTO case_context_collection_command",
    bindingIndex: null,
    bindingValue: null,
  });
  await expect(evaluate(fixture, fetcher)).rejects.toThrow(
    "injected_sql_failure",
  );
  expect(
    fixture.sql
      .exec("SELECT evaluation_id FROM case_context_discovery_pending")
      .toArray(),
  ).toHaveLength(1);
  const rotating = new RotatingRecoveryTransaction(
    fixture.sql,
    fixture.transaction,
  );
  const recovery = await evaluate(
    { ...fixture, transaction: rotating.run.bind(rotating) },
    fetcher,
  );
  expect(recovery).toMatchObject({
    ok: true,
    value: { receipt: { kind: "stale" }, decisions: [], recorded: [] },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    fixture.sql.exec("SELECT * FROM case_context_collection").toArray(),
  ).toEqual([]);
  expect(
    fixture.sql.exec("SELECT * FROM case_context_discovery_pending").toArray(),
  ).toEqual([]);
  fixture.sqlite.database.close();
}

class RotatingRecoveryTransaction {
  private calls = 0;

  constructor(
    private readonly sql: SqlStorage,
    private readonly base: SchemaTransaction,
  ) {}

  run<Value>(operation: () => Value): Value {
    this.calls += 1;
    if (this.calls === 2)
      this.sql.exec("UPDATE typesafe_connection SET revision = revision + 1");
    return this.base(operation);
  }
}

async function recordsMetadata(): Promise<void> {
  const fixture = await caseContextCollectionFixture("metadata_only");
  const unrelated = recordCaseContextCollectionSuggestion({
    sql: fixture.sql,
    transaction: fixture.transaction,
    organisationId: fixture.organisationId,
    commandId: "seed_unrelated",
    requestDigest: "b".repeat(64),
    caseContextCollectionId: "case_context_collection_unrelated",
    relationshipId: "relationship_unrelated",
    expectedRevision: 0,
    scope: {
      organisationId: fixture.organisationId,
      merchantId: "merchant_cafe",
      party: { kind: "supplier", id: "supplier_flour" },
      issueKind: "email_issue",
      issueInstance: "different_issue",
    },
    sourceScope: {
      organisationId: fixture.organisationId,
      merchantId: "merchant_cafe",
      party: { kind: "supplier", id: "supplier_flour" },
      issueKind: "email_issue",
      issueInstance: "different_issue",
    },
    anchorSelection: selection("other_anchor"),
    selection: selection("separate"),
    evaluationId: "seed_evaluation",
    outcome: "same_issue",
    confidence: 1,
    expiresAt: NOW + 10_000,
    now: NOW,
  });
  expect(unrelated.ok).toBe(true);
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jevResponse());
  const result = await evaluate(fixture, fetcher);
  expect(result).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "evaluated" },
      recorded: [{ revision: 1 }],
    },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const caseContextCollectionIds = listCaseContextCollectionIdsForCase(
    fixture.sql,
    fixture.organisationId,
    "case_anchor",
    NOW,
  );
  expect(caseContextCollectionIds).toHaveLength(1);
  expect(
    listCaseContextCollectionIdsForCase(
      fixture.sql,
      fixture.organisationId,
      "case_related",
      NOW,
    ),
  ).toEqual(caseContextCollectionIds);
  expect(
    listCaseContextCollectionIdsForCase(
      fixture.sql,
      fixture.organisationId,
      "case_separate",
      NOW,
    ),
  ).toEqual(["case_context_collection_unrelated"]);
  const caseContextCollection = readCaseContextCollection(
    fixture.sql,
    fixture.organisationId,
    caseContextCollectionIds[0] ?? "missing",
  );
  expect(caseContextCollection).toMatchObject({
    anchorSelection: selection("anchor"),
    revision: 1,
    relationships: [
      {
        kind: "suggested",
        selection: selection("related"),
        outcome: "same_issue",
      },
    ],
  });
  const replay = await evaluate(fixture, fetcher);
  expect(replay).toMatchObject({
    ok: true,
    value: { receipt: { kind: "evaluated" }, recorded: [] },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const persisted = JSON.stringify(
    fixture.sqlite.database
      .prepare(
        "SELECT * FROM typesafe_evaluation, case_context_collection, case_context_collection_relationship",
      )
      .all(),
  );
  expect(persisted).not.toContain("anchor private message");
  expect(persisted).not.toContain("related private message");
  fixture.sqlite.database.close();
}

async function keepsShadow(): Promise<void> {
  const fixture = await caseContextCollectionFixture("shadow");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jevResponse());
  expect(await evaluate(fixture, fetcher)).toMatchObject({
    ok: true,
    value: { receipt: { kind: "evaluated" }, recorded: [] },
  });
  expect(
    fixture.sql.exec("SELECT * FROM case_context_collection").toArray(),
  ).toEqual([]);
  fixture.sqlite.database.close();
}

async function rollsBack(): Promise<void> {
  const fixture = await caseContextCollectionFixture("metadata_only");
  for (let index = 0; index < 19; index += 1) {
    const seeded = recordCaseContextCollectionSuggestion({
      sql: fixture.sql,
      transaction: fixture.transaction,
      organisationId: fixture.organisationId,
      commandId: `seed_${index}`,
      requestDigest: index.toString(16).padStart(64, "0"),
      caseContextCollectionId: "case_context_collection_at_capacity",
      relationshipId: `seed_relationship_${index}`,
      expectedRevision: index,
      scope: operationalScope(fixture.organisationId),
      sourceScope: operationalScope(fixture.organisationId),
      anchorSelection: selection("anchor"),
      selection: selection(`seed_${index}`),
      evaluationId: `seed_evaluation_${index}`,
      outcome: "same_issue",
      confidence: 1,
      expiresAt: NOW + 10_000,
      now: NOW,
    });
    expect(seeded.ok).toBe(true);
  }
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
      answers: {
        candidate_0: { type: "choice", choice: "same_issue" },
        candidate_1: { type: "choice", choice: "same_issue" },
      },
      usage: { input_tokens: 100, output_tokens: 20, cost: 0.00002 },
    }),
  );
  expect(await evaluate(fixture, fetcher)).toEqual({
    ok: false,
    error: { code: "case_context_collection_capacity_exceeded" },
  });
  expect(
    readCaseContextCollection(
      fixture.sql,
      fixture.organisationId,
      "case_context_collection_at_capacity",
    )?.revision,
  ).toBe(19);
  expect(
    listCaseContextCollectionIdsForCase(
      fixture.sql,
      fixture.organisationId,
      "case_related",
      NOW,
    ),
  ).toEqual([]);
  expect(
    fixture.sql
      .exec<{ state: string }>("SELECT state FROM typesafe_evaluation")
      .toArray(),
  ).toEqual([{ state: "evaluated" }]);
  fixture.sqlite.database.close();
}

async function growsCaseContextCollection(): Promise<void> {
  const fixture = await caseContextCollectionFixture("metadata_only");
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(jevResponse())
    .mockResolvedValueOnce(jevSameIssueResponse());
  const first = await evaluate(fixture, fetcher);
  expect(first.ok).toBe(true);
  const caseContextCollectionId = listCaseContextCollectionIdsForCase(
    fixture.sql,
    fixture.organisationId,
    "case_anchor",
    NOW,
  )[0];
  if (caseContextCollectionId === undefined)
    throw new Error("missing CaseContextCollection fixture");
  const caseContextCollection = readCaseContextCollection(
    fixture.sql,
    fixture.organisationId,
    caseContextCollectionId,
  );
  const relationshipId =
    caseContextCollection?.relationships[0]?.relationshipId;
  if (relationshipId === undefined) throw new Error("missing relationship");
  expect(
    decideCaseContextCollectionRelationship({
      sql: fixture.sql,
      transaction: fixture.transaction,
      organisationId: fixture.organisationId,
      commandId: "confirm_operational_member",
      requestDigest: "c".repeat(64),
      caseContextCollectionId,
      expectedRevision: 1,
      actorId: "user_ac60d4c0-0104-5a11-95f6-f2c3f46948f9",
      now: NOW + 1,
      decision: {
        kind: "confirm",
        relationshipId,
        sourceScope: operationalScope(fixture.organisationId),
      },
    }),
  ).toMatchObject({ ok: true, value: { revision: 2 } });

  const followupScope = {
    ...operationalScope(fixture.organisationId),
    issueInstance: "case_followup",
  };
  const followup = await evaluateOperationalCaseContextDiscovery({
    sourceAccess: await sourceAccess(fixture.organisationId),
    sql: fixture.sql,
    transaction: fixture.transaction,
    credential: { provider: "typesafe" as const, apiKey: KEY, authority: { kind: "organisation_byo" as const, connectionRevision: 1 } },
    scope: fixture.scope,
    request: {
      scope: followupScope,
      anchor: {
        selection: selection("followup"),
        evidence: "later private message",
      },
      candidates: [
        {
          selection: selection("related"),
          evidence: "confirmed member private message",
        },
      ],
    },
    signal: new AbortController().signal,
    fetcher,
    now: fixedNow,
  });
  expect(followup).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "evaluated" },
      recorded: [{ caseContextCollectionId, revision: 3 }],
    },
  });
  const grown = readCaseContextCollection(
    fixture.sql,
    fixture.organisationId,
    caseContextCollectionId,
  );
  expect(grown).toMatchObject({
    anchorSelection: selection("anchor"),
    revision: 3,
  });
  expect(grown?.relationships).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "attached",
        selection: selection("related"),
      }),
      expect.objectContaining({
        kind: "suggested",
        selection: selection("followup"),
      }),
    ]),
  );
  expect(
    listMemberCaseContextCollectionIdsForCase(
      fixture.sql,
      fixture.organisationId,
      "case_followup",
    ),
  ).toEqual([]);
  fixture.sqlite.database.close();
}

async function recoversMetadataCommit(): Promise<void> {
  const fixture = await caseContextCollectionFixture("metadata_only");
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jevResponse());
  fixture.sqlite.storage.failOnceWhen({
    queryIncludes: "INSERT INTO case_context_collection_command",
    bindingIndex: null,
    bindingValue: null,
  });
  await expect(evaluate(fixture, fetcher)).rejects.toThrow(
    "injected_sql_failure",
  );
  expect(
    fixture.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM case_context_discovery_pending",
      )
      .toArray()[0]?.count,
  ).toBe(1);
  expect(await evaluate(fixture, fetcher)).toMatchObject({
    ok: true,
    value: {
      receipt: { kind: "evaluated" },
      recorded: [{ revision: 1 }],
    },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    fixture.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM case_context_discovery_pending",
      )
      .toArray()[0]?.count,
  ).toBe(0);
  fixture.sqlite.database.close();
}

async function caseContextCollectionFixture(mode: "shadow" | "metadata_only") {
  const sqlite = emptySqliteFixture();
  const sql = sqlStorage(sqlite.storage);
  const organisation = parseOrganisationId(
    "organisation_operational_case_context_discovery",
  );
  if (!organisation.ok) throw new Error("invalid fixture organisation");
  const db = createMigratedDatabase();
  await db
    .prepare(
      "INSERT INTO organisation (organisation_id, name, created_at) VALUES (?, 'CaseContextCollection', 1)",
    )
    .bind(organisation.value)
    .run();
  const placement = await ensureInitialOrganisationPlacement({
    db,
    organisationId: organisation.value,
    environment: "development",
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: NOW,
  });
  if (!placement.ok) throw new Error(placement.error.code);
  const scope = await requireOrganisationExecutionScope(
    {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    organisation.value,
  );
  sql.exec(
    "CREATE TABLE state_object_policy_export_barrier (singleton INTEGER PRIMARY KEY)",
  );
  const transaction = sqlite.storage.transactionSync.bind(sqlite.storage);
  createCaseContextDiscoveryEvaluationSchema(sql);
  createTypeSafeConnectionSchema(sql);
  sql.exec(
    `INSERT INTO typesafe_connection (organisation_id, revision, provider, vault_handle, tested_at, updated_by)
    VALUES (?, 1, 'typesafe', ?, ?, 'fixture')`,
    organisation.value,
    `vault:${organisation.value}:typesafe:fixture`,
    NOW,
  );
  createCaseContextCollectionRelationshipSchema(sql);
  const policy = parseCaseContextDiscoveryPolicy({
    mode,
    route: {
      provider: "typesafe",
      connectionRevision: 1,
      funding: "organisation_byo",
      credentialRef: "organisation_typesafe",
    },
    sources: [{ source: "gmail", integrationAccountId: "gmail_account" }],
    limits: {
      maxEvaluations: 10,
      maxConcurrentEvaluations: 10,
      maxInputBytes: 100_000,
      maxInputTokens: 10 * 65_536,
      maxWallMs: 40_000,
      maxCostMicrousd: 40_000,
      reservationMicrousd: 10_000,
      requestTimeoutMs: 10_000,
    },
  });
  if (!policy.ok) throw new Error("invalid fixture policy");
  const published = publishCaseContextDiscoveryPolicy({
    sql,
    transaction,
    organisationId: organisation.value,
    commandId: "configure_operational",
    requestDigest: "a".repeat(64),
    expectedRevision: 0,
    policy: policy.value,
    actorId: "user_ec7e5384-b37e-590e-b920-f1de686e4ff7",
    now: NOW,
  });
  if (!published.ok) throw new Error("fixture publication failed");
  return {
    sqlite,
    sql,
    transaction,
    organisationId: organisation.value,
    scope,
  };
}

async function sourceAccess(
  organisationId: Awaited<
    ReturnType<typeof caseContextCollectionFixture>
  >["organisationId"],
) {
  const account = parseIntegrationAccountId("gmail_account");
  if (!account.ok) throw new Error("invalid fixture account");
  const authority = buildAgentMailboxAuthority({
    organisationId,
    integrationAccountId: account.value,
    mailboxBindingId: "mailbox_fixture",
    bindingRevision: 1,
    mailboxPolicyVersion: 1,
  }).requestAuthority;
  const label = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId },
      readers: [
        {
          kind: "agent_mailbox",
          integrationAccountId: "gmail_account",
          mailboxBindingId: "mailbox_fixture",
          bindingRevision: 1,
        },
      ],
    },
  ]);
  if (!label.ok) throw new Error(label.error.code);
  return { authority, label: label.value };
}

async function evaluate(
  fixture: Awaited<ReturnType<typeof caseContextCollectionFixture>>,
  fetcher: typeof fetch,
) {
  return evaluateOperationalCaseContextDiscovery({
    sourceAccess: await sourceAccess(fixture.organisationId),
    sql: fixture.sql,
    transaction: fixture.transaction,
    credential: { provider: "typesafe" as const, apiKey: KEY, authority: { kind: "organisation_byo" as const, connectionRevision: 1 } },
    scope: fixture.scope,
    request: {
      scope: operationalScope(fixture.organisationId),
      anchor: {
        selection: selection("anchor"),
        evidence: "anchor private message",
      },
      candidates: [
        {
          selection: selection("related"),
          evidence: "related private message",
        },
        {
          selection: selection("separate"),
          evidence: "separate private message",
        },
      ],
    },
    signal: new AbortController().signal,
    fetcher,
    now: fixedNow,
  });
}

function operationalScope(
  organisationId: Awaited<
    ReturnType<typeof caseContextCollectionFixture>
  >["organisationId"],
) {
  return {
    organisationId,
    merchantId: "merchant_cafe",
    party: { kind: "supplier" as const, id: "supplier_flour" },
    issueKind: "email_issue",
    issueInstance: "case_anchor",
  };
}

function selection(name: string): CaseContextCollectionSelection {
  return {
    caseId: `case_${name}`,
    source: "gmail",
    integrationAccountId: "gmail_account",
    reference: `message_${name}`,
    sourceRevision: 1,
    verificationId: "verification_supplier",
    verificationRevision: 1,
  };
}

function jevResponse(): Response {
  return Response.json({
    model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
    answers: {
      candidate_0: {
        type: "choice",
        choice: "same_issue",
        confidence: 0.95,
      },
      candidate_1: {
        type: "choice",
        choice: "different_issue",
        confidence: 0.99,
      },
    },
    usage: { input_tokens: 100, output_tokens: 20, cost: 0.00002 },
  });
}

function jevSameIssueResponse(): Response {
  return Response.json({
    model: CASE_CONTEXT_DISCOVERY_JEV_MODEL,
    answers: {
      candidate_0: {
        type: "choice",
        choice: "same_issue",
        confidence: 0.95,
      },
    },
    usage: { input_tokens: 100, output_tokens: 20, cost: 0.00002 },
  });
}

function fixedNow(): number {
  return NOW;
}
