import { describe, expect, it } from "vitest";

import {
  createCaseContextCollectionRelationshipSchema,
  decideCaseContextCollectionRelationship,
  listCaseContextCollectionIdsForCase,
  listMemberCaseContextCollectionIdsForCase,
  parseCaseContextCollectionReviewCommand,
  parseCaseContextCollectionSelection,
  readCaseContextCollection,
  recordCaseContextCollectionSuggestion,
  type CaseContextCollectionScope,
  type CaseContextCollectionSelection,
} from "../src/case-context-discovery/relationships";
import { parseOrganisationId } from "../src/ids";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

const NOW = 1_789_000_000_000;

describe("CaseContextCollection relationship metadata", suite);

function suite(): void {
  it(
    "keeps customer, supplier, merchant and issue boundaries despite a score of 1",
    rejectsForeignScope,
  );
  it(
    "confirms and detaches exact references with revisioned, replayable commands",
    reviewsReferences,
  );
  it(
    "converges canonical creation and rejects duplicate selections without partial writes",
    convergesCreation,
  );
  it(
    "rolls back a relationship when its command receipt cannot be saved",
    rollsBack,
  );
  it(
    "requires unexpired same-issue evidence and immutable scope for confirmation",
    checksConfirmation,
  );
  it(
    "resolves an CaseContextCollection without reviving it on a later suggestion",
    resolvesCaseContextCollection,
  );
  it("rejects invalid source selections at the boundary", parsesSelections);
  it("accepts only exact review command shapes", parsesReviewCommands);
  it(
    "bounds active members and releases capacity after rejection",
    boundsMembers,
  );
  it(
    "bounds the CaseContextCollections discoverable from one Case",
    boundsCaseContextCollections,
  );
}

function fixture() {
  const sqlite = emptySqliteFixture();
  const organisation = parseOrganisationId(
    "organisation_case_context_collection_relationships",
  );
  if (!organisation.ok) throw new Error("invalid organisation fixture");
  const sql = sqlStorage(sqlite.storage);
  const transaction = sqlite.storage.transactionSync.bind(sqlite.storage);
  createCaseContextCollectionRelationshipSchema(sql);
  const scope: CaseContextCollectionScope = {
    organisationId: organisation.value,
    merchantId: "merchant_cafe",
    party: { kind: "supplier", id: "supplier_flour" },
    issueKind: "delivery_delay",
    issueInstance: "shipment_842_1",
  };
  return {
    sqlite,
    sql,
    transaction,
    organisationId: organisation.value,
    scope,
  };
}
type Fixture = ReturnType<typeof fixture>;

function selection(index = 1): CaseContextCollectionSelection {
  return {
    caseId: `case_delivery_${index}`,
    source: "gmail",
    integrationAccountId: "integration_supplier_mailbox",
    reference: `message_${index}`,
    sourceRevision: 1,
    verificationId: "verification_supplier",
    verificationRevision: 1,
  };
}

function suggestion(
  f: Fixture,
  index = 1,
): Parameters<typeof recordCaseContextCollectionSuggestion>[0] {
  return {
    sql: f.sql,
    transaction: f.transaction,
    organisationId: f.organisationId,
    commandId: `suggest_${index}`,
    requestDigest: String(index).padStart(64, "0"),
    caseContextCollectionId: "case_context_collection_delivery",
    relationshipId: `relationship_${index}`,
    expectedRevision: index - 1,
    scope: f.scope,
    sourceScope: f.scope,
    anchorSelection: selection(0),
    selection: selection(index),
    evaluationId: `evaluation_${index}`,
    outcome: "same_issue",
    confidence: 1,
    expiresAt: NOW + 10_000,
    now: NOW,
  };
}

