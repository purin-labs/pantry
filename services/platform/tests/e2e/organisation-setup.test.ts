import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
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

// Plan 91 phase 4. A person on the deployment's list of test organisation
// owners makes a test organisation, which lives in the development
// environment, so that it takes provider test accounts. Every other person
// is refused one.
it(
  "makes a test organisation in the development environment for a listed owner, and refuses an owner who is not on the list",
  testOrganisationJourney,
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

async function testOrganisationJourney(context: TestContext): Promise<void> {
  // The list is `Test-Owner@pantry.test, second@pantry.test`: the check
  // ignores case and spaces.
  const now = Date.now();
  const listed = await upsertUser({
    db: env.DB,
    identity: {
      issuer: "https://accounts.google.com",
      subject: `test-owner-${crypto.randomUUID()}`,
      email: "test-owner@pantry.test",
      displayName: "Test owner",
      emailVerified: true,
    },
    now,
  });
  const listedSession = await issueControlSession({
    db: env.DB,
    userId: listed.userId,
    now,
    ttlMs: 600_000,
  });
  const other = await commerceClient(`test-other-${crypto.randomUUID()}`);

  // Denied: a verified owner who is not on the list.
  const refused = await create(
    other.session,
    "test_operation_other",
    "Not a test shop",
    "test",
  );
  expect(refused).toMatchObject({
    status: 403,
    code: "organisation_test_not_allowed",
  });
  expect(await ownedOrganisations(other.session)).toEqual([]);

  // Denied: a purpose that Pantry does not know.
  const unknownPurpose = await create(
    listedSession,
    "test_operation_unknown",
    "Live shop",
    "live",
  );
  expect(unknownPurpose).toMatchObject({
    status: 422,
    code: "organisation_create_invalid",
  });

  const made = await create(
    listedSession,
    "test_operation_listed",
    "Test shop",
    "test",
  );
  expect(made.status, JSON.stringify(made)).toBe(200);
  const environment = await organisationEnvironment(
    listedSession,
    String(made.organisationId),
  );
  expect(environment).toBe("development");
  // A repeat answers with the same test organisation.
  const repeat = await create(
    listedSession,
    "test_operation_listed",
    "Test shop",
    "test",
  );
  expect(repeat).toEqual(made);
  // Denied: the same operation id as an ordinary organisation.
  const asBusiness = await create(
    listedSession,
    "test_operation_listed",
    "Test shop",
  );
  expect(asBusiness).toMatchObject({
    status: 409,
    code: "idempotency_key_conflict",
  });
  expect(await ownedOrganisations(listedSession)).toEqual([
    made.organisationId,
  ]);

  context.task.meta.organisationSetup = {
    refused,
    unknownPurpose,
    made: made.status,
    environment,
    repeatSameOrganisation: repeat.organisationId === made.organisationId,
    asBusiness,
  };
}

/** The environment that the Portal reads for the organisation. */
async function organisationEnvironment(
  session: IssuedControlSession,
  organisationId: string,
): Promise<unknown> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}`,
    { headers: commerceHeaders(session) },
  );
  const body: unknown = await response.json();
  const found: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value))
      for (const [key, child] of Object.entries(value))
        if (key === "environment") found.push(child);
        else visit(child);
  };
  visit(body);
  if (response.status !== 200 || found.length === 0)
    throw new Error(`No environment in ${JSON.stringify(body).slice(0, 400)}`);
  return new Set(found).size === 1 ? found[0] : found;
}

async function create(
  session: IssuedControlSession,
  operationId: string,
  name: string,
  purpose?: string,
): Promise<Created> {
  const response = await exports.default.fetch(
    "https://localhost/v1/control/organisations",
    {
      method: "POST",
      headers: commerceHeaders(session),
      body: JSON.stringify(
        purpose === undefined
          ? { operationId, name }
          : { operationId, name, purpose },
      ),
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
