// Attaches the Organisation of a journey's fixture Worker (the Brain, side
// Case and Kitchen journeys) to the real account authority. The provider
// process runs the built account Worker and binds it to the Worker under
// test, so each request below passes through that binding.
import { isRecord } from "../../packages/std/src/index";
import { ensurePantryAccountAutomationGrant } from "../../services/platform/src/account-platform/automation";
import { resolvePantryAccountBinding } from "../../services/platform/src/account-platform/binding";
import { linkPantryAccountUser } from "../../services/platform/src/account-platform/identity";
import { readPantryProvisionApplied } from "../../services/platform/src/account-platform/provisioning-boundary";
import { handleAccountPlatformRequest } from "../../services/platform/src/account-platform/routes";
import { accountText } from "../../services/platform/src/account-platform/types";
import { newControlMutationIdentity } from "../../services/platform/src/data/control-mutation";
import {
  bootstrapOrganisation,
  issueControlSession,
  upsertUser,
  type ActiveControlSession,
  type ControlRole,
  type User,
} from "../../services/platform/src/data/control-plane";
import type { Env } from "../../services/platform/src/env";
import type { OrganisationId } from "../../services/platform/src/ids";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope";
import { parseInitialOrganisationPlacement } from "../../services/platform/src/placement";

/** A person with a role in one Organisation and a control session. */
export type AccountPerson = Readonly<{
  user: User;
  personId: string;
  session: ActiveControlSession;
}>;

type NativeOwner = Readonly<{
  organisationId: OrganisationId;
  person: AccountPerson;
}>;

function nativeMember(person: AccountPerson) {
  if (person.user.issuer !== "https://accounts.google.com")
    throw new Error("The account authority needs a verified Google identity");
  return {
    nativeUserId: person.user.userId,
    nativePersonId: person.personId,
    nativeSessionId: person.session.controlSessionId,
    google: { issuer: person.user.issuer, subject: person.user.subject },
  };
}

