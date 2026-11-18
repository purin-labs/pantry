import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import {
  parseUserPreferenceDocument,
  isUserId,
  isConversationId,
  isProjectId,
  newConversationId,
  newProjectId,
  type PreferenceArea,
  type UserPreferenceDocument,
} from "@seams/control-api";
import { isRecord } from "@seams/std";
import {
  issueControlSession,
  rotateControlSession,
  revokeControlSession,
  upsertUser,
  type IssuedControlSession,
} from "../../src/data/control-plane";

it(
  "restores account preferences across sessions while fencing competing edits, other users and unsupported documents",
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
  expect(isUserId(alice.session.userId)).toBe(true);
  expect(isConversationId(newConversationId())).toBe(true);
  expect(isProjectId(newProjectId())).toBe(true);
  expect(isProjectId(newConversationId())).toBe(false);
  expect(isUserId("control_00000000-0000-0000-0000-000000000000")).toBe(false);
  const firstReads = await Promise.all([
    preferenceRequest(alice, "chat"),
    preferenceRequest(secondAlice, "chat"),
  ]);
  const first = await preferenceDocument(firstReads[0]);
  const simultaneous = await preferenceDocument(firstReads[1]);
  expect(first.revision).toBe(1);
  expect(simultaneous).toEqual(first);
  expect(first.area).toBe("chat");
  if (first.area !== "chat") throw new Error("Missing chat preferences");
  expect(first.values).toEqual({
    dockedPanelWidthPx: 600,
    fullscreenSidebarWidthPx: 360,
  });
  const races = await Promise.all([
    preferenceRequest(alice, "chat", {
      expectedRevision: 1,
      command: { kind: "set_docked_chat_width", widthPx: 1100 },
    }),
    preferenceRequest(secondAlice, "chat", {
      expectedRevision: 1,
      command: { kind: "set_fullscreen_chat_sidebar_width", widthPx: 420 },
    }),
  ]);
  expect(races.map(responseStatus).sort()).toEqual([200, 409]);
  const accepted = races.find(successResponse);
  const conflict = races.find(conflictResponse);
  if (accepted === undefined || conflict === undefined)
    throw new Error("Missing concurrency outcomes");
  const current = await saveDocument(conflict, "conflict");
  expect(current.revision).toBe(2);
  if (current.area !== "chat") throw new Error("Missing chat conflict");
  const retryCommand =
    current.values.dockedPanelWidthPx === 1100
      ? { kind: "set_fullscreen_chat_sidebar_width", widthPx: 420 }
      : { kind: "set_docked_chat_width", widthPx: 1100 };
  const merged = await saveDocument(
    await preferenceRequest(secondAlice, "chat", {
      expectedRevision: 2,
      command: retryCommand,
    }),
    "saved",
  );
  expect(merged.revision).toBe(3);
  if (merged.area !== "chat") throw new Error("Missing merged widths");
  expect(merged.values).toEqual({
    dockedPanelWidthPx: 1100,
    fullscreenSidebarWidthPx: 420,
  });
  const same = await saveDocument(
    await preferenceRequest(alice, "chat", {
      expectedRevision: 3,
      command: { kind: "set_docked_chat_width", widthPx: 1100 },
    }),
    "saved",
  );
  expect(same.revision).toBe(3);
  const appearance = await preferenceDocument(
    await preferenceRequest(alice, "appearance"),
  );
  const bakery = await preferenceDocument(
    await preferenceRequest(alice, "bakeryos"),
  );
  const areaEdits = await Promise.all([
    preferenceRequest(alice, "appearance", {
      expectedRevision: appearance.revision,
      command: {
        kind: "set_appearance",
        value: { mode: "dark", palette: "espresso" },
      },
    }),
    preferenceRequest(alice, "bakeryos", {
      expectedRevision: bakery.revision,
      command: { kind: "set_scene_labels", labels: "all" },
    }),
  ]);
  expect(areaEdits.map(responseStatus)).toEqual([200, 200]);
  const themed = await preferenceDocument(
    await preferenceRequest(secondAlice, "appearance"),
  );
  if (themed.area !== "appearance") throw new Error("Missing appearance");
  expect(themed.values).toEqual({ mode: "dark", palette: "espresso" });
  const restored = await preferenceDocument(
    await preferenceRequest(secondAlice, "chat"),
  );
  expect(restored).toEqual(merged);
  const isolated = await preferenceDocument(
    await preferenceRequest(bob, "chat"),
  );
  expect(isolated.userId).toBe(bob.session.userId);
  expect(isolated.revision).toBe(1);
  if (isolated.area !== "chat") throw new Error("Missing Bob preferences");
  expect(isolated.values.dockedPanelWidthPx).toBe(600);
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
    await preferenceDocument(await preferenceRequest(bob, "chat")),
  ).toEqual(isolated);
  expect(
    await preferenceDocument(await preferenceRequest(alice, "chat")),
  ).toEqual(merged);
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
    (
      await preferenceRequest(alice, "bakeryos", {
        expectedRevision: 2,
        command: { kind: "set_docked_chat_width", widthPx: 800 },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await preferenceRequest(alice, "chat", {
        expectedRevision: 3,
        command: { kind: "set_docked_chat_width", widthPx: 339 },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await preferenceRequest(alice, "chat", {
        expectedRevision: 3,
        command: { kind: "set_fullscreen_chat_sidebar_width", widthPx: 501 },
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await exports.default.fetch(
        new Request("https://localhost/v1/control/user/preferences/chat"),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await exports.default.fetch(
        new Request("https://localhost/v1/control/user/preferences/cafeos", {
          headers: authHeaders(alice),
        }),
      )
    ).status,
  ).toBe(404);
  const badCsrf = new Request(
    "https://localhost/v1/control/user/preferences/chat",
    {
      method: "PATCH",
      headers: {
        ...authHeaders(alice),
        origin: "https://localhost",
        "content-type": "application/json",
        "x-satyr-csrf": "wrong",
      },
      body: JSON.stringify({
        expectedUserId: alice.session.userId,
        expectedRevision: 3,
        command: { kind: "reset" },
      }),
    },
  );
  expect((await exports.default.fetch(badCsrf)).status).toBe(403);
  await env.DB.prepare(
    "UPDATE user_preferences SET schema_version = 99 WHERE user_id = ? AND area = 'bakeryos'",
  )
    .bind(alice.session.userId)
    .run();
  const future = await preferenceRequest(alice, "bakeryos");
  expect(future.status).toBe(422);
  expect(await future.json()).toMatchObject({
    error: "preferences_version_unsupported",
  });
  expect(
    (
      await preferenceRequest(alice, "bakeryos", {
        expectedRevision: 2,
        command: { kind: "reset" },
      })
    ).status,
  ).toBe(422);
  const preserved = await env.DB.prepare(
    "SELECT schema_version, revision, values_json FROM user_preferences WHERE user_id = ? AND area = 'bakeryos'",
  )
    .bind(alice.session.userId)
    .first();
  expect(preserved).toMatchObject({ schema_version: 99, revision: 2 });
  const session = await exports.default.fetch(
    new Request("https://localhost/v1/control/session", {
      headers: authHeaders(alice),
    }),
  );
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({
    identity: { userId: alice.session.userId },
  });
  const rotated = await rotateControlSession({
    db: env.DB,
    session: secondAlice.session,
    now: Date.now(),
    expiresAt: Date.now() + 3600000,
  });
  if (!rotated.ok) throw new Error(rotated.error.code);
  expect((await preferenceRequest(secondAlice, "chat")).status).toBe(401);
  expect(
    await preferenceDocument(await preferenceRequest(rotated.value, "chat")),
  ).toEqual(merged);
  await revokeControlSession({
    db: env.DB,
    session: rotated.value.session,
    now: Date.now(),
  });
  expect((await preferenceRequest(rotated.value, "chat")).status).toBe(401);
  const signedInAgain = await createUserSession("alice");
  expect(signedInAgain.session.userId).toBe(alice.session.userId);
  expect(
    await preferenceDocument(await preferenceRequest(signedInAgain, "chat")),
  ).toEqual(merged);
  const result = {
    scenario: "account-preferences",
    twoUsers: true,
    twoSessions: true,
    rotationAndSignInPreservePreferences: true,
    concurrentFirstReadRevision: first.revision,
    concurrentWrites: [200, 409],
    mergedRevision: merged.revision,
    values: merged.values,
    independentAreas: [200, 200],
    crossUserWrite: 422,
    staleAccountWrite: 409,
    staleAccountPreservesBothUsers: true,
    unauthenticated: 401,
    csrf: 403,
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
function authHeaders(session: IssuedControlSession): Record<string, string> {
  return {
    cookie: `satyr_control_session=${session.token}; satyr_control_csrf=${session.csrfToken}`,
  };
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
        ...authHeaders(session),
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
function successResponse(response: Response): boolean {
  return response.status === 200;
}
function conflictResponse(response: Response): boolean {
  return response.status === 409;
}
