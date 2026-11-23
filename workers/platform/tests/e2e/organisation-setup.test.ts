import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";

import {
  issueControlSession,
  upsertUser,
  type IssuedControlSession,
} from "@purin-labs/tenancy/data/control-plane";
import {
  parseOrganisationId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { runScheduledOnboardingReconciliation } from "../../src/onboarding-reconciliation-runner";
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

// One name rule for an Organisation. The owner makes one with the longest
// name that Pantry takes and renames it to another name of that length and
// to the shortest one. A name that is one character too short or too long is
// refused, at creation and at a rename, as a problem with the name.
it(
  "takes the same organisation names at creation and at a rename, and refuses a name that is too short or too long at both",
  nameRuleJourney,
  120_000,
);

// A mutation receipt lives one day. Within the day, a repeat of a rename
// under the same Idempotency-Key answers from the receipt, and another name
// under that key is a conflict. After the day, the scheduled run deletes the
// receipt, so the key starts a new rename.
it(
  "replays a rename under its key for one day, and takes the key as new after the scheduled run deletes the receipt",
  receiptLifetimeJourney,
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

async function nameRuleJourney(context: TestContext): Promise<void> {
  const owner = await commerceClient(`name-owner-${crypto.randomUUID()}`);
  const longest = "Rhubarb and Rye Bakery ".repeat(6).slice(0, 120);
  const otherLongest = "Croissant and Coffee House ".repeat(5).slice(0, 120);
  expect([longest.trim().length, otherLongest.trim().length]).toEqual([
    120, 120,
  ]);

  // Denied at creation: one character, and 121 characters.
  const tooShort = await create(owner.session, "name_operation_short", "Q");
  const tooLong = await create(
    owner.session,
    "name_operation_long",
    `${longest}X`,
  );
  expect([tooShort, tooLong]).toEqual([
    { status: 422, organisationId: null, code: "organisation_create_invalid" },
    { status: 422, organisationId: null, code: "organisation_create_invalid" },
  ]);
  expect(await ownedOrganisations(owner.session)).toEqual([]);

  const made = await create(owner.session, "name_operation_made", longest);
  expect(made.status, JSON.stringify(made)).toBe(200);
  const organisationId = String(made.organisationId);

  // A rename takes each name that creation takes.
  const renamedLongest = await rename(
    owner.session,
    organisationId,
    otherLongest,
  );
  expect(renamedLongest).toEqual({ status: 200, code: null });
  expect(await organisationName(owner.session, organisationId)).toBe(
    otherLongest,
  );
  const renamedShortest = await rename(owner.session, organisationId, "Ox");
  expect(renamedShortest).toEqual({ status: 200, code: null });

  // Denied at a rename: the same two names that creation refused.
  const renamedTooShort = await rename(owner.session, organisationId, "Q");
  const renamedTooLong = await rename(
    owner.session,
    organisationId,
    `${longest}X`,
  );
  expect([renamedTooShort, renamedTooLong]).toEqual([
    { status: 422, code: "organisation_rename_request_invalid" },
    { status: 422, code: "organisation_rename_request_invalid" },
  ]);
  expect(await organisationName(owner.session, organisationId)).toBe("Ox");

  context.task.meta.organisationSetup = {
    createdTooShort: tooShort,
    createdTooLong: tooLong,
    created: made.status,
    renamedLongest,
    renamedShortest,
    renamedTooShort,
    renamedTooLong,
  };
}

async function receiptLifetimeJourney(context: TestContext): Promise<void> {
  const owner = await commerceClient(`receipt-owner-${crypto.randomUUID()}`);
  const made = await create(owner.session, "receipt_operation_made", "Rye");
  expect(made.status, JSON.stringify(made)).toBe(200);
  const organisationId = String(made.organisationId);
  const key = `rename-${crypto.randomUUID()}`;
  // A retry sends the request again as it was: the same key and version.
  const { configurationVersion } = await organisationProjection(
    owner.session,
    organisationId,
  );
  const retry = { idempotencyKey: key, configurationVersion };

  const first = await rename(
    owner.session,
    organisationId,
    "Rye Bakery",
    retry,
  );
  expect(first).toEqual({ status: 200, code: null });
  const replayed = await rename(
    owner.session,
    organisationId,
    "Rye Bakery",
    retry,
  );
  expect(replayed).toEqual({ status: 200, code: null });
  // Denied within the day: another name under the same key.
  const conflict = await rename(
    owner.session,
    organisationId,
    "Rye Cafe",
    retry,
  );
  expect(conflict).toEqual({ status: 409, code: "idempotency_key_conflict" });
  expect(await organisationName(owner.session, organisationId)).toBe(
    "Rye Bakery",
  );
  const receiptsBefore = await renameReceipts(organisationId, key);
  expect(receiptsBefore).toBe(1);

  // A day and a quarter of an hour later, the scheduled run has deleted the
  // receipt: the key starts a new rename.
  await runScheduledOnboardingReconciliation(
    env,
    Date.now() + 24 * 60 * 60 * 1_000 + 15 * 60 * 1_000,
  );
  const receiptsAfter = await renameReceipts(organisationId, key);
  expect(receiptsAfter).toBe(0);
  const later = await rename(owner.session, organisationId, "Rye Cafe", {
    idempotencyKey: key,
  });
  expect(later).toEqual({ status: 200, code: null });
  expect(await organisationName(owner.session, organisationId)).toBe(
    "Rye Cafe",
  );

  context.task.meta.organisationSetup = {
    first,
    replayed,
    conflict,
    receiptsBefore,
    receiptsAfter,
    later,
  };
}

/** The receipts of the rename route under one key, in every database. */
async function renameReceipts(
  organisationId: string,
  key: string,
): Promise<number> {
  const scope = await requireOrganisationExecutionScope(
    env,
    parseRequiredOrganisationId(organisationId),
  );
  const row = await scope.database
    .prepare(
      "SELECT COUNT(*) AS count FROM control_mutation_receipt WHERE organisation_scope = ? AND idempotency_key = ?",
    )
    .bind(organisationId, key)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

function parseRequiredOrganisationId(raw: string): OrganisationId {
  const parsed = parseOrganisationId(raw);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
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

/** The projection of the organisation, as the Portal reads it. */
async function organisationProjection(
  session: IssuedControlSession,
  organisationId: string,
): Promise<Readonly<{ configurationVersion: number; name: string }>> {
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}`,
    { headers: commerceHeaders(session) },
  );
  const body: unknown = await response.json();
  if (
    response.status !== 200 ||
    !isRecord(body) ||
    typeof body.configuration_version !== "number" ||
    !isRecord(body.organisation) ||
    typeof body.organisation.name !== "string"
  )
    throw new Error(`No projection in ${JSON.stringify(body).slice(0, 400)}`);
  return {
    configurationVersion: body.configuration_version,
    name: body.organisation.name,
  };
}

async function organisationName(
  session: IssuedControlSession,
  organisationId: string,
): Promise<string> {
  return (await organisationProjection(session, organisationId)).name;
}

/** The rename of the Organisations page, with the version that it read. */
async function rename(
  session: IssuedControlSession,
  organisationId: string,
  name: string,
  retry?: Readonly<{ idempotencyKey: string; configurationVersion?: number }>,
): Promise<Readonly<{ status: number; code: string | null }>> {
  const idempotencyKey = retry?.idempotencyKey ?? crypto.randomUUID();
  const configurationVersion =
    retry?.configurationVersion ??
    (await organisationProjection(session, organisationId))
      .configurationVersion;
  const headers = commerceHeaders(session);
  headers.set("idempotency-key", idempotencyKey);
  headers.set("x-pantry-configuration-version", String(configurationVersion));
  const response = await exports.default.fetch(
    `https://localhost/v1/control/organisations/${organisationId}`,
    { method: "PATCH", headers, body: JSON.stringify({ name }) },
  );
  const body: unknown = await response.json();
  return {
    status: response.status,
    code: isRecord(body) && typeof body.error === "string" ? body.error : null,
  };
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
