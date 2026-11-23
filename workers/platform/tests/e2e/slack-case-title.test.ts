import { env, exports } from "cloudflare:workers";
import { fixtureDatabase } from "./organisation-database";
import { http, HttpResponse, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import type { CaseTimelineCase } from "@purin-labs/control-api";

import { CONTEXT_CASE_READ_CAPABILITY } from "@purin-labs/authority/authorization/access-grants/turn-authority";
import { createAccessGrant } from "@purin-labs/authority/data/access-grants";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { CASE_ACTOR_SCHEMA_VERSION } from "@purin-labs/actor-runtime/actors/actor-schema-versions";
import { compilePublishAndActivateOrganisationPolicy } from "@purin-labs/authority/policy-snapshot";
import {
  executionRequest,
  openNodes,
  readCaseExecution,
  readCaseTimeline,
} from "./case-execution-support";
import { commerceClient } from "./commerce-support";
import { network } from "./network";
import {
  CHANNEL_ID,
  ORGANISATION_ID,
  ROOT_TS,
  WORKSPACE_ID,
  discoverSlackChannel,
  installSlackActorFixture,
  openRouterText,
  signedSlackRequest,
  slackEnvelopeFor,
  respondToSlack,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    slackCaseTitle?: Record<string, unknown>;
  }
}

/**
 * A Slack Case shows in the Portal to each member when its channel is public,
 * and only to the channel's members while it is private (Plan 27C).
 *
 * Two administrators of the Organisation hold the same Case read grant. One
 * is linked to the Slack user who mentions Pantry in the channel; the other is
 * linked to no Slack user. Slack lists only the author as a member of the
 * private channel. The Case and its title show to the author, and are absent
 * for the other member, whose trace read is refused. The message's first line
 * appears nowhere in what that member gets. Then a new discovery lists the
 * channel as public, as after a workspace admin opens it. Both now read the
 * same Case, titled with the message's first line, with its trigger open. The
 * Case still shows when the registry lists it at the Case schema before the
 * current one, as a Case registered before a schema step stays: its Actor
 * moves its own schema when it wakes. Last, the author writes to Pantry in a
 * direct message. That Case shows to the author and to nobody else.
 */
it(
  "shows a private Slack Case to its members and a public one to each member",
  slackCaseTitle,
  90_000,
);

const SLACK_AUTHOR = "U0E2ETITLE";
const FIRST_LINE = "Raise Friday croissants to 140?";

type Person = Readonly<{
  userId: string;
  personId: string;
  session: IssuedControlSession;
}>;

async function slackCaseTitle({ task }: TestContext): Promise<void> {
  const joining = [await joiner(), await joiner()] as const;
  await installSlackActorFixture();
  const author = await admin(joining[0], "Slack author");
  const reader = await admin(joining[1], "Unlinked reader");
  await linkSlackUser(author);
  await discoverSlackChannel("private_channel", Date.now() - 60_000);
  // The Organisation is active and its policy names the new members.
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_slack_title', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId: ORGANISATION_ID,
    now: Date.now(),
  });
  const published = await compilePublishAndActivateOrganisationPolicy({
    bindings: { db: fixtureDatabase(), kv: env.POLICY_KV },
    organisationId: ORGANISATION_ID,
    organisation,
    now: Date.now(),
  });
  if (!published.ok) throw new Error(published.error.code);

  const posts: number[] = [];
  network.use(
    http.post("https://openrouter.ai/api/v1/chat/completions", replyToModel),
    http.post(
      "https://slack.com/api/:method",
      respondToSlack.bind(null, posts),
    ),
    http.get("https://slack.com/api/conversations.info", () =>
      HttpResponse.json({
        ok: true,
        channel: { id: CHANNEL_ID, is_private: true, is_ext_shared: false },
      }),
    ),
    http.get("https://slack.com/api/conversations.members", () =>
      HttpResponse.json({ ok: true, members: [SLACK_AUTHOR, "U0PANTRY"] }),
    ),
  );
  const response = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelopeFor({
        workspaceId: WORKSPACE_ID,
        channelId: CHANNEL_ID,
        userId: SLACK_AUTHOR,
        eventType: "app_mention",
        eventId: "Ev_SLACK_CASE_TITLE",
        messageTs: ROOT_TS,
        threadTs: ROOT_TS,
        text: `<@U0PANTRY> ${FIRST_LINE}\nThe forecast says 132 for Friday.`,
      }),
    ),
  );
  expect(response.status).toBe(200);
  await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(1);

  const caseRow = await fixtureDatabase()
    .prepare(
      "SELECT case_id FROM case_project WHERE organisation_id = ? AND origin_kind = 'slack'",
    )
    .bind(ORGANISATION_ID)
    .first<{ case_id: string }>();
  if (caseRow === null) throw new Error("Slack Case missing");
  const caseId = caseRow.case_id;

  // The channel is private: the Case shows only to its member.
  const memberEvent = (await timelineOf(author)).find(
    (item) => item.caseId === caseId,
  );
  expect(memberEvent).toMatchObject({ origin: "slack", title: FIRST_LINE });
  expect(
    openNodes(
      await readCaseExecution(ORGANISATION_ID, author.session, caseId, 100),
      "trigger",
    ),
  ).toHaveLength(1);
  const events = await timelineOf(reader);
  expect(events.map((event) => event.caseId)).not.toContain(caseId);
  const trace = await executionRequest(
    ORGANISATION_ID,
    reader.session,
    `/cases/${caseId}/execution?limit=100`,
  );
  expect(trace.status).toBe(404);
  expect(JSON.stringify([events, trace.body])).not.toContain("croissant");

  // The channel is public now: each member reads the Case and its title.
  await discoverSlackChannel("public_channel", Date.now());
  const shown = [];
  for (const person of [author, reader]) {
    const event = (await timelineOf(person)).find(
      (item) => item.caseId === caseId,
    );
    expect(event).toMatchObject({ origin: "slack", title: FIRST_LINE });
    const trace = await readCaseExecution(
      ORGANISATION_ID,
      person.session,
      caseId,
      100,
    );
    expect(openNodes(trace, "trigger")).toHaveLength(1);
    shown.push(event);
  }

  // No command advances the registry row of a Case, so a Case registered
  // before a Case schema step keeps the older version. A read that creates
  // nothing still finds it, as the next message of its thread does.
  const older = await fixtureDatabase()
    .prepare(
      "UPDATE durable_object_registry SET schema_version = ? WHERE organisation_id = ? AND object_kind = 'case' AND logical_object_id = ? AND lifecycle_status = 'active'",
    )
    .bind(CASE_ACTOR_SCHEMA_VERSION - 1, ORGANISATION_ID, caseId)
    .run();
  expect(older.meta.changes).toBe(1);
  expect(
    openNodes(
      await readCaseExecution(ORGANISATION_ID, author.session, caseId, 100),
      "trigger",
    ),
  ).toHaveLength(1);

  // A direct message with the agent stays with its person.
  const direct = await exports.default.fetch(
    await signedSlackRequest(
      slackEnvelopeFor({
        workspaceId: WORKSPACE_ID,
        channelId: "D0E2ETITLE",
        userId: SLACK_AUTHOR,
        eventType: "app_mention",
        eventId: "Ev_SLACK_CASE_TITLE_DM",
        messageTs: "1787500002.000001",
        threadTs: "1787500002.000001",
        text: "<@U0PANTRY> Keep this between us.",
      }),
    ),
  );
  expect(direct.status).toBe(200);
  await expect.poll(() => posts.length, { timeout: 30_000 }).toBe(2);
  const dmCase = await fixtureDatabase()
    .prepare(
      "SELECT case_id FROM case_project WHERE organisation_id = ? AND origin_kind = 'slack' AND case_id <> ?",
    )
    .bind(ORGANISATION_ID, caseId)
    .first<{ case_id: string }>();
  if (dmCase === null) throw new Error("Slack DM Case missing");
  expect((await timelineOf(author)).map((event) => event.caseId)).toContain(
    dmCase.case_id,
  );
  expect((await timelineOf(reader)).map((event) => event.caseId)).not.toContain(
    dmCase.case_id,
  );

  task.meta.slackCaseTitle = {
    caseId,
    whilePrivate: { author: memberEvent?.title, reader: 404 },
    whilePublic: shown.map((event) => ({
      title: event?.title,
      withheld: event?.withheld,
    })),
  };
}

