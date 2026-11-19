import { describe, expect, it } from "vitest";

import {
  runCredentialClosureCommand,
  type CredentialClosureCommandRuntime,
} from "../scripts/audit-credential-closure";

const ORGANISATION_ID = "organisation_command_test";
const LOCAL_ORIGIN = "http://127.0.0.1:8787";
const REMOTE_ORIGIN = "https://satyr.example.com";
const ADMIN_TOKEN = "organisation-admin-secret";

describe("credential closure audit command", credentialClosureCommandSuite);

function credentialClosureCommandSuite(): void {
  it(
    "audits a stable local cohort through D1 and the Organisation Actor",
    auditsStableLocalCohort,
  );
  it(
    "uses remote D1 and HTTPS only when explicitly requested",
    auditsRemoteCohort,
  );
  it(
    "returns one when either closure reports a finding",
    returnsFindingExitCode,
  );
  it(
    "includes retained-root findings in the aggregate result",
    reportsRootFinding,
  );
  it(
    "emits only metadata keys for every finding source",
    emitsOnlyMetadataKeys,
  );
  it(
    "fails closed when the active organisation cohort changes",
    rejectsChangedCohort,
  );
  it(
    "fails closed for invalid or empty organisation inventories",
    rejectsInvalidInventory,
  );
  it(
    "requires a mode-appropriate Worker origin and admin token",
    rejectsInvalidWorkerConfiguration,
  );
  it(
    "rejects malformed or mismatched Actor responses",
    rejectsInvalidActorResponses,
  );
  it(
    "rejects missing or inconsistent retained-root evidence",
    rejectsInvalidRootEvidence,
  );
  it("redacts D1 and Actor transport failures", redactsFailures);
  it(
    "fails closed when D1 audit rows violate the boundary schema",
    rejectsInvalidAuditRows,
  );
}

