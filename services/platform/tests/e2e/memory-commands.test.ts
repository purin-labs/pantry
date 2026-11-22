import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { evictDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import type { MemoryCommand, MemoryContent } from "@purin-labs/control-api";
import {
  parseEntityRef,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@purin-labs/commerce-client";
import {
  installSlackActorFixture,
  ORGANISATION_ID,
  OTHER_ORGANISATION_ID,
} from "./slack-journey-support";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { readChatControlAuthority } from "@purin-labs/conversation/chat/information-flow";
import { parseUserId } from "@purin-labs/control-api/ids";
import { restoreSerializedMemory } from "../../src/memory/store";
import {
  canonicalFlowLabel,
  createCurrentSourceFlowLabel,
  FlowLabel,
  joinFlowLabels,
} from "@purin-labs/authority/policy/information-flow/index";

const OPERATOR = { kind: "operator", personId: "person_e2e-slack-actor" };
const AGENT = {
  kind: "agent",
  caseId: "case_memory_delivery",
  assignmentId: "assignment_memory_delivery",
  sessionId: "session_memory_delivery",
};
const CORRECTION = {
  kind: "proposal_correction",
  caseId: "case_memory_delivery",
  integrationAccountId: "integration_account_memory_delivery",
  proposalId: "proposal_supplier_reply",
  version: 2,
  digest: "c".repeat(64),
} as const;
const CUTOFF: MemoryContent = {
  memoryKind: "fact",
  statement: "Next-day orders for this supplier close at noon.",
  applicability: {
    kind: "commerce_entity",
    merchantId: "merchant_e2e",
    entity: parseEntityRef({
      origin: "custom",
      typeId: SUPPLIER_ENTITY_TYPE_ID,
      entityId: "supplier_primary",
    }),
  },
  validity: {
    timezone: "Australia/Sydney",
    effectiveFrom: "2026-10-01",
    effectiveUntil: null,
    dependsOn: [CORRECTION],
  },
  evidence: [CORRECTION],
  sourceCaseId: "case_memory_delivery",
};

it(
  "keeps one logical Memory decision across Actor replacement and each revision's own label",
  { timeout: 60_000 },
  memoryCommandJourney,
);

async function memoryCommandJourney({ task }: TestContext): Promise<void> {
  await installSlackActorFixture();
  await fixtureDatabase().prepare(
    "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = 'memory-commands-fixture', activated_at = ? WHERE organisation_id = ?",
  )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const userId = parseUserId("user_ddea8ec2-b424-5505-a2f4-8f66b89b13ab");
  if (!userId.ok) throw new Error(userId.error.code);
  const authority = await readChatControlAuthority(fixtureDatabase(), {
    organisationId: ORGANISATION_ID,
    userId: userId.value,
  });
  if (authority === null) throw new Error("control authority unavailable");
  // The agent's candidate carries the label of the Case evidence it read; the
  // operator's revision joins that with what the operator wrote.
  const evidenceLabel = required(
    await FlowLabel.create([
      {
        owner: { kind: "organisation", organisationId: ORGANISATION_ID },
        readers: [{ kind: "case", caseId: AGENT.caseId }],
      },
    ]),
  );
  const authorLabel = required(
    await createCurrentSourceFlowLabel({
      kind: "ingress",
      db: fixtureDatabase(),
      authority,
    }),
  );
  const revisedLabel = required(
    await joinFlowLabels(evidenceLabel, authorLabel),
  );
  expect(revisedLabel.digest).not.toBe(evidenceLabel.digest);

  const send = (
    principal: unknown,
    body: MemoryCommand,
    flowLabel: FlowLabel | null,
  ) =>
    organisation.commandMemory({
      organisationId: ORGANISATION_ID,
      principal,
      body,
      flowLabel: flowLabel === null ? null : canonicalFlowLabel(flowLabel),
    });

  const propose: MemoryCommand = {
    commandId: "memory_command_propose",
    expectedRevision: 0,
    kind: "propose",
    memoryId: null,
    submission: "own_input",
    content: CUTOFF,
  };
  const proposed = await send(AGENT, propose, evidenceLabel);
  if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
  const memoryId = proposed.value.memoryId;
  expect(proposed.value).toMatchObject({
    revision: 1,
    headRevision: 1,
    state: "candidate",
  });

  // An agent proposes and has no branch that decides.
  const accept = (
    revision: number,
    expectedRevision: number,
  ): MemoryCommand => ({
    commandId: `memory_command_accept_${revision}`,
    expectedRevision,
    kind: "accept",
    memoryId,
    revision,
  });
  expect(await send(AGENT, accept(1, 1), null)).toEqual({
    ok: false,
    error: { code: "memory_reviewer_required" },
  });
  // A proposal without a verifiable label is refused before any write.
  expect(
    await organisation.commandMemory({
      organisationId: ORGANISATION_ID,
      principal: OPERATOR,
      body: { ...propose, commandId: "memory_command_unlabelled" },
      flowLabel: {
        ...canonicalFlowLabel(evidenceLabel),
        digest: "0".repeat(64),
      },
    }),
  ).toEqual({ ok: false, error: { code: "memory_invalid" } });

  // The operator corrects the candidate's wording. The agent's text stays in
  // history as revised, under its own narrower label.
  const revise: MemoryCommand = {
    commandId: "memory_command_revise",
    expectedRevision: 1,
    kind: "propose",
    memoryId,
    submission: "own_input",
    content: {
      ...CUTOFF,
      statement:
        "Next-day orders for this supplier close at 12:00 Sydney time.",
    },
  };
  const revised = await send(OPERATOR, revise, revisedLabel);
  expect(revised).toMatchObject({
    ok: true,
    value: { revision: 2, headRevision: 2, state: "candidate" },
  });
  // The stale view cannot accept, and the revised candidate cannot be accepted.
  expect(await send(OPERATOR, accept(1, 1), null)).toEqual({
    ok: false,
    error: { code: "memory_conflict" },
  });
  expect(await send(OPERATOR, accept(1, 2), null)).toEqual({
    ok: false,
    error: { code: "memory_conflict" },
  });

  const accepted = await send(OPERATOR, accept(2, 2), null);
  if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
  expect(accepted.value).toMatchObject({ revision: 2, state: "accepted" });

  // Replace the Actor after publication and repeat the command: one decision.
  await evictDurableObject(organisation);
  const repeated = await send(OPERATOR, accept(2, 2), null);
  expect(repeated).toEqual(accepted);
  // The same command identity cannot carry a different decision.
  const reusedIdentity: MemoryCommand = {
    commandId: accept(2, 2).commandId,
    expectedRevision: 2,
    kind: "reject",
    memoryId,
    revision: 2,
  };
  expect(await send(OPERATOR, reusedIdentity, null)).toEqual({
    ok: false,
    error: { code: "memory_command_conflict" },
  });

  const read = await organisation.readMemories({
    organisationId: ORGANISATION_ID,
  });
  if (!read.ok) throw new Error(JSON.stringify(read.error));
  expect(read.value).toHaveLength(1);
  const memory = await restoreSerializedMemory(ORGANISATION_ID, read.value[0]);
  if (memory === null) throw new Error("stored Memory failed verification");
  const [candidate, current] = memory.revisions;
  expect(memory).toMatchObject({ memoryId, headRevision: 2 });
  expect(candidate).toMatchObject({
    kind: "rejected",
    proposedBy: AGENT,
    rejection: {
      reason: "revised",
      replacementRevision: 2,
      reviewerPersonId: OPERATOR.personId,
      commandId: revise.commandId,
    },
  });
  expect(current).toMatchObject({
    kind: "accepted",
    proposedBy: { ...OPERATOR, submission: "own_input" },
    statement: revise.content.statement,
    acceptance: {
      reviewerPersonId: OPERATOR.personId,
      commandId: accept(2, 2).commandId,
    },
  });
  // Each revision keeps the restrictions it was written under.
  expect(candidate?.flowLabel.digest).toBe(evidenceLabel.digest);
  expect(current?.flowLabel.digest).toBe(revisedLabel.digest);
  // A label altered at rest or in transit fails verification as a whole.
  expect(
    await restoreSerializedMemory(ORGANISATION_ID, {
      ...read.value[0],
      revisions: read.value[0]?.revisions.map((revision) => ({
        ...revision,
        flowLabel: { ...revision.flowLabel, policies: [] },
      })),
    }),
  ).toBeNull();

  // Revocation keeps the acceptance it withdraws, across another replacement.
  const revoke: MemoryCommand = {
    commandId: "memory_command_revoke",
    expectedRevision: 2,
    kind: "revoke",
    memoryId,
    revision: 2,
  };
  const revoked = await send(OPERATOR, revoke, null);
  expect(revoked).toMatchObject({ ok: true, value: { state: "revoked" } });
  await evictDurableObject(organisation);
  expect(await send(OPERATOR, revoke, null)).toEqual(revoked);
  const afterRevoke = await organisation.readMemories({
    organisationId: ORGANISATION_ID,
  });
  if (!afterRevoke.ok) throw new Error(JSON.stringify(afterRevoke.error));
  expect(afterRevoke.value[0]?.revisions[1]).toMatchObject({
    kind: "revoked",
    acceptance: { commandId: accept(2, 2).commandId },
    revocation: { commandId: revoke.commandId },
  });

  // Another organisation's identity reaches nothing through this Actor.
  expect(
    await organisation.readMemories({ organisationId: OTHER_ORGANISATION_ID }),
  ).toMatchObject({ ok: false });

  Object.assign(task.meta, {
    memoryCommands: {
      memoryId,
      commands: [
        propose.commandId,
        revise.commandId,
        accept(2, 2).commandId,
        revoke.commandId,
      ],
      receipts: { proposed: proposed.value, accepted: accepted.value },
      repeatedAfterEviction: repeated,
      revisions: afterRevoke.value[0]?.revisions.map((revision) => ({
        revision: revision.revision,
        state: revision.kind,
        flowLabelDigest: revision.flowLabel.digest,
      })),
    },
  });
}

function required<Value>(
  result: { ok: true; value: Value } | { ok: false; error: unknown },
): Value {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}
