import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import {
  parseUserPreferenceDocument,
  type PreferenceArea,
  type UserPreferenceDocument,
} from "@seams/control-api";
import { isRecord } from "@seams/std";
import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
} from "../../src/data/control-plane";

it(
  "restores account preferences in a new session, fences competing edits, and keeps each user to their own preferences",
  preferenceJourney,
);

async function preferenceJourney(context: TestContext): Promise<void> {
  const alice = await createUserSession("alice");
  const secondAlice = await issueControlSession({
    db: env.DB,
    userId: alice.session.userId,
    now: Date.now(),
    ttlMs: 3600000,
  });
  const bob = await createUserSession("bob");
  const first = await preferenceDocument(
    await preferenceRequest(alice, "chat"),
  );

  // Two sessions of Alice change two values from the same revision. The
  // store writes the whole document, so one edit is refused with the current
  // document, and its retry keeps both values: no edit is lost.
  const races = await Promise.all([
    preferenceRequest(alice, "chat", {
      expectedRevision: first.revision,
      command: { kind: "set_docked_chat_width", widthPx: 1100 },
    }),
    preferenceRequest(secondAlice, "chat", {
      expectedRevision: first.revision,
      command: { kind: "set_fullscreen_chat_sidebar_width", widthPx: 420 },
    }),
  ]);
  expect(races.map(responseStatus).sort()).toEqual([200, 409]);
  const conflict = races.find(conflictResponse);
  if (conflict === undefined) throw new Error("Missing concurrency conflict");
  const current = await saveDocument(conflict, "conflict");
  if (current.area !== "chat") throw new Error("Missing chat conflict");
  const retryCommand =
    current.values.dockedPanelWidthPx === 1100
      ? { kind: "set_fullscreen_chat_sidebar_width", widthPx: 420 }
      : { kind: "set_docked_chat_width", widthPx: 1100 };
  const merged = await saveDocument(
    await preferenceRequest(secondAlice, "chat", {
      expectedRevision: current.revision,
      command: retryCommand,
    }),
    "saved",
  );
  if (merged.area !== "chat") throw new Error("Missing merged preferences");
  expect(merged.values).toEqual({
    dockedPanelWidthPx: 1100,
    fullscreenSidebarWidthPx: 420,
  });

  // A new sign-in of Alice restores her preferences.
  const signedInAgain = await createUserSession("alice");
  expect(signedInAgain.session.userId).toBe(alice.session.userId);
  expect(
    await preferenceDocument(await preferenceRequest(signedInAgain, "chat")),
  ).toEqual(merged);

  // Bob reads only his own preferences, and he cannot change Alice's: not
  // from a tab that still expects Alice's account, and not by naming her.
  const isolated = await preferenceDocument(
    await preferenceRequest(bob, "chat"),
  );
  expect(isolated.userId).toBe(bob.session.userId);
  expect(isolated.revision).toBe(1);
  const staleAccount = await preferenceRequest(bob, "chat", {
    expectedUserId: alice.session.userId,
    expectedRevision: isolated.revision,
    command: { kind: "set_docked_chat_width", widthPx: 800 },
  });
  expect(staleAccount.status).toBe(409);
  expect(await staleAccount.json()).toEqual({
    ok: false,
    error: "preferences_user_changed",
  });
  expect(
    (
      await preferenceRequest(bob, "chat", {
        userId: alice.session.userId,
        expectedRevision: 1,
        command: { kind: "set_docked_chat_width", widthPx: 800 },
      })
    ).status,
  ).toBe(422);
  expect(
    await preferenceDocument(await preferenceRequest(bob, "chat")),
  ).toEqual(isolated);
  expect(
    await preferenceDocument(await preferenceRequest(alice, "chat")),
  ).toEqual(merged);

  // A document that a newer release wrote stays as it is: this release
  // refuses to read it or to reset it, so a release that rolls back loses no
  // preference.
  await env.DB.prepare(
    "UPDATE user_preferences SET schema_version = 99 WHERE user_id = ? AND area = 'chat'",
  )
    .bind(alice.session.userId)
    .run();
  const future = await preferenceRequest(alice, "chat");
  expect(future.status).toBe(422);
  expect(await future.json()).toMatchObject({
    error: "preferences_version_unsupported",
  });
  expect(
    (
      await preferenceRequest(alice, "chat", {
        expectedRevision: merged.revision,
        command: { kind: "reset" },
      })
    ).status,
  ).toBe(422);
  const preserved = await env.DB.prepare(
    "SELECT schema_version, revision FROM user_preferences WHERE user_id = ? AND area = 'chat'",
  )
    .bind(alice.session.userId)
    .first();
  expect(preserved).toMatchObject({
    schema_version: 99,
    revision: merged.revision,
  });
  const result = {
    scenario: "account-preferences",
    twoUsers: true,
    twoSessions: true,
    signInRestoresPreferences: true,
    concurrentWrites: [200, 409],
    mergedRevision: merged.revision,
    values: merged.values,
    crossUserWrite: 422,
    staleAccountWrite: 409,
    staleAccountPreservesBothUsers: true,
    futureVersionPreserved: true,
  };
  await context.annotate(JSON.stringify(result), "plan53-evidence");
}
async function createUserSession(name: string): Promise<IssuedControlSession> {
  const user = await upsertUser({
    db: env.DB,
    now: Date.now(),
    identity: {
      issuer: "https://accounts.google.com",
      subject: `preferences-${name}`,
      email: `${name}@example.test`,
      displayName: name,
      emailVerified: true,
    },
  });
  return issueControlSession({
    db: env.DB,
    userId: user.userId,
    now: Date.now(),
    ttlMs: 3600000,
  });
}
function preferenceRequest(
  session: IssuedControlSession,
  area: PreferenceArea,
  body?: unknown,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://localhost/v1/control/user/preferences/${area}`, {
      method: body === undefined ? "GET" : "PATCH",
      headers: {
        cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
        origin: "https://localhost",
        "x-satyr-csrf": session.csrfToken,
        "content-type": "application/json",
      },
      body:
        body === undefined
          ? undefined
          : JSON.stringify(preferenceBody(session, body)),
    }),
  );
}
function preferenceBody(session: IssuedControlSession, body: unknown): unknown {
  if (!isRecord(body)) return body;
  return { expectedUserId: session.session.userId, ...body };
}
async function preferenceDocument(
  response: Response | undefined,
): Promise<UserPreferenceDocument> {
  if (response === undefined || response.status !== 200)
    throw new Error("Preference read failed");
  const parsed = parseUserPreferenceDocument(await response.json());
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.value;
}
async function saveDocument(
  response: Response,
  kind: "saved" | "conflict",
): Promise<UserPreferenceDocument> {
  const raw: unknown = await response.json();
  if (!isRecord(raw) || raw.kind !== kind)
    throw new Error("Unexpected preference update");
  const parsed = parseUserPreferenceDocument(raw.document);
  if (!parsed.ok) throw new Error(parsed.code);
  return parsed.value;
}
function responseStatus(response: Response): number {
  return response.status;
}
function conflictResponse(response: Response): boolean {
  return response.status === 409;
}