function decision(
  f: Fixture,
): Parameters<typeof decideCaseContextCollectionRelationship>[0] {
  return {
    sql: f.sql,
    transaction: f.transaction,
    organisationId: f.organisationId,
    commandId: "confirm_1",
    requestDigest: "a".repeat(64),
    caseContextCollectionId: "case_context_collection_delivery",
    expectedRevision: 1,
    actorId: "user_ac60d4c0-0104-5a11-95f6-f2c3f46948f9",
    now: NOW + 1,
    decision: {
      kind: "confirm",
      relationshipId: "relationship_1",
      sourceScope: f.scope,
    },
  };
}

function rejectsForeignScope(): void {
  const f = fixture();
  const otherOrganisation = parseOrganisationId("organisation_foreign");
  if (!otherOrganisation.ok) throw new Error("invalid fixture");
  const foreignScopes: CaseContextCollectionScope[] = [
    { ...f.scope, organisationId: otherOrganisation.value },
    { ...f.scope, merchantId: "merchant_other" },
    { ...f.scope, party: { kind: "customer", id: "supplier_flour" } },
    { ...f.scope, party: { kind: "supplier", id: "supplier_other" } },
    { ...f.scope, issueKind: "invoice_correction" },
    { ...f.scope, issueInstance: "shipment_842_2" },
  ];
  for (const sourceScope of foreignScopes) {
    expect(
      recordCaseContextCollectionSuggestion({ ...suggestion(f), sourceScope }),
    ).toEqual({
      ok: false,
      error: { code: "case_context_collection_relationship_invalid" },
    });
  }
  expect(
    readCaseContextCollection(
      f.sql,
      f.organisationId,
      "case_context_collection_delivery",
    ),
  ).toBeNull();
}

function reviewsReferences(): void {
  const f = fixture();
  expect(recordCaseContextCollectionSuggestion(suggestion(f))).toEqual({
    ok: true,
    value: {
      caseContextCollectionId: "case_context_collection_delivery",
      revision: 1,
    },
  });
  const confirmed = decideCaseContextCollectionRelationship(decision(f));
  expect(confirmed).toEqual({
    ok: true,
    value: {
      caseContextCollectionId: "case_context_collection_delivery",
      revision: 2,
    },
  });
  expect(decideCaseContextCollectionRelationship(decision(f))).toEqual(
    confirmed,
  );
  const attached = readCaseContextCollection(
    f.sql,
    f.organisationId,
    "case_context_collection_delivery",
  );
  expect(attached?.relationships).toEqual([
    {
      kind: "attached",
      relationshipId: "relationship_1",
      selection: selection(),
      evaluationId: "evaluation_1",
      outcome: "same_issue",
      confidence: 1,
      expiresAt: NOW + 10_000,
      acceptedAtRevision: 2,
      decidedBy: "user_ac60d4c0-0104-5a11-95f6-f2c3f46948f9",
    },
  ]);
  expect(
    decideCaseContextCollectionRelationship({
      ...decision(f),
      requestDigest: "b".repeat(64),
    }),
  ).toEqual({
    ok: false,
    error: { code: "case_context_collection_relationship_conflict" },
  });
  expect(
    decideCaseContextCollectionRelationship({
      ...decision(f),
      commandId: "detach_1",
      requestDigest: "c".repeat(64),
      expectedRevision: 2,
      decision: { kind: "detach", relationshipId: "relationship_1" },
    }),
  ).toMatchObject({ ok: true, value: { revision: 3 } });
  expect(
    readCaseContextCollection(
      f.sql,
      f.organisationId,
      "case_context_collection_delivery",
    )?.relationships[0],
  ).toMatchObject({ kind: "detached" });
  expect(
    listCaseContextCollectionIdsForCase(
      f.sql,
      f.organisationId,
      "case_delivery_1",
      NOW + 2,
    ),
  ).toEqual([]);
  expect(
    listMemberCaseContextCollectionIdsForCase(
      f.sql,
      f.organisationId,
      "case_delivery_1",
    ),
  ).toEqual([]);
}