async function accountFixture(
  env: Env,
  operation: "setup" | "acknowledge",
  body: unknown,
): Promise<Record<string, unknown>> {
  if (!env.ACCOUNT_PLATFORM)
    throw new Error("The account Worker is not bound to the fixture Worker");
  const response = await env.ACCOUNT_PLATFORM.fetch(
    `https://account-platform.internal/__fixture/account-platform/v1/${operation}`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer shared-account-e2e-admin",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const raw: unknown = await response.json();
  if (!response.ok || !isRecord(raw))
    throw new Error(
      `Account fixture ${operation} failed: ${String(response.status)} ${JSON.stringify(raw)}`,
    );
  return raw;
}

function hasName(name: string | null, candidate: string): boolean {
  return name === candidate;
}

/**
 * The people and Organisations of a journey's fixture Worker (Plans 42J, 74
 * and 81). Each Google subject is `subjectPrefix` and the person's name;
 * `label` names the placement cell and the hashes of each Organisation that
 * the fixture creates.
 */
export function fixturePeople(subjectPrefix: string, label: string) {
  /** The account authority verifies a Google identity, so each person has one. */
  async function fixtureUser(env: Env, name: string) {
    const subject = `${subjectPrefix}${name.toLowerCase().replaceAll(" ", "-")}`;
    return upsertUser({
      db: env.DB,
      now: Date.now(),
      identity: {
        issuer: "https://accounts.google.com",
        subject,
        email: `${subject}@example.test`,
        displayName: name,
        emailVerified: true,
      },
    });
  }

  async function fixtureOrganisation(
    env: Env,
    owner: User,
    name: string,
  ): Promise<OrganisationId> {
    const now = Date.now();
    const placement = parseInitialOrganisationPlacement({
      kind: "affinity",
      placementEpoch: 1,
      placementCellId: label,
      locationHint: "wnam",
    });
    if (!placement.ok) {
      throw new Error(placement.error.path);
    }
    const created = await bootstrapOrganisation({
      env,
      owner,
      organisationName: name,
      environment: "development",
      placement: placement.value,
      now,
      mutation: {
        scope: {
          userId: owner.userId,
          organisationScope: "organisation:create",
          route: "/v1/control/organisations",
          operation: "organisation.create",
        },
        boundary: {
          kind: "unversioned",
          idempotencyKey: crypto.randomUUID(),
          requestHash: label,
        },
        identity: newControlMutationIdentity({
          portalSubjectHash: label,
          causationId: crypto.randomUUID(),
          now,
        }),
      },
    });
    if (!created.ok) {
      throw new Error(created.error.code);
    }
    return created.value.organisationId;
  }

  /** One person's role in an Organisation, with a control session of theirs. */
  async function fixturePerson(
    env: Env,
    organisationId: OrganisationId,
    user: User,
  ): Promise<AccountPerson> {
    const grant = await env.DB.prepare(
      "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND status = 'active'",
    )
      .bind(organisationId, user.userId)
      .first<{ personId: string }>();
    if (grant === null) {
      throw new Error("Fixture person has no role");
    }
    const issued = await issueControlSession({
      db: env.DB,
      userId: user.userId,
      now: Date.now(),
      ttlMs: 3_600_000,
    });
    return { user, personId: grant.personId, session: issued.session };
  }

  /** A person of the account fixture who owns a separate organisation. */
  async function auxiliaryOwner(env: Env, auxiliary: string) {
    const user = await fixtureUser(env, `Auxiliary ${auxiliary}`);
    const organisationId = await fixtureOrganisation(
      env,
      user,
      `Account fixture ${auxiliary}`,
    );
    return {
      organisationId,
      person: await fixturePerson(env, organisationId, user),
    };
  }

  /**
   * Signs in `name`, one of `names`, with the control session and CSRF
   * cookies. With `withCsrfToken` the body also names the CSRF token.
   */
  async function login(
    env: Env,
    names: readonly string[],
    name: string | null,
    withCsrfToken = false,
  ): Promise<Response> {
    if (name === null || !names.some(hasName.bind(null, name))) {
      return new Response(null, { status: 400 });
    }
    const user = await fixtureUser(env, name);
    const issued = await issueControlSession({
      db: env.DB,
      userId: user.userId,
      now: Date.now(),
      ttlMs: 3_600_000,
    });
    const response = Response.json(
      withCsrfToken
        ? { userId: user.userId, csrfToken: issued.csrfToken }
        : { userId: user.userId },
    );
    response.headers.append(
      "set-cookie",
      `satyr_control_session=${issued.token}; HttpOnly; Path=/; SameSite=Lax`,
    );
    response.headers.append(
      "set-cookie",
      `satyr_control_csrf=${issued.csrfToken}; Path=/; SameSite=Lax`,
    );
    return response;
  }

  /**
   * One active Organisation `name` with Pantry's model route. "Owner" creates
   * it and "Other" is its administrator; `member`, when given, has `role`.
   * The account authority admits each of them, and `label` names the
   * activation.
   */
  async function admittedOrganisation(
    env: Env,
    name: string,
    member?: Readonly<{ name: string; role: ControlRole }>,
  ) {
    const now = Date.now();
    const owner = await fixtureUser(env, "Owner");
    const other = await fixtureUser(env, "Other");
    const memberUser =
      member === undefined ? undefined : await fixtureUser(env, member.name);
    const organisationId = await fixtureOrganisation(env, owner, name);
    const roles: { user: User; name: string; role: ControlRole }[] = [
      { user: other, name: "Other", role: "admin" },
    ];
    if (member !== undefined && memberUser !== undefined)
      roles.push({ user: memberUser, name: member.name, role: member.role });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE organisation_onboarding SET lifecycle = 'active', activation_receipt_id = ?, activated_at = ?, updated_at = ? WHERE organisation_id = ?",
      ).bind(label, now, now, organisationId),
      ...roles.flatMap((person) => {
        const personId = `person_${crypto.randomUUID()}`;
        return [
          env.DB.prepare(
            "INSERT INTO person (organisation_id, person_id, display_name) VALUES (?, ?, ?)",
          ).bind(organisationId, personId, person.name),
          env.DB.prepare(
            "INSERT INTO service_role_grant (organisation_id, user_id, person_id, role, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
          ).bind(
            organisationId,
            person.user.userId,
            personId,
            person.role,
            now,
          ),
        ];
      }),
      env.DB.prepare(
        "INSERT INTO organisation_inference_selection (organisation_id, selection_kind, selected_by_user_id, selected_at) VALUES (?, 'satyr_platform', ?, ?)",
      ).bind(organisationId, owner.userId, now),
    ]);
    const ownerPerson = await fixturePerson(env, organisationId, owner);
    await attachToAccountAuthority(env, {
      organisationId,
      owner: ownerPerson,
      administrator: await fixturePerson(env, organisationId, other),
      member:
        memberUser === undefined
          ? undefined
          : await fixturePerson(env, organisationId, memberUser),
      auxiliary: auxiliaryOwner.bind(null, env),
    });
    return { organisationId, owner, other, member: memberUser, ownerPerson };
  }

  return {
    fixtureUser,
    fixtureOrganisation,
    fixturePerson,
    auxiliaryOwner,
    admittedOrganisation,
    login,
  };
}

