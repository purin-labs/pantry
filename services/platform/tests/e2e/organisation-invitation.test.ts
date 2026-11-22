import { env, exports } from "cloudflare:workers";
import { http, type HttpResponseResolver } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { newConversationId } from "@purin-labs/control-api";

import { saveConversation } from "@purin-labs/conversation/chat/store";
import type { IssuedControlSession } from "@purin-labs/tenancy/data/control-plane";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { platformConversation } from "./chat-journey-support";
import { commerceClient, commerceHeaders } from "./commerce-support";
import { network } from "./network";
import { fixtureDatabase } from "./organisation-database";
import {
  ORGANISATION_ID,
  installSlackActorFixture,
  openRouterText,
} from "./slack-journey-support";

declare module "vitest" {
  interface TaskMeta {
    organisationInvitation?: Record<string, unknown>;
  }
}

const MODEL = "moonshotai/kimi-k3";
const BASE = `/v1/control/organisations/${ORGANISATION_ID}/invitations`;

// Plan 95 step 2, journey J5. Pantry keeps its own invitations. The link
// works only for the invited Google email, only once for one person, and not
// after it expires, after a revoke or after a newer invitation replaces it.
it(
  "admits only the invited email, makes one membership for a repeated accept, and refuses an expired, revoked or replaced invitation",
  invitationJourney,
  90_000,
);

type Answer = Readonly<{ status: number; body: unknown; code: string | null }>;

