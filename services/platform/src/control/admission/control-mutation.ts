/**
 * The shared steps of a control mutation route: the idempotency boundary, the
 * app user of the session, the replay of an earlier attempt, the receipt
 * identity and the projection answer. Each step answers its own refusal as a
 * Response. A route keeps the order of the steps where the order decides
 * which error a request gets.
 */
import type { Variant } from "@seams/type-utils";
import { isRecord } from "@seams/std";
import { resolveUser, type User } from "../../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
  parseControlMutationBoundary,
  prepareControlMutationReceipt,
  readControlMutationReplay,
  type ControlMutationBoundary,
  type ControlMutationIdentity,
  type ControlMutationReceiptScope,
  type StoredControlMutationReceipt,
} from "../../data/control-mutation";
import {
  buildOnboardingProjection,
  type OnboardingProjection,
} from "../../data/onboarding-projection";
import type { QuerySource } from "../../data/query-source";
import type { Env } from "../../env";
import type { UserId } from "../../ids";
import type { AuthorizedOrganisationRequest } from "../authorization";
import { controlError, controlJson } from "../http";
import { controlCausationId } from "../mutation";

type BoundaryKind = ControlMutationBoundary["kind"];

export type AdmittedMutation<K extends BoundaryKind> = Readonly<{
  boundary: Variant<ControlMutationBoundary, K>;
  scope: ControlMutationReceiptScope;
}>;

export type AdmittedUserMutation<K extends BoundaryKind> = AdmittedMutation<K> &
  Readonly<{ user: User }>;

/** The answer to a replayed attempt; null carries the request through again. */
type ReplayResponse<K extends BoundaryKind> = (
  receipt: StoredControlMutationReceipt,
  mutation: AdmittedMutation<K>,
) => Response | null | Promise<Response | null>;

/** The idempotency boundary of the request; 422 when it is absent or invalid. */
export async function parseMutationBoundary<K extends BoundaryKind>(
  request: Request,
  body: Readonly<Record<string, unknown>>,
  kind: K,
): Promise<Variant<ControlMutationBoundary, K> | Response> {
  const boundary = await parseControlMutationBoundary({
    request,
    body,
    requireConfigurationVersion: kind === "configuration_versioned",
  });
  if (!boundary.ok || !hasBoundaryKind(boundary.value, kind)) {
    return controlError(
      boundary.ok ? "mutation_boundary_invalid" : boundary.error.code,
      422,
    );
  }
  return boundary.value;
}

function hasBoundaryKind<K extends BoundaryKind>(
  boundary: ControlMutationBoundary,
  kind: K,
): boundary is Variant<ControlMutationBoundary, K> {
  return boundary.kind === kind;
}

/** The app user of the session; 401 when the user record is gone. */
export async function resolveMutationUser(
  env: Env,
  userId: UserId,
): Promise<User | Response> {
  const user = await resolveUser({ db: env.DB, userId });
  return user ?? controlError("app_user_missing", 401);
}

/**
 * The answer of an earlier attempt with the same idempotency key, or null
 * when there is none. A key that names another request is a 409.
 */
export async function replayControlMutation<K extends BoundaryKind>(
  input: AdmittedMutation<K> &
    Readonly<{ db: QuerySource; replay?: ReplayResponse<K> }>,
): Promise<Response | null> {
  const replay = await readControlMutationReplay({
    db: input.db,
    scope: input.scope,
    boundary: input.boundary,
  });
  if (replay.kind === "conflict") {
    return controlError("idempotency_key_conflict", 409);
  }
  if (replay.kind === "absent") return null;
  return input.replay === undefined
    ? controlJson(replay.receipt.responseBody, replay.receipt.responseStatus)
    : input.replay(replay.receipt, {
        boundary: input.boundary,
        scope: input.scope,
      });
}

type MutationAdmission<K extends BoundaryKind> = Readonly<{
  request: Request;
  authorized: AuthorizedOrganisationRequest;
  body: Readonly<Record<string, unknown>>;
  boundary: K;
  route: string;
  operation: string;
  /** The database of the receipt; the Organisation's database by default. */
  db?: QuerySource;
  /** The answer to a replay; the stored response by default. */
  replay?: ReplayResponse<NoInfer<K>>;
}>;

/** The boundary, the receipt scope and the replay of a control mutation. */
export async function admitControlMutation<K extends BoundaryKind>(
  input: MutationAdmission<K>,
): Promise<AdmittedMutation<K> | Response> {
  const boundary = await parseMutationBoundary(
    input.request,
    input.body,
    input.boundary,
  );
  if (boundary instanceof Response) return boundary;
  const admitted = {
    boundary,
    scope: controlMutationScope(input.authorized, input.route, input.operation),
  };
  return (await replayMutation(input, admitted)) ?? admitted;
}