async function auditsStableLocalCohort(): Promise<void> {
  const fake = new FakeRuntime();
  const outcome = await runCredentialClosureCommand([], fake.runtime());

  expect(outcome).toMatchObject({
    exitCode: 0,
    result: {
      schema: "satyr.credential-closure-receipt.v1",
      status: "passed",
      mode: "local",
      workerOrigin: LOCAL_ORIGIN,
      cohort: { organisationCount: 1 },
      activePolicies: {
        status: "passed",
        auditedOrganisationCount: 1,
        failedOrganisationCount: 0,
        findingKinds: [],
      },
      retainedVaultRoots: {
        status: "passed",
        auditedRowCount: 0,
        revokedRowCount: 0,
        versions: [],
        findingKinds: [],
      },
    },
  });
  expect(fake.wranglerCalls).toHaveLength(11);
  expect(fake.wranglerCalls.every(hasLocalMode)).toBe(true);
  expect(fake.wranglerCalls.every(hasNoCompoundSelect)).toBe(true);
  expect(fake.actorRequests).toHaveLength(2);
  expect(fake.actorRequests[0]?.url).toBe(
    `${LOCAL_ORIGIN}/v1/admin/active-policy-credential-closure?organisationId=${ORGANISATION_ID}`,
  );
  expect(fake.actorRequests[0]?.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
  expect(JSON.stringify(outcome)).not.toContain(ADMIN_TOKEN);
}

async function reportsRootFinding(): Promise<void> {
  const fake = new FakeRuntime({ rootFinding: true });
  const outcome = await runCredentialClosureCommand([], fake.runtime());

  expect(outcome).toMatchObject({
    exitCode: 1,
    result: {
      status: "failed",
      retainedVaultRoots: {
        status: "failed",
        findingKinds: [
          {
            kind: "referenced_vault_root_unavailable",
            count: 1,
          },
        ],
      },
    },
  });
}

/**
 * The other receipt assertions use `toMatchObject`, which is a partial match:
 * it proves the metadata fields are present but would still pass if an organisation
 * id, vault handle, or provider identifier were reintroduced alongside them.
 * This case pins the exact key set at every level, so any added field fails
 * here even when nothing else changes.
 */
async function emitsOnlyMetadataKeys(): Promise<void> {
  const sources = [
    { label: "d1", runtime: new FakeRuntime({ d1Finding: true }) },
    { label: "policy", runtime: new FakeRuntime({ actorFinding: true }) },
    { label: "root", runtime: new FakeRuntime({ rootFinding: true }) },
  ];

  for (const source of sources) {
    const outcome = await runCredentialClosureCommand(
      [],
      source.runtime.runtime(),
    );
    const result = outcome.result as Record<string, unknown>;

    expect(Object.keys(result).sort(), source.label).toEqual([
      "activePolicies",
      "cohort",
      "d1",
      "mode",
      "retainedVaultRoots",
      "schema",
      "status",
      "workerOrigin",
    ]);
    expect(Object.keys(result.cohort as object).sort(), source.label).toEqual([
      "organisationCount",
      "organisationDigest",
    ]);
    expect(Object.keys(result.d1 as object).sort(), source.label).toEqual([
      "findingKinds",
      "status",
      "summary",
    ]);
    expect(
      Object.keys(result.activePolicies as object).sort(),
      source.label,
    ).toEqual([
      "auditedOrganisationCount",
      "failedOrganisationCount",
      "findingKinds",
      "status",
    ]);

    const serialized = JSON.stringify(outcome);

    expect(serialized, source.label).not.toContain(ORGANISATION_ID);
    expect(serialized, source.label).not.toContain("vault:test:command");
    expect(serialized, source.label).not.toContain(ADMIN_TOKEN);
  }
}

async function auditsRemoteCohort(): Promise<void> {
  const fake = new FakeRuntime({ origin: REMOTE_ORIGIN });
  const outcome = await runCredentialClosureCommand(
    ["--remote"],
    fake.runtime(),
  );

  expect(outcome).toMatchObject({
    exitCode: 0,
    result: { status: "passed", mode: "remote", workerOrigin: REMOTE_ORIGIN },
  });
  expect(fake.wranglerCalls.every(hasRemoteMode)).toBe(true);
  expect(fake.wranglerCalls.some(hasLocalMode)).toBe(false);
}

async function returnsFindingExitCode(): Promise<void> {
  const d1Finding = new FakeRuntime({ d1Finding: true });
  const d1Outcome = await runCredentialClosureCommand([], d1Finding.runtime());
  expect(d1Outcome).toMatchObject({
    exitCode: 1,
    result: {
      status: "failed",
      d1: {
        status: "failed",
        findingKinds: [
          {
            kind: "active_provider_generation_without_live_vault",
            count: 1,
          },
        ],
      },
    },
  });
  expect(JSON.stringify(d1Outcome)).not.toContain(ORGANISATION_ID);
  expect(JSON.stringify(d1Outcome)).not.toContain("vault:test:command");

  const actorFinding = new FakeRuntime({ actorFinding: true });
  const actorOutcome = await runCredentialClosureCommand(
    [],
    actorFinding.runtime(),
  );
  expect(actorOutcome).toMatchObject({
    exitCode: 1,
    result: {
      status: "failed",
      activePolicies: {
        status: "failed",
        failedOrganisationCount: 1,
        findingKinds: [{ kind: "active_policy_missing", count: 1 }],
      },
    },
  });
  expect(JSON.stringify(actorOutcome)).not.toContain(ORGANISATION_ID);
}

async function rejectsChangedCohort(): Promise<void> {
  const fake = new FakeRuntime({ changedCohort: true });
  const outcome = await runCredentialClosureCommand([], fake.runtime());

  expect(outcome).toEqual(
    evidenceMissing("local", "active_organisation_inventory_changed"),
  );
}

async function rejectsInvalidInventory(): Promise<void> {
  const empty = new FakeRuntime({ organisationRows: [] });
  expect(await runCredentialClosureCommand([], empty.runtime())).toEqual(
    evidenceMissing("local", "active_organisation_inventory_empty"),
  );

  const duplicate = new FakeRuntime({
    organisationRows: [
      { organisationId: ORGANISATION_ID },
      { organisationId: ORGANISATION_ID },
    ],
  });
  expect(await runCredentialClosureCommand([], duplicate.runtime())).toEqual(
    evidenceMissing("local", "active_organisation_inventory_invalid"),
  );
}

async function rejectsInvalidWorkerConfiguration(): Promise<void> {
  const missing = new FakeRuntime({ token: "" });
  expect(await runCredentialClosureCommand([], missing.runtime())).toEqual(
    evidenceMissing("local", "worker_configuration_invalid"),
  );

  const remoteForLocal = new FakeRuntime({ origin: REMOTE_ORIGIN });
  expect(
    await runCredentialClosureCommand([], remoteForLocal.runtime()),
  ).toEqual(evidenceMissing("local", "worker_configuration_invalid"));

  const localForRemote = new FakeRuntime();
  expect(
    await runCredentialClosureCommand(["--remote"], localForRemote.runtime()),
  ).toEqual(evidenceMissing("remote", "worker_configuration_invalid"));

  const unknown = await runCredentialClosureCommand(
    ["--production"],
    missing.runtime(),
  );
  expect(unknown).toEqual(evidenceMissing("unresolved", "invalid_arguments"));
}

async function rejectsInvalidActorResponses(): Promise<void> {
  const malformed = new FakeRuntime({ actorResponse: { ok: true } });
  expect(await runCredentialClosureCommand([], malformed.runtime())).toEqual(
    evidenceMissing("local", "actor_response_invalid"),
  );

  const mismatched = new FakeRuntime({
    actorResponse: passedActorResponse("organisation_another"),
  });
  expect(await runCredentialClosureCommand([], mismatched.runtime())).toEqual(
    evidenceMissing("local", "actor_response_invalid"),
  );
}

async function rejectsInvalidRootEvidence(): Promise<void> {
  const transport = new FakeRuntime({ rootFailure: true });
  expect(await runCredentialClosureCommand([], transport.runtime())).toEqual(
    evidenceMissing("local", "vault_root_request_failed"),
  );

  const inconsistent = new FakeRuntime({
    rootResponse: {
      ok: true,
      closure: {
        status: "passed",
        auditedRowCount: 1,
        revokedRowCount: 0,
        versions: [{ keyVersion: "v1", rowCount: 1, decryptedCount: 0 }],
        findings: [],
      },
    },
  });
  expect(await runCredentialClosureCommand([], inconsistent.runtime())).toEqual(
    evidenceMissing("local", "vault_root_response_invalid"),
  );
}

async function redactsFailures(): Promise<void> {
  const d1Failure = new FakeRuntime({ d1Failure: true });
  const actorFailure = new FakeRuntime({ actorFailure: true });
  const outcomes = [
    await runCredentialClosureCommand([], d1Failure.runtime()),
    await runCredentialClosureCommand([], actorFailure.runtime()),
  ];

  expect(outcomes[0]).toEqual(evidenceMissing("local", "d1_command_failed"));
  expect(outcomes[1]).toEqual(evidenceMissing("local", "actor_request_failed"));
  const serialized = JSON.stringify(outcomes);
  expect(serialized).not.toContain("plaintext-provider-secret");
  expect(serialized).not.toContain(ADMIN_TOKEN);
}

async function rejectsInvalidAuditRows(): Promise<void> {
  const fake = new FakeRuntime({ invalidD1Row: true });
  const outcome = await runCredentialClosureCommand([], fake.runtime());

  expect(outcome).toEqual(evidenceMissing("local", "audit_data_invalid"));
}

type FakeRuntimeOptions = {
  readonly origin?: string;
  readonly token?: string;
  readonly organisationRows?: readonly Readonly<Record<string, unknown>>[];
  readonly changedCohort?: boolean;
  readonly d1Finding?: boolean;
  readonly invalidD1Row?: boolean;
  readonly d1Failure?: boolean;
  readonly actorFinding?: boolean;
  readonly actorFailure?: boolean;
  readonly actorResponse?: unknown;
  readonly rootFinding?: boolean;
  readonly rootFailure?: boolean;
  readonly rootResponse?: unknown;
};

type ActorRequest = {
  readonly url: string;
  readonly authorization: string | null;
};

class FakeRuntime {
  readonly wranglerCalls: string[][] = [];
  readonly actorRequests: ActorRequest[] = [];
  private activeOrganisationReads = 0;

  constructor(private readonly options: FakeRuntimeOptions = {}) {}

  runtime(): CredentialClosureCommandRuntime {
    return {
      execute: this.execute.bind(this),
      fetch: this.fetch.bind(this),
      environment: {
        PANTRY_WORKER_URL: this.options.origin ?? LOCAL_ORIGIN,
        ORGANISATION_ADMIN_TOKEN: this.options.token ?? ADMIN_TOKEN,
      },
    };
  }

  execute(args: readonly string[]): string {
    this.wranglerCalls.push([...args]);
    if (this.options.d1Failure === true) {
      throw new Error("plaintext-provider-secret");
    }
    const query = queryArgument(args);
    if (isActiveOrganisationQuery(query)) {
      this.activeOrganisationReads += 1;
      if (
        this.options.changedCohort === true &&
        this.activeOrganisationReads === 2
      ) {
        return rows([{ organisationId: "organisation_replacement" }]);
      }
      return rows(
        this.options.organisationRows ?? [{ organisationId: ORGANISATION_ID }],
      );
    }
    if (
      this.options.invalidD1Row === true &&
      query.includes("provider_credential_generation")
    ) {
      return rows([{ organisationId: 7 }]);
    }
    if (
      this.options.d1Finding === true &&
      query.includes("provider_credential_generation")
    ) {
      return rows([missingProviderFinding()]);
    }
    return rows([]);
  }

  async fetch(request: Request): Promise<Response> {
    this.actorRequests.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    const path = new URL(request.url).pathname;
    if (path === "/v1/admin/vault-root-closure") {
      if (this.options.rootFailure === true) {
        throw new Error("plaintext-root-secret");
      }
      return Response.json(
        this.options.rootResponse ??
          (this.options.rootFinding === true
            ? failedRootResponse()
            : passedRootResponse()),
      );
    }
    if (this.options.actorFailure === true) {
      throw new Error("plaintext-actor-secret");
    }
    const body =
      this.options.actorResponse ??
      (this.options.actorFinding === true
        ? failedActorResponse()
        : passedActorResponse(ORGANISATION_ID));
    return Response.json(body);
  }
}

function passedRootResponse(): unknown {
  return {
    ok: true,
    closure: {
      status: "passed",
      auditedRowCount: 0,
      revokedRowCount: 0,
      versions: [],
      findings: [],
    },
  };
}

function failedRootResponse(): unknown {
  return {
    ok: true,
    closure: {
      status: "failed",
      auditedRowCount: 2,
      revokedRowCount: 1,
      versions: [{ keyVersion: "v1", rowCount: 2, decryptedCount: 1 }],
      findings: [
        {
          kind: "referenced_vault_root_unavailable",
          keyVersion: "v1",
          affectedRows: 1,
        },
      ],
    },
  };
}

function passedActorResponse(organisationId: string): unknown {
  return {
    ok: true,
    closure: {
      status: "passed",
      organisationId,
      activePolicyVersion: 3,
      findings: [],
    },
  };
}

function failedActorResponse(): unknown {
  return {
    ok: true,
    closure: {
      status: "failed",
      organisationId: ORGANISATION_ID,
      activePolicyVersion: null,
      findings: [
        { kind: "active_policy_missing", organisationId: ORGANISATION_ID },
      ],
    },
  };
}

function missingProviderFinding(): Readonly<Record<string, unknown>> {
  return {
    organisationId: ORGANISATION_ID,
    providerConnectionId: "connection_command_test",
    credentialGeneration: 1,
    provider: "stripe",
    environment: "development",
    vaultHandle: "vault:test:command",
    vaultIssue: "missing",
  };
}

function evidenceMissing(
  mode: "local" | "remote" | "unresolved",
  reason: string,
): unknown {
  return {
    result: {
      schema: "satyr.credential-closure-receipt.v1",
      status: "evidence_missing",
      mode,
      reason,
    },
    exitCode: 2,
  };
}

function rows(results: readonly unknown[]): string {
  return JSON.stringify([{ success: true, results }]);
}

function queryArgument(args: readonly string[]): string {
  const index = args.indexOf("--command");
  const query = args[index + 1];
  if (query === undefined) throw new Error("test_query_missing");
  return query;
}

function isActiveOrganisationQuery(query: string): boolean {
  return (
    query.includes("FROM organisation") && query.includes("status = 'active'")
  );
}

function hasLocalMode(args: readonly string[]): boolean {
  return args.includes("--local");
}

function hasRemoteMode(args: readonly string[]): boolean {
  return args.includes("--remote");
}

function hasNoCompoundSelect(args: readonly string[]): boolean {
  return !queryArgument(args).includes("UNION ALL");
}
