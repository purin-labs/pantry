import type { SingleDatabase } from "../src/database-handles";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isRecord } from "@seams/std";
import type { OrganisationId } from "../src/ids";
import {
  issueControlSession,
  upsertUser,
  type ActiveControlSession,
  type User,
} from "../src/data/control-plane";
import { OrganisationExecutionScope } from "../src/organisation-execution-scope";
import { handleAccountPlatformRequest } from "../src/account-platform/routes";
import { readPantryProvisionApplied } from "../src/account-platform/provisioning-boundary";
import { resolvePantryAccountBinding } from "../src/account-platform/binding";
import { linkPantryAccountUser } from "../src/account-platform/identity";
import { accountText } from "../src/account-platform/types";
import { requireOrganisationBootstrap } from "./organisation-execution-fixture";
import { organisationBootstrapMutation } from "./control-mutation-fixture";
import {
  TEST_INITIAL_ORGANISATION_PLACEMENT,
  TEST_ORGANISATION_PLACEMENT_PROFILE,
} from "./fixtures/organisation-placement";
import { createMigratedDatabase, d1Database } from "./sqlite-d1";
import { platformEnv, type UnitTestEnv } from "./worker-fakes";

const ACCOUNT_ORIGIN = "https://account.shared-account.invalid";
const NATIVE_ORIGIN = "https://satyr.shared-account.invalid";
const assertionKeys = generateKeyPairSync("ed25519");
const googleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const provisionKeys = generateKeyPairSync("ed25519");

export interface RealAccountFixtureUser {
  readonly user: User;
  readonly session: ActiveControlSession;
}

interface NativeMember {
  readonly nativeUserId: string;
  readonly nativePersonId: string;
  readonly nativeSessionId: string;
  readonly google: {
    readonly issuer: "https://accounts.google.com";
    readonly subject: string;
  };
}