/**
 * The account authority admits the owner and the administrator. The other
 * people that its fixture names own separate organisations, so the attach
 * adds no role to the Organisation under test.
 */
export async function attachToAccountAuthority(
  env: Env,
  input: Readonly<{
    organisationId: OrganisationId;
    owner: AccountPerson;
    administrator: AccountPerson;
    member?: AccountPerson;
    auxiliary: (label: string) => Promise<NativeOwner>;
  }>,
): Promise<void> {
  const foreign = await input.auxiliary("foreign");
  const finance = await input.auxiliary("finance");
  const privateMemberPerson =
    input.member ?? (await input.auxiliary("private")).person;
  const setup = await accountFixture(env, "setup", {
    version: 1,
    organisations: {
      primary: {
        nativeOrganisationId: input.organisationId,
        owner: nativeMember(input.owner),
      },
      foreign: {
        nativeOrganisationId: foreign.organisationId,
        owner: nativeMember(foreign.person),
      },
    },
    members: {
      finance: nativeMember(finance.person),
      operator: nativeMember(input.administrator),
      privateMember: nativeMember(privateMemberPerson),
    },
  });
  if (!isRecord(setup.provisionEnvelopes) || !isRecord(setup.googleIdTokens))
    throw new Error("Account fixture setup is invalid");
  const provision = await handleAccountPlatformRequest(
    new Request(
      `${accountText(env.ACCOUNT_PLATFORM_ASSERTION_ISSUER)}/account-platform/v1/provision`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accountText(env.ACCOUNT_PLATFORM_PROVISION_TOKEN)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(setup.provisionEnvelopes.primary),
      },
    ),
    env,
  );
  if (provision === null) throw new Error("Native provision route missing");
  const raw: unknown = await provision.json();
  if (!provision.ok || !isRecord(raw) || raw.kind !== "accepted")
    throw new Error(
      `Native account provision failed: ${String(provision.status)} ${JSON.stringify(raw)}`,
    );
  const applied = readPantryProvisionApplied(raw.value);
  await accountFixture(env, "acknowledge", {
    version: 1,
    receipt: applied.receipt,
    owner: applied.owner,
  });
  const binding = await resolvePantryAccountBinding(env, input.organisationId);
  if (!binding.ok)
    throw new Error(`Account binding failed: ${binding.error.code}`);
  const linked = await linkPantryAccountUser(env, {
    binding: binding.value,
    userId: input.administrator.user.userId,
    nativeSessionId: input.administrator.session.controlSessionId,
    googleIdToken: accountText(
      setup.googleIdTokens[input.administrator.user.userId],
    ),
  });
  if (!linked.ok)
    throw new Error(`Account identity link failed: ${linked.error.code}`);
  if (input.member !== undefined) {
    const memberLinked = await linkPantryAccountUser(env, {
      binding: binding.value,
      userId: input.member.user.userId,
      nativeSessionId: input.member.session.controlSessionId,
      googleIdToken: accountText(
        setup.googleIdTokens[input.member.user.userId],
      ),
    });
    if (!memberLinked.ok)
      throw new Error(
        `Account member identity link failed: ${memberLinked.error.code}`,
      );
  }
}

/** The account authority admits the agent of one mailbox binding. */
export async function admitMailboxAgent(
  env: Env,
  input: Readonly<{
    organisationId: OrganisationId;
    administrator: AccountPerson;
    mailboxBindingId: string;
    bindingRevision: number;
  }>,
): Promise<void> {
  const scope = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!scope.ok) throw new Error(scope.error.code);
  const granted = await ensurePantryAccountAutomationGrant({
    env,
    scope: scope.value,
    session: input.administrator.session,
    native: {
      kind: "agent_mailbox",
      nativeId: input.mailboxBindingId,
      revision: input.bindingRevision,
    },
  });
  if (!granted.ok)
    throw new Error(`Account automation grant failed: ${granted.error.code}`);
}
