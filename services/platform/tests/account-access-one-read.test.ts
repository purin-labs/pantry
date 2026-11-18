import type { UnitTestEnv } from "./worker-fakes";
import { afterEach, expect, it, vi } from "vitest";

import {
  accountAccessOfOneRead,
  type AccountPlatformAccess,
} from "../src/account-platform/access";
import {
  issueControlSession,
  revokeControlSession,
} from "../src/data/control-plane";
import { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { connectRealAccountPlatform } from "./real-account-platform-fixture";
import {
  createSplitTopology,
  onboardSplitOrganisation,
} from "./split-topology";

afterEach(vi.useRealTimers);

// The gate of a list read and the viewer of that read ask the account the
// same question. One read may use the answer that its request holds. Nothing
// else may, and no answer reaches another request.
it("gives one read the answer of its own request, for five seconds at most", async function oneRead() {
  const fixture = await accountFixture();
  const question = fixture.question;
  const access = await fixture.requestAccess();

  // The access of a request asks each time.
  expect((await access.checkUser(question)).ok).toBe(true);
  expect((await access.checkUser(question)).ok).toBe(true);
  expect(fixture.decisions()).toBe(2);

  // One read asks nothing for a question that its request has answered.
  const read = accountAccessOfOneRead(access);
  expect((await read.checkUser(question)).ok).toBe(true);
  expect(fixture.decisions()).toBe(2);

  // Another action and another authority are other questions.
  expect((await read.checkUser({ ...question, action: "execute" })).ok).toBe(
    true,
  );
  expect(
    (
      await read.checkUser({
        ...question,
        authority: {
          kind: "disclosure_recipient",
          disclosureEvidenceId: "label_one_read",
        },
      })
    ).ok,
  ).toBe(true);
  expect(fixture.decisions()).toBe(4);

  await fixture.revokeSession();

  // Denied: the request's own access asks, and sees the revocation.
  expect(await access.checkUser(question)).toMatchObject({
    ok: false,
    error: { code: "membership_ineligible" },
  });
  // Denied: one read then holds that newer answer, not the earlier one.
  expect((await read.checkUser(question)).ok).toBe(false);
  // Denied: another request holds no answer of this one.
  const later = accountAccessOfOneRead(await fixture.requestAccess());
  expect((await later.checkUser(question)).ok).toBe(false);
});

it("asks again for a read that outlasts its answer", async function agedAnswer() {
  const fixture = await accountFixture();
  const question = fixture.question;
  const access = await fixture.requestAccess();
  vi.useFakeTimers({ toFake: ["Date"] });
  const askedAt = Date.now();
  expect((await access.checkUser(question)).ok).toBe(true);
  await fixture.revokeSession();

  // The read began with its request, so it may still hold the answer.
  vi.setSystemTime(askedAt + 4_999);
  expect((await accountAccessOfOneRead(access).checkUser(question)).ok).toBe(
    true,
  );
  expect(fixture.decisions()).toBe(1);

  // Denied: an answer that is five seconds old is asked again.
  vi.setSystemTime(askedAt + 5_000);
  expect((await accountAccessOfOneRead(access).checkUser(question)).ok).toBe(
    false,
  );
});

async function accountFixture() {
  const now = Date.now();
  const topology = createSplitTopology();
  const organisation = await onboardSplitOrganisation(topology, now);
  const issued = await issueControlSession({
    db: topology.env.DB,
    userId: organisation.owner.userId,
    now,
    ttlMs: 3_600_000,
  });
  const account = await connectRealAccountPlatform(topology.env, {
    organisationId: organisation.organisationId,
    owner: { user: organisation.owner, session: issued.session },
    members: [],
  });
  const requests = accountRequests(account.env);
  return {
    question: {
      userId: organisation.owner.userId,
      authority: {
        kind: "authenticated_session",
        nativeSessionId: issued.session.controlSessionId,
      },
      action: "disclose",
    } as const,
    /** The account access of a new request, which holds no answer. */
    async requestAccess(): Promise<AccountPlatformAccess> {
      const scope = await OrganisationExecutionScope.resolve(
        account.env,
        organisation.organisationId,
      );
      if (!scope.ok) throw new Error(scope.error.code);
      return scope.value.accountAccess;
    },
    /** How many decisions the account has made since the fixture was built. */
    decisions(): number {
      return requests.filter(isDecision).length;
    },
    revokeSession(): Promise<void> {
      return revokeControlSession({
        db: topology.env.DB,
        session: issued.session,
        now: Date.now(),
      });
    },
  };
}

/** The path of each request that the Worker sends to the account from now on. */
function accountRequests(env: UnitTestEnv): string[] {
  const account = env.ACCOUNT_PLATFORM;
  if (account === undefined) throw new Error("fixture has no account");
  const paths: string[] = [];
  const send = account.fetch.bind(account);
  vi.spyOn(account, "fetch").mockImplementation(function counted(
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    const request = new Request(input, init);
    paths.push(new URL(request.url).pathname);
    return send(request);
  });
  return paths;
}

function isDecision(path: string): boolean {
  return path.endsWith("/eligibility/current");
}