async function invitationJourney(context: TestContext): Promise<void> {
  const { ownerSession } = await installSlackActorFixture();
  await fixtureDatabase()
    .prepare(
      "UPDATE organisation_onboarding SET lifecycle = 'active', activation_attempt_id = NULL, readiness_version = NULL, activation_receipt_id = 'receipt_invitation', activated_at = ? WHERE organisation_id = ?",
    )
    .bind(Date.now(), ORGANISATION_ID)
    .run();
  const model = countingModel();
  network.use(model.handler);
  const invited = await commerceClient(`invite-a-${crypto.randomUUID()}`);
  const stranger = await commerceClient(`invite-b-${crypto.randomUUID()}`);

  // The owner invites a@ as an admin, and the list shows it as pending.
  const issued = await invite(ownerSession, invited.identity.email, "admin");
  expect(issued.status, JSON.stringify(issued.body)).toBe(201);
  const link = invitationLink(issued);
  const pending = await send(ownerSession, BASE, null);
  expect(pending.status).toBe(200);
  expect(JSON.stringify(pending.body)).toContain(link.invitationId);

  // Denied: b@ opens the link of a@.
  const wrongPerson = await accept(stranger.session, link);
  expect(wrongPerson).toMatchObject({
    status: 403,
    code: "organisation_invitation_email_mismatch",
  });
  // Denied: a@ with a token that is not the link's token.
  const wrongToken = await accept(invited.session, {
    ...link,
    token: "a".repeat(43),
  });
  expect(wrongToken).toMatchObject({
    status: 404,
    code: "organisation_invitation_not_found",
  });

  // a@ accepts, and a second accept changes nothing.
  const accepted = await accept(invited.session, link);
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
  expect(accepted.body).toMatchObject({ member: { role: "admin" } });
  const again = await accept(invited.session, link);
  expect(again).toEqual(accepted);
  const grants = await fixtureDatabase()
    .prepare(
      "SELECT COUNT(*) AS count FROM service_role_grant WHERE organisation_id = ? AND user_id = ?",
    )
    .bind(ORGANISATION_ID, invited.identity.userId)
    .first<{ count: number }>();
  expect(grants?.count).toBe(1);
  // Denied: b@ cannot take the link after a@ accepted it.
  const taken = await accept(stranger.session, link);
  expect(taken.status).not.toBe(200);

  // The new admin runs a Portal chat turn.
  const conversationId = newConversationId();
  const saved = await saveConversation(
    await requireOrganisationExecutionScope(env, ORGANISATION_ID),
    invited.identity.userId,
    platformConversation(conversationId, "Spring menu", MODEL),
    0,
  );
  expect(saved.kind).toBe("saved");
  const message = await send(
    invited.session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat`,
    {
      kind: "message",
      conversationId,
      requestId: "invitation_first",
      model: MODEL,
      text: "Add rhubarb tart to the notes.",
      browserContext: { kind: "unavailable" },
    },
  );
  expect(message.status, JSON.stringify(message.body)).toBe(200);
  await expect
    .poll(workKind.bind(null, invited.session, conversationId), {
      timeout: 20_000,
    })
    .toBe("ready");
  expect(model.calls()).toBe(1);

  // Denied: an invitation that expired. The seed is an invitation that the
  // owner sent eight days ago.
  const late = await commerceClient(`invite-late-${crypto.randomUUID()}`);
  const expired = await seedExpiredInvitation(
    late.identity.email,
    ownerSession,
  );
  expect(await accept(late.session, expired)).toMatchObject({
    status: 409,
    code: "organisation_invitation_expired",
  });

  // Denied: an invitation that the owner revoked.
  const revokedPerson = await commerceClient(`invite-c-${crypto.randomUUID()}`);
  const toRevoke = invitationLink(
    await invite(ownerSession, revokedPerson.identity.email, "viewer"),
  );
  const revoked = await send(
    ownerSession,
    `${BASE}/${toRevoke.invitationId}/revoke`,
    {},
  );
  expect(revoked.status).toBe(200);
  expect(await accept(revokedPerson.session, toRevoke)).toMatchObject({
    status: 409,
    code: "organisation_invitation_closed",
  });

  // A newer invitation for the same email replaces the older link.
  const replaced = await commerceClient(`invite-d-${crypto.randomUUID()}`);
  const older = invitationLink(
    await invite(ownerSession, replaced.identity.email, "operator"),
  );
  const newer = invitationLink(
    await invite(ownerSession, replaced.identity.email, "operator"),
  );
  expect(await accept(replaced.session, older)).toMatchObject({
    status: 409,
    code: "organisation_invitation_closed",
  });
  const newerAccepted = await accept(replaced.session, newer);
  expect(newerAccepted.status).toBe(200);
  expect(newerAccepted.body).toMatchObject({ member: { role: "operator" } });

  // Nobody whom a refused link names became a member.
  const members = await fixtureDatabase()
    .prepare(
      "SELECT user_id AS userId FROM service_role_grant WHERE organisation_id = ? AND status = 'active'",
    )
    .bind(ORGANISATION_ID)
    .all<{ userId: string }>();
  const memberIds = members.results.map((row) => row.userId);
  for (const refused of [stranger, late, revokedPerson])
    expect(memberIds).not.toContain(refused.identity.userId);

  context.task.meta.organisationInvitation = {
    issued: issued.status,
    wrongPerson,
    wrongToken,
    accepted: accepted.status,
    secondAcceptSame: JSON.stringify(again) === JSON.stringify(accepted),
    grantRows: grants?.count,
    takenByAnother: taken.status,
    chatTurn: message.status,
    modelCalls: model.calls(),
    expired: "organisation_invitation_expired",
    revoked: "organisation_invitation_closed",
    replacedOlderLink: "organisation_invitation_closed",
    newerAccepted: newerAccepted.status,
  };
}

type Link = Readonly<{ invitationId: string; token: string }>;

function invitationLink(answer: Answer): Link {
  const body = answer.body;
  if (
    !isRecord(body) ||
    !isRecord(body.invitation) ||
    typeof body.invitation.organisationInvitationId !== "string" ||
    typeof body.token !== "string"
  )
    throw new Error(`Invalid invitation answer: ${JSON.stringify(body)}`);
  return {
    invitationId: body.invitation.organisationInvitationId,
    token: body.token,
  };
}

function invite(
  owner: IssuedControlSession,
  email: string,
  role: "admin" | "operator" | "viewer",
): Promise<Answer> {
  return send(owner, BASE, { email, role });
}

function accept(session: IssuedControlSession, link: Link): Promise<Answer> {
  return send(session, `${BASE}/${link.invitationId}/accept`, {
    token: link.token,
  });
}

async function seedExpiredInvitation(
  email: string,
  owner: IssuedControlSession,
): Promise<Link> {
  const token = "expired".padEnd(43, "x");
  const invitationId = `invitation_${crypto.randomUUID()}`;
  const sent = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await fixtureDatabase()
    .prepare(
      `INSERT INTO organisation_invitation (organisation_id, invitation_id, email,
         role, token_hash, invited_by_user_id, created_at, expires_at, state)
       VALUES (?, ?, ?, 'operator', ?, ?, ?, ?, 'pending')`,
    )
    .bind(
      ORGANISATION_ID,
      invitationId,
      email,
      await sha256Hex(token),
      owner.session.userId,
      sent,
      sent + 7 * 24 * 60 * 60 * 1000,
    )
    .run();
  return { invitationId, token };
}

async function send(
  session: IssuedControlSession,
  path: string,
  body: unknown,
): Promise<Answer> {
  const response = await exports.default.fetch(`https://localhost${path}`, {
    method: body === null ? "GET" : "POST",
    headers: commerceHeaders(session),
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await response.json();
  return {
    status: response.status,
    body: parsed,
    code:
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : null,
  };
}

async function workKind(
  session: IssuedControlSession,
  conversationId: ReturnType<typeof newConversationId>,
): Promise<string | null> {
  const answer = await send(
    session,
    `/v1/control/organisations/${ORGANISATION_ID}/chat?conversation=${conversationId}&observe=true`,
    null,
  );
  const body = answer.body;
  return isRecord(body) &&
    isRecord(body.conversation) &&
    isRecord(body.conversation.work) &&
    typeof body.conversation.work.kind === "string"
    ? body.conversation.work.kind
    : null;
}

function countingModel(): {
  readonly handler: ReturnType<typeof http.post>;
  readonly calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    handler: http.post(
      "https://openrouter.ai/api/v1/chat/completions",
      async ({ request }: Parameters<HttpResponseResolver>[0]) => {
        await request.json();
        calls += 1;
        return openRouterText(
          JSON.stringify({
            kind: "reply",
            text: "Rhubarb tart is in the notes.",
          }),
          `invitation_${String(calls)}`,
        );
      },
    ),
  };
}
