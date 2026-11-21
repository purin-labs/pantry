import { env, exports } from "cloudflare:workers";
import { expect, it, type TestContext } from "vitest";
import { isRecord } from "@purin-labs/std";
import { requireOrganisationExecutionScope } from "../organisation-execution-fixture";
import { commerceHeaders } from "./commerce-support";
import { installMemoryFixture, type Member } from "./memory-support";

declare module "vitest" {
  interface TaskMeta {
    customConnectorReview?: Record<string, unknown>;
  }
}

const ORIGIN = "https://api.carrier.example.net";
const REASON = "The account read must name the carrier's documented fields.";

it(
  "rejects a validated connector revision with a reason, refuses its approval and setup, and approves the corrected revision",
  { timeout: 60_000 },
  customConnectorReviewJourney,
);

async function customConnectorReviewJourney({
  task,
}: TestContext): Promise<void> {
  const { organisationId, author, viewer } = await installMemoryFixture();
  const scope = await requireOrganisationExecutionScope(env, organisationId);
  const version = await scope.database
    .prepare(
      "SELECT configuration_version AS version FROM organisation_onboarding WHERE organisation_id = ?",
    )
    .bind(organisationId)
    .first<{ version: number }>();
  if (version === null) throw new Error("The Organisation has no onboarding");
  const review = new Review(version.version);
  const connectors = `/v1/control/organisations/${organisationId}/custom-connectors`;

  // The administrator writes the connector and has it validated.
  const created = await review.accepted(author, connectors, {
    document: DOCUMENT,
  });
  const connectorId = created.connectorId;
  const draft = created.revision;
  if (typeof connectorId !== "string" || !isRecord(draft))
    throw new Error(`No connector: ${JSON.stringify(created)}`);
  const first = `${connectors}/${connectorId}/revisions/${String(draft.revision)}`;
  const validated = await review.accepted(author, `${first}/validate`, {
    authoringDigest: draft.authoringDigest,
  });
  if (!isRecord(validated.revision))
    throw new Error(`Not validated: ${JSON.stringify(validated)}`);
  const definitionDigest = validated.revision.definitionDigest;

  // A viewer cannot reject, and a rejection needs a reason.
  const viewerRejection = await review.send(viewer, `${first}/reject`, {
    definitionDigest,
    reason: REASON,
  });
  expect(viewerRejection.status).not.toBe(200);
  const emptyReason = await review.send(author, `${first}/reject`, {
    definitionDigest,
    reason: "   ",
  });
  expect(emptyReason).toMatchObject({
    status: 422,
    body: { error: "custom_connector_request_invalid" },
  });

  // The administrator rejects the revision. A retry of the same request
  // returns the same receipt and changes nothing.
  const rejection = { definitionDigest, reason: ` ${REASON} ` };
  const rejected = await review.accepted(
    author,
    `${first}/reject`,
    rejection,
    "connector-review-reject",
  );
  expect(rejected.revision).toMatchObject({
    revision: draft.revision,
    reviewState: "rejected",
    definitionDigest,
    rejection: { reason: REASON, rejectedByUserId: author.userId },
  });
  const replayed = await review.send(
    author,
    `${first}/reject`,
    rejection,
    "connector-review-reject",
    review.versionBefore,
  );
  expect(replayed.status).toBe(200);
  expect(replayed.body.receipt).toEqual(rejected.receipt);

  // A rejected revision cannot be approved or set up.
  const approval = await review.send(author, `${first}/approve`, {
    definitionDigest,
    review: {
      origin: ORIGIN,
      effects: [{ operationId: "account", effect: "read" }],
    },
  });
  expect(approval.status).toBe(409);
  expect(approval.body).toMatchObject({
    error: "custom_connector_revision_conflict",
  });
  const setup = await review.send(
    author,
    `${connectors}/${connectorId}/setup-attempts`,
    {
      connectorRevision: draft.revision,
      definitionDigest,
      target: { kind: "new_account", environment: "production" },
    },
  );
  expect(setup.status).not.toBe(200);

  // The Portal reads the rejection and its reason on the head revision.
  const detail = await read(author, `${connectors}/${connectorId}`);
  const revisions = isRecord(detail) ? detail.revisions : undefined;
  expect(revisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        revision: draft.revision,
        reviewState: "rejected",
        rejection: expect.objectContaining({ reason: REASON }),
      }),
    ]),
  );

  // The author corrects the definition; the new revision passes review.
  const corrected = await review.accepted(
    author,
    `${connectors}/${connectorId}/revisions`,
    {
      document: { ...DOCUMENT, description: "Reads the documented account." },
      expectedHeadRevision: draft.revision,
    },
  );
  if (!isRecord(corrected.revision))
    throw new Error(`No revision: ${JSON.stringify(corrected)}`);
  const second = `${connectors}/${connectorId}/revisions/${String(corrected.revision.revision)}`;
  const revalidated = await review.accepted(author, `${second}/validate`, {
    authoringDigest: corrected.revision.authoringDigest,
  });
  if (!isRecord(revalidated.revision))
    throw new Error(`Not validated: ${JSON.stringify(revalidated)}`);
  const approved = await review.accepted(author, `${second}/approve`, {
    definitionDigest: revalidated.revision.definitionDigest,
    review: {
      origin: ORIGIN,
      effects: [{ operationId: "account", effect: "read" }],
    },
  });
  expect(approved.revision).toMatchObject({ reviewState: "approved" });

  task.meta.customConnectorReview = {
    viewerRejectionStatus: viewerRejection.status,
    emptyReasonRefused: emptyReason.status === 422,
    rejectedReason: REASON,
    replaySameReceipt: true,
    approvalOfRejectedStatus: approval.status,
    setupOfRejectedStatus: setup.status,
    correctedRevisionApproved: true,
  };
}

type Answer = Readonly<{ status: number; body: Record<string, unknown> }>;

/** The review requests, each with the configuration version it expects. */
class Review {
  private requests = 0;
  /** The version before the last accepted change, for a replay of it. */
  versionBefore: number;

  constructor(private configurationVersion: number) {
    this.versionBefore = configurationVersion;
  }

  async send(
    person: Member,
    path: string,
    body: unknown,
    key?: string,
    configurationVersion?: number,
  ): Promise<Answer> {
    this.requests += 1;
    const headers = commerceHeaders(person.session);
    headers.set(
      "idempotency-key",
      key ?? `connector-review-${String(this.requests)}`,
    );
    headers.set(
      "x-pantry-configuration-version",
      String(configurationVersion ?? this.configurationVersion),
    );
    const answered = await exports.default.fetch(
      new Request(`https://localhost${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    );
    const raw: unknown = await answered.json().catch(() => null);
    return { status: answered.status, body: isRecord(raw) ? raw : {} };
  }

  /** One change. It fails the journey unless the Worker accepts it. */
  async accepted(
    person: Member,
    path: string,
    body: unknown,
    key?: string,
  ): Promise<Record<string, unknown>> {
    const answered = await this.send(person, path, body, key);
    expect(answered.status, `${path}: ${JSON.stringify(answered.body)}`).toBe(
      200,
    );
    const next = answered.body.configurationVersion;
    if (typeof next !== "number") throw new Error(`${path}: no version`);
    this.versionBefore = this.configurationVersion;
    this.configurationVersion = next;
    return answered.body;
  }
}

async function read(person: Member, path: string): Promise<unknown> {
  const answered = await exports.default.fetch(
    new Request(`https://localhost${path}`, {
      headers: commerceHeaders(person.session),
    }),
  );
  expect(answered.status).toBe(200);
  return answered.json();
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
