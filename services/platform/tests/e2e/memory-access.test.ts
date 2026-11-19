import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  newProjectId,
  type MemoryCommand,
  type MemoryContent,
} from "@purin-labs/control-api";
import {
  parseEntityRef,
  SUPPLIER_ENTITY_TYPE_ID,
} from "@purin-labs/commerce-client";
import {
  brainSummary,
  caseEntry,
  command,
  createConversation,
  ids,
  installMemoryFixture,
  instruct,
  instructionEntry,
  list,
  type Member,
  post,
  postJson,
  receiptMemoryId,
  storedConversation,
} from "./memory-support";

it(
  "releases a Memory only to people who can read its author and every cited record, and withholds it when a source is revoked",
  { timeout: 90_000 },
  memoryAccessJourney,
);

async function memoryAccessJourney({ task }: TestContext): Promise<void> {
  // The owner and a second administrator hold the context capability through
  // their roles. Role alone decides nothing further here. The third member's
  // role carries no such grant. The account authority admits these three, so
  // each of their control requests passes the real account check.
  const {
    organisationId,
    organisation,
    author,
    reviewer,
    viewer: ungranted,
    outsider,
    route,
    paths,
  } = await installMemoryFixture();
  const { chat: CHAT, projects: PROJECTS, memories: MEMORIES } = paths;
  // The author states the cutoff in a conversation shared with a Project.
  // Input accepted there carries the conversation's stable reader, which
  // Project members satisfy while they remain members.
  const projectId = newProjectId();
  expect(
    (
      await post(author, PROJECTS, {
        kind: "create_project",
        operationId: crypto.randomUUID(),
        projectId,
        content: {
          name: "Supplier operations",
          brief: "Supplier ordering notes.",
          references: [],
        },
      })
    ).status,
  ).toBe(200);
  const projectAccess = `${PROJECTS}/${projectId}/access`;
  expect(
    await postJson(author, projectAccess, {
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
  await instruct(author, sharedConversationId, "memory_access_shared");
  const sharedEntry = await instructionEntry(author, sharedConversationId);

  // The author repeats it in a private conversation. Private control input is
  // person-scoped, so that accepted Case entry names only the author.
  const privateConversationId = newConversationId();
  await createConversation(author, privateConversationId, route);
  await instruct(author, privateConversationId, "memory_access_private");
  const privateEntry = await instructionEntry(author, privateConversationId);
  const cited = privateEntry.evidence;
  const caseId = cited.caseId;
  const cutoff: MemoryContent = {
    memoryKind: "fact",
    statement: "Next-day orders for the primary supplier close at noon.",
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
      dependsOn: [cited],
    },
    evidence: [cited],
    sourceCaseId: caseId,
  };
  const citing = (evidence: typeof cited): MemoryContent => ({
    ...cutoff,
    validity: { ...cutoff.validity, dependsOn: [evidence] },
    evidence: [evidence],
    sourceCaseId: evidence.caseId,
  });
  const propose = (
    commandId: string,
    evidence: typeof cited = cited,
  ): MemoryCommand => ({
    commandId,
    expectedRevision: 0,
    kind: "propose",
    memoryId: null,
    submission: "own_input",
    content: citing(evidence),
  });

  // Before any Memory exists, nothing waits for anyone. Each later answer
  // to a person who may not read a Memory must equal this one, byte for byte.
  const nothingWaits = (await brainSummary(author)).text;
  expect((await brainSummary(author)).summary).toEqual({
    memoriesToReview: 0,
    evalsToReview: 0,
  });

  // A request names only the command. A supplied principal or label is refused.
  const forged = await post(author, `${MEMORIES}/commands`, {
    ...propose("memory_access_forged"),
    principal: { kind: "operator", personId: reviewer.personId },
    flowLabel: privateEntry.inputLabel,
  });
  expect(forged.status).toBe(422);
  expect(await forged.json()).toEqual({ ok: false, error: "memory_invalid" });

  const proposed = await command(author, propose("memory_access_author"));
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
  const authored = receiptMemoryId(proposed.body);

  // The author reads it. An administrator with the capability but no access
  // to the author's input or the cited conversation learns nothing, not even
  // a count, and one without the capability reads no Memory at all.
  expect(ids(await list(author))).toEqual([authored]);
  const authorList = await post(author, MEMORIES, null);
  expect(await authorList.text()).not.toMatch(/flowLabel|policies|readers/u);
  expect(await list(reviewer)).toEqual([]);
  expect((await post(ungranted, MEMORIES, null)).status).toBe(404);
  // The count of what waits follows the list. The candidate waits for the
  // author. The reviewer may decide but cannot read it, and the third member
  // can read nothing: each receives the answer of an empty Organisation.
  expect((await brainSummary(author)).summary.memoriesToReview).toBe(1);
  expect((await brainSummary(reviewer)).text).toBe(nothingWaits);
  expect((await brainSummary(ungranted)).text).toBe(nothingWaits);
  const accept = (
    memoryId: string,
    revision: number,
    commandId: string,
  ): MemoryCommand => ({
    commandId,
    expectedRevision: revision,
    kind: "accept",
    memoryId,
    revision,
  });
  // A hidden Memory and a missing one are indistinguishable to the reviewer.
  const blind = await command(
    reviewer,
    accept(authored, 1, "memory_access_blind_accept"),
  );
  const missing = await command(
    reviewer,
    accept("memory_does_not_exist", 1, "memory_access_missing_accept"),
  );
  expect([blind.status, blind.body]).toEqual([missing.status, missing.body]);
  expect(blind).toMatchObject({
    status: 404,
    body: { ok: false, error: "memory_unavailable" },
  });
  // The account authority decides before Pantry reads a role. It does not
  // admit the fourth person, who is an administrator of this Organisation
  // with a valid control session. Each of their requests is refused in one
  // way, whether the Memory exists or not.
  const outsiderRefusals = {
    list: await postJson(outsider, MEMORIES, null),
    summary: await postJson(outsider, paths.brainSummary, null),
    existing: await command(
      outsider,
      accept(authored, 1, "memory_access_outsider_accept"),
    ),
    missing: await command(
      outsider,
      accept("memory_does_not_exist", 1, "memory_access_outsider_missing"),
    ),
  };
  for (const refusal of Object.values(outsiderRefusals))
    expect(refusal).toEqual({
      status: 404,
      body: { ok: false, error: "membership_ineligible" },
    });
  // Nor can the reviewer cite a record they cannot read.
  expect(
    await command(reviewer, propose("memory_access_unreadable_evidence")),
  ).toMatchObject({ status: 404, body: { error: "memory_unavailable" } });

  const accepted = await command(
    author,
    accept(authored, 1, "memory_access_author_accept"),
  );
  expect(accepted).toMatchObject({
    status: 200,
    body: { receipt: { state: "accepted", revision: 1 } },
  });

  // Reading the shared source reveals nothing of the author's private Memory.
  expect(await list(reviewer)).toEqual([]);
  // An accepted Memory waits for no one.
  expect((await brainSummary(author)).text).toBe(nothingWaits);

  // The reviewer may cite the shared record. Their Memory carries their own
  // input label, so the author in turn cannot read it.
  const reviewerProposed = await command(
    reviewer,
    propose("memory_access_reviewer", sharedEntry.evidence),
  );
  expect(reviewerProposed.status, JSON.stringify(reviewerProposed.body)).toBe(
    200,
  );
  const reviewed = receiptMemoryId(reviewerProposed.body);
  expect(ids(await list(reviewer))).toEqual([reviewed]);
  expect(ids(await list(author))).toEqual([authored]);

  // An agent's candidate from the shared conversation carries that
  // conversation's label alone, so both people can inspect it. The agent
  // proposal path is not built yet; the Actor command stands in for it here.
  const agentProposed = await organisation.commandMemory({
    organisationId,
    principal: {
      kind: "agent",
      caseId: sharedEntry.evidence.caseId,
      assignmentId: "assignment_memory_access",
      sessionId: "session_memory_access",
    },
    body: propose("memory_access_agent", sharedEntry.evidence),
    flowLabel: sharedEntry.inputLabel,
  });
  if (!agentProposed.ok) throw new Error(JSON.stringify(agentProposed.error));
  const shared = agentProposed.value.memoryId;
  expect(ids(await list(author))).toEqual([authored, shared].sort());
  expect(ids(await list(reviewer))).toEqual([reviewed, shared].sort());
  // Both may decide the shared candidate. The reviewer's own candidate waits
  // for the reviewer alone.
  expect((await brainSummary(author)).summary.memoriesToReview).toBe(1);
  expect((await brainSummary(reviewer)).summary.memoriesToReview).toBe(2);

  // The reviewer edits it on the shared review surface. The edit keeps the
  // candidate's label and adds no private clause, so the author, a permitted
  // second operator, still reads both revisions and accepts the edit.
  const edit = (
    memoryId: string,
    commandId: string,
    expectedRevision: number,
    submission: "own_input" | "shared_review",
  ): MemoryCommand => ({
    commandId,
    expectedRevision,
    kind: "propose",
    memoryId,
    submission,
    content: {
      ...citing(sharedEntry.evidence),
      statement: `Primary supplier cutoff: 12:00 Sydney (${commandId}).`,
    },
  });
  expect(
    await command(
      reviewer,
      edit(shared, "memory_access_shared_edit", 1, "shared_review"),
    ),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 2, state: "candidate" } },
  });
  const authorView = (await list(author)).find(
    (memory) => memory.memoryId === shared,
  );
  expect(authorView?.revisions.map((revision) => revision.kind)).toEqual([
    "rejected",
    "candidate",
  ]);
  expect(authorView?.revisions[1]?.proposedBy).toEqual({
    kind: "operator",
    personId: reviewer.personId,
    submission: "shared_review",
  });
  expect(
    await command(author, accept(shared, 2, "memory_access_shared_accept")),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 2, state: "accepted" } },
  });
  // A shared accepted Memory takes a shared replacement. The reviewer
  // proposes one against the accepted revision. It inherits that revision's
  // label, so the author reads it, and the accepted revision stays in force.
  const labelDigests = async (memoryId: string): Promise<readonly string[]> => {
    const stored = await organisation.readMemories({
      organisationId,
    });
    if (!stored.ok) throw new Error(JSON.stringify(stored.error));
    return (
      stored.value.find((memory) => memory.memoryId === memoryId)?.revisions ??
      []
    ).map((revision) => revision.flowLabel.digest);
  };
  const states = async (person: Member, memoryId: string) =>
    (await list(person))
      .find((memory) => memory.memoryId === memoryId)
      ?.revisions.map((revision) => revision.kind);
  const replacement = edit(
    shared,
    "memory_access_replacement",
    2,
    "shared_review",
  );
  const replaced = await command(reviewer, replacement);
  expect(replaced).toMatchObject({
    status: 200,
    body: { receipt: { revision: 3, state: "candidate" } },
  });
  expect(await states(author, shared)).toEqual([
    "rejected",
    "accepted",
    "candidate",
  ]);
  // Sent again, the command returns its receipt and adds no revision.
  expect(await command(reviewer, replacement)).toEqual(replaced);
  // A replacement is bound to the revision its author read. One bound to the
  // accepted revision is refused now that a newer revision exists.
  expect(
    await command(
      author,
      edit(shared, "memory_access_stale_replacement", 2, "shared_review"),
    ),
  ).toMatchObject({ status: 409, body: { error: "memory_conflict" } });
  // The author declines it. The accepted revision is no longer the latest,
  // and the next replacement still inherits from it.
  expect(
    await command(author, {
      commandId: "memory_access_replacement_declined",
      expectedRevision: 3,
      kind: "reject",
      memoryId: shared,
      revision: 3,
    }),
  ).toMatchObject({ status: 200, body: { receipt: { state: "rejected" } } });
  expect(
    await command(
      reviewer,
      edit(shared, "memory_access_second_replacement", 3, "shared_review"),
    ),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 4, state: "candidate" } },
  });
  const sharedLabels = await labelDigests(shared);
  expect(sharedLabels).toHaveLength(4);
  expect(sharedLabels[2]).toBe(sharedLabels[1]);
  expect(sharedLabels[3]).toBe(sharedLabels[1]);
  // Accepting the replacement supersedes the revision it replaces.
  expect(
    await command(
      author,
      accept(shared, 4, "memory_access_replacement_accept"),
    ),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 4, state: "accepted" } },
  });
  const replacedView = (await list(reviewer)).find(
    (memory) => memory.memoryId === shared,
  );
  expect(replacedView?.revisions.map((revision) => revision.kind)).toEqual([
    "rejected",
    "superseded",
    "rejected",
    "accepted",
  ]);
  expect(replacedView?.revisions[1]).toMatchObject({
    supersession: { replacementRevision: 4 },
  });

  // A private revision stays private. The reviewer revises a second agent
  // candidate as their own input, so one revision is now hidden from the
  // author, who loses the whole inspector view and cannot decide it.
  const second = await organisation.commandMemory({
    organisationId,
    principal: {
      kind: "agent",
      caseId: sharedEntry.evidence.caseId,
      assignmentId: "assignment_memory_access",
      sessionId: "session_memory_access",
    },
    body: propose("memory_access_agent_second", sharedEntry.evidence),
    flowLabel: sharedEntry.inputLabel,
  });
  if (!second.ok) throw new Error(JSON.stringify(second.error));
  const privatelyRevised = second.value.memoryId;
  expect(ids(await list(author))).toEqual(
    [authored, shared, privatelyRevised].sort(),
  );
  expect(
    await command(
      reviewer,
      edit(privatelyRevised, "memory_access_private_edit", 1, "own_input"),
    ),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 2, state: "candidate" } },
  });
  expect(ids(await list(author))).toEqual([authored, shared].sort());
  expect(
    await command(
      author,
      accept(privatelyRevised, 2, "memory_access_author_blind"),
    ),
  ).toMatchObject({ status: 404, body: { error: "memory_unavailable" } });
  // A shared edit of that private candidate inherits its private label. It
  // does not widen the reviewer's private input to the conversation.
  expect(
    await command(
      reviewer,
      edit(privatelyRevised, "memory_access_no_widening", 2, "shared_review"),
    ),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 3, state: "candidate" } },
  });
  expect(ids(await list(author))).toEqual([authored, shared].sort());
  const storedMemories = await organisation.readMemories({
    organisationId,
  });
  if (!storedMemories.ok) throw new Error(JSON.stringify(storedMemories.error));
  const storedRevisions =
    storedMemories.value.find((memory) => memory.memoryId === privatelyRevised)
      ?.revisions ?? [];
  expect(storedRevisions[2]?.flowLabel.digest).toBe(
    storedRevisions[1]?.flowLabel.digest,
  );
  expect(storedRevisions[1]?.flowLabel.digest).not.toBe(
    storedRevisions[0]?.flowLabel.digest,
  );
  // The Actor refuses a shared edit whose label drops one of the candidate's
  // restrictions, whoever assembled that label.
  expect(
    await organisation.commandMemory({
      organisationId,
      principal: { kind: "operator", personId: reviewer.personId },
      body: edit(
        privatelyRevised,
        "memory_access_dropped_restriction",
        3,
        "shared_review",
      ),
      flowLabel: sharedEntry.inputLabel,
    }),
  ).toEqual({ ok: false, error: { code: "memory_invalid" } });
  // Acceptance changes none of that. A replacement for the accepted private
  // revision is refused under the conversation's label alone, and one made
  // on the review surface keeps the private label and stays hidden.
  expect(
    await command(
      reviewer,
      accept(privatelyRevised, 3, "memory_access_private_accept"),
    ),
  ).toMatchObject({ status: 200, body: { receipt: { state: "accepted" } } });
  expect(
    await organisation.commandMemory({
      organisationId,
      principal: { kind: "operator", personId: reviewer.personId },
      body: edit(
        privatelyRevised,
        "memory_access_replacement_dropped_restriction",
        3,
        "shared_review",
      ),
      flowLabel: sharedEntry.inputLabel,
    }),
  ).toEqual({ ok: false, error: { code: "memory_invalid" } });
  expect(
    await command(
      reviewer,
      edit(
        privatelyRevised,
        "memory_access_private_replacement",
        3,
        "shared_review",
      ),
    ),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 4, state: "candidate" } },
  });
  const privateLabels = await labelDigests(privatelyRevised);
  expect(privateLabels[3]).toBe(privateLabels[2]);
  expect(ids(await list(author))).toEqual([authored, shared].sort());

  // An operator instruction is a message a person wrote. The agent's reply in
  // the same conversation is readable evidence, and not an instruction.
  const reply = await caseEntry(
    author,
    sharedConversationId,
    "Noted the supplier cutoff",
    "case_observation",
  );
  const citingReply = (
    commandId: string,
    kind: "case_observation" | "operator_instruction",
  ): MemoryCommand =>
    propose(commandId, { ...reply.evidence, kind } as typeof cited);
  expect(
    await command(
      author,
      citingReply("memory_access_reply_as_instruction", "operator_instruction"),
    ),
  ).toMatchObject({ status: 422, body: { error: "memory_invalid" } });
  const observed = await command(
    author,
    citingReply("memory_access_reply_as_observation", "case_observation"),
  );
  expect(observed.status, JSON.stringify(observed.body)).toBe(200);
  const fromReply = receiptMemoryId(observed.body);
  // Once its only candidate is declined, that Memory has no candidate under
  // review and no accepted revision. A shared edit has nothing to inherit.
  expect(
    await command(author, {
      commandId: "memory_access_reply_declined",
      expectedRevision: 1,
      kind: "reject",
      memoryId: fromReply,
      revision: 1,
    }),
  ).toMatchObject({ status: 200, body: { receipt: { state: "rejected" } } });
  expect(
    await command(
      author,
      edit(fromReply, "memory_access_nothing_to_inherit", 1, "shared_review"),
    ),
  ).toMatchObject({ status: 409, body: { error: "memory_conflict" } });

  // Two candidates wait for the reviewer: their own, and the replacement of
  // the Memory they revised privately. Neither waits for the author.
  const beforeRevocation = {
    reviewer: (await brainSummary(reviewer)).summary.memoriesToReview,
    author: (await brainSummary(author)).summary.memoriesToReview,
  };
  expect(beforeRevocation).toEqual({ reviewer: 2, author: 0 });

  // Revoke the reviewer's access to the source. Every Memory that cites it
  // disappears for them, including the one they wrote, and they can no longer
  // decide either.
  const revoked = await postJson(author, projectAccess, {
    kind: "remove_project_member",
    operationId: crypto.randomUUID(),
    expectedAccessRevision: 1,
    userId: reviewer.userId,
  });
  expect(revoked).toMatchObject({ status: 200 });
  expect(revoked.body).not.toMatchObject({ kind: "rejected" });
  expect(await list(reviewer)).toEqual([]);
  expect((await brainSummary(reviewer)).text).toBe(nothingWaits);
  expect(
    await command(
      reviewer,
      accept(reviewed, 1, "memory_access_revoked_accept"),
    ),
  ).toMatchObject({ status: 404, body: { error: "memory_unavailable" } });
  // The author's own access is unchanged.
  expect(ids(await list(author))).toEqual([authored, shared, fromReply].sort());

  Object.assign(task.meta, {
    memoryAccess: {
      citedEntries: {
        private: privateEntry.evidence,
        shared: sharedEntry.evidence,
      },
      memories: { authored, reviewed, shared, privatelyRevised, fromReply },
      sharedReview: {
        editedBy: reviewer.personId,
        acceptedBy: author.personId,
        privateEditLabelInherited:
          storedRevisions[2]?.flowLabel.digest ===
          storedRevisions[1]?.flowLabel.digest,
      },
      sharedReplacement: {
        proposedBy: reviewer.personId,
        decidedBy: author.personId,
        repeatedCommand: replaced.body,
        states: replacedView?.revisions.map((revision) => revision.kind),
        labelDigests: sharedLabels,
        privateReplacementLabelDigests: privateLabels,
      },
      forgedRequestStatus: forged.status,
      hiddenAndMissingIndistinguishable: {
        hidden: blind,
        missing,
      },
      ungrantedStatus: 404,
      notAdmittedByAccountAuthority: outsiderRefusals,
      brainSummary: {
        emptyOrganisation: nothingWaits,
        waitingBeforeSourceRevocation: beforeRevocation,
        reviewerAfterSourceRevocation: nothingWaits,
      },
      afterSourceRevocation: {
        reviewerVisible: 0,
        authorVisible: [authored, shared, fromReply],
      },
    },
  });
}
