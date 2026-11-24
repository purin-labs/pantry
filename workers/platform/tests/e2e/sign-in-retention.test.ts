import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";

import {
  issueControlSession,
  revokeControlSession,
  upsertUser,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import { beginGoogleOidc } from "@purin-labs/control/worker/oidc";
import { googleConfig } from "@purin-labs/control/worker/google-oidc-config";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
import { commerceHeaders } from "./commerce-support";
import {
  controlReadHeaders,
  PUBLIC_ORIGIN,
} from "./hibernatable-socket-support";

declare module "vitest" {
  interface TaskMeta {
    signInRetention?: Record<string, unknown>;
  }
}

const DAY_MS = 24 * 60 * 60 * 1_000;

// A person's sessions and Google sign-in starts. The 15-minute onboarding run
// deletes a session 30 days after it ended or was revoked, and a sign-in
// state one day after it ended, used or not. A session in use, a recent
// sign-out and a recent sign-in start stay, and the person stays signed in.
it(
  "deletes sessions 30 days after their end or revoke and sign-in states one day after their end, and keeps the person signed in",
  retentionJourney,
  120_000,
);

async function retentionJourney(context: TestContext): Promise<void> {
  const now = Date.now();
  const person = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `retention-${crypto.randomUUID()}`,
      email: "retention@pantry.test",
      displayName: "Retention baker",
      emailVerified: true,
    },
    now,
  });
  const session = (at: number, ttlMs: number) =>
    issueControlSession({ db: env.DB, userId: person.userId, now: at, ttlMs });

  // A session that ended 33 days ago, and one that ended 13 days ago.
  const endedLongAgo = await session(now - 40 * DAY_MS, 7 * DAY_MS);
  const endedRecently = await session(now - 20 * DAY_MS, 7 * DAY_MS);
  // A session revoked 31 days ago. It would end only 5 days ago.
  const revokedLongAgo = await session(now - 35 * DAY_MS, 30 * DAY_MS);
  await revokeControlSession({
    db: env.DB,
    session: revokedLongAgo.session,
    now: now - 31 * DAY_MS,
  });
  // The person signs out of one browser now, and stays signed in on another
  // with a session from 29 days ago.
  const signedOut = await session(now, 7 * DAY_MS);
  const logout = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/logout`,
    { method: "POST", headers: commerceHeaders(signedOut) },
  );
  expect(logout.status, await logout.clone().text()).toBe(200);
  const inUse = await session(now - 29 * DAY_MS, 30 * DAY_MS);
  expect(await sessionStatus(inUse)).toBe(200);

  // A sign-in state from two days ago that a callback used, one that nobody
  // used, one that ended 23 hours ago, and a sign-in that starts now.
  const config = googleConfig(env);
  if (config === null) throw new Error("No Google sign-in configuration");
  const start = (at: number) =>
    beginGoogleOidc({
      db: env.DB,
      config,
      redirectPath: "/portal",
      authentication: { kind: "sign_in" },
      now: at,
    });
  const usedLongAgo = await start(now - 2 * DAY_MS);
  await env.DB.prepare(
    "UPDATE control_oidc_state SET consumed_at = created_at + 60000 WHERE expires_at = ?",
  )
    .bind(usedLongAgo.expiresAt)
    .run();
  const unusedLongAgo = await start(now - 2 * DAY_MS - 1_000);
  const endedYesterday = await start(now - 23 * 60 * 60 * 1_000);
  const started = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/auth/google/start?returnTo=%2Fportal`,
    { redirect: "manual" },
  );
  expect(started.status).toBe(302);
  const startedState = new URL(
    started.headers.get("location") ?? "",
  ).searchParams.get("state");
  if (startedState === null) throw new Error("No state in the sign-in start");

  const sessionsBefore = await sessionIds(person.userId);
  const statesBefore = await stateEnds();
  expect(sessionsBefore).toHaveLength(5);

  await runScheduledOnboardingReconciliation(env, now);

  // The old session rows are gone; the recent ones stay.
  const sessionsAfter = await sessionIds(person.userId);
  expect(sessionsAfter.sort()).toEqual(
    [
      endedRecently.session.controlSessionId,
      signedOut.session.controlSessionId,
      inUse.session.controlSessionId,
    ].sort(),
  );
  expect(sessionsAfter).not.toContain(endedLongAgo.session.controlSessionId);
  expect(sessionsAfter).not.toContain(revokedLongAgo.session.controlSessionId);
  // The person is still signed in where they did not sign out.
  expect(await sessionStatus(inUse)).toBe(200);
  expect(await sessionStatus(signedOut)).toBe(401);

  // The old sign-in states are gone, used or not; the recent ones stay.
  const statesAfter = await stateEnds();
  expect(statesAfter).not.toContain(usedLongAgo.expiresAt);
  expect(statesAfter).not.toContain(unusedLongAgo.expiresAt);
  expect(statesAfter).toContain(endedYesterday.expiresAt);
  expect(statesAfter.filter((end) => end > now)).toHaveLength(
    statesBefore.filter((end) => end > now).length,
  );

  // A second run in the same quarter hour finds nothing more to delete.
  await runScheduledOnboardingReconciliation(env, now + 15 * 60 * 1_000);
  expect((await sessionIds(person.userId)).sort()).toEqual(
    sessionsAfter.sort(),
  );
  expect(await stateEnds()).toEqual(statesAfter);

  context.task.meta.signInRetention = {
    sessionsBefore: sessionsBefore.length,
    sessionsAfter: sessionsAfter.length,
    statesBefore: statesBefore.length,
    statesAfter: statesAfter.length,
    inUseAfterRun: 200,
  };
}

async function sessionStatus(issued: IssuedControlSession): Promise<number> {
  const response = await exports.default.fetch(
    `${PUBLIC_ORIGIN}/v1/control/session`,
    { headers: controlReadHeaders(issued) },
  );
  return response.status;
}

async function sessionIds(userId: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT control_session_id AS id FROM control_session WHERE user_id = ?",
  )
    .bind(userId)
    .all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

/** The end of each stored sign-in state, in order. */
async function stateEnds(): Promise<number[]> {
  const rows = await env.DB.prepare(
    "SELECT expires_at AS end FROM control_oidc_state ORDER BY expires_at",
  ).all<{ end: number }>();
  return rows.results.map((row) => row.end);
}