function convergesCreation(): void {
  const f = fixture();
  const first = recordCaseContextCollectionSuggestion(suggestion(f));
  expect(recordCaseContextCollectionSuggestion(suggestion(f))).toEqual(first);
  expect(
    recordCaseContextCollectionSuggestion({
      ...suggestion(f, 2),
      caseContextCollectionId: "case_context_collection_duplicate",
      expectedRevision: 0,
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "case_context_collection_relationship_conflict" },
  });
  expect(
    recordCaseContextCollectionSuggestion({
      ...suggestion(f, 2),
      caseContextCollectionId: "case_context_collection_duplicate",
    }),
  ).toEqual({
    ok: true,
    value: {
      caseContextCollectionId: "case_context_collection_delivery",
      revision: 2,
    },
  });
  expect(
    recordCaseContextCollectionSuggestion({
      ...suggestion(f, 3),
      selection: selection(),
    }),
  ).toMatchObject({
    ok: false,
    error: { code: "case_context_collection_relationship_conflict" },
  });
  expect(
    readCaseContextCollection(
      f.sql,
      f.organisationId,
      "case_context_collection_delivery",
    )?.revision,
  ).toBe(2);
  expect(
    readCaseContextCollection(
      f.sql,
      f.organisationId,
      "case_context_collection_duplicate",
    ),
  ).toBeNull();
}

function rollsBack(): void {
  const f = fixture();
  f.sqlite.storage.failOnceWhen({
    queryIncludes: "INSERT INTO case_context_collection_command",
    bindingIndex: null,
    bindingValue: null,
  });
  expect(
    recordCaseContextCollectionSuggestion.bind(null, suggestion(f)),
  ).toThrow("injected_sql_failure");
  expect(
    readCaseContextCollection(
      f.sql,
      f.organisationId,
      "case_context_collection_delivery",
    ),
  ).toBeNull();
  expect(recordCaseContextCollectionSuggestion(suggestion(f))).toMatchObject({
    ok: true,
    value: { revision: 1 },
  });
}

function checksConfirmation(): void {
  const f = fixture();
  recordCaseContextCollectionSuggestion(suggestion(f));
  expect(
    decideCaseContextCollectionRelationship({
      ...decision(f),
      now: NOW + 10_000,
    }),
  ).toMatchObject({ ok: false });
  expect(
    decideCaseContextCollectionRelationship({
      ...decision(f),
      decision: {
        kind: "confirm",
        relationshipId: "relationship_1",
        sourceScope: {
          ...f.scope,
          party: { kind: "supplier", id: "supplier_other" },
        },
      },
    }),
  ).toMatchObject({ ok: false });
  expect(
    readCaseContextCollection(
      f.sql,
      f.organisationId,
      "case_context_collection_delivery",
    )?.revision,
  ).toBe(1);
  recordCaseContextCollectionSuggestion({
    ...suggestion(f, 2),
    outcome: "related_reference",
  });
  expect(
    decideCaseContextCollectionRelationship({
      ...decision(f),
      expectedRevision: 2,
      decision: {
        kind: "confirm",
        relationshipId: "relationship_2",
        sourceScope: f.scope,
      },
    }),
  ).toMatchObject({ ok: false });
  expect(
    decideCaseContextCollectionRelationship({
      ...decision(f),
      expectedRevision: 2,
      decision: { kind: "reject", relationshipId: "relationship_2" },
    }),
  ).toMatchObject({ ok: true });
  expect(
    listCaseContextCollectionIdsForCase(
      f.sql,
      f.organisationId,
      "case_delivery_2",
      NOW + 2,
    ),
  ).toEqual([]);
  expect(
    listMemberCaseContextCollectionIdsForCase(
      f.sql,
      f.organisationId,
      "case_delivery_2",
    ),
  ).toEqual([]);
}

function resolvesCaseContextCollection(): void {
  const f = fixture();
  recordCaseContextCollectionSuggestion(suggestion(f));
  expect(
    decideCaseContextCollectionRelationship({
      ...decision(f),
      decision: { kind: "resolve" },
    }),
  ).toMatchObject({ ok: true });
  expect(
    recordCaseContextCollectionSuggestion({
      ...suggestion(f, 2),
      expectedRevision: 2,
    }),
  ).toMatchObject({ ok: false });
  expect(
    readCaseContextCollection(
      f.sql,
      f.organisationId,
      "case_context_collection_delivery",
    ),
  ).toMatchObject({
    revision: 2,
    lifecycle: "resolved",
  });
}

