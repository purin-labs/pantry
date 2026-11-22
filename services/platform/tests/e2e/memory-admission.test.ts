import { env } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  newProjectId,
  type ConversationId,
  type MemoryCommand,
  type MemoryContent,
} from "@purin-labs/control-api";
import {
  parseEntityRef,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@purin-labs/commerce-client";
import { runInDurableObject } from "cloudflare:test";
import {
  readSessionTurnMemoryRecords,
  recordTransientTurnContext,
} from "@purin-labs/agent/actors/actor-journal/transactions";
import { restoreSessionTurnContext } from "@purin-labs/agent/actors/actor-journal";
import { serializeContextBundle } from "@purin-labs/agent/actors/actor-journal/parsers";
import {
  resolveActiveCaseActor,
  resolveActiveSessionActor,
} from "@purin-labs/actor-runtime/actors/actor-router";
import {
  canonicalFlowLabel,
  FlowLabel,
} from "@purin-labs/authority/policy/information-flow/index";
import { deriveDirectCaseIdentities } from "@purin-labs/conversation/actors/case-direct-processing";
import {
  MEMORY_LIMITATION_NOTICE,
  renderModelContext,
} from "@purin-labs/agent/actors/model-context-prompt";
import { initialConversationCaseIdentity } from "@purin-labs/conversation/chat/conversation-actor-identity";
import { conversationAudienceMayReceive } from "@purin-labs/conversation/chat/conversation-disclosure";
import { readChatControlAuthority } from "@purin-labs/conversation/chat/information-flow";
import {
  digestHistoricalContextBundle,
  type TurnMemoryReader,
} from "@purin-labs/agent/context/assembly/index";
import { prepareTurnContext } from "@purin-labs/agent/context/turn-context";
import {
  createTurnMemoryReader,
  TURN_MEMORY_PAGE,
  type TurnMemoryDestination,
} from "../../src/memory/access";
import {
  turnMemoryReaderWithoutSubjects,
} from "../../src/memory/contract/turn-memory";
import {
  parseAssignmentId,
  parseSessionId,
  type AssignmentId,
  type SessionId,
} from "@purin-labs/kernel/ids";
import { memoryApplicabilityKey } from "../../src/memory/store";
import { readCurrentOrganisationPolicySnapshot } from "@purin-labs/authority/policy-snapshot";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import {
  incoming,
  openNodes,
  readCaseExecution,
  readCaseExecutionDetail,
  readCaseTimeline,
} from "./case-execution-support";
import {
  command,
  createConversation,
  installMemoryFixture,
  instruct,
  instructionEntry,
  postJson,
  receiptMemoryId,
  storedConversation,
  type Member,
} from "./memory-support";

const QUESTION = "When does the primary supplier close next-day orders?";
const SHARED_FACT = "Next-day orders for the primary supplier close at noon.";
const PRIVATE_FACT = "The primary supplier's account manager prefers calls.";
const OTHER_SUPPLIER_FACT = "The secondary supplier closes orders at 15:00.";
const CANDIDATE_FACT = "Unreviewed: the primary supplier closes at 11:00.";
const EXPIRED_FACT = "In January the primary supplier closed at 10:00.";
const SKILL_FACT = "Purchasing confirms every order by reply before noon.";
const REPLACEMENT_FACT =
  "The primary supplier now closes next-day orders at 13:00.";

it(
  "admits accepted Memory to a turn only when it applies, holds, reaches the destination and fits the limits",
  { timeout: 120_000 },
  memoryAdmissionJourney,
);

async function memoryAdmissionJourney({ task }: TestContext): Promise<void> {
  // The account authority admits the owner and a second administrator. Each
  // control request and each turn authority below passes the real account
  // check.
  const { organisationId, organisation, author, reviewer, route, paths } =
    await installMemoryFixture();
  const { chat: CHAT, projects: PROJECTS } = paths;
  const authorScope = { organisationId, userId: author.userId };

  // One conversation shared with the reviewer through a Project, one private.
  const projectId = newProjectId();
  expect(
    await postJson(author, PROJECTS, {
      kind: "create_project",
      operationId: crypto.randomUUID(),
      projectId,
      content: {
        name: "Supplier operations",
        brief: "Supplier ordering notes.",
        references: [],
      },
    }),
  ).toMatchObject({ status: 200 });
  expect(
    await postJson(author, `${PROJECTS}/${projectId}/access`, {
      kind: "share_project",
      operationId: crypto.randomUUID(),
      expectedAccessRevision: 0,
      members: [{ userId: reviewer.userId, role: "editor" }],
    }),
  ).toMatchObject({ status: 200 });
  const sharedConversationId = newConversationId();
  await createConversation(author, sharedConversationId, route);
  const unshared = await storedConversation(author, sharedConversationId);
  if (unshared === null) throw new Error("conversation missing");
  expect(
    await postJson(
      author,
      `${CHAT}/conversations/${sharedConversationId}/access`,
      {
        kind: "share_conversation",
        operationId: crypto.randomUUID(),
        expectedRevision: unshared.revision,
        projectId,
        expectedProjectAccessRevision: 1,
      },
    ),
  ).toMatchObject({ status: 200, body: { kind: "accepted" } });
  await instruct(author, sharedConversationId, "memory_admission_shared");
  const sharedEntry = await instructionEntry(author, sharedConversationId);
  const privateConversationId = newConversationId();
  await createConversation(author, privateConversationId, route);
  await instruct(author, privateConversationId, "memory_admission_private");
  const privateEntry = await instructionEntry(author, privateConversationId);

  const supplier = (entityId: string): MemoryContent["applicability"] => ({
    kind: "commerce_entity",
    merchantId: "merchant_e2e",
    entity: parseEntityRef({
      origin: "custom",
      typeId: SUPPLIER_ENTITY_TYPE_ID,
      entityId,
    }),
  });
  const content = (
    statement: string,
    evidence: typeof sharedEntry.evidence,
    overrides: Partial<
      Pick<MemoryContent, "applicability"> & MemoryContent["validity"]
    > = {},
  ): MemoryContent => ({
    memoryKind: "fact",
    statement,
    applicability: overrides.applicability ?? supplier("supplier_primary"),
    validity: {
      timezone: "Australia/Sydney",
      effectiveFrom: overrides.effectiveFrom ?? "2026-10-01",
      effectiveUntil: overrides.effectiveUntil ?? null,
      dependsOn: [evidence],
    },
    evidence: [evidence],
    sourceCaseId: evidence.caseId,
  });
  let commands = 0;
  const nextCommandId = (): string => `memory_admission_${(commands += 1)}`;
  // An agent's candidate from the shared conversation carries that
  // conversation's label. This journey sets scopes and labels that the
  // agent's tool does not, so the Actor command stands in for it. The
  // `memory-teaching` journey covers the tool.
  const agentCandidate = async (
    proposed: MemoryContent,
    flowLabel: unknown = sharedEntry.inputLabel,
  ): Promise<string> => {
    const result = await organisation.commandMemory({
      organisationId,
      principal: {
        kind: "agent",
        caseId: sharedEntry.evidence.caseId,
        assignmentId: "assignment_memory_admission",
        sessionId: "session_memory_admission",
      },
      body: {
        commandId: nextCommandId(),
        expectedRevision: 0,
        kind: "propose",
        memoryId: null,
        submission: "own_input",
        content: proposed,
      } satisfies MemoryCommand,
      flowLabel,
    });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value.memoryId;
  };
  const decide = async (
    kind: "accept" | "revoke",
    memoryId: string,
    revision = 1,
  ): Promise<void> => {
    const decided = await command(author, {
      commandId: nextCommandId(),
      expectedRevision: revision,
      kind,
      memoryId,
      revision,
    });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
  };
  const acceptedShared = async (proposed: MemoryContent): Promise<string> => {
    const memoryId = await agentCandidate(proposed);
    await decide("accept", memoryId);
    return memoryId;
  };
  // Memory the author cannot inspect is accepted through the Actor command.
  const acceptedByActor = async (
    proposed: MemoryContent,
    flowLabel: unknown,
  ): Promise<string> => {
    const memoryId = await agentCandidate(proposed, flowLabel);
    const accepted = await organisation.commandMemory({
      organisationId,
      principal: { kind: "operator", personId: author.personId },
      body: {
        commandId: nextCommandId(),
        expectedRevision: 1,
        kind: "accept",
        memoryId,
        revision: 1,
      } satisfies MemoryCommand,
      flowLabel: null,
    });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    return memoryId;
  };

  const shared = await acceptedShared(
    content(SHARED_FACT, sharedEntry.evidence),
  );
  const otherSupplier = await acceptedShared(
    content(OTHER_SUPPLIER_FACT, sharedEntry.evidence, {
      applicability: supplier("supplier_secondary"),
    }),
  );
  const expired = await acceptedShared(
    content(EXPIRED_FACT, sharedEntry.evidence, {
      effectiveFrom: "2026-01-01",
      effectiveUntil: "2026-01-31",
    }),
  );
  const candidate = await agentCandidate(
    content(CANDIDATE_FACT, sharedEntry.evidence),
  );
  const privateProposal = await command(author, {
    commandId: nextCommandId(),
    expectedRevision: 0,
    kind: "propose",
    memoryId: null,
    submission: "own_input",
    content: content(PRIVATE_FACT, privateEntry.evidence),
  });
  expect(privateProposal.status, JSON.stringify(privateProposal.body)).toBe(
    200,
  );
  const privateMemory = receiptMemoryId(privateProposal.body);
  await decide("accept", privateMemory);

  const execution = await requireOrganisationExecutionScope(
    env,
    organisationId,
  );
  const snapshot = await readCurrentOrganisationPolicySnapshot(
    fixtureDatabase(),
    organisationId,
  );
  if (!snapshot.ok) throw new Error(snapshot.error.code);
  // The reader a turn about the primary supplier receives. The destination is
  // the conversation's whole current audience.
  const conversationDestination =
    (person: Member, conversationId: ConversationId): TurnMemoryDestination =>
    (label) =>
      conversationAudienceMayReceive(
        fixtureDatabase(),
        execution.accountAccess,
        { organisationId, userId: person.userId },
        conversationId,
        label,
      );
  const reader = (
    person: Member,
    conversationId: ConversationId,
    options: Readonly<{
      now?: number;
      destinationMayReceive?: TurnMemoryDestination;
      applicability?: readonly MemoryContent["applicability"][];
    }> = {},
  ): TurnMemoryReader =>
    createTurnMemoryReader({
      env,
      execution,
      organisationId,
      subjects: {
        applicability: options.applicability ?? [supplier("supplier_primary")],
      },
      destinationMayReceive:
        options.destinationMayReceive ??
        conversationDestination(person, conversationId),
      now: options.now ?? Date.now(),
    });
  const prepare = async (
    person: Member,
    conversationId: ConversationId,
    memoryReader: TurnMemoryReader,
    /** The assignment and Session the context is for, when not the first. */
    turn?: Readonly<{ assignmentId: AssignmentId; sessionId: SessionId }>,
  ) => {
    const identities = await deriveDirectCaseIdentities(
      initialConversationCaseIdentity(authorScope, conversationId),
    );
    if (!identities.ok) throw new Error(identities.error.code);
    const authority = await readChatControlAuthority(fixtureDatabase(), {
      organisationId,
      userId: person.userId,
    });
    if (authority === null) throw new Error("control authority unavailable");
    const caseActor = await resolveActiveCaseActor({
      env,
      namespace: env.CASE,
      organisationId,
      caseId: identities.value.caseId,
      now: Date.now(),
    });
    if (!caseActor.ok) throw new Error(caseActor.error.code);
    return prepareTurnContext({
      db: fixtureDatabase(),
      accountAccess: execution.accountAccess,
      userAuthority: {
        kind: "authenticated_session",
        nativeSessionId: person.session.session.controlSessionId,
      },
      action: "execute",
      organisationId,
      caseId: identities.value.caseId,
      assignmentId: turn?.assignmentId ?? identities.value.assignmentId,
      sessionId: turn?.sessionId ?? identities.value.sessionId,
      requestAuthority: authority,
      policy: {
        version: snapshot.value.version,
        egress: snapshot.value.egress,
        authz: snapshot.value.authz,
        conversationRisk: snapshot.value.conversationRisk,
        modelRoute: route,
      },
      query: QUESTION,
      now: Date.now(),
      tailReader: caseActor.value,
      memoryReader,
    });
  };
  const assemble = async (
    person: Member,
    conversationId: ConversationId,
    memoryReader: TurnMemoryReader,
    turn?: Parameters<typeof prepare>[3],
  ) => {
    const prepared = await prepare(person, conversationId, memoryReader, turn);
    if (!prepared.ok) throw new Error(prepared.error.code);
    return prepared.value.context;
  };
  const privateIdentities = await deriveDirectCaseIdentities(
    initialConversationCaseIdentity(authorScope, privateConversationId),
  );
  if (!privateIdentities.ok) throw new Error(privateIdentities.error.code);
  const privateIdentitiesValue = privateIdentities.value;
  const admittedIds = (context: Awaited<ReturnType<typeof assemble>>) =>
    context.bundle.memory.kind === "admitted" ||
    context.bundle.memory.kind === "limited"
      ? context.bundle.memory.revisions.map((ref) => ref.memoryId).sort()
      : [];
  const prompt = (context: Awaited<ReturnType<typeof assemble>>) =>
    renderModelContext(context.modelContext, QUESTION, 100_000);

  // The author's private turn. Both accepted, applicable, current revisions
  // reach the model, ahead of the conversation's own history. The other
  // supplier's fact, the unreviewed candidate and the expired fact do not.
  const privateTurn = await assemble(
    author,
    privateConversationId,
    reader(author, privateConversationId),
  );
  expect(privateTurn.bundle.memory).toMatchObject({ kind: "admitted" });
  expect(admittedIds(privateTurn)).toEqual([shared, privateMemory].sort());
  expect(
    privateTurn.bundle.items.slice(0, 2).map((item) => item.source.kind),
  ).toEqual(["memory", "memory"]);
  const privatePrompt = prompt(privateTurn);
  expect(privatePrompt.text).toContain(SHARED_FACT);
  expect(privatePrompt.text).toContain(PRIVATE_FACT);
  for (const withheld of [OTHER_SUPPLIER_FACT, CANDIDATE_FACT, EXPIRED_FACT])
    expect(privatePrompt.text).not.toContain(withheld);
  expect(privatePrompt.text).not.toContain(MEMORY_LIMITATION_NOTICE);
  expect(privatePrompt.text.endsWith(QUESTION)).toBe(true);
  expect(privatePrompt.memory).toHaveLength(2);

  // The recorded bundle binds the exact revisions. It restores unchanged, and
  // neither the outcome nor an item can be altered under the same digest.
  const recorded: {
    bundle: {
      memory: { revisions: { revision: number }[] };
      items: { boundedExcerpt: string }[];
    };
  } = JSON.parse(
    JSON.stringify({
      bundle: serializeContextBundle(privateTurn.bundle),
      bundleDigest: privateTurn.bundleDigest,
      modelContext: privateTurn.modelContext,
    }),
  );
  const restored = await restoreSessionTurnContext(recorded);
  expect(restored?.bundle.memory).toEqual(privateTurn.bundle.memory);
  const substituted = structuredClone(recorded);
  const firstRevision = substituted.bundle.memory.revisions[0];
  if (firstRevision === undefined) throw new Error("recorded revision missing");
  firstRevision.revision += 1;
  expect(await restoreSessionTurnContext(substituted)).toBeNull();
  const reworded = structuredClone(recorded);
  const firstItem = reworded.bundle.items[0];
  if (firstItem === undefined) throw new Error("recorded item missing");
  firstItem.boundedExcerpt = `${firstItem.boundedExcerpt} Or later.`;
  expect(await restoreSessionTurnContext(reworded)).toBeNull();

  // The same question in the shared conversation. The reviewer would receive
  // the reply and cannot receive the author's private Memory, so it is not
  // offered. Nothing in the bundle or the prompt says that one was withheld.
  const sharedTurn = await assemble(
    author,
    sharedConversationId,
    reader(author, sharedConversationId),
  );
  expect(sharedTurn.bundle.memory).toEqual({
    kind: "admitted",
    revisions: [{ memoryId: shared, revision: 1 }],
  });
  expect(sharedTurn.modelContext.memoryLimitation).toBeUndefined();
  expect(prompt(sharedTurn).text).toContain(SHARED_FACT);
  expect(prompt(sharedTurn).text).not.toContain(PRIVATE_FACT);
  expect(prompt(sharedTurn).text).not.toContain(MEMORY_LIMITATION_NOTICE);
  // The reviewer's own turn there admits the shared Memory too.
  const reviewerTurn = await assemble(
    reviewer,
    sharedConversationId,
    reader(reviewer, sharedConversationId),
  );
  expect(admittedIds(reviewerTurn)).toEqual([shared]);

  // A turn with no verified subject reads nothing and records `none`.
  const unscoped = await assemble(
    author,
    privateConversationId,
    turnMemoryReaderWithoutSubjects(),
  );
  expect(unscoped.bundle.memory).toEqual({ kind: "none" });
  // A bundle accepted before Memory admission has no Memory outcome. Its
  // stored form has no such key, and it still verifies under the digest it
  // had then. A bundle that does record an outcome cannot have it stripped.
  const { memory: _recordedOutcome, ...beforeAdmission } = unscoped.bundle;
  const historical: { bundle: object } = JSON.parse(
    JSON.stringify({
      bundle: serializeContextBundle(beforeAdmission),
      bundleDigest: await digestHistoricalContextBundle(beforeAdmission),
      modelContext: unscoped.modelContext,
    }),
  );
  expect("memory" in historical.bundle).toBe(false);
  const restoredHistorical = await restoreSessionTurnContext(historical);
  expect(restoredHistorical).not.toBeNull();
  expect(restoredHistorical?.bundle.memory).toBeUndefined();
  const stripped: { bundle: { memory?: unknown } } = structuredClone(recorded);
  delete stripped.bundle.memory;
  expect(await restoreSessionTurnContext(stripped)).toBeNull();

  // A dependency known to be gone excludes its Memory. The rest of the read
  // stands, because that is a fact about one record and not a failed lookup.
  const orphaned = await agentCandidate({
    ...content(
      "The primary supplier delivers before 07:00.",
      sharedEntry.evidence,
    ),
    validity: {
      timezone: "Australia/Sydney",
      effectiveFrom: "2026-10-01",
      effectiveUntil: null,
      dependsOn: [
        {
          kind: "case_observation",
          caseId: sharedEntry.evidence.caseId,
          entryId: "trigger:trigger_no_longer_present",
          digest: "0".repeat(64),
        },
      ],
    },
    evidence: [
      {
        kind: "case_observation",
        caseId: sharedEntry.evidence.caseId,
        entryId: "trigger:trigger_no_longer_present",
        digest: "0".repeat(64),
      },
    ],
  });
  const orphanAccepted = await organisation.commandMemory({
    organisationId,
    principal: { kind: "operator", personId: author.personId },
    body: {
      commandId: nextCommandId(),
      expectedRevision: 1,
      kind: "accept",
      memoryId: orphaned,
      revision: 1,
    } satisfies MemoryCommand,
    flowLabel: null,
  });
  expect(orphanAccepted).toMatchObject({ ok: true });
  const withOrphan = await assemble(
    author,
    privateConversationId,
    reader(author, privateConversationId),
  );
  expect(withOrphan.bundle.memory).toMatchObject({ kind: "admitted" });
  expect(admittedIds(withOrphan)).toEqual([shared, privateMemory].sort());

  // Validity is read on the turn's own date. In January only the January
  // fact held.
  const januaryTurn = await assemble(
    author,
    privateConversationId,
    reader(author, privateConversationId, { now: Date.UTC(2026, 0, 15) }),
  );
  expect(admittedIds(januaryTurn)).toEqual([expired]);

  // A read that outlives its deadline, or fails, is unavailable. That is not
  // a finding that nothing applies, and the model is told so. The late result
  // changes nothing.
  const real = reader(author, privateConversationId);
  const late = await assemble(author, privateConversationId, {
    read: async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return real.read(request);
    },
  });
  expect(late.bundle.memory).toEqual({
    kind: "unavailable",
    reason: "deadline",
  });
  expect(late.bundle.items.some((item) => item.source.kind === "memory")).toBe(
    false,
  );
  expect(late.modelContext.memoryLimitation).toBe("unavailable");
  expect(prompt(late).text).toContain(MEMORY_LIMITATION_NOTICE);
  // That turn restores with the outcome it recorded. A restore reads no
  // Memory again, and the next new turn reads Memory as it stands then.
  const restoredLate = await restoreSessionTurnContext(
    JSON.parse(
      JSON.stringify({
        bundle: serializeContextBundle(late.bundle),
        bundleDigest: late.bundleDigest,
        modelContext: late.modelContext,
      }),
    ),
  );
  expect(restoredLate?.bundle.memory).toEqual(late.bundle.memory);
  expect(restoredLate?.modelContext.memoryLimitation).toBe("unavailable");
  const afterLate = await assemble(author, privateConversationId, real);
  expect(afterLate.bundle.memory).toMatchObject({ kind: "admitted" });
  expect(admittedIds(afterLate)).toEqual(admittedIds(privateTurn));
  // So is a read that fails, a reader that reports a failed lookup, and a
  // destination check that could not decide. None of them becomes `none`.
  const unavailable = { kind: "unavailable", reason: "read_failed" };
  const failed = await assemble(author, privateConversationId, {
    read: () => Promise.reject(new Error("memory store offline")),
  });
  expect(failed.bundle.memory).toEqual(unavailable);
  const reported = await assemble(author, privateConversationId, {
    read: async () => ({ kind: "unavailable" }),
  });
  expect(reported.bundle.memory).toEqual(unavailable);
  const undecided = await assemble(
    author,
    privateConversationId,
    reader(author, privateConversationId, {
      destinationMayReceive: async () => "unavailable",
    }),
  );
  expect(undecided.bundle.memory).toEqual(unavailable);
  // Whereas a destination known to refuse every label yields `none`.
  const refused = await assemble(
    author,
    privateConversationId,
    reader(author, privateConversationId, {
      destinationMayReceive: async () => "deny",
    }),
  );
  expect(refused.bundle.memory).toEqual({ kind: "none" });
  // Persisted Memory that fails verification is a fault. The turn does not
  // proceed as if nothing applied.
  expect(
    await prepare(author, privateConversationId, {
      read: async () => ({ kind: "invalid_state" }),
    }),
  ).toEqual({ ok: false, error: { code: "memory_state_invalid" } });

  // More hidden Memory than one read page holds. None of it may reach this
  // conversation, so it neither crowds out a permitted revision nor shows up
  // as a limitation. The store reads in applicability order and every hidden
  // revision is filed under the supplier, so the Memory filed under the skill
  // is read only after all of them.
  const purchasing: MemoryContent["applicability"] = {
    kind: "skill",
    skillId: "skill_memory_purchasing",
  };
  expect(
    memoryApplicabilityKey(supplier("supplier_primary")) <
      memoryApplicabilityKey(purchasing),
  ).toBe(true);
  const afterHidden = await acceptedShared(
    content(SKILL_FACT, sharedEntry.evidence, { applicability: purchasing }),
  );
  const hiddenLabel = await FlowLabel.create([
    {
      owner: { kind: "organisation", organisationId },
      readers: [{ kind: "person", personId: "person_memory_elsewhere" }],
    },
  ]);
  if (!hiddenLabel.ok) throw new Error(hiddenLabel.error.code);
  const hidden: string[] = [];
  for (let index = 0; index < 40; index += 1)
    hidden.push(
      await acceptedByActor(
        content(
          `Hidden note ${index} about the primary supplier.`,
          sharedEntry.evidence,
        ),
        canonicalFlowLabel(hiddenLabel.value),
      ),
    );
  expect(hidden.length).toBeGreaterThan(TURN_MEMORY_PAGE);
  const amongHidden = await assemble(
    author,
    sharedConversationId,
    reader(author, sharedConversationId, {
      applicability: [supplier("supplier_primary"), purchasing],
    }),
  );
  expect(amongHidden.bundle.memory.kind).toBe("admitted");
  expect(admittedIds(amongHidden)).toEqual([shared, afterHidden].sort());
  expect(amongHidden.modelContext.memoryLimitation).toBeUndefined();
  expect(prompt(amongHidden).text).toContain(SKILL_FACT);
  expect(prompt(amongHidden).text).not.toContain(MEMORY_LIMITATION_NOTICE);
  expect(prompt(amongHidden).text).not.toContain("Hidden note");

  // Each attempt at a transient turn keeps its own record. A second attempt
  // adds one beside the first, the same attempt is reused unchanged, and a
  // recorded attempt cannot be rewritten.
  const sessionActor = await resolveActiveSessionActor({
    env,
    namespace: env.SESSION,
    organisationId,
    sessionId: privateIdentitiesValue.sessionId,
    now: Date.now(),
  });
  if (!sessionActor.ok) throw new Error(sessionActor.error.code);
  const attemptTurnId = "turn_memory_attempts";
  const attempt = (
    context: Awaited<ReturnType<typeof assemble>>,
    omittedForBytes = false,
  ) => ({
    turnId: attemptTurnId,
    organisationId,
    sessionId: privateIdentitiesValue.sessionId,
    context: { bundle: context.bundle, bundleDigest: context.bundleDigest },
    memoryRendering: {
      revisions: prompt(context).memory,
      omittedForBytes,
    },
  });
  const attempts = await runInDurableObject(
    sessionActor.value,
    async (_actor: unknown, durable: DurableObjectState) => {
      const sql = durable.storage.sql;
      return {
        first: recordTransientTurnContext(sql, attempt(privateTurn)),
        second: recordTransientTurnContext(sql, attempt(withOrphan)),
        repeated: recordTransientTurnContext(sql, attempt(privateTurn)),
        rewritten: recordTransientTurnContext(sql, attempt(privateTurn, true)),
        records: await readSessionTurnMemoryRecords(sql, {
          turnId: attemptTurnId,
          organisationId,
          sessionId: privateIdentitiesValue.sessionId,
        }),
      };
    },
  );
  expect(attempts).toMatchObject({
    first: { ok: true, value: "recorded" },
    second: { ok: true, value: "recorded" },
    repeated: { ok: true, value: "reused" },
    rewritten: { ok: false, error: { code: "invalid_persisted_state" } },
    records: {
      ok: true,
      value: [
        {
          bundleDigest: privateTurn.bundleDigest,
          rendering: { omittedForBytes: false },
        },
        { bundleDigest: withOrphan.bundleDigest },
      ],
    },
  });

  // An operator reads what became of Memory for each turn through the
  // execution read of the Case. A mail turn keeps no turn record: its Session
  // records the context of each run, with what the prompt carried. The runs
  // below are recorded that way in the Session of each chat's own assignment.
  const chatTurnOf = async (conversationId: ConversationId) => {
    const row = await fixtureDatabase().prepare(
      "SELECT case_id FROM portal_conversation WHERE organisation_id = ? AND conversation_id = ?",
    )
      .bind(organisationId, conversationId)
      .first<{ case_id: string }>();
    if (row === null) throw new Error("chat Case missing");
    const read = await readCaseExecution(
      organisationId,
      author.session,
      row.case_id,
      100,
    );
    const assignment = openNodes(read, "assignment")[0];
    const assignmentId = parseAssignmentId(assignment?.assignmentId ?? "");
    const sessionId = parseSessionId(assignment?.sessionId ?? "");
    if (!assignmentId.ok || !sessionId.ok)
      throw new Error("chat assignment missing");
    return {
      caseId: row.case_id,
      assignmentId: assignmentId.value,
      sessionId: sessionId.value,
    };
  };
  const recordRun = async (
    turn: Awaited<ReturnType<typeof chatTurnOf>>,
    turnId: string,
    context: Awaited<ReturnType<typeof assemble>>,
  ) => {
    const session = await resolveActiveSessionActor({
      env,
      namespace: env.SESSION,
      organisationId,
      sessionId: turn.sessionId,
      now: Date.now(),
    });
    if (!session.ok) throw new Error(session.error.code);
    expect(
      await runInDurableObject(
        session.value,
        (_actor: unknown, durable: DurableObjectState) =>
          recordTransientTurnContext(durable.storage.sql, {
            turnId,
            organisationId,
            sessionId: turn.sessionId,
            context,
            memoryRendering: {
              revisions: prompt(context).memory,
              omittedForBytes: false,
            },
          }),
      ),
    ).toEqual({ ok: true, value: "recorded" });
  };
  const turnsOf = async (
    person: Member,
    turn: Awaited<ReturnType<typeof chatTurnOf>>,
  ) => {
    const read = await readCaseExecution(
      organisationId,
      person.session,
      turn.caseId,
      100,
    );
    return {
      read,
      turns: read.nodes.filter((node) => node.kind === "turn"),
      open: openNodes(read, "turn"),
    };
  };

  // The private chat. One turn's read misses its deadline. Another turn's
  // read misses its deadline, and the turn runs again and is given Memory.
  const privateChat = await chatTurnOf(privateConversationId);
  const lateRun = await assemble(
    author,
    privateConversationId,
    {
      read: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return real.read(request);
      },
    },
    privateChat,
  );
  const secondRun = await assemble(
    author,
    privateConversationId,
    real,
    privateChat,
  );
  expect(lateRun.bundle.memory).toEqual(late.bundle.memory);
  expect(admittedIds(secondRun)).toEqual([shared, privateMemory].sort());
  const lateTurnId = "turn_memory_late";
  const retriedTurnId = "turn_memory_retried";
  await recordRun(privateChat, lateTurnId, lateRun);
  await recordRun(privateChat, retriedTurnId, lateRun);
  await recordRun(privateChat, retriedTurnId, secondRun);
  const privateRead = await turnsOf(author, privateChat);
  expect(privateRead.turns).toHaveLength(privateRead.open.length);
  const memoryOf = (turnId: string) =>
    privateRead.open.find((turn) => turn.turnId === turnId)?.memory;
  // The read missed its deadline. The turn says so, and does not say that
  // no Memory applies.
  expect(memoryOf(lateTurnId)).toEqual({
    kind: "unavailable",
    reason: "deadline",
  });
  // A turn that ran two times shows its later run. The count of the
  // revisions that run was given is all the read holds of them.
  expect(memoryOf(retriedTurnId)).toEqual({ kind: "admitted", revisions: 2 });
  // The chat's own turn has a turn record. It named no verified subject, so
  // its read completed and found nothing.
  expect(
    privateRead.open
      .filter((turn) => turn.state !== "unrecorded")
      .map((turn) => turn.memory),
  ).toEqual([{ kind: "none" }]);
  // A turn with no turn record has no start. Its one recorded link is the
  // assignment that its context record names.
  const contextTurns = privateRead.open.filter(
    (turn) => turn.state === "unrecorded",
  );
  expect(contextTurns.map((turn) => turn.turnId).sort()).toEqual(
    [lateTurnId, retriedTurnId].sort(),
  );
  for (const turn of contextTurns) {
    expect(turn.startedAt).toBeNull();
    expect(incoming(privateRead.read, turn.nodeId)).toEqual([
      "assignment:assignment",
    ]);
  }
  // No Memory identity and no Memory text is in the read, or in the detail
  // of the turn that was given Memory.
  const retried = contextTurns.find((turn) => turn.turnId === retriedTurnId);
  if (retried === undefined) throw new Error("retried turn missing");
  const retriedDetail = await readCaseExecutionDetail(
    organisationId,
    author.session,
    privateChat.caseId,
    retried.nodeId,
  );
  expect(retriedDetail.detail).toEqual({
    caseId: privateChat.caseId,
    node: retried,
    content: [],
    context: [],
  });
  const privateText = JSON.stringify([privateRead.read.nodes, retriedDetail]);
  for (const hidden of [shared, privateMemory, SHARED_FACT, PRIVATE_FACT])
    expect(privateText).not.toContain(hidden);

  // The shared chat. A turn there is given the shared Memory and the
  // author's private Memory, as a turn whose reply goes to the author alone.
  // The author reads its result. The reviewer may read the chat and may not
  // read the private Memory: the reviewer gets that turn withheld, with its
  // kind and no result, below an assignment that is open to both.
  const sharedChat = await chatTurnOf(sharedConversationId);
  const bothRun = await assemble(
    author,
    sharedConversationId,
    reader(author, sharedConversationId, {
      destinationMayReceive: conversationDestination(
        author,
        privateConversationId,
      ),
    }),
    sharedChat,
  );
  expect(admittedIds(bothRun)).toEqual([shared, privateMemory].sort());
  const bothTurnId = "turn_memory_private_and_shared";
  await recordRun(sharedChat, bothTurnId, bothRun);
  const authorRead = await turnsOf(author, sharedChat);
  const reviewerRead = await turnsOf(reviewer, sharedChat);
  expect(
    authorRead.open.find((turn) => turn.turnId === bothTurnId)?.memory,
  ).toEqual({ kind: "admitted", revisions: 2 });
  const withheldTurns = reviewerRead.turns.filter(
    (turn) => turn.access === "withheld",
  );
  expect(withheldTurns).toEqual([
    {
      nodeId: authorRead.open.find((turn) => turn.turnId === bothTurnId)
        ?.nodeId,
      kind: "turn",
      access: "withheld",
    },
  ]);
  expect(openNodes(reviewerRead.read, "assignment")).toEqual(
    openNodes(authorRead.read, "assignment"),
  );
  // The chat's own turn stays open to the reviewer, with its result.
  expect(reviewerRead.open.map((turn) => turn.memory)).toEqual([
    { kind: "none" },
  ]);
  // The Activity timeline summarises the same reads. The author's event for
  // the shared chat counts the turn's two Memory revisions. The reviewer's
  // event counts none of them: the turn is one withheld record, and the
  // timeline says nothing more of it.
  const timelineWindow = {
    from: Date.now() - 6 * 86_400_000,
    to: Date.now() + 60_000,
  };
  const authorTimeline = await readCaseTimeline(
    organisationId,
    author.session,
    timelineWindow,
  );
  const reviewerTimeline = await readCaseTimeline(
    organisationId,
    reviewer.session,
    timelineWindow,
  );
  expect([authorTimeline.status, reviewerTimeline.status]).toEqual([200, 200]);
  const authorEvent = authorTimeline.timeline?.cases.find(
    (event) => event.caseId === sharedChat.caseId,
  );
  const reviewerEvent = reviewerTimeline.timeline?.cases.find(
    (event) => event.caseId === sharedChat.caseId,
  );
  expect(authorEvent?.context?.memories).toBe(2);
  expect(authorEvent?.withheld).toBe(0);
  expect(reviewerEvent?.context?.memories ?? 0).toBe(0);
  expect(reviewerEvent?.withheld).toBe(withheldTurns.length);
  expect(reviewerEvent?.agent).toEqual(authorEvent?.agent);
  expect(JSON.stringify(reviewerTimeline.timeline)).not.toContain(
    privateMemory,
  );
  expect(
    (
      await readCaseExecutionDetail(
        organisationId,
        reviewer.session,
        sharedChat.caseId,
        withheldTurns[0]?.nodeId ?? "",
      )
    ).status,
  ).toBe(404);
  const turnMemoryExecution = {
    privateChat: {
      caseId: privateChat.caseId,
      turns: privateRead.open.map((turn) => ({
        turnId: turn.turnId,
        state: turn.state,
        memory: turn.memory,
        links: incoming(privateRead.read, turn.nodeId),
      })),
    },
    sharedChat: {
      caseId: sharedChat.caseId,
      author: authorRead.turns,
      reviewer: reviewerRead.turns,
    },
  };

  // The reviewer proposes a shared replacement for the accepted revision.
  // Turns keep the accepted revision while the replacement is under review,
  // and carry the replacement alone once it is accepted.
  const proposedReplacement = await command(reviewer, {
    commandId: nextCommandId(),
    expectedRevision: 1,
    kind: "propose",
    memoryId: shared,
    submission: "shared_review",
    content: content(REPLACEMENT_FACT, sharedEntry.evidence),
  });
  expect(
    proposedReplacement.status,
    JSON.stringify(proposedReplacement.body),
  ).toBe(200);
  const underReview = await assemble(
    author,
    sharedConversationId,
    reader(author, sharedConversationId),
  );
  expect(underReview.bundle.memory).toEqual({
    kind: "admitted",
    revisions: [{ memoryId: shared, revision: 1 }],
  });
  expect(prompt(underReview).text).toContain(SHARED_FACT);
  expect(prompt(underReview).text).not.toContain(REPLACEMENT_FACT);
  await decide("accept", shared, 2);
  const afterReplacement = await assemble(
    author,
    sharedConversationId,
    reader(author, sharedConversationId),
  );
  expect(afterReplacement.bundle.memory).toEqual({
    kind: "admitted",
    revisions: [{ memoryId: shared, revision: 2 }],
  });
  expect(prompt(afterReplacement).text).toContain(REPLACEMENT_FACT);
  expect(prompt(afterReplacement).text).not.toContain(SHARED_FACT);

  // Revocation ends use on the next turn.
  await decide("revoke", shared, 2);
  const afterRevocation = await assemble(
    author,
    sharedConversationId,
    reader(author, sharedConversationId),
  );
  expect(afterRevocation.bundle.memory).toEqual({ kind: "none" });
  expect(prompt(afterRevocation).text).not.toContain(REPLACEMENT_FACT);
  // The turn recorded while the first revision was in force still restores
  // with that revision, though it was replaced and the Memory then revoked.
  // The record of a turn keeps what the turn used. Nothing newer takes its
  // place, and the record gives the revision no standing for a new turn.
  const restoredEarlier = await restoreSessionTurnContext(
    JSON.parse(
      JSON.stringify({
        bundle: serializeContextBundle(underReview.bundle),
        bundleDigest: underReview.bundleDigest,
        modelContext: underReview.modelContext,
      }),
    ),
  );
  expect(restoredEarlier?.bundle.memory).toEqual({
    kind: "admitted",
    revisions: [{ memoryId: shared, revision: 1 }],
  });

  // More accepted Memory than the token limit holds. The turn keeps what
  // fits, records which revisions and why, and tells the model some is
  // missing. It does not record `none`.
  const long: string[] = [];
  for (const index of [1, 2, 3, 4])
    long.push(
      await acceptedShared(
        content(
          `Standing instruction ${index} for the primary supplier. ${"Confirm the delivery window before ordering. ".repeat(40)}`,
          sharedEntry.evidence,
        ),
      ),
    );
  const crowded = await assemble(
    author,
    sharedConversationId,
    reader(author, sharedConversationId),
  );
  expect(crowded.bundle.memory).toMatchObject({
    kind: "limited",
    reason: "tokens",
  });
  expect(admittedIds(crowded).length).toBeGreaterThan(0);
  expect(admittedIds(crowded).length).toBeLessThan(long.length);
  expect(crowded.modelContext.memoryLimitation).toBe("limited");
  expect(prompt(crowded).text).toContain(MEMORY_LIMITATION_NOTICE);
  // The prompt's own byte budget can omit more. The notice and the request
  // still render, and the render reports exactly what reached the model.
  const squeezed = renderModelContext(crowded.modelContext, QUESTION, 2_600);
  expect(squeezed.memoryOmittedForBytes).toBe(true);
  expect(squeezed.memory.length).toBeLessThan(admittedIds(crowded).length);
  expect(squeezed.text).toContain(MEMORY_LIMITATION_NOTICE);
  expect(squeezed.text.endsWith(QUESTION)).toBe(true);

  Object.assign(task.meta, {
    turnMemoryExecution,
    memoryAdmission: {
      memories: { shared, privateMemory, otherSupplier, expired, candidate },
      privateTurn: {
        outcome: privateTurn.bundle.memory,
        bundleDigest: privateTurn.bundleDigest,
      },
      sharedTurn: {
        outcome: sharedTurn.bundle.memory,
        bundleDigest: sharedTurn.bundleDigest,
      },
      reviewerTurn: reviewerTurn.bundle.memory,
      withoutSubjects: unscoped.bundle.memory,
      historicalBundleVerifies: restoredHistorical !== null,
      orphanedDependencyExcluded: !admittedIds(withOrphan).includes(orphaned),
      undecidedDestination: undecided.bundle.memory,
      refusedDestination: refused.bundle.memory,
      januaryTurn: januaryTurn.bundle.memory,
      lateRead: late.bundle.memory,
      lateReadRestored: restoredLate?.bundle.memory ?? null,
      turnAfterLateRead: afterLate.bundle.memory,
      replacedRevisionRestored: restoredEarlier?.bundle.memory ?? null,
      failedRead: failed.bundle.memory,
      sharedReplacement: {
        underReview: underReview.bundle.memory,
        afterAcceptance: afterReplacement.bundle.memory,
      },
      afterRevocation: afterRevocation.bundle.memory,
      crowded: crowded.bundle.memory,
      amongHiddenBeyondReadPage: {
        hiddenAccepted: hidden.length,
        readPage: TURN_MEMORY_PAGE,
        permittedReadAfterHidden: afterHidden,
        outcome: amongHidden.bundle.memory,
      },
      attemptRecords: attempts,
      promptByteOmission: {
        rendered: squeezed.memory,
        omitted: squeezed.memoryOmittedForBytes,
      },
    },
  });
}
