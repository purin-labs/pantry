import type { UnitTestEnv } from "./worker-fakes";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  actor: vi.fn(),
  publish: vi.fn(),
  evaluate: vi.fn(),
  read: vi.fn(),
  readCaseContextCollection: vi.fn(),
  metadata: vi.fn(),
  review: vi.fn(),
}));
vi.mock("../src/control/authorization", () => ({
  authorizeOrganisationRequest: mocks.authorize,
}));
vi.mock("../src/actors/actor-router", () => ({
  requireActiveOrganisationActor: mocks.actor,
}));
vi.mock("../src/case-context-discovery/metadata", () => ({
  readCaseContextCollectionMetadata: mocks.metadata,
}));

import {
  handleCaseContextDiscoveryRoute,
  matchCaseContextDiscoveryRoute,
} from "../src/control/routes/case-context-discovery";

const ORIGIN = "https://satyr.example";
const PATH =
  "/v1/control/organisations/organisation_case_context_discovery_route/case-context-discovery";
const ENV = {} as UnitTestEnv;
const OPERATOR_TOKEN =
  "case-context-collection-operator-token-at-least-32-characters";

describe("Cue CaseContextCollection control route", suite);

function suite(): void {
  beforeEach(reset);
  it(
    "requires organisation admin authorization before touching the Actor",
    rejectsUnauthorized,
  );
  it(
    "uses CSRF-protected mutations and the existing organisation Actor",
    routesMutation,
  );
  it(
    "allows the configured operator to publish through the same Actor",
    routesOperatorMutation,
  );
  it("bounds request bodies before passing input to the Actor", boundsRequest);
  it("exposes bounded relationship review routes", boundsRoutes);
  it("routes an administrator relationship decision", routesReview);
}

function reset(): void {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue({
    ok: true,
    organisationId: "organisation_case_context_discovery_route",
    membership: { userId: "user_ec7e5384-b37e-590e-b920-f1de686e4ff7" },
  });
  mocks.actor.mockResolvedValue({
    publishCaseContextDiscoveryConfiguration: mocks.publish,
    readCaseContextDiscoveryConfiguration: mocks.read,
    readCaseContextCollection: mocks.readCaseContextCollection,
    reviewCaseContextCollectionRelationship: mocks.review,
  });
  mocks.publish.mockResolvedValue({ ok: true, value: { revision: 1 } });
  mocks.read.mockResolvedValue({
    ok: true,
    value: { revision: 0, policy: { mode: "disabled" } },
  });
  mocks.readCaseContextCollection.mockResolvedValue({
    ok: true,
    value: {
      caseContextCollectionId: "case_context_collection_one",
      relationships: [],
    },
  });
  mocks.metadata.mockResolvedValue({
    caseContextCollectionId: "case_context_collection_one",
    relationships: [],
  });
  mocks.review.mockResolvedValue({
    ok: true,
    value: {
      caseContextCollectionId: "case_context_collection_one",
      revision: 2,
    },
  });
}

async function rejectsUnauthorized(): Promise<void> {
  mocks.authorize.mockResolvedValue({
    ok: false,
    response: new Response(null, { status: 404 }),
  });
  const route = matchCaseContextDiscoveryRoute(PATH);
  if (route === null) throw new Error("missing route");
  const request = new Request(ORIGIN + PATH);
  expect(
    (await handleCaseContextDiscoveryRoute(request, ENV, route)).status,
  ).toBe(404);
  expect(mocks.authorize).toHaveBeenCalledWith(
    request,
    ENV,
    "organisation_case_context_discovery_route",
    "admin",
    false,
  );
  expect(mocks.actor).not.toHaveBeenCalled();
}

