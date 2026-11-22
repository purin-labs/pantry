/// <reference types="@cloudflare/workers-types" />

import { describe, expect, test } from "vitest";

import {
  admitSessionInformationFlowObservation,
  appendSessionInformationFlowInTransaction,
  createSessionInformationFlowSchema,
  prepareSessionInformationFlow,
  readSessionInformationFlow,
  readSessionTurnFlowBinding,
} from "@purin-labs/agent/actors/agent-session-information-flow";
import {
  FlowLabel,
  ObservationEvidence,
} from "@purin-labs/authority/policy/index";
import { emptySqliteFixture, sqlStorage } from "./sqlite-storage";

describe("AgentSession OAC persistence", () => {
  test("restores cumulative revisions and exact turn bindings", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionInformationFlowSchema(sql);
    const first = await contextBundle("entry_1", "person_1", 1);
    const second = await contextBundle("entry_2", "person_2", 2);
    const firstCommit = await prepareSessionInformationFlow({
      sql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: first,
    });
    expect(firstCommit.ok).toBe(true);
    if (!firstCommit.ok) return;
    expect(
      appendSessionInformationFlowInTransaction(sql, firstCommit.value),
    ).toEqual({
      ok: true,
      value: null,
    });

    const secondCommit = await prepareSessionInformationFlow({
      sql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_2",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: second,
    });
    expect(secondCommit.ok).toBe(true);
    if (!secondCommit.ok) return;
    expect(secondCommit.value.context.revision).toBe(2);
    expect(
      appendSessionInformationFlowInTransaction(sql, secondCommit.value),
    ).toEqual({
      ok: true,
      value: null,
    });

    const restored = await readSessionInformationFlow(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok || restored.value === null) return;
    expect(restored.value.context.digest).toBe(
      secondCommit.value.context.digest,
    );
    expect(restored.value.observations).toHaveLength(2);
    const firstTurnBinding = await readSessionTurnFlowBinding(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
    });
    expect(firstTurnBinding.ok).toBe(true);
    if (!firstTurnBinding.ok || firstTurnBinding.value === null) return;
    expect(firstTurnBinding.value.binding.informationFlowContextDigest).toBe(
      firstCommit.value.context.digest,
    );
    expect(
      readCount(fixture.database, "session_information_flow_revision"),
    ).toBe(2);
    expect(
      readCount(fixture.database, "session_information_flow_observation"),
    ).toBe(2);
  });

  test("is deterministic when context observations arrive in a different order", async () => {
    const firstFixture = emptySqliteFixture();
    const secondFixture = emptySqliteFixture();
    const firstSql = sqlStorage(firstFixture.storage);
    const secondSql = sqlStorage(secondFixture.storage);
    createSessionInformationFlowSchema(firstSql);
    createSessionInformationFlowSchema(secondSql);
    const first = await contextBundle("entry_1", "person_1", 1);
    const second = await contextBundle("entry_2", "person_2", 2);
    const ordered = await prepareSessionInformationFlow({
      sql: firstSql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: bundleWithItems([singleItem(first), singleItem(second)]),
    });
    const reversed = await prepareSessionInformationFlow({
      sql: secondSql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: bundleWithItems([singleItem(second), singleItem(first)]),
    });
    expect(ordered.ok).toBe(true);
    expect(reversed.ok).toBe(true);
    if (!ordered.ok || !reversed.ok) return;
    expect(ordered.value.context.digest).toBe(reversed.value.context.digest);
    expect(ordered.value.binding.informationFlowContextDigest).toBe(
      reversed.value.binding.informationFlowContextDigest,
    );
  });

  test("advances the current turn binding with an admitted runtime observation", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionInformationFlowSchema(sql);
    const initial = await contextBundle("entry_1", "person_1", 1);
    const prepared = await prepareSessionInformationFlow({
      sql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: initial,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(
      appendSessionInformationFlowInTransaction(sql, prepared.value),
    ).toEqual({
      ok: true,
      value: null,
    });

    const runtime = singleItem(
      await contextBundle("entry_runtime", "person_1", 2),
    );
    const admitted = await admitSessionInformationFlowObservation({
      authorizeCommit: authorizeObservationFixture,
      sql,
      transactionSync: runImmediately,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
      authorityPartitionDigest: "a".repeat(64),
      inputLabel: runtime.inputLabel,
      observation: runtime.observationEvidence,
      observedAt: runtime.observedAt,
    });

    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.value.context.revision).toBe(2);
    const binding = await readSessionTurnFlowBinding(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok || binding.value === null) return;
    expect(binding.value.revision).toBe(2);
    expect(binding.value.binding.informationFlowContextDigest).toBe(
      admitted.value.context.digest,
    );
    expect(
      readCount(fixture.database, "session_information_flow_revision"),
    ).toBe(1);
    expect(
      readCount(fixture.database, "session_information_flow_observation"),
    ).toBe(2);
  });

  test("rejects a stale prepared revision", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionInformationFlowSchema(sql);
    const first = await contextBundle("entry_1", "person_1", 1);
    const second = await contextBundle("entry_2", "person_2", 2);
    const firstCommit = await prepareSessionInformationFlow({
      sql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: first,
    });
    expect(firstCommit.ok).toBe(true);
    if (!firstCommit.ok) return;
    expect(
      appendSessionInformationFlowInTransaction(sql, firstCommit.value).ok,
    ).toBe(true);
    const secondCommit = await prepareSessionInformationFlow({
      sql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_2",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: second,
    });
    expect(secondCommit.ok).toBe(true);
    if (!secondCommit.ok) return;
    expect(
      appendSessionInformationFlowInTransaction(sql, secondCommit.value).ok,
    ).toBe(true);
    expect(
      appendSessionInformationFlowInTransaction(sql, firstCommit.value),
    ).toEqual({
      ok: false,
      error: { code: "session_information_flow_stale" },
    });
  });

  test("records a binding for every turn when the context revision is unchanged", async () => {
    const fixture = emptySqliteFixture();
    const sql = sqlStorage(fixture.storage);
    createSessionInformationFlowSchema(sql);
    const bundle = await contextBundle("entry_1", "person_1", 1);
    const first = await prepareSessionInformationFlow({
      sql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_1",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: bundle,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(appendSessionInformationFlowInTransaction(sql, first.value).ok).toBe(
      true,
    );
    const second = await prepareSessionInformationFlow({
      sql,
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_2",
      authorityPartitionDigest: "a".repeat(64),
      contextBundle: bundle,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.context.revision).toBe(first.value.context.revision);
    expect(
      appendSessionInformationFlowInTransaction(sql, second.value).ok,
    ).toBe(true);
    const restored = await readSessionTurnFlowBinding(sql, {
      organisationId: "organisation_1",
      sessionId: "session_1",
      turnId: "turn_2",
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok || restored.value === null) return;
    expect(restored.value.binding.toJSON()).toEqual(
      second.value.binding.toJSON(),
    );
    expect(
      readCount(fixture.database, "session_information_flow_revision"),
    ).toBe(1);
    expect(
      readCount(fixture.database, "session_information_flow_turn_binding"),
    ).toBe(2);
    sql.exec(
      "UPDATE session_information_flow_turn_binding SET binding_json = ? WHERE turn_id = 'turn_2'",
      JSON.stringify(first.value.binding.toJSON()),
    );
    expect(
      await readSessionTurnFlowBinding(sql, {
        organisationId: "organisation_1",
        sessionId: "session_1",
        turnId: "turn_2",
      }),
    ).toEqual({
      ok: false,
      error: {
        code: "session_information_flow_invalid",
        field: "turn_binding_metadata",
      },
    });
  });
});

async function contextBundle(
  entryId: string,
  personId: string,
  revision: number,
): Promise<ContextBundleFixture> {
  const label = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId: "organisation_1" },
      readers: [{ kind: "person", personId }],
    },
  ]);
  if (!label.ok) throw new Error(label.error.code);
  const evidence = await ObservationEvidence.create({
    source: { kind: "case_entry", caseId: "case_1", entryId },
    sourceRevision: revision,
    contentDigest: revision === 1 ? "b".repeat(64) : "c".repeat(64),
    inputLabel: label.value,
    observedAt: revision,
  });
  if (!evidence.ok) throw new Error(evidence.error.code);
  return bundleWithItems([
    {
      source: { kind: "case_entry", caseId: "case_1", entryId },
      provenance: { kind: "case_entry" },
      sourceRevision: revision,
      contentDigest: evidence.value.contentDigest,
      boundedExcerpt: `entry ${entryId}`,
      inputLabel: label.value,
      observationEvidence: evidence.value,
      observedAt: revision,
      freshness: { kind: "fresh" },
      retrievalEvidence: {
        exactPhraseMatch: true,
        tokenOverlapMillionths: 1_000_000,
        recencyRank: revision,
      },
    },
  ]);
}