/** Execute the built account Worker with real D1, signed assertions and verified Google proofs. */
export async function connectRealAccountPlatform(
  env: UnitTestEnv,
  input: Readonly<{
    organisationId: OrganisationId;
    owner: RealAccountFixtureUser;
    members: readonly Readonly<{
      slot: "finance" | "operator" | "privateMember";
      actor: RealAccountFixtureUser;
    }>[];
  }>,
): Promise<Readonly<{ env: UnitTestEnv; artifactSha256: string }>> {
  const artifact = process.env.PANTRY_ACCOUNT_WORKER_ARTIFACT;
  if (!artifact)
    throw new Error(
      "Set PANTRY_ACCOUNT_WORKER_ARTIFACT to the built shared account Worker",
    );
  const transport = await RealAccountTransport.create(artifact);
  const configured: UnitTestEnv = {
    ...env,
    ACCOUNT_PLATFORM: transport,
    ACCOUNT_PLATFORM_DEPLOYMENT_ID: "shared-account-satyr-e2e",
    ACCOUNT_PLATFORM_PROVISION_TOKEN: "shared-account-e2e-pantry-provision",
    ACCOUNT_PLATFORM_PROVISION_ASSERTION_JWK: JSON.stringify(
      provisionKeys.publicKey.export({ format: "jwk" }),
    ),
    ACCOUNT_PLATFORM_PROVISION_ASSERTION_KEY_ID: "account-shared-account-e2e",
    ACCOUNT_PLATFORM_PROVISION_ASSERTION_ISSUER: ACCOUNT_ORIGIN,
    ACCOUNT_PLATFORM_PROVISION_ASSERTION_AUDIENCE: NATIVE_ORIGIN,
    ACCOUNT_PLATFORM_USER_ASSERTION_KEY_ID: "satyr-shared-account-e2e",
    ACCOUNT_PLATFORM_USER_ASSERTION_PKCS8_B64U: assertionKeys.privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64url"),
    ACCOUNT_PLATFORM_ASSERTION_ISSUER: NATIVE_ORIGIN,
    ACCOUNT_PLATFORM_ASSERTION_AUDIENCE: ACCOUNT_ORIGIN,
    GOOGLE_OIDC_CLIENT_ID: "shared-account-satyr-e2e",
  };
  // Auxiliary identities have actual native sessions in an isolated native database.
  // They never add a role or a project grant to the organisation under test.
  const auxiliary = createMigratedDatabase();
  const foreign = await auxiliaryOwner(auxiliary, "foreign");
  const finance = await auxiliaryOwner(auxiliary, "finance");
  const operator = await auxiliaryOwner(auxiliary, "operator");
  const privateMember = await auxiliaryOwner(auxiliary, "private");
  const nativeMembers: Record<
    "finance" | "operator" | "privateMember",
    NativeMember
  > = {
    finance: finance.member,
    operator: operator.member,
    privateMember: privateMember.member,
  };
  for (const member of input.members)
    nativeMembers[member.slot] = await nativeMember(
      configured,
      input.organisationId,
      member.actor,
    );
  const setup = await transport.fixture("setup", {
    version: 1,
    organisations: {
      primary: {
        nativeOrganisationId: input.organisationId,
        owner: await nativeMember(
          configured,
          input.organisationId,
          input.owner,
        ),
      },
      foreign: {
        nativeOrganisationId: foreign.organisationId,
        owner: foreign.member,
      },
    },
    members: nativeMembers,
  });
  if (
    !isRecord(setup) ||
    !isRecord(setup.provisionEnvelopes) ||
    !isRecord(setup.googleIdTokens)
  )
    throw new Error("Invalid account fixture setup");
  const provision = await handleAccountPlatformRequest(
    new Request(`${NATIVE_ORIGIN}/account-platform/v1/provision`, {
      method: "POST",
      headers: {
        authorization: "Bearer shared-account-e2e-pantry-provision",
        "content-type": "application/json",
      },
      body: JSON.stringify(setup.provisionEnvelopes.primary),
    }),
    configured,
  );
  if (provision === null) throw new Error("Native provision route missing");
  const raw: unknown = await provision.json();
  if (!provision.ok || !isRecord(raw) || raw.kind !== "accepted")
    throw new Error(
      `Native account provision failed: ${provision.status} ${JSON.stringify(raw)}`,
    );
  const applied = readPantryProvisionApplied(raw.value);
  await transport.fixture("acknowledge", {
    version: 1,
    receipt: applied.receipt,
    owner: applied.owner,
  });
  const binding = await resolvePantryAccountBinding(
    configured,
    input.organisationId,
  );
  if (!binding.ok)
    throw new Error(`Account binding failed: ${binding.error.code}`);
  for (const actor of [input.owner, ...input.members.map(memberActor)]) {
    const linked = await linkPantryAccountUser(configured, {
      binding: binding.value,
      userId: actor.user.userId,
      nativeSessionId: actor.session.controlSessionId,
      googleIdToken: accountText(setup.googleIdTokens[actor.user.userId]),
    });
    if (!linked.ok)
      throw new Error(`Account identity link failed: ${linked.error.code}`);
  }
  return {
    env: configured,
    artifactSha256: createHash("sha256")
      .update(readFileSync(artifact))
      .digest("hex"),
  };
}

function memberActor(
  member: Readonly<{ actor: RealAccountFixtureUser }>,
): RealAccountFixtureUser {
  return member.actor;
}

async function nativeMember(
  env: UnitTestEnv,
  organisationId: OrganisationId,
  actor: RealAccountFixtureUser,
): Promise<NativeMember> {
  if (actor.user.issuer !== "https://accounts.google.com")
    throw new Error("Fixture needs a verified Google identity");
  const scope = await OrganisationExecutionScope.resolve(env, organisationId);
  if (!scope.ok) throw new Error(scope.error.code);
  const grant = await scope.value.database
    .prepare(
      "SELECT person_id AS personId FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND status = 'active'",
    )
    .bind(organisationId, actor.user.userId)
    .first<{ personId: string }>();
  if (grant === null || actor.session.userId !== actor.user.userId)
    throw new Error("Fixture needs an active native role and actual session");
  return {
    nativeUserId: actor.user.userId,
    nativePersonId: grant.personId,
    nativeSessionId: actor.session.controlSessionId,
    google: { issuer: actor.user.issuer, subject: actor.user.subject },
  };
}