async function routesMutation(): Promise<void> {
  const route = matchCaseContextDiscoveryRoute(PATH);
  if (route === null) throw new Error("missing route");
  const body = {
    commandId: "disable-1",
    expectedRevision: 0,
    policy: { mode: "disabled" },
  };
  const request = new Request(ORIGIN + PATH, {
    method: "PUT",
    body: JSON.stringify(body),
  });
  const result = await handleCaseContextDiscoveryRoute(request, ENV, route);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(mocks.authorize).toHaveBeenCalledWith(
    request,
    ENV,
    "organisation_case_context_discovery_route",
    "admin",
    true,
  );
  expect(mocks.publish).toHaveBeenCalledWith({
    organisationId: "organisation_case_context_discovery_route",
    actorId: "user_ec7e5384-b37e-590e-b920-f1de686e4ff7",
    body,
  });
}

async function routesOperatorMutation(): Promise<void> {
  const route = matchCaseContextDiscoveryRoute(PATH);
  if (route === null) throw new Error("missing route");
  const body = {
    commandId: "shadow-1",
    expectedRevision: 0,
    policy: { mode: "disabled" },
  };
  const request = new Request(ORIGIN + PATH, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${OPERATOR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = await handleCaseContextDiscoveryRoute(
    request,
    { ORGANISATION_ADMIN_TOKEN: OPERATOR_TOKEN } as UnitTestEnv,
    route,
  );
  expect(result.status).toBe(200);
  expect(mocks.authorize).not.toHaveBeenCalled();
  expect(mocks.publish).toHaveBeenCalledWith({
    organisationId: "organisation_case_context_discovery_route",
    actorId: "operator_organisation_admin",
    body,
  });
}

async function boundsRequest(): Promise<void> {
  const route = matchCaseContextDiscoveryRoute(PATH);
  if (route === null) throw new Error("missing route");
  const request = new Request(ORIGIN + PATH, {
    method: "PUT",
    body: JSON.stringify({ data: "x".repeat(16_384) }),
  });
  expect(
    (await handleCaseContextDiscoveryRoute(request, ENV, route)).status,
  ).toBe(400);
  expect(mocks.publish).not.toHaveBeenCalled();
}

function boundsRoutes(): void {
  expect(
    matchCaseContextDiscoveryRoute(PATH + "/synthetic-evaluation"),
  ).toBeNull();
  expect(
    matchCaseContextDiscoveryRoute(PATH + "/cases/case_one"),
  ).toMatchObject({
    operation: "case_relationships",
    caseId: "case_one",
  });
  expect(
    matchCaseContextDiscoveryRoute(
      PATH + "/caseContextCollections/case_context_collection_one",
    ),
  ).toMatchObject({
    operation: "caseContextCollection",
    caseContextCollectionId: "case_context_collection_one",
  });
  expect(
    matchCaseContextDiscoveryRoute(
      PATH + "/caseContextCollections/case_context_collection_one/review",
    ),
  ).toMatchObject({
    operation: "case_context_collection_review",
    caseContextCollectionId: "case_context_collection_one",
  });
  expect(
    matchCaseContextDiscoveryRoute(
      PATH + "/caseContextCollections/case_context_collection_one/context",
    ),
  ).toBeNull();
  expect(matchCaseContextDiscoveryRoute(PATH + "/cases/%2F")).toBeNull();
}

async function routesReview(): Promise<void> {
  const path =
    PATH + "/caseContextCollections/case_context_collection_one/review";
  const route = matchCaseContextDiscoveryRoute(path);
  if (route === null) throw new Error("missing route");
  const body = {
    commandId: "reject-one",
    expectedRevision: 1,
    decision: { kind: "reject", relationshipId: "relationship_one" },
  };
  const request = new Request(ORIGIN + path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const result = await handleCaseContextDiscoveryRoute(request, ENV, route);
  expect(result.status).toBe(200);
  expect(mocks.authorize).toHaveBeenCalledWith(
    request,
    ENV,
    "organisation_case_context_discovery_route",
    "admin",
    true,
  );
  expect(mocks.review).toHaveBeenCalledWith({
    organisationId: "organisation_case_context_discovery_route",
    actorId: "user_ec7e5384-b37e-590e-b920-f1de686e4ff7",
    caseContextCollectionId: "case_context_collection_one",
    body,
  });
}
