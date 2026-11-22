import { requireActiveOrganisationActor } from "@purin-labs/actor-runtime/actors/actor-router";
import { resolveCaseReference } from "@purin-labs/authority/access-control/references";
import type { ConversationScope } from "../../chat/store";
import {
  readCaseContextCollectionMetadata,
  type CaseContextSelectionVerification,
} from "../../case-context-discovery/metadata";
import { parseCaseContextCollectionReviewCommand } from "../../case-context-discovery/relationships";
import type {
  CaseContextCollectionMetadataView,
  UserId,
} from "@purin-labs/control-api";
import { identifier } from "../../case-context-discovery/policy";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationActorStub } from "@purin-labs/actor-runtime/actors/actor-stubs";
import { authorizeConfiguredBearer } from "@purin-labs/kernel/fault-injection-auth";
import {
  parseCaseId,
  parseOrganisationId,
  type CaseId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { authorizeOrganisationRequest } from "../authorization";
import { controlError, controlJson, readBoundedJsonRecord } from "../http";
import { assertNever } from "@purin-labs/std";
import type { Result } from "@purin-labs/kernel/result";

const CASE_CONTEXT_COLLECTION_OPERATOR_ID = "operator_organisation_admin";

export type CaseContextDiscoveryRoute = Readonly<{
  kind: "caseContextCollections";
  organisationId: OrganisationId;
}> &
  (
    | Readonly<{ operation: "configuration" }>
    | Readonly<{ operation: "inspector" }>
    | Readonly<{ operation: "screen_observations" }>
    | Readonly<{ operation: "case_relationships"; caseId: CaseId }>
    | Readonly<{
        operation: "caseContextCollection";
        caseContextCollectionId: string;
      }>
    | Readonly<{
        operation: "case_context_collection_review";
        caseContextCollectionId: string;
      }>
  );

type CaseContextDiscoveryMetadataRoute = Exclude<
  CaseContextDiscoveryRoute,
  {
    operation: "configuration" | "screen_observations";
  }
>;

export function matchCaseContextDiscoveryRoute(
  pathname: string,
): CaseContextDiscoveryRoute | null {
  const match =
    /^\/v1\/control\/organisations\/([^/]+)\/case-context-discovery(?:\/(.+))?$/.exec(
      pathname,
    );
  if (match === null) return null;
  try {
    const organisationId = parseOrganisationId(
      decodeURIComponent(match[1] ?? ""),
    );
    if (!organisationId.ok) return null;
    return parseCaseContextCollectionOperation(organisationId.value, match[2]);
  } catch {
    return null;
  }
}

function parseCaseContextCollectionOperation(
  organisationId: OrganisationId,
  suffix: string | undefined,
): CaseContextDiscoveryRoute | null {
  const base = { kind: "caseContextCollections" as const, organisationId };
  if (suffix === undefined) return { ...base, operation: "configuration" };
  if (suffix === "inspector") return { ...base, operation: "inspector" };
  if (suffix === "screen-observations")
    return { ...base, operation: "screen_observations" };
  const caseMatch = /^cases\/([^/]+)$/.exec(suffix);
  if (caseMatch !== null) {
    const caseId = parseCaseId(decodeURIComponent(caseMatch[1] ?? ""));
    return caseId.ok
      ? { ...base, operation: "case_relationships", caseId: caseId.value }
      : null;
  }
  const caseContextCollectionMatch =
    /^caseContextCollections\/([^/]+)(?:\/(review))?$/.exec(suffix);
  if (caseContextCollectionMatch === null) return null;
  const caseContextCollectionId = decodeURIComponent(
    caseContextCollectionMatch[1] ?? "",
  );
  if (!identifier(caseContextCollectionId)) return null;
  return caseContextCollectionMatch[2] === "review"
    ? {
        ...base,
        operation: "case_context_collection_review",
        caseContextCollectionId,
      }
    : { ...base, operation: "caseContextCollection", caseContextCollectionId };
}

/**
 * What the Worker gives to the route: the Inbox check of a selection, and
 * the Portal route of the screen observations of a Case.
 */
export type CaseContextDiscoveryParts = Readonly<{
  verifySelection: CaseContextSelectionVerification;
  screenObservations: (
    request: Request,
    env: Env,
    scope: ConversationScope,
  ) => Promise<Response>;
}>;

export async function handleCaseContextDiscoveryRoute(
  request: Request,
  env: Env,
  route: CaseContextDiscoveryRoute,
  parts: CaseContextDiscoveryParts,
): Promise<Response> {
  const mutation = caseContextCollectionMutation(route, request.method);
  if (mutation === null) return controlError("method_not_allowed", 405);
  const authorized = await authorizeCaseContextCollectionRequest(
    request,
    env,
    route.organisationId,
    mutation,
  );
  if (!authorized.ok) return authorized.response;
  try {
    switch (route.operation) {
      case "screen_observations":
        if (authorized.identity.kind !== "user")
          return controlError("case_screen_observations_unavailable", 404);
        return await parts.screenObservations(request, env, {
          organisationId: authorized.organisationId,
          userId: authorized.identity.userId,
        });
      case "inspector":
      case "case_relationships":
      case "caseContextCollection":
      case "case_context_collection_review":
        if (authorized.identity.kind !== "user")
          return controlError(
            "case_context_collection_relationship_unavailable",
            404,
          );
        return await handleCaseContextDiscoveryMetadataRoute(
          request,
          env,
          {
            organisationId: authorized.organisationId,
            userId: authorized.identity.userId,
          },
          route,
          parts.verifySelection,
        );
      case "configuration":
        break;
      default:
        return assertNever(route);
    }
    const actor = await requireActiveOrganisationActor({
      env,
      organisationId: authorized.organisationId,
      now: Date.now(),
    });
    if (route.operation === "configuration" && request.method === "GET") {
      const result = await actor.readCaseContextDiscoveryConfiguration({
        organisationId: authorized.organisationId,
      });
      return caseContextCollectionResult(result);
    }
    const body = await readCaseContextCollectionBody(request);
    if (body === null) return invalidRequest();
    const result = await actor.publishCaseContextDiscoveryConfiguration({
      organisationId: authorized.organisationId,
      actorId: authorized.actorId,
      body,
    });
    return caseContextCollectionResult(result);
  } catch {
    return controlError(unavailableCode(route), 503);
  }
}

async function handleCaseContextDiscoveryMetadataRoute(
  request: Request,
  env: Env,
  scope: ConversationScope,
  route: CaseContextDiscoveryMetadataRoute,
  verifySelection: CaseContextSelectionVerification,
): Promise<Response> {
  const actor = await requireActiveOrganisationActor({
    env,
    organisationId: scope.organisationId,
    now: Date.now(),
  });
  switch (route.operation) {
    case "inspector":
    case "case_relationships": {
      let caseId: CaseId;
      if (route.operation === "inspector") {
        const query = new URL(request.url).searchParams;
        const reference = query.get("case_ref");
        const revision = Number(query.get("revision"));
        if (
          reference === null ||
          !/^case_[a-f0-9]{32}$/.test(reference) ||
          !Number.isSafeInteger(revision) ||
          revision < 1
        )
          return invalidRequest();
        const resolved = await resolveCaseReference(
          { env, organisationId: scope.organisationId, now: Date.now() },
          reference,
          revision,
        );
        if (!resolved.ok)
          return controlError(
            "case_context_collection_relationship_unavailable",
            404,
          );
        caseId = resolved.value;
      } else caseId = route.caseId;
      const result = await actor.readCaseContextCollectionsForCase({
        organisationId: scope.organisationId,
        caseId,
      });
      if (!result.ok) return caseContextCollectionResult(result);
      const caseContextCollections: CaseContextCollectionMetadataView[] = [];
      for (const caseContextCollection of result.value.caseContextCollections) {
        const view = await readCaseContextCollectionMetadata(
          env,
          scope,
          caseContextCollection,
          verifySelection,
        );
        if (view !== null) caseContextCollections.push(view);
      }
      return controlJson({ ok: true, caseContextCollections });
    }
    case "caseContextCollection": {
      const result = await readAuthorizedCaseContextCollection(
        actor,
        env,
        scope,
        route.caseContextCollectionId,
        verifySelection,
      );
      return result.ok
        ? controlJson({ ok: true, caseContextCollections: [result.value] })
        : caseContextCollectionResult(result);
    }
    case "case_context_collection_review": {
      const body = await readCaseContextCollectionBody(request);
      if (body === null) return invalidRequest();
      const command = parseCaseContextCollectionReviewCommand(body);
      if (command === null) return invalidRequest();
      const current = await readAuthorizedCaseContextCollection(
        actor,
        env,
        scope,
        route.caseContextCollectionId,
        verifySelection,
      );
      if (!current.ok) return caseContextCollectionResult(current);
      const result = await actor.reviewCaseContextCollectionRelationship({
        organisationId: scope.organisationId,
        actorId: scope.userId,
        caseContextCollectionId: route.caseContextCollectionId,
        body: command,
      });
      return caseContextCollectionResult(result);
    }
    default:
      return assertNever(route);
  }
}

async function readAuthorizedCaseContextCollection(
  actor: OrganisationActorStub,
  env: Env,
  scope: ConversationScope,
  caseContextCollectionId: string,
  verifySelection: CaseContextSelectionVerification,
): Promise<
  Result<CaseContextCollectionMetadataView, Readonly<{ code: string }>>
> {
  const result = await actor.readCaseContextCollection({
    organisationId: scope.organisationId,
    caseContextCollectionId,
  });
  if (!result.ok) return result;
  const view = await readCaseContextCollectionMetadata(
    env,
    scope,
    result.value,
    verifySelection,
  );
  return view === null
    ? {
        ok: false,
        error: { code: "case_context_collection_relationship_unavailable" },
      }
    : { ok: true, value: view };
}

async function authorizeCaseContextCollectionRequest(
  request: Request,
  env: Env,
  organisationId: OrganisationId,
  mutation: boolean,
): Promise<
  | Readonly<{
      ok: true;
      organisationId: OrganisationId;
      actorId: string;
      identity:
        | Readonly<{ kind: "operator" }>
        | Readonly<{ kind: "user"; userId: UserId }>;
    }>
  | Readonly<{ ok: false; response: Response }>
> {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) {
    return authorizeConfiguredBearer({
      authorization,
      configuredToken: env.ORGANISATION_ADMIN_TOKEN,
    })
      ? {
          ok: true,
          organisationId,
          actorId: CASE_CONTEXT_COLLECTION_OPERATOR_ID,
          identity: { kind: "operator" },
        }
      : { ok: false, response: controlError("not_found", 404) };
  }
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationId,
    "admin",
    mutation,
  );
  return authorized.ok
    ? {
        ok: true,
        organisationId: authorized.organisationId,
        actorId: authorized.membership.userId,
        identity: { kind: "user", userId: authorized.membership.userId },
      }
    : authorized;
}

