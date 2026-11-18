import { singleDatabaseSchema } from "../scripts/single-database-schema.mjs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type {
  CaseContextSource,
  CaseContextReplayAuthority,
  CaseContextSourceRef,
  CaseContextSourceReader,
  CaseContextSourceReaderError,
  ContextProjectionCommand,
  ContextProjectionApplyResult,
  ContextVisibility,
} from "../src/context/projection";
import {
  applyContextProjectionCommand,
  createContextProjectionCommand,
  handleContextProjectionQueueMessage,
  parseContextProjectionCommand,
  searchContextProjections,
} from "../src/context/projection";
import { type OrganisationId } from "../src/ids";
import { serializeCanonical } from "../src/policy/information-flow/digest";
import { SqliteD1Database } from "./sqlite-d1";
import { requireCaseId, requireOrganisationId } from "./test-ids";

const INVALID_INDEPENDENT_REPLAY_AUTHORITY: CaseContextReplayAuthority = {
  kind: "partition_independent",
  // @ts-expect-error Partition-independent replay cannot carry a partition digest.
  authorityPartitionDigest: "a".repeat(64),
};
// @ts-expect-error Partition-bound replay always requires its authority digest.
const INVALID_PARTITION_REPLAY_AUTHORITY: CaseContextReplayAuthority = {
  kind: "authority_partition",
};
void INVALID_INDEPENDENT_REPLAY_AUTHORITY;
void INVALID_PARTITION_REPLAY_AUTHORITY;

const migration = singleDatabaseSchema();

class FixtureSourceReader implements CaseContextSourceReader {
  private readonly sources = new Map<string, CaseContextSource>();
  private failNextRead = false;

  add(source: CaseContextSource): void {
    this.sources.set(
      sourceKey(source.organisationId, source.source, source.sourceRevision),
      source,
    );
  }

  failOnce(): void {
    this.failNextRead = true;
  }

  async read(input: {
    readonly organisationId: OrganisationId;
    readonly source: CaseContextSourceRef;
    readonly sourceRevision: number;
  }): Promise<
    | { readonly ok: true; readonly value: CaseContextSource }
    | { readonly ok: false; readonly error: CaseContextSourceReaderError }
  > {
    if (this.failNextRead) {
      this.failNextRead = false;
      return { ok: false, error: { code: "storage_failure" } };
    }
    const source = this.sources.get(
      sourceKey(input.organisationId, input.source, input.sourceRevision),
    );
    return source === undefined
      ? { ok: false, error: { code: "source_missing" } }
      : { ok: true, value: source };
  }
}

type Fixture = {
  readonly db: SqliteD1Database;
  readonly reader: FixtureSourceReader;
};

function fixture(): Fixture {
  const database = new DatabaseSync(":memory:");
  database.exec(migration);
  return {
    db: new SqliteD1Database(database),
    reader: new FixtureSourceReader(),
  };
}

function source(input: {
  readonly organisationId: string;
  readonly caseId: string;
  readonly entryId: string;
  readonly revision: number;
  readonly digest?: string;
  readonly replayAuthority?: CaseContextReplayAuthority;
  readonly visibility: ContextVisibility;
  readonly text: string;
  readonly observedAt: number;
}): CaseContextSource {
  const content = { kind: "text" as const, text: input.text };
  return {
    organisationId: requireOrganisationId(input.organisationId),
    source: {
      kind: "case_entry",
      caseId: requireCaseId(input.caseId),
      entryId: input.entryId,
    },
    sourceRevision: input.revision,
    replayAuthority: input.replayAuthority ?? { kind: "partition_independent" },
    contentDigest: input.digest ?? canonicalDigest(content),
    content,
    visibility: input.visibility,
    inputLabel: serializedOrganisationLabel(
      input.organisationId,
      input.visibility,
    ),
    observedAt: input.observedAt,
  };
}

function serializedOrganisationLabel(
  organisationId: string,
  visibility: ContextVisibility,
) {
  const policies = [
    {
      owner: { kind: "organisation" as const, organisationId },
      readers: [visibility],
    },
  ];
  return {
    policies,
    digest: createHash("sha256")
      .update(serializeCanonical(policies))
      .digest("hex"),
  };
}

function canonicalDigest(content: {
  readonly kind: "text";
  readonly text: string;
}): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function command(input: {
  readonly organisationId: string;
  readonly caseId: string;
  readonly entryId: string;
  readonly revision: number;
}): ContextProjectionCommand {
  return createContextProjectionCommand({
    organisationId: requireOrganisationId(input.organisationId),
    source: {
      kind: "case_entry",
      caseId: requireCaseId(input.caseId),
      entryId: input.entryId,
    },
    sourceRevision: input.revision,
  });
}

function sourceKey(
  organisationId: OrganisationId,
  sourceRef: CaseContextSourceRef,
  revision: number,
): string {
  return `${organisationId}:${sourceRef.caseId}:${sourceRef.entryId}:${revision}`;
}