async function auxiliaryOwner(
  db: SingleDatabase,
  label: string,
): Promise<Readonly<{ organisationId: OrganisationId; member: NativeMember }>> {
  const subject = `account-fixture-${label}-${randomUUID()}`;
  const user = await upsertUser({
    db,
    identity: {
      issuer: "https://accounts.google.com",
      subject,
      email: `${subject}@example.test`,
      displayName: label,
      emailVerified: true,
    },
    now: Date.now(),
  });
  const organisation = await requireOrganisationBootstrap({
    env: {
      DB: db,
      PANTRY_ORGANISATION_PLACEMENT_PROFILE: TEST_ORGANISATION_PLACEMENT_PROFILE,
    },
    owner: user,
    organisationName: label,
    environment: "development",
    mutation: organisationBootstrapMutation(user, Date.now()),
    placement: TEST_INITIAL_ORGANISATION_PLACEMENT,
    now: Date.now(),
  });
  const issued = await issueControlSession({
    db,
    userId: user.userId,
    now: Date.now(),
    ttlMs: 3600000,
  });
  return {
    organisationId: organisation.organisationId,
    member: await nativeMember(
      platformEnv({
        DB: db,
        PANTRY_ORGANISATION_PLACEMENT_PROFILE:
          TEST_ORGANISATION_PLACEMENT_PROFILE,
      }),
      organisation.organisationId,
      { user, session: issued.session },
    ),
  };
}

class RealAccountTransport {
  private constructor(
    private readonly worker: object,
    private readonly handler: Function,
    private readonly bindings: Readonly<Record<string, unknown>>,
  ) {}

  static async create(artifact: string): Promise<RealAccountTransport> {
    const module: unknown = await import(
      /* @vite-ignore */ `${pathToFileURL(artifact).href}?fixture=${randomUUID()}`
    );
    if (
      !isRecord(module) ||
      !isRecord(module.default) ||
      typeof module.default.fetch !== "function"
    )
      throw new Error("Invalid built account Worker export");
    return new RealAccountTransport(module.default, module.default.fetch, {
      ACCOUNT_DB: d1Database(new DatabaseSync(":memory:")),
      FIXTURE_ASSERTION_PUBLIC_JWK: JSON.stringify(
        assertionKeys.publicKey.export({ format: "jwk" }),
      ),
      FIXTURE_GOOGLE_PRIVATE_JWK: JSON.stringify(
        googleKeys.privateKey.export({ format: "jwk" }),
      ),
      FIXTURE_GOOGLE_PUBLIC_JWK: JSON.stringify(
        googleKeys.publicKey.export({ format: "jwk" }),
      ),
      FIXTURE_GOOGLE_CLIENT_ID: "shared-account-satyr-e2e",
      FIXTURE_PROVISION_PRIVATE_JWK: JSON.stringify(
        provisionKeys.privateKey.export({ format: "jwk" }),
      ),
    });
  }

  connect(
    ..._input: Parameters<Fetcher["connect"]>
  ): ReturnType<Fetcher["connect"]> {
    throw new Error("The account fixture supports HTTP requests only");
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request =
      input instanceof Request && init === undefined
        ? input
        : new Request(input, init);
    const response: unknown = await Reflect.apply(this.handler, this.worker, [
      request,
      this.bindings,
    ]);
    if (!(response instanceof Response))
      throw new Error("Invalid account Worker response");
    return response;
  }

  async fixture(
    operation: "setup" | "acknowledge",
    body: unknown,
  ): Promise<unknown> {
    const response = await this.fetch(
      `${ACCOUNT_ORIGIN}/__fixture/account-platform/v1/${operation}`,
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
    if (!response.ok)
      throw new Error(
        `Account fixture ${operation} failed: ${response.status} ${JSON.stringify(raw)}`,
      );
    return raw;
  }
}
