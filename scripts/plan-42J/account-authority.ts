// Attaches the Brain journey's Organisation to the real account authority.
// The provider process runs the built account Worker and binds it to the
// Worker under test, so each request below passes through that binding.
import { isRecord } from "../../packages/std/src/index";
import { ensurePantryAccountAutomationGrant } from "../../services/platform/src/account-platform/automation";
import { resolvePantryAccountBinding } from "../../services/platform/src/account-platform/binding";
import { linkPantryAccountUser } from "../../services/platform/src/account-platform/identity";
import { readPantryProvisionApplied } from "../../services/platform/src/account-platform/provisioning-boundary";
import { handleAccountPlatformRequest } from "../../services/platform/src/account-platform/routes";
import { accountText } from "../../services/platform/src/account-platform/types";
import type {
  ActiveControlSession,
  User,
} from "../../services/platform/src/data/control-plane";
import type { Env } from "../../services/platform/src/env";
import type { OrganisationId } from "../../services/platform/src/ids";
import { OrganisationExecutionScope } from "../../services/platform/src/organisation-execution-scope";

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
