// The members and the turn reads of the journeys of a held exit (Plan 27C).
import { fixtureDatabase } from "./organisation-database";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";

import { admitSessionInformationFlowObservation } from "../../src/actors/agent-session-information-flow";
import { CONTEXT_CASE_READ_CAPABILITY } from "../../src/authorization/access-grants/turn-authority";
import { createAccessGrant } from "../../src/data/access-grants";
import type { IssuedControlSession } from "../../src/data/control-plane";
import { FlowLabel, ObservationEvidence } from "../../src/policy";
import type {
  FlowPolicyInput,
  FlowWriter,
} from "../../src/policy/information-flow";
import { commerceClient } from "./commerce-support";
import { ORGANISATION_ID } from "./slack-journey-support";

export type Person = Readonly<{
  personId: string;
  session: IssuedControlSession;
}>;

export async function registeredActors(
  kind: "case" | "session",
  organisationId: string = ORGANISATION_ID,
): Promise<readonly string[]> {
  const rows = await fixtureDatabase()
    .prepare(
      `SELECT physical_object_name AS name FROM durable_object_registry
     WHERE organisation_id = ? AND lifecycle_status = 'active' AND object_kind = ?`,
    )
    .bind(organisationId, kind)
    .all<{ name: string }>();
  return rows.results.map((row) => row.name);
}

/**
 * Add a read to the running turn, through the commit that a tool read uses. A
 * running turn is the newest turn binding of all Sessions. `writer` makes it
 * the read of a text that a person outside the Organisation wrote (Plan 89).
 */
export async function raiseLabel(
  policy: FlowPolicyInput,
  writer?: FlowWriter,
  organisationId: string = ORGANISATION_ID,
): Promise<void> {
  const label = await FlowLabel.create([policy], writer);
  if (!label.ok) throw new Error(label.error.code);
  const newest = await Promise.all(
    (await registeredActors("session", organisationId)).map(async (name) => {
      const stub = env.SESSION.getByName(name);
      const committedAt = await runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql
            .exec<{ at: number | null }>(
              "SELECT MAX(committed_at) AS at FROM session_information_flow_revision",
            )
            .one().at ?? 0,
      );
      return { stub, committedAt };
    }),
  );
  newest.sort((left, right) => right.committedAt - left.committedAt);
  const target = newest[0];
  if (target === undefined) throw new Error("No Session runs a turn");
  await runInDurableObject(target.stub, async (_instance, state) => {
    const turn = state.storage.sql
      .exec<{
        organisation_id: string;
        session_id: string;
        turn_id: string;
        authority_partition_digest: string;
      }>(
        `SELECT organisation_id, session_id, turn_id, authority_partition_digest
         FROM session_information_flow_revision
         ORDER BY revision DESC LIMIT 1`,
      )
      .one();
    const evidence = await ObservationEvidence.create({
      source: {
        kind: "case_entry",
        caseId: "case_held_source",
        entryId: `entry_${crypto.randomUUID()}`,
      },
      sourceRevision: 1,
      contentDigest: "b".repeat(64),
      inputLabel: label.value,
      observedAt: Date.now(),
    });
    if (!evidence.ok) throw new Error(evidence.error.code);
    const admitted = await admitSessionInformationFlowObservation({
      authorizeCommit: () => undefined,
      sql: state.storage.sql,
      transactionSync: state.storage.transactionSync.bind(state.storage),
      organisationId: turn.organisation_id,
      sessionId: turn.session_id,
      turnId: turn.turn_id,
      authorityPartitionDigest: turn.authority_partition_digest,
      inputLabel: label.value,
      observation: evidence.value,
      observedAt: Date.now(),
    });
    if (!admitted.ok) throw new Error(admitted.error.code);
  });
}

export async function joiner() {
  const client = await commerceClient(`held-output-${crypto.randomUUID()}`);
  const personId = `person_${crypto.randomUUID()}`;
  return { client, personId, slot: { client, laterPersonId: personId } };
}

export async function admin(
  joining: Awaited<ReturnType<typeof joiner>>,
  displayName: string,
): Promise<Person> {
  const userId = joining.client.identity.userId;
  await fixtureDatabase().batch([
    fixtureDatabase()
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
      )
      .bind(ORGANISATION_ID, joining.personId, displayName),
    fixtureDatabase()
      .prepare(
        "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, 'admin', 'active', ?)",
      )
      .bind(ORGANISATION_ID, userId, joining.personId, Date.now()),
  ]);
  const granted = await createAccessGrant({
    db: fixtureDatabase(),
    organisationId: ORGANISATION_ID,
    grantId: `grant_${userId}`,
    subject: { kind: "person", personId: joining.personId },
    target: {
      kind: "platform_capability",
      capabilityId: CONTEXT_CASE_READ_CAPABILITY,
      capabilityVersion: 1,
    },
    provenance: {
      kind: "baseline",
      profile: "read_and_propose",
      profileVersion: 1,
      materializationReceiptId: "receipt_held_output",
    },
    now: Date.now(),
  });
  if (!granted.ok) throw new Error(granted.error.code);
  return { personId: joining.personId, session: joining.client.session };
}