/**
 * {@link admitControlMutation} with the app user of the session. `user` puts
 * the user read before or after the replay read, which decides the answer to
 * a replay whose user record is gone.
 */
export async function admitUserMutation<K extends BoundaryKind>(
  input: MutationAdmission<K> &
    Readonly<{ env: Env; user: "before_replay" | "after_replay" }>,
): Promise<AdmittedUserMutation<K> | Response> {
  const userId = input.authorized.authenticated.session.userId;
  if (input.user === "after_replay") {
    const admitted = await admitControlMutation(input);
    if (admitted instanceof Response) return admitted;
    const user = await resolveMutationUser(input.env, userId);
    return user instanceof Response ? user : { ...admitted, user };
  }
  const boundary = await parseMutationBoundary(
    input.request,
    input.body,
    input.boundary,
  );
  if (boundary instanceof Response) return boundary;
  const user = await resolveMutationUser(input.env, userId);
  if (user instanceof Response) return user;
  const admitted = {
    boundary,
    scope: controlMutationScope(input.authorized, input.route, input.operation),
  };
  return (await replayMutation(input, admitted)) ?? { ...admitted, user };
}

/** The receipt scope of a mutation by the session's user. */
export function controlMutationScope(
  authorized: AuthorizedOrganisationRequest,
  route: string,
  operation: string,
): ControlMutationReceiptScope {
  return {
    userId: authorized.authenticated.session.userId,
    organisationScope: authorized.organisationId,
    route,
    operation,
  };
}

function replayMutation<K extends BoundaryKind>(
  input: MutationAdmission<K>,
  admitted: AdmittedMutation<K>,
): Promise<Response | null> {
  return replayControlMutation({
    ...admitted,
    db: input.db ?? input.authorized.executionScope.database,
    replay: input.replay,
  });
}

/** The receipt identity of a mutation that this request asks for. */
export async function controlMutationIdentity(
  request: Request,
  user: Pick<User, "issuer" | "subject">,
  now: number,
): Promise<ControlMutationIdentity> {
  return newControlMutationIdentity({
    portalSubjectHash: await hashPortalSubject(user.issuer, user.subject),
    causationId: controlCausationId(request),
    now,
  });
}

/**
 * Records the receipt of a mutation by the session in the Organisation's
 * database. The idempotency key is the cause.
 */
export async function recordSessionMutationReceipt(
  authorized: AuthorizedOrganisationRequest,
  mutation: AdmittedMutation<BoundaryKind>,
  response: Readonly<{ status: number; body: unknown }>,
  now: number,
): Promise<void> {
  await prepareControlMutationReceipt(authorized.executionScope.database, {
    scope: mutation.scope,
    boundary: mutation.boundary,
    identity: newControlMutationIdentity({
      portalSubjectHash: await hashPortalSubject(
        "control",
        authorized.authenticated.session.userId,
      ),
      causationId: mutation.boundary.idempotencyKey,
      now,
    }),
    responseStatus: response.status,
    responseBody: response.body,
  }).run();
}

/**
 * The Organisation's projection after a mutation. `missing` is the error
 * when the projection is gone, which no mutation allows.
 */
export async function mutationProjection(
  authorized: AuthorizedOrganisationRequest,
  missing: string,
): Promise<OnboardingProjection> {
  const projection = await buildOnboardingProjection({
    db: authorized.executionScope.database,
    organisationId: authorized.organisationId,
    membership: authorized.membership,
    now: Date.now(),
  });
  if (projection === null) throw new Error(missing);
  return projection;
}

/** The answer of a configuration mutation: its projection and own fields. */
export async function projectionResponse(
  authorized: AuthorizedOrganisationRequest,
  missing: string,
  fields: Readonly<Record<string, unknown>>,
  status?: number,
): Promise<Response> {
  const projection = await mutationProjection(authorized, missing);
  return controlJson({ kind: "success", projection, ...fields }, status);
}

/** The replay of a configuration mutation: its stored receipt and projection. */
export function projectionReplay(
  authorized: AuthorizedOrganisationRequest,
): (receipt: StoredControlMutationReceipt) => Promise<Response> {
  return async (receipt) => {
    if (
      !isRecord(receipt.responseBody) ||
      receipt.responseBody.organisation_id !== authorized.organisationId ||
      typeof receipt.responseBody.receipt_id !== "string"
    ) {
      throw new Error(
        "control mutation receipt projection identity is invalid",
      );
    }
    return projectionResponse(
      authorized,
      "control mutation replay projection is missing",
      { receipt: receipt.responseBody },
      receipt.responseStatus,
    );
  };
}
