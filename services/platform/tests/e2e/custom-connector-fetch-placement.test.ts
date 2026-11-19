import { env, exports } from "cloudflare:workers";
import { http, HttpResponse } from "msw";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import { installMemoryFixture, type Member } from "./memory-support";
import { network } from "./network";
import { erase, resolvePublicAddress } from "./link-fetch-support";

declare module "vitest" {
  interface TaskMeta {
    customConnectorFetchPlacement?: Record<string, unknown>;
  }
}
const ORIGIN = "https://api.carrier.example.net";
const CREDENTIAL = "synthetic-carrier-api-key";
const ACCOUNT = { id: "carrier_account_7", name: "Carrier account" };
/** An Organisation that no registry names. */
const GONE_ORGANISATION = "organisation_00000000-0000-4000-8000-00000000c0de";

it(
  "tests the credential of a custom connector through the fetch container of the organisation, asked for in the organisation's region, and the operator's erase refuses that container only",
  { timeout: 120_000 },
  customConnectorFetchPlacementJourney,
);

type Addressed = Readonly<{ name: string; locationHint: string | null }>;

/**
 * Stands in for the class binding of the Worker. It records each container
 * that the Worker asks for and answers as the fetch service does.
 */
class RecordingConnectorFetch {
  readonly addressed: Addressed[] = [];
  readonly requested: unknown[] = [];

  getByName(name: string, options?: { readonly locationHint?: string }): this {
    this.addressed.push({ name, locationHint: options?.locationHint ?? null });
    return this;
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const raw: unknown = await new Request(input, init).json();
    if (!isRecord(raw) || !isRecord(raw.operation))
      throw new Error("The fetch request has no operation");
    expect(raw.authentication).toEqual({ kind: "bearer", value: CREDENTIAL });
    this.requested.push({ kind: raw.operation.kind, url: raw.operation.url });
    return HttpResponse.json({
      status: 200,
      contentType: "application/json",
      bodyBase64: btoa(JSON.stringify(ACCOUNT)),
    });
  }
}

