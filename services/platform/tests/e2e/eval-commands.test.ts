import { evictDurableObject } from "cloudflare:test";
import { expect, it, type TestContext } from "vitest";
import {
  newConversationId,
  newProjectId,
  parseEvalListResponse,
  type EvalCommand,
  type EvalContent,
  type EvalScenario,
  type EvalView,
} from "@purin-labs/control-api";
import { isRecord } from "@purin-labs/std";
import {
  brainSummary,
  controlPaths,
  createConversation,
  installMemoryFixture,
  instruct,
  instructionEntry,
  type Member,
  post,
  postJson,
  storedConversation,
} from "./memory-support";
import { OTHER_ORGANISATION_ID } from "./slack-journey-support";

const MAILBOX = "integration_account_eval_mailbox";

it(
  "keeps an Eval's review to people who can read what it was built from, through revisions, replacement and Actor replacement",
  { timeout: 120_000 },
  evalCommandJourney,
);

async function evalCommandJourney({ task }: TestContext): Promise<void> {
  // The account authority admits the owner, a second administrator and a
  // member whose role carries no context access. Each of their control
  // requests passes the real account check.
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
  const { chat: CHAT, projects: PROJECTS, evals: EVALS } = paths;

  // The author states the cutoff in a conversation shared with a Project the
  // reviewer belongs to, and again in a private conversation.
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
  await instruct(author, sharedConversationId, "eval_commands_shared");
  const sharedEntry = await instructionEntry(author, sharedConversationId);
  const privateConversationId = newConversationId();
  await createConversation(author, privateConversationId, route);
  await instruct(author, privateConversationId, "eval_commands_private");
  const privateEntry = await instructionEntry(author, privateConversationId);

  const lateRequest: EvalScenario = {
    scenarioId: "late_change",
    role: "target",
    title: "Order change after the cutoff",
    sender: { verificationId: "verification_primary_supplier", revision: 1 },
    message: {
      subject: "Change to tomorrow's order",
      body: "Please add ten cases of butter to tomorrow's delivery.",
      receivedAt: Date.UTC(2026, 9, 12, 4, 30),
      timezone: "Australia/Sydney",
    },
    criteria: [
      {
        criterionId: "escalates",
        kind: "outcome",
        expected: "approval_required",
      },
    ],
  };
  const content = (
    scenarios: readonly EvalScenario[],
    evidence: EvalContent["evidence"] = [sharedEntry.evidence],
  ): EvalContent => ({
    title: "Next-day order cutoff",
    subject: { kind: "mailbox_reply", integrationAccountId: MAILBOX },
    scenarios,
    evidence,
    sourceCaseId: sharedEntry.evidence.caseId,
  });
  const agent = {
    kind: "agent",
    caseId: sharedEntry.evidence.caseId,
    assignmentId: "assignment_eval_commands",
    sessionId: "session_eval_commands",
  };

  // Before any Eval exists, nothing waits for anyone.
  const nothingWaits = (await brainSummary(author)).text;

  // Pantry opens the Eval from the shared Case. Its label is that Case
  // entry's label, so both people who read the entry can review the Eval.
  const proposal = {
    commandId: "eval_commands_propose",
    content: content([lateRequest]),
  };
  const proposed = await organisation.commandEval({
    organisationId,
    principal: agent,
    body: proposal,
    flowLabel: sharedEntry.inputLabel,
  });
  if (!proposed.ok) throw new Error(JSON.stringify(proposed.error));
  const evalId = proposed.value.evalId;
  expect(proposed.value).toMatchObject({
    revision: 1,
    headRevision: 1,
    state: "candidate",
  });
  expect(ids(await list(author))).toEqual([evalId]);
  expect(ids(await list(reviewer))).toEqual([evalId]);
  const authorList = await post(author, EVALS, null);
  expect(await authorList.text()).not.toMatch(/flowLabel|policies|readers/u);
  expect((await post(ungranted, EVALS, null)).status).toBe(404);
  // The count of what waits follows the list. The Eval waits for each person
  // who reads it and may decide it. The third member receives the answer of
  // an Organisation with no records.
  expect((await brainSummary(author)).summary).toEqual({
    memoriesToReview: 0,
    evalsToReview: 1,
  });
  expect((await brainSummary(reviewer)).summary.evalsToReview).toBe(1);
  expect((await brainSummary(ungranted)).text).toBe(nothingWaits);

  // Pantry proposes and has no branch that revises or decides. A person has
  // no branch that opens an Eval, and no request names its own principal.
  const accept = (
    revision: number,
    expectedRevision: number,
    commandId = `eval_commands_accept_${revision}`,
  ): EvalCommand => ({
    commandId,
    evalId,
    expectedRevision,
    kind: "accept",
    revision,
  });
  // The account authority decides before Pantry reads a role. It does not
  // admit the fourth person, who is an administrator of this Organisation
  // with a valid control session. Their read and their decision are refused
  // in one way, and the Eval stays a candidate.
  const outsiderRefusals = {
    list: await postJson(outsider, EVALS, null),
    summary: await postJson(outsider, paths.brainSummary, null),
    accept: await command(
      outsider,
      accept(1, 1, "eval_commands_outsider_accept"),
    ),
  };
  for (const refusal of Object.values(outsiderRefusals))
    expect(refusal).toEqual({
      status: 404,
      body: { ok: false, error: "membership_ineligible" },
    });
  expect(await states(author, evalId)).toEqual(["candidate"]);
  expect(
    await organisation.commandEval({
      organisationId,
      principal: agent,
      body: accept(1, 1),
      flowLabel: null,
    }),
  ).toEqual({ ok: false, error: { code: "eval_reviewer_required" } });
  expect(
    await organisation.commandEval({
      organisationId,
      principal: { kind: "operator", personId: author.personId },
      body: { ...proposal, commandId: "eval_commands_person_opens" },
      flowLabel: sharedEntry.inputLabel,
    }),
  ).toEqual({ ok: false, error: { code: "eval_invalid" } });
  const revise = (
    commandId: string,
    expectedRevision: number,
    next: EvalContent,
  ): EvalCommand => ({
    commandId,
    evalId,
    expectedRevision,
    kind: "revise",
    content: next,
  });
  const forged = await post(author, `${EVALS}/commands`, {
    ...accept(1, 1, "eval_commands_forged"),
    principal: { kind: "operator", personId: reviewer.personId },
  });
  expect(forged.status).toBe(422);
  expect(await forged.json()).toEqual({ ok: false, error: "eval_invalid" });

  // The reviewer adds the two controls on the shared review surface. The
  // revision keeps the candidate's label, so the author reads both.
  const earlyRequest: EvalScenario = {
    ...lateRequest,
    scenarioId: "early_change",
    role: "control",
    title: "Order change before the cutoff",
    message: {
      ...lateRequest.message,
      receivedAt: Date.UTC(2026, 9, 11, 22, 30),
    },
    criteria: [
      { criterionId: "answers", kind: "outcome", expected: "reply_now" },
    ],
  };
  const otherSupplier: EvalScenario = {
    ...lateRequest,
    scenarioId: "other_supplier",
    role: "control",
    title: "The same request from another supplier",
    sender: { verificationId: "verification_secondary_supplier", revision: 1 },
    criteria: [
      { criterionId: "answers", kind: "outcome", expected: "reply_now" },
      { criterionId: "no_cutoff", kind: "reply_excludes", text: "cutoff" },
    ],
  };
  const reviewed = content([lateRequest, earlyRequest, otherSupplier]);
  const firstRevision = revise("eval_commands_revise", 1, reviewed);
  const revised = await command(reviewer, firstRevision);
  expect(revised).toMatchObject({
    status: 200,
    body: { receipt: { revision: 2, headRevision: 2, state: "candidate" } },
  });
  const afterRevision = (await list(author))[0];
  expect(afterRevision?.revisions.map((revision) => revision.kind)).toEqual([
    "rejected",
    "candidate",
  ]);
  expect(afterRevision?.revisions[0]).toMatchObject({
    proposedBy: agent,
    rejection: {
      reason: "revised",
      replacementRevision: 2,
      reviewerPersonId: reviewer.personId,
    },
  });
  expect(afterRevision?.revisions[1]).toMatchObject({
    proposedBy: { kind: "operator", personId: reviewer.personId },
    scenarios: [
      { scenarioId: "late_change", role: "target" },
      { scenarioId: "early_change", role: "control" },
      { scenarioId: "other_supplier", role: "control" },
    ],
  });

  // The Actor holds a revision's label to the revision it inherits from,
  // whoever assembled it: one without the candidate's policies is refused.
  expect(
    await organisation.commandEval({
      organisationId,
      principal: { kind: "operator", personId: author.personId },
      body: revise("eval_commands_narrow_label", 2, reviewed),
      flowLabel: privateEntry.inputLabel,
    }),
  ).toEqual({ ok: false, error: { code: "eval_invalid" } });

  // A revision cannot cite a record its author cannot read, point the Eval
  // at another agent, drop its target, or build on a view that is stale.
  expect(
    await command(
      reviewer,
      revise(
        "eval_commands_unreadable",
        2,
        content(reviewed.scenarios, [
          sharedEntry.evidence,
          privateEntry.evidence,
        ]),
      ),
    ),
  ).toMatchObject({ status: 404, body: { error: "eval_unavailable" } });
  expect(
    await command(
      author,
      revise("eval_commands_other_agent", 2, {
        ...reviewed,
        subject: {
          kind: "mailbox_reply",
          integrationAccountId: "integration_account_other_mailbox",
        },
      }),
    ),
  ).toMatchObject({ status: 422, body: { error: "eval_invalid" } });
  expect(
    await command(
      author,
      revise(
        "eval_commands_controls_only",
        2,
        content([earlyRequest, otherSupplier]),
      ),
    ),
  ).toMatchObject({ status: 422, body: { error: "eval_invalid" } });
  // An arrival time that is no date is refused. A date formatter throws on
  // it, in the Portal and in the turn.
  expect(
    await command(
      author,
      revise(
        "eval_commands_no_date",
        2,
        content([
          {
            ...lateRequest,
            message: {
              ...lateRequest.message,
              receivedAt: 9_000_000_000_000_000,
            },
          },
          earlyRequest,
          otherSupplier,
        ]),
      ),
    ),
  ).toMatchObject({ status: 422, body: { error: "eval_invalid" } });
  expect(
    await command(author, revise("eval_commands_stale", 1, reviewed)),
  ).toMatchObject({ status: 409, body: { error: "eval_conflict" } });
  expect(await command(author, accept(1, 2))).toMatchObject({
    status: 409,
    body: { error: "eval_conflict" },
  });

  // The author accepts the reviewed criteria. One decision stands across a
  // replacement of the Actor, and its identity carries no other decision.
  const accepted = await command(author, accept(2, 2));
  expect(accepted).toMatchObject({
    status: 200,
    body: { receipt: { revision: 2, state: "accepted" } },
  });
  await evictDurableObject(organisation);
  expect(await command(author, accept(2, 2))).toEqual(accepted);
  // An accepted Eval waits for no one.
  expect((await brainSummary(reviewer)).text).toBe(nothingWaits);
  expect(
    await command(author, {
      commandId: accept(2, 2).commandId,
      evalId,
      expectedRevision: 2,
      kind: "reject",
      revision: 2,
    }),
  ).toMatchObject({ status: 409, body: { error: "eval_command_conflict" } });

  // A replacement is proposed against the accepted revision, which stays in
  // force until the replacement is accepted and then names it.
  const tightened = content([
    {
      ...lateRequest,
      criteria: [
        ...lateRequest.criteria,
        { criterionId: "names_cutoff", kind: "reply_includes", text: "noon" },
      ],
    },
    earlyRequest,
    otherSupplier,
  ]);
  expect(
    await command(reviewer, revise("eval_commands_replace", 2, tightened)),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 3, state: "candidate" } },
  });
  expect(await states(author, evalId)).toEqual([
    "rejected",
    "accepted",
    "candidate",
  ]);
  expect(await command(author, accept(3, 3))).toMatchObject({
    status: 200,
    body: { receipt: { revision: 3, state: "accepted" } },
  });
  const replaced = (await list(reviewer))[0];
  expect(replaced?.revisions[1]).toMatchObject({
    kind: "superseded",
    supersession: { replacementRevision: 3 },
  });

  // The author now cites their private note. The revision joins that note's
  // label, so the reviewer, who cannot read the note, loses the whole Eval:
  // a hidden Eval and a missing one are indistinguishable to them.
  expect(
    await command(
      author,
      revise(
        "eval_commands_private_evidence",
        3,
        content(tightened.scenarios, [
          sharedEntry.evidence,
          privateEntry.evidence,
        ]),
      ),
    ),
  ).toMatchObject({
    status: 200,
    body: { receipt: { revision: 4, state: "candidate" } },
  });
  expect(await list(reviewer)).toEqual([]);
  // The private revision waits for its author. The reviewer, who can no
  // longer read the Eval, learns nothing from the count either.
  expect((await brainSummary(author)).summary.evalsToReview).toBe(1);
  expect((await brainSummary(reviewer)).text).toBe(nothingWaits);
  const blind = await command(
    reviewer,
    accept(4, 4, "eval_commands_blind_accept"),
  );
  const missing = await command(reviewer, {
    ...accept(4, 4, "eval_commands_missing_accept"),
    evalId: "eval_does_not_exist",
  });
  expect([blind.status, blind.body]).toEqual([missing.status, missing.body]);
  expect(blind).toMatchObject({
    status: 404,
    body: { ok: false, error: "eval_unavailable" },
  });
  expect(await states(author, evalId)).toEqual([
    "rejected",
    "superseded",
    "accepted",
    "candidate",
  ]);
  const stored = await organisation.readEvals({
    organisationId,
  });
  if (!stored.ok) throw new Error(JSON.stringify(stored.error));
  const digests = (stored.value[0]?.revisions ?? []).map(
    (revision) => revision.flowLabel.digest,
  );
  expect(new Set(digests.slice(0, 3)).size).toBe(1);
  expect(digests[3]).not.toBe(digests[0]);

  // Declining the private revision and revoking the accepted one both keep
  // the history they decide.
  expect(
    await command(author, {
      commandId: "eval_commands_decline",
      evalId,
      expectedRevision: 4,
      kind: "reject",
      revision: 4,
    }),
  ).toMatchObject({ status: 200, body: { receipt: { state: "rejected" } } });
  const revoke: EvalCommand = {
    commandId: "eval_commands_revoke",
    evalId,
    expectedRevision: 4,
    kind: "revoke",
    revision: 3,
  };
  const revoked = await command(author, revoke);
  expect(revoked).toMatchObject({
    status: 200,
    body: { receipt: { revision: 3, state: "revoked" } },
  });
  await evictDurableObject(organisation);
  expect(await command(author, revoke)).toEqual(revoked);
  const final = (await list(author))[0];
  expect(final?.revisions[2]).toMatchObject({
    kind: "revoked",
    acceptance: { commandId: accept(3, 3).commandId },
    revocation: { commandId: revoke.commandId },
  });

  // The limit of 200 Evals counts those in use or under review. The Eval
  // above is declined and revoked, so Pantry opens 200 more beside it.
  const open = (commandId: string) =>
    organisation.commandEval({
      organisationId,
      principal: agent,
      body: { commandId, content: content([lateRequest]) },
      flowLabel: sharedEntry.inputLabel,
    });
  const opened: string[] = [];
  for (let index = 0; index < 200; index += 1) {
    const next = await open(`eval_commands_fill_${index}`);
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    opened.push(next.value.evalId);
  }
  expect(new Set(opened).size).toBe(200);
  // One more is refused. The retired Eval cannot return to review through a
  // revision, so nothing passes the limit that way.
  const full = { ok: false, error: { code: "eval_capacity_exceeded" } };
  expect(await open("eval_commands_over")).toMatchObject(full);
  expect(
    await command(author, revise("eval_commands_return", 4, tightened)),
  ).toMatchObject({ status: 409, body: { error: "eval_conflict" } });
  // A person declines one Eval. That makes room for one more, and no more.
  expect(
    await command(author, {
      commandId: "eval_commands_make_room",
      evalId: opened[0] ?? "",
      expectedRevision: 1,
      kind: "reject",
      revision: 1,
    }),
  ).toMatchObject({ status: 200, body: { receipt: { state: "rejected" } } });
  expect(await open("eval_commands_after_room")).toMatchObject({
    ok: true,
    value: { revision: 1, state: "candidate" },
  });
  expect(await open("eval_commands_over_again")).toMatchObject(full);

  // Another organisation's identity reaches nothing through this Actor.
  expect(
    await organisation.readEvals({ organisationId: OTHER_ORGANISATION_ID }),
  ).toMatchObject({ ok: false });

  Object.assign(task.meta, {
    evalCommands: {
      evalId,
      receipts: { proposed: proposed.value, accepted: accepted.body },
      states: final?.revisions.map((revision) => ({
        revision: revision.revision,
        state: revision.kind,
        scenarios: revision.scenarios.map((scenario) => scenario.scenarioId),
      })),
      labelDigests: digests,
      hiddenFromReviewerAfterPrivateEvidence: true,
      limit: { inUseOrUnderReview: 200, recordsHeld: 202 },
      notAdmittedByAccountAuthority: outsiderRefusals,
    },
  });
}

async function command(
  user: Member,
  body: EvalCommand,
): Promise<Readonly<{ status: number; body: unknown }>> {
  const response = await post(
    user,
    `${controlPaths(user.organisationId).evals}/commands`,
    body,
  );
  return { status: response.status, body: await response.json() };
}

async function list(user: Member): Promise<readonly EvalView[]> {
  const response = await post(
    user,
    controlPaths(user.organisationId).evals,
    null,
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Eval list missing");
  return parseEvalListResponse(body);
}

function ids(evals: readonly EvalView[]): readonly string[] {
  return evals.map((entry) => entry.evalId).sort();
}

async function states(user: Member, evalId: string) {
  return (await list(user))
    .find((entry) => entry.evalId === evalId)
    ?.revisions.map((revision) => revision.kind);
}
