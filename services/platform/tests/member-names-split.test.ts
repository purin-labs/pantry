import { connectRealAccountPlatform } from "./real-account-platform-fixture";
import { issueControlSession } from "../src/data/control-plane";
import { expect, it } from "vitest";
import { handleControlRequest } from "../src/control-router";
import { newPersonId } from "../src/ids";
import { baseProjectId } from "../src/projects/default-project";
import {
  createSplitTopology,
  onboardSplitOrganisation,
  splitControlRequest,
  splitUser,
} from "./split-topology";

// The sign-in identity (`app_user`) is in the global database. Project access
// and the access-control subject list read an Organisation's regional database,
// so the names they show come from its own person records.
it("names project members and access subjects on the regional database", async function memberNames() {
  const now = Date.now();
  const topology = createSplitTopology();
  const organisation = await onboardSplitOrganisation(topology, now);
  const issued = await issueControlSession({
    db: topology.env.DB,
    userId: organisation.owner.userId,
    now,
    ttlMs: 3600000,
  });
  const account = await connectRealAccountPlatform(topology.env, {
    organisationId: organisation.organisationId,
    owner: { user: organisation.owner, session: issued.session },
    members: [],
  });
  const colleague = await splitUser(topology, "colleague", now);
  const colleaguePersonId = newPersonId();
  // A member of the Organisation who has not joined the project.
  await topology.regional.db.batch([
    topology.regional.db
      .prepare(
        "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, 'Sam Colleague')",
      )
      .bind(organisation.organisationId, colleaguePersonId),
    topology.regional.db
      .prepare(
        `INSERT INTO service_role_grant (
           organisation_id, user_id, person_id, role, status, created_at, revoked_at
         ) VALUES (?, ?, ?, 'operator', 'active', ?, NULL)`,
      )
      .bind(
        organisation.organisationId,
        colleague.userId,
        colleaguePersonId,
        now,
      ),
  ]);

  const projectId = await baseProjectId(organisation.organisationId);
  const access = await handleControlRequest(
    splitControlRequest(organisation, `projects/${projectId}/access`),
    account.env,
  );
  expect(access.status).toBe(200);
  expect(await access.json()).toMatchObject({
    members: [
      {
        userId: organisation.owner.userId,
        displayName: "owner",
        role: "owner",
      },
    ],
    candidates: [{ userId: colleague.userId, displayName: "Sam Colleague" }],
  });

  const subjects = await handleControlRequest(
    splitControlRequest(organisation, "access-control/options?kind=subjects"),
    account.env,
  );
  expect(subjects.status).toBe(200);
  expect(await subjects.json()).toMatchObject({
    options: {
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "person", label: "owner" }),
        expect.objectContaining({ kind: "person", label: "Sam Colleague" }),
      ]),
    },
  });
});