function caseContextCollectionMutation(
  route: CaseContextDiscoveryRoute,
  method: string,
): boolean | null {
  switch (route.operation) {
    case "configuration":
      if (method === "GET") return false;
      return method === "PUT" ? true : null;
    case "case_context_collection_review":
      return method === "POST" ? true : null;
    case "case_relationships":
    case "inspector":
    case "screen_observations":
    case "caseContextCollection":
      return method === "GET" ? false : null;
    default:
      return assertNever(route);
  }
}

async function readCaseContextCollectionBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  return readBoundedJsonRecord(request, 16_384);
}

function invalidRequest(): Response {
  return controlError("case_context_collection_request_invalid", 400);
}

function caseContextCollectionResult(
  result:
    | Readonly<{ ok: true; value: unknown }>
    | Readonly<{ ok: false; error: Readonly<{ code: string }> }>,
): Response {
  return result.ok
    ? controlJson(result)
    : controlError(
        result.error.code,
        caseContextCollectionErrorStatus(result.error.code),
      );
}

function caseContextCollectionErrorStatus(code: string): number {
  if (code === "jev_test_rate_limited") return 429;
  if (code.endsWith("_invalid")) return 422;
  if (code === "case_context_collection_relationship_unavailable") return 404;
  return 409;
}

function unavailableCode(route: CaseContextDiscoveryRoute): string {
  switch (route.operation) {
    case "case_relationships":
    case "inspector":
    case "caseContextCollection":
    case "case_context_collection_review":
      return "case_context_collection_relationship_unavailable";
    case "screen_observations":
      return "case_screen_observations_unavailable";
    case "configuration":
      return "case_context_discovery_evaluation_unavailable";
    default:
      return assertNever(route);
  }
}
