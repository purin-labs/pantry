// The people and Organisations of a journey's fixture Worker (the Brain, side
// Case and Kitchen journeys). Pantry keeps its own members (Plan 95), so the
// fixture needs no outside account authority.
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
import { parseInitialOrganisationPlacement } from "../../services/platform/src/placement";

/** A person with a role in one Organisation and a control session. */
export type AccountPerson = Readonly<{
  user: User;
  personId: string;
  session: ActiveControlSession;
}>;

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
  /** Each person signs in with a verified Google identity. */
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

  /** A person who owns a separate organisation. */
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
   * `label` names the activation.
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