async function joiner() {
  const client = await commerceClient(`slack-title-${crypto.randomUUID()}`);
  const personId = `person_${crypto.randomUUID()}`;
  return { client, personId, slot: { client, laterPersonId: personId } };
}

/**
 * An administrator with the Case read grant and a seat in the default
 * Project, as an Organisation gives one to a person who reads Activity.
 */
async function admin(
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
    fixtureDatabase()
      .prepare(
        `INSERT OR IGNORE INTO project_member (organisation_id, project_id, user_id, role)
       SELECT organisation_id, project_id, ?, 'editor'
       FROM organisation_default_project WHERE organisation_id = ?`,
      )
      .bind(userId, ORGANISATION_ID),
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
      materializationReceiptId: "receipt_slack_title",
    },
    now: Date.now(),
  });
  if (!granted.ok) throw new Error(granted.error.code);
  return {
    userId,
    personId: joining.personId,
    session: joining.client.session,
  };
}

/** Links a person to the Slack user who writes the message, as verified. */
async function linkSlackUser(person: Person): Promise<void> {
  const existing = await fixtureDatabase()
    .prepare(
      "SELECT workspace_connection_id FROM external_identity_link WHERE organisation_id = ? AND workspace_id = ? LIMIT 1",
    )
    .bind(ORGANISATION_ID, WORKSPACE_ID)
    .first<{ workspace_connection_id: string }>();
  if (existing === null) throw new Error("Slack connection missing");
  await fixtureDatabase()
    .prepare(
      `INSERT INTO external_identity_link (
       organisation_id, workspace_connection_id, workspace_id, external_user_id,
       user_id, verified_at, verified_by
     ) VALUES (?, ?, ?, ?, ?, ?, 'google')`,
    )
    .bind(
      ORGANISATION_ID,
      existing.workspace_connection_id,
      WORKSPACE_ID,
      SLACK_AUTHOR,
      person.userId,
      Date.now(),
    )
    .run();
}

/** The Cases of the last week on one person's Activity timeline. */
async function timelineOf(
  person: Person,
): Promise<readonly CaseTimelineCase[]> {
  const read = await readCaseTimeline(ORGANISATION_ID, person.session, {
    from: Date.now() - 6 * 86_400_000,
    to: Date.now() + 60_000,
  });
  expect(read.status).toBe(200);
  return read.timeline?.cases ?? [];
}

async function replyToModel({
  request,
}: Parameters<HttpResponseResolver>[0]): Promise<Response> {
  await request.json();
  return openRouterText("Reply.", "chatcmpl_slack_case_title");
}