async function apply(
  fixtureValue: Fixture,
  projectionCommand: ContextProjectionCommand,
): Promise<ContextProjectionApplyResult> {
  const result = await applyContextProjectionCommand({
    db: fixtureValue.db,
    sourceReader: fixtureValue.reader,
    command: projectionCommand,
    now: 1_000,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}

describe("Plan 25 context projection", () => {
  it("accepts only the canonical ref command shape", () => {
    const parsed = parseContextProjectionCommand(
      command({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_a",
        revision: 1,
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(
      parseContextProjectionCommand({
        ...command({
          organisationId: "organisation_a",
          caseId: "case_a",
          entryId: "entry_a",
          revision: 1,
        }),
        contentDigest: "legacy_claim",
      }),
    ).toEqual({
      ok: false,
      error: { code: "invalid_field", field: "contentDigest" },
    });
  });

  it("filters by organisation and exact visibility before deterministic ranking", async () => {
    const value = fixture();
    const shared: ContextVisibility = {
      kind: "conversation",
      integrationAccountId: "acct_a",
      conversationId: "channel_a",
    };
    const other: ContextVisibility = {
      kind: "conversation",
      integrationAccountId: "acct_a",
      conversationId: "channel_b",
    };
    const records = [
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_old",
        revision: 1,
        visibility: shared,
        text: "Order status for Monday",
        observedAt: 100,
      }),
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_new",
        revision: 1,
        visibility: shared,
        text: "Order status for Monday and Tuesday",
        observedAt: 200,
      }),
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_hidden",
        revision: 1,
        visibility: other,
        text: "Order status for Monday",
        observedAt: 300,
      }),
      source({
        organisationId: "organisation_b",
        caseId: "case_a",
        entryId: "entry_other",
        revision: 1,
        visibility: shared,
        text: "Order status for Monday",
        observedAt: 400,
      }),
    ];
    for (const record of records) value.reader.add(record);
    for (const record of records) {
      await apply(
        value,
        command({
          organisationId: record.organisationId,
          caseId: record.source.caseId,
          entryId: record.source.entryId,
          revision: record.sourceRevision,
        }),
      );
    }

    const results = await searchContextProjections(value.db, {
      organisationId: requireOrganisationId("organisation_a"),
      visibility: [shared],
      sourceKind: "all",
      authorityPartitionDigest: "a".repeat(64),
      query: "order status monday",
      limit: 10,
    });
    expect(results.map((result) => result.projection.source)).toEqual([
      { kind: "case_entry", caseId: "case_a", entryId: "entry_new" },
      { kind: "case_entry", caseId: "case_a", entryId: "entry_old" },
    ]);
  });

  it("filters case rows by replay authority and excludes invalid provenance", async () => {
    const value = fixture();
    const visibility: ContextVisibility = { kind: "case", caseId: "case_a" };
    const partition = "a".repeat(64);
    const records = [
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_independent",
        revision: 1,
        replayAuthority: { kind: "partition_independent" },
        visibility,
        text: "independent",
        observedAt: 100,
      }),
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_same_partition",
        revision: 1,
        replayAuthority: {
          kind: "authority_partition",
          authorityPartitionDigest: partition,
        },
        visibility,
        text: "same partition",
        observedAt: 90,
      }),
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_other_partition",
        revision: 1,
        replayAuthority: {
          kind: "authority_partition",
          authorityPartitionDigest: "b".repeat(64),
        },
        visibility,
        text: "other partition",
        observedAt: 80,
      }),
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_legacy",
        revision: 1,
        visibility,
        text: "legacy provenance",
        observedAt: 70,
      }),
    ];
    for (const record of records) {
      value.reader.add(record);
      await apply(
        value,
        command({
          organisationId: record.organisationId,
          caseId: record.source.caseId,
          entryId: record.source.entryId,
          revision: record.sourceRevision,
        }),
      );
    }
    await value.db
      .prepare(
        `UPDATE context_projection
          SET provenance_json = ?
        WHERE organisation_id = ? AND source_kind = 'case_entry' AND source_key = ?`,
      )
      .bind(
        JSON.stringify({
          kind: "case_entry",
          replayAuthority: { kind: "partition_independent" },
          unexpected: true,
        }),
        "organisation_a",
        "case_a\u0000entry_legacy",
      )
      .run();

    const results = await searchContextProjections(value.db, {
      organisationId: requireOrganisationId("organisation_a"),
      visibility: [visibility],
      sourceKind: "all",
      authorityPartitionDigest: partition,
      query: "",
      limit: 10,
    });
    expect(results.map((result) => result.projection.source)).toEqual([
      { kind: "case_entry", caseId: "case_a", entryId: "entry_independent" },
      { kind: "case_entry", caseId: "case_a", entryId: "entry_same_partition" },
    ]);
  });

  it("repairs legacy case provenance on same-revision redelivery", async () => {
    const value = fixture();
    const visibility: ContextVisibility = { kind: "case", caseId: "case_a" };
    const replayAuthority: CaseContextReplayAuthority = {
      kind: "authority_partition",
      authorityPartitionDigest: "a".repeat(64),
    };
    const record = source({
      organisationId: "organisation_a",
      caseId: "case_a",
      entryId: "entry_repair",
      revision: 1,
      replayAuthority,
      visibility,
      text: "repair me",
      observedAt: 10,
    });
    value.reader.add(record);
    const projectionCommand = command({
      organisationId: record.organisationId,
      caseId: record.source.caseId,
      entryId: record.source.entryId,
      revision: record.sourceRevision,
    });
    expect((await apply(value, projectionCommand)).kind).toBe("applied");
    await value.db
      .prepare(
        `UPDATE context_projection
          SET provenance_json = NULL
        WHERE organisation_id = ? AND source_kind = 'case_entry' AND source_key = ?`,
      )
      .bind("organisation_a", "case_a\u0000entry_repair")
      .run();

    expect(await apply(value, projectionCommand)).toMatchObject({
      kind: "applied",
    });
    const row = await value.db
      .prepare(
        `SELECT provenance_json
         FROM context_projection
        WHERE organisation_id = ? AND source_kind = 'case_entry' AND source_key = ?`,
      )
      .bind("organisation_a", "case_a\u0000entry_repair")
      .first<{ readonly provenance_json: unknown }>();
    expect(JSON.parse(String(row?.provenance_json))).toEqual({
      kind: "case_entry",
      replayAuthority,
    });
  });

  it("validates the canonical source digest before materialization", async () => {
    const value = fixture();
    const visibility: ContextVisibility = { kind: "case", caseId: "case_a" };
    value.reader.add(
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_a",
        revision: 1,
        visibility,
        text: "accepted",
        observedAt: 50,
      }),
    );
    value.reader.add(
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_b",
        revision: 1,
        digest: "",
        visibility,
        text: "invalid",
        observedAt: 50,
      }),
    );
    value.reader.add(
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_c",
        revision: 1,
        digest: "mismatched",
        visibility,
        text: "tampered",
        observedAt: 50,
      }),
    );
    const applied = await apply(
      value,
      command({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_a",
        revision: 1,
      }),
    );
    expect(applied.kind).toBe("applied");
    if (applied.kind === "applied")
      expect(applied.projection.contentDigest).toBe(
        canonicalDigest({ kind: "text", text: "accepted" }),
      );
    await expect(
      apply(
        value,
        command({
          organisationId: "organisation_a",
          caseId: "case_a",
          entryId: "entry_b",
          revision: 1,
        }),
      ),
    ).resolves.toEqual({
      kind: "skipped",
      reason: "source_digest_mismatch",
    });
    await expect(
      apply(
        value,
        command({
          organisationId: "organisation_a",
          caseId: "case_a",
          entryId: "entry_c",
          revision: 1,
        }),
      ),
    ).resolves.toEqual({
      kind: "skipped",
      reason: "source_digest_mismatch",
    });
  });

  it("keeps one latest ready row per source and ignores stale delivery", async () => {
    const value = fixture();
    const visibility: ContextVisibility = { kind: "case", caseId: "case_a" };
    value.reader.add(
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_a",
        revision: 1,
        visibility,
        text: "old",
        observedAt: 10,
      }),
    );
    value.reader.add(
      source({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_a",
        revision: 2,
        visibility,
        text: "new",
        observedAt: 20,
      }),
    );
    expect(
      (
        await apply(
          value,
          command({
            organisationId: "organisation_a",
            caseId: "case_a",
            entryId: "entry_a",
            revision: 1,
          }),
        )
      ).kind,
    ).toBe("applied");
    expect(
      (
        await apply(
          value,
          command({
            organisationId: "organisation_a",
            caseId: "case_a",
            entryId: "entry_a",
            revision: 2,
          }),
        )
      ).kind,
    ).toBe("applied");
    const stale = await apply(
      value,
      command({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_a",
        revision: 1,
      }),
    );
    expect(stale.kind).toBe("stale");
    expect(
      await value.db
        .prepare("SELECT source_revision, bounded_text FROM context_projection")
        .all(),
    ).toEqual({
      success: true,
      results: [{ source_revision: 2, bounded_text: "new" }],
      meta: expect.anything(),
    });
  });

  it("returns transient source reads as retryable and succeeds on redelivery", async () => {
    const value = fixture();
    const visibility: ContextVisibility = { kind: "case", caseId: "case_a" };
    const record = source({
      organisationId: "organisation_a",
      caseId: "case_a",
      entryId: "entry_a",
      revision: 1,
      visibility,
      text: "queued",
      observedAt: 10,
    });
    value.reader.add(record);
    value.reader.failOnce();
    const first = await handleContextProjectionQueueMessage({
      db: value.db,
      sourceReader: value.reader,
      message: command({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_a",
        revision: 1,
      }),
      now: 1_000,
    });
    expect(first).toEqual({
      ok: false,
      error: { code: "storage_failure", retryable: true },
    });
    const retry = await handleContextProjectionQueueMessage({
      db: value.db,
      sourceReader: value.reader,
      message: command({
        organisationId: "organisation_a",
        caseId: "case_a",
        entryId: "entry_a",
        revision: 1,
      }),
      now: 1_001,
    });
    expect(retry.ok).toBe(true);
    if (retry.ok) expect(retry.value.kind).toBe("applied");
  });
});
