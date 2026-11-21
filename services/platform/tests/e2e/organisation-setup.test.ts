import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
} from "../../src/data/control-plane";
import { commerceClient, commerceHeaders } from "./commerce-support";

declare module "vitest" {
  interface TaskMeta {
    organisationSetup?: Record<string, unknown>;
  }
}

// Plan 95 step 2, journey J4. A signed-in person makes an organisation in
// Pantry and becomes its owner, with no outside account. The operation id of
// the Portal makes a retry return the same organisation, and one person owns
// at most five active organisations.
it(
  "makes an organisation for a signed-in person, returns the same one for a repeat, refuses a sixth, and refuses a person without a verified Google email",
  setupJourney,
  120_000,
);

type Created = Readonly<{
  status: number;
  organisationId: string | null;
  code: string | null;
}>;

async function setupJourney(context: TestContext): Promise<void> {
  const owner = await commerceClient(`setup-owner-${crypto.randomUUID()}`);

  const first = await create(owner.session, "setup_operation_1", "Rhubarb");
  expect(first.status, JSON.stringify(first)).toBe(200);
  expect(first.organisationId).not.toBeNull();
  const firstId = first.organisationId;
  // The person owns the new organisation and can read it.
  expect(await ownedOrganisations(owner.session)).toEqual([firstId]);
  const read = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${String(firstId)}`,
    { headers: commerceHeaders(owner.session) },
  );
  expect(read.status).toBe(200);

  // A repeat of the same operation makes no second organisation.
  const repeat = await create(owner.session, "setup_operation_1", "Rhubarb");
  expect(repeat).toEqual({ status: 200, organisationId: firstId, code: null });
  // Denied: the same operation id with another name.
  const changed = await create(owner.session, "setup_operation_1", "Other");
  expect(changed).toMatchObject({
    status: 409,
    code: "idempotency_key_conflict",
  });
  expect(await ownedOrganisations(owner.session)).toHaveLength(1);

  // The person makes four more organisations.
  const more: Created[] = [];
  for (const index of [2, 3, 4, 5])
    more.push(
      await create(owner.session, `setup_operation_${index}`, `Shop ${index}`),
    );
  expect(more.map((created) => created.status)).toEqual([200, 200, 200, 200]);
  // Denied: a sixth active organisation.
  const sixth = await create(owner.session, "setup_operation_6", "Shop 6");
  expect(sixth).toMatchObject({
    status: 409,
    code: "organisation_limit_reached",
  });
  // A repeat of the fifth still answers with the fifth organisation.
  const fifthAgain = await create(owner.session, "setup_operation_5", "Shop 5");
  expect(fifthAgain).toEqual({
    status: 200,
    organisationId: more[3]?.organisationId,
    code: null,
  });
  const owned = await ownedOrganisations(owner.session);
  expect(owned).toHaveLength(5);

  // Denied: a signed-in person whose identity is not a verified Google one.
  const now = Date.now();
  const outsider = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://login.example.test",
      subject: `setup-outsider-${crypto.randomUUID()}`,
      email: "outsider@example.test",
      displayName: "Outsider",
      emailVerified: true,
    },
    now,
  });
  const outsiderSession = await issueControlSession({
    db: env.DB,
    userId: outsider.userId,
    now,
    ttlMs: 600_000,
  });
  const unverified = await create(
    outsiderSession,
    "setup_operation_outsider",
    "Outsider shop",
  );
  expect(unverified).toMatchObject({
    status: 403,
    code: "organisation_owner_unverified",
  });
  expect(await ownedOrganisations(outsiderSession)).toEqual([]);

  context.task.meta.organisationSetup = {
    first: first.status,
    repeatSameOrganisation: repeat.organisationId === firstId,
    changedRepeat: changed,
    sixth,
    fifthRepeatSameOrganisation:
      fifthAgain.organisationId === more[3]?.organisationId,
    ownedOrganisations: owned.length,
    unverified,
  };
}

async function create(
  session: IssuedControlSession,
  operationId: string,
  name: string,
): Promise<Created> {
  const response = await exports.default.fetch(
    "https://localhost/v1/control/organisations",
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify({ operationId, name }),
    },
  );
  const body: unknown = await response.json();
  return {
    status: response.status,
    organisationId:
      isRecord(body) &&
      isRecord(body.organisation) &&
      typeof body.organisation.organisationId === "string"
        ? body.organisation.organisationId
        : null,
    code: isRecord(body) && typeof body.error === "string" ? body.error : null,
  };
}

/** The organisations that the person owns, as the Portal lists them. */
async function ownedOrganisations(
  session: IssuedControlSession,
): Promise<readonly string[]> {
  const response = await exports.default.fetch(
    "https://localhost/v1/control/organisations",
    { headers: commerceHeaders(session) },
  );
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.memberships))
    throw new Error(`Invalid organisation list: ${JSON.stringify(body)}`);
  const owned = new Set<string>();
  for (const membership of body.memberships)
    if (
      isRecord(membership) &&
      membership.role === "owner" &&
      typeof membership.organisationId === "string"
    )
      owned.add(membership.organisationId);
  return [...owned];
}
