// Attaches the trial Organisation to the built shared account Worker, which
// the runtime binds as ACCOUNT_PLATFORM (see account-worker.mjs). Each
// control request and each turn then passes the real account check.
import { ensurePantryAccountAutomationGrant } from "../../services/platform/src/account-platform/automation.ts";
import { resolvePantryAccountBinding } from "../../services/platform/src/account-platform/binding.ts";
import { linkPantryAccountUser } from "../../services/platform/src/account-platform/identity.ts";
import { readPantryProvisionApplied } from "../../services/platform/src/account-platform/provisioning-boundary.ts";
import { handleAccountPlatformRequest } from "../../services/platform/src/account-platform/routes.ts";
import { acceptedExecutionAccountAuthority } from "../../services/platform/src/account-platform/access.ts";
import { accountText } from "../../services/platform/src/account-platform/types.ts";
import { compileTurnAuthority } from "../../services/platform/src/authorization/access-grants/turn-authority.ts";
import {
  issueControlSession,
  resolveControlSessionById,
} from "../../services/platform/src/data/control-plane.ts";
import {
  newControlSessionId,
  newUserId,
  parseUserId,
} from "../../services/platform/src/ids.ts";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope.ts";

const GOOGLE = "https://accounts.google.com";

// The account authority binds the Organisation to one Pantry owner. The trial
// people keep their operator roles, so a trial can demote or revoke them. It
// lives here, not in a trial's entry module, which may export only handlers.
const parsedOwnerUser = parseUserId(
  "user_00000000-0000-5000-8000-000000000050",
);
if (!parsedOwnerUser.ok) throw new Error("Invalid trial owner");
export const ownerUser = parsedOwnerUser.value;

async function accountFixture(env, operation, body) {
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
  const raw = await response.json();
  if (!response.ok)
    throw new Error(
      `Account fixture ${operation} failed: ${response.status} ${JSON.stringify(raw)}`,
    );
  return raw;
}

/** A trial person: a Google identity, an active role and a control session. */
async function nativeMember(env, organisationId, userId) {
  const row = await env.DB.prepare(
    "SELECT u.issuer, u.subject, g.person_id AS personId FROM app_user u JOIN service_role_grant g ON g.user_id = u.user_id WHERE g.organisation_id = ? AND u.user_id = ? AND g.status = 'active'",
  )
    .bind(organisationId, userId)
    .first();
  if (row === null || row.issuer !== GOOGLE)
    throw new Error(`Trial person ${userId} has no Google identity and role`);
  const issued = await issueControlSession({
    db: env.DB,
    userId,
    now: Date.now(),
    ttlMs: 3_600_000,
  });
  return {
    nativeUserId: userId,
    nativePersonId: row.personId,
    nativeSessionId: issued.session.controlSessionId,
    google: { issuer: GOOGLE, subject: row.subject },
  };
}

/** A person of another account organisation. It adds no role here. */
function outsideMember(label) {
  return {
    nativeUserId: newUserId(),
    nativePersonId: `person_${crypto.randomUUID()}`,
    nativeSessionId: newControlSessionId(),
    google: {
      issuer: GOOGLE,
      subject: `plan50-outside-${label}-${crypto.randomUUID()}`,
    },
  };
}

/**
 * The owner must hold the Pantry owner role. `members` maps the account slots
 * `operator` and `privateMember` to user ids of this Organisation; the
 * account admits both. An empty slot is a person of another organisation.
 */
export async function attachTrialOrganisation(
  env,
  { organisationId, ownerUserId, members },
) {
  const owner = await nativeMember(env, organisationId, ownerUserId);
  const slots = {
    finance: outsideMember("finance"),
    operator: outsideMember("operator"),
    privateMember: outsideMember("private"),
  };
  for (const [slot, userId] of Object.entries(members))
    slots[slot] = await nativeMember(env, organisationId, userId);
  const setup = await accountFixture(env, "setup", {
    version: 1,
    organisations: {
      primary: { nativeOrganisationId: organisationId, owner },
      foreign: {
        nativeOrganisationId: `organisation_plan50_foreign_${crypto.randomUUID()}`,
        owner: outsideMember("foreign"),
      },
    },
    members: slots,
  });
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
  const raw = await provision.json();
  if (!provision.ok || raw.kind !== "accepted")
    throw new Error(
      `Native account provision failed: ${provision.status} ${JSON.stringify(raw)}`,
    );
  const applied = readPantryProvisionApplied(raw.value);
  await accountFixture(env, "acknowledge", {
    version: 1,
    receipt: applied.receipt,
    owner: applied.owner,
  });
  const binding = await resolvePantryAccountBinding(env, organisationId);
  if (!binding.ok)
    throw new Error(`Account binding failed: ${binding.error.code}`);
  // The acknowledgement links the owner; each admitted member links here.
  for (const slot of Object.keys(members)) {
    const member = slots[slot];
    const token = setup.googleIdTokens[member.nativeUserId];
    if (token === undefined)
      throw new Error(`No Google proof for ${member.nativeUserId}`);
    const linked = await linkPantryAccountUser(env, {
      binding: binding.value,
      userId: member.nativeUserId,
      nativeSessionId: member.nativeSessionId,
      googleIdToken: token,
    });
    if (!linked.ok)
      throw new Error(`Account identity link failed: ${linked.error.code}`);
  }
  return owner;
}

/** The account grant of one workflow, as an administrator gives it. */
export async function admitTrialWorkflow(env, organisationId, owner, native) {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  const session = await resolveControlSessionById({
    db: env.DB,
    controlSessionId: owner.nativeSessionId,
    now: Date.now(),
  });
  if (!session.ok) throw new Error("Trial owner session is not active");
  const granted = await ensurePantryAccountAutomationGrant({
    env,
    scope: scope.value,
    session: session.value,
    native: { kind: "workflow", ...native },
  });
  if (!granted.ok)
    throw new Error(`Account automation grant failed: ${granted.error.code}`);
}

/** The account access of the trial Organisation's current placement. */
export async function trialAccountAccess(env, organisationId) {
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  return scope.value.accountAccess;
}

/** The turn authority of an accepted turn, under the current account check. */
export async function compileTrialTurnAuthority(env, input) {
  const scope = await OrganisationExecutionScope.resolve(
    env,
    input.organisationId,
  );
  if (!scope.ok) return { ok: false, error: scope.error };
  return compileTurnAuthority({
    db: scope.value.database,
    accountAccess: scope.value.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(
      input.sessionId,
      input.turnId,
    ),
    action: "execute",
    organisationId: input.organisationId,
    requestAuthority: input.requestAuthority,
    policy: input.policy,
  });
}
