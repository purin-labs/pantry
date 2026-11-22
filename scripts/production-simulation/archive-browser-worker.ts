// The Worker of the shared archive journeys (Plan 70 J3):
// verify-shared-artifacts-browser.js and verify-large-shared-archive-browser.js.
// serve-archive-acceptance.mjs starts it on port 8840 with local D1 and R2.
// Every /v1 request uses production routing and authorization. GET
// /fixture/setup builds the Organisation and signs in its two people, which a
// browser cannot do alone.
import gateway from "../../services/platform/src/integration-gateway";
import { issueControlSession } from "../../services/platform/src/data/control-plane";
import type { Env } from "../../foundation/kernel/env";
import type { OrganisationId } from "../../foundation/kernel/ids";
import { fixturePeople } from "../plan-42J/account-authority";

export {
  OrganisationDO,
  SessionDO,
  CaseDO,
  ConnectorDO,
  CodeModePlatformGovernorActor,
} from "../../services/platform/src/integration-gateway";

const { admittedOrganisation } = fixturePeople("archive-", "archive-browser");

type ArchiveFixture = Readonly<{
  organisationId: OrganisationId;
  sessions: readonly Readonly<{ token: string; csrfToken: string }>[];
}>;

// One Organisation for each runtime: the journey calls the setup once, and a
// second call returns the same people.
let fixture: Promise<ArchiveFixture> | undefined;

export default {
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return gateway.queue(batch, env);
  },
  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/test/health")
      return new Response(null, { status: 204 });
    if (url.pathname === "/fixture/setup") {
      fixture ??= setup(env);
      return Response.json(await fixture);
    }
    return gateway.fetch(request, env, context);
  },
};

/**
 * The owner publishes the archive. The administrator, a second person with
 * a session of their own, reads it back.
 */
async function setup(env: Env): Promise<ArchiveFixture> {
  const { organisationId, owner, other } = await admittedOrganisation(
    env,
    "Archive browser acceptance",
  );
  const sessions = [];
  for (const user of [owner, other]) {
    const issued = await issueControlSession({
      db: env.DB,
      userId: user.userId,
      now: Date.now(),
      ttlMs: 3_600_000,
    });
    sessions.push({ token: issued.token, csrfToken: issued.csrfToken });
  }
  return { organisationId, sessions };
}