async function customConnectorFetchPlacementJourney({
  task,
}: TestContext): Promise<void> {
  const { organisationId, author } = await installMemoryFixture();
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  // The region of the Organisation, as its placement row holds it.
  const placement = scope.placement;
  const connectors = `/v1/control/organisations/${organisationId}/custom-connectors`;
  network.use(
    http.get("https://cloudflare-dns.com/dns-query", resolvePublicAddress),
  );
  const version = await scope.database
    .prepare(
      "SELECT configuration_version AS version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ version: number }>();
  if (version === null) throw new Error("The Organisation has no onboarding");
  const setup = new Setup(author, version.version);

  // The administrator writes the connector, has it validated and approves it.
  const created = await setup.change(connectors, { document: DOCUMENT });
  const connectorId = created.connectorId;
  const draft = created.revision;
  if (typeof connectorId !== "string" || !isRecord(draft))
    throw new Error(`No connector: ${JSON.stringify(created)}`);
  const revision = `${connectors}/${connectorId}/revisions/${String(draft.revision)}`;
  const validated = await setup.change(`${revision}/validate`, {
    authoringDigest: draft.authoringDigest,
  });
  if (!isRecord(validated.revision))
    throw new Error(`Not validated: ${JSON.stringify(validated)}`);
  const definitionDigest = validated.revision.definitionDigest;
  await setup.change(`${revision}/approve`, {
    definitionDigest,
    review: {
      origin: ORIGIN,
      effects: [{ operationId: "account", effect: "read" }],
    },
  });

  // The administrator starts the setup of an account and gives its key.
  const attempts = `${connectors}/${connectorId}/setup-attempts`;
  const started = await setup.change(attempts, {
    connectorRevision: draft.revision,
    definitionDigest,
    target: { kind: "new_account", environment: "production" },
  });
  if (
    !isRecord(started.attempt) ||
    typeof started.attempt.attemptId !== "string"
  )
    throw new Error(`No setup: ${JSON.stringify(started)}`);
  const attempt = `${attempts}/${started.attempt.attemptId}`;
  const stored = await setup.change(`${attempt}/credential`, {
    credentialValue: CREDENTIAL,
    expectedAttemptRevision: started.attempt.attemptRevision,
  });
  if (!isRecord(stored.attempt))
    throw new Error(`No credential: ${JSON.stringify(stored)}`);

  // The test of the key is the first request of an Organisation to its fetch
  // container. The Worker and this file share one environment.
  const fetchContainers = new RecordingConnectorFetch();
  const classBinding = env.CUSTOM_CONNECTOR_FETCH;
  Object.defineProperty(env, "CUSTOM_CONNECTOR_FETCH", {
    configurable: true,
    value: fetchContainers,
  });
  let tested;
  try {
    tested = await setup.change(`${attempt}/test`, {
      expectedAttemptRevision: stored.attempt.attemptRevision,
    });
  } finally {
    // The operator route below needs the class itself again.
    Object.defineProperty(env, "CUSTOM_CONNECTOR_FETCH", {
      configurable: true,
      value: classBinding,
    });
  }

  // The provider's account reached the administrator.
  expect(tested.kind).toBe("custom_connector_test_verified");
  expect(tested.preview).toEqual(ACCOUNT);
  expect(isRecord(tested.attempt) ? tested.attempt.lifecycle : null).toBe(
    "verified",
  );
  expect(fetchContainers.requested).toEqual([
    { kind: "get", url: `${ORIGIN}/account` },
  ]);

  // The request went to the container of this Organisation, asked for in the
  // region of the Organisation.
  expect(fetchContainers.addressed).toEqual([
    { name: organisationId, locationHint: placement.locationHint },
  ]);

  // The operator's erase refuses the container of an Organisation that a
  // registry names. It does not refuse the container of one that no registry
  // names: that erase reaches the Actor, which only a runtime with
  // containers can build.
  const containerOfThisOrganisation = await erase(
    "custom_connector_fetch",
    env.CUSTOM_CONNECTOR_FETCH.idFromName(organisationId).toString(),
  );
  const containerOfGoneOrganisation = await erase(
    "custom_connector_fetch",
    env.CUSTOM_CONNECTOR_FETCH.idFromName(GONE_ORGANISATION).toString(),
  );
  const objectOfAnotherClass = await erase(
    "custom_connector_fetch",
    env.CASE.idFromName("custom-connector-fetch-placement").toString(),
  );
  expect(containerOfThisOrganisation).toEqual({
    status: 409,
    code: "actor_registered",
  });
  expect(objectOfAnotherClass).toEqual({
    status: 404,
    code: "actor_not_found",
  });
  expect(["actor_registered", "actor_not_found"]).not.toContain(
    containerOfGoneOrganisation.code,
  );
  expect(containerOfGoneOrganisation.status).not.toBe(200);

  task.meta.customConnectorFetchPlacement = {
    organisationLocationHint: placement.locationHint,
    credentialTest: {
      addressed: fetchContainers.addressed.map(withoutOrganisation),
      addressedContainerOfThisOrganisation: fetchContainers.addressed.every(
        (address) => address.name === organisationId,
      ),
      requested: fetchContainers.requested,
      outcome: tested.kind,
    },
    erase: {
      containerOfThisOrganisation,
      objectOfAnotherClass,
      // No refusal of the route. The local runtime cannot build the Actor.
      containerOfGoneOrganisation,
    },
  };
}

/** The setup requests of one administrator, each with the version it expects. */
class Setup {
  private requests = 0;

  constructor(
    private readonly person: Member,
    private configurationVersion: number,
  ) {}

  /** One change. It fails the journey unless the Worker accepts it. */
  async change(path: string, body: unknown): Promise<Record<string, unknown>> {
    this.requests += 1;
    const headers = commerceHeaders(this.person.session);
    headers.set(
      "idempotency-key",
      `connector-fetch-placement-${String(this.requests)}`,
    );
    headers.set(
      "x-satyr-configuration-version",
      String(this.configurationVersion),
    );
    const answered = await exports.default.fetch(
      new Request(`https://localhost${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    const text = await answered.text();
    expect(answered.status, `${path}: ${text}`).toBe(200);
    const raw: unknown = JSON.parse(text);
    if (!isRecord(raw) || typeof raw.configurationVersion !== "number")
      throw new Error(`${path}: ${text}`);
    this.configurationVersion = raw.configurationVersion;
    return raw;
  }
}

/** A connector with one read: the account that a key belongs to. */
const DOCUMENT = {
  schemaVersion: 1,
  name: "Carrier",
  description: "Reads the carrier account.",
  origin: ORIGIN,
  authentication: { kind: "bearer" },
  documentation: [{ url: `${ORIGIN}/docs`, sha256: "7".repeat(64) }],
  operations: [
    {
      id: "account",
      description: "Read the carrier account.",
      effect: { kind: "read" },
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      transport: {
        kind: "rest",
        method: "GET",
        pathTemplate: "/account",
        pathBindings: {},
        queryBindings: {},
        bodyBindings: null,
      },
      response: {
        successStatuses: [200],
        resultPointer: "",
        outputSchema: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 128 },
            name: { type: "string", minLength: 1, maxLength: 128 },
          },
          required: ["id", "name"],
          additionalProperties: false,
        },
        classification: "internal",
      },
      pagination: { kind: "none" },
    },
  ],
  identity: {
    operationId: "account",
    arguments: {},
    accountIdPointer: "/id",
    displayNamePointer: "/name",
  },
  limits: {},
};

/** The record names no Organisation: its identifier changes with each run. */
function withoutOrganisation(address: Addressed) {
  return { locationHint: address.locationHint };
}