function parsesSelections(): void {
  expect(parseCaseContextCollectionSelection(selection())).toEqual(selection());
  expect(
    parseCaseContextCollectionSelection({
      ...selection(),
      evidence: "must not be stored",
    }),
  ).toBeNull();
  expect(
    parseCaseContextCollectionSelection({
      ...selection(),
      verificationRevision: 0,
    }),
  ).toBeNull();
  expect(
    parseCaseContextCollectionSelection({
      ...selection(),
      source: "inferred_sender",
    }),
  ).toBeNull();
}

function parsesReviewCommands(): void {
  const command = {
    commandId: "confirm_relationship_1",
    expectedRevision: 1,
    decision: { kind: "confirm", relationshipId: "relationship_1" },
  };
  expect(parseCaseContextCollectionReviewCommand(command)).toEqual(command);
  expect(
    parseCaseContextCollectionReviewCommand({
      ...command,
      decision: { ...command.decision, sourceScope: "untrusted" },
    }),
  ).toBeNull();
  expect(
    parseCaseContextCollectionReviewCommand({
      ...command,
      decision: { kind: "resolve", relationshipId: "relationship_1" },
    }),
  ).toBeNull();
  expect(
    parseCaseContextCollectionReviewCommand({
      ...command,
      expectedRevision: 0,
    }),
  ).toBeNull();
}

function boundsMembers(): void {
  const f = fixture();
  for (let index = 1; index <= 20; index += 1) {
    expect(recordCaseContextCollectionSuggestion(suggestion(f, index)).ok).toBe(
      true,
    );
  }
  expect(
    recordCaseContextCollectionSuggestion(suggestion(f, 21)),
  ).toMatchObject({
    ok: false,
    error: { code: "case_context_collection_capacity_exceeded" },
  });
  expect(
    readCaseContextCollection(
      f.sql,
      f.organisationId,
      "case_context_collection_delivery",
    )?.revision,
  ).toBe(20);
  expect(
    decideCaseContextCollectionRelationship({
      ...decision(f),
      commandId: "reject_capacity_member",
      requestDigest: "e".repeat(64),
      expectedRevision: 20,
      decision: { kind: "reject", relationshipId: "relationship_1" },
    }),
  ).toMatchObject({ ok: true, value: { revision: 21 } });
  expect(
    recordCaseContextCollectionSuggestion({
      ...suggestion(f, 21),
      expectedRevision: 21,
    }),
  ).toMatchObject({ ok: true, value: { revision: 22 } });
}

function boundsCaseContextCollections(): void {
  const f = fixture();
  for (let index = 1; index <= 20; index += 1) {
    const scope = {
      ...f.scope,
      issueInstance: `shipment_shared_${index}`,
    };
    expect(
      recordCaseContextCollectionSuggestion({
        ...suggestion(f, index),
        caseContextCollectionId: `case_context_collection_shared_${index}`,
        expectedRevision: 0,
        scope,
        sourceScope: scope,
        selection: { ...selection(index), caseId: "case_shared" },
      }).ok,
    ).toBe(true);
  }
  const overflowScope = {
    ...f.scope,
    issueInstance: "shipment_shared_21",
  };
  expect(
    recordCaseContextCollectionSuggestion({
      ...suggestion(f, 21),
      caseContextCollectionId: "case_context_collection_shared_21",
      expectedRevision: 0,
      scope: overflowScope,
      sourceScope: overflowScope,
      selection: { ...selection(21), caseId: "case_shared" },
    }),
  ).toEqual({
    ok: false,
    error: { code: "case_context_collection_capacity_exceeded" },
  });
  expect(
    listCaseContextCollectionIdsForCase(
      f.sql,
      f.organisationId,
      "case_shared",
      NOW,
    ),
  ).toHaveLength(20);
}