type ContextBundleFixture = {
  readonly organisationId: string;
  readonly caseId: string;
  readonly assignmentId: string;
  readonly sessionId: string;
  readonly policyVersion: string;
  readonly assemblyStrategyVersion: "context_assembly_v1";
  readonly assembledAt: number;
  readonly items: readonly ContextItemFixture[];
  readonly usage: { readonly items: number; readonly estimatedTokens: number };
  readonly disposition: { readonly kind: "complete" };
};

type ContextItemFixture = {
  readonly source: {
    readonly kind: "case_entry";
    readonly caseId: string;
    readonly entryId: string;
  };
  readonly provenance: { readonly kind: "case_entry" };
  readonly sourceRevision: number;
  readonly contentDigest: string;
  readonly boundedExcerpt: string;
  readonly inputLabel: FlowLabel;
  readonly observationEvidence: ObservationEvidence;
  readonly observedAt: number;
  readonly freshness: { readonly kind: "fresh" };
  readonly retrievalEvidence: {
    readonly exactPhraseMatch: boolean;
    readonly tokenOverlapMillionths: number;
    readonly recencyRank: number;
  };
};

function bundleWithItems(
  items: readonly ContextItemFixture[],
): ContextBundleFixture {
  return {
    organisationId: "organisation_1",
    caseId: "case_1",
    assignmentId: "assignment_1",
    sessionId: "session_1",
    policyVersion: "policy_1",
    assemblyStrategyVersion: "context_assembly_v1",
    assembledAt: 10,
    items,
    usage: { items: items.length, estimatedTokens: items.length * 2 },
    disposition: { kind: "complete" },
  };
}

function singleItem(bundle: ContextBundleFixture): ContextItemFixture {
  const item = bundle.items[0];
  if (item === undefined) throw new Error("context fixture is empty");
  return item;
}

function readCount(
  database: import("node:sqlite").DatabaseSync,
  table: string,
): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
  if (typeof row?.count !== "number")
    throw new Error(`missing count for ${table}`);
  return row.count;
}

function runImmediately<Value>(callback: () => Value): Value {
  return callback();
}

async function authorizeObservationFixture(): Promise<void> {}
