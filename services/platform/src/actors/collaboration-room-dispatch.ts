import { controlError } from "../control/http";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import type { Result } from "@purin-labs/kernel/result";
import { isOrganisationExecutionActive } from "@purin-labs/actor-runtime/actors/actor-execution-quiescence";
import type {
  CollaborationRoomKind,
  CollaborationSocketRoom,
  CollaborationSocketRoute,
} from "./collaboration-room";

/** One request of a shared document room, after its path matched. */
type CollaborationRoomRequest = Readonly<{
  /**
   * Admits the request. An admitted request names its Organisation and
   * answers for the room.
   */
  authorize(
    request: Request,
    env: Env,
  ): Promise<
    | Readonly<{
        ok: true;
        organisationId: OrganisationId;
        respond(
          scope: OrganisationExecutionScope,
        ): Response | Promise<Response>;
      }>
    | Readonly<{ ok: false; response: Response }>
  >;
  /** False for a room that does not read the Organisation record. */
  checksOrganisationRecord: boolean;
}>;

/**
 * The route of one shared document room. The area of the document gives it:
 * the path match, the admission check and the room. It returns null for a
 * path of another room.
 */
export type CollaborationRoomRoute = (
  pathname: string,
) => CollaborationRoomRequest | null;

/** The room of an accepted socket, for each kind of shared document. */
export type CollaborationSocketRooms = Readonly<
  Record<
    CollaborationRoomKind,
    (
      organisationId: OrganisationId,
      key: string,
    ) =>
      CollaborationSocketRoom | null | Promise<CollaborationSocketRoom | null>
  >
>;

export async function resolveCollaborationSocket(
  sockets: CollaborationSocketRooms,
  organisationId: OrganisationId,
  route: CollaborationSocketRoute,
): Promise<CollaborationSocketRoom | null> {
  return sockets[route.kind](organisationId, route.key);
}

/**
 * Sends one request to the room whose route matches its path. The order of
 * the checks is the same for each room: the admission of the room, the
 * placement of the Organisation, then the Organisation record.
 */
export async function dispatchCollaborationFetch(
  input: Readonly<{
    request: Request;
    pathname: string;
    env: Env;
    sql: SqlStorage;
    scope: OrganisationExecutionScope;
    routes: readonly CollaborationRoomRoute[];
    validateOrganisation: (
      organisationId: OrganisationId,
    ) => Result<unknown, Readonly<{ code: string }>>;
  }>,
): Promise<Response> {
  const { request, pathname, env, sql, scope, validateOrganisation } = input;
  for (const route of input.routes) {
    const matched = route(pathname);
    if (matched === null) continue;
    const authorized = await matched.authorize(request, env);
    if (!authorized.ok) return authorized.response;
    if (
      authorized.organisationId !== scope.organisationId ||
      !(await isOrganisationExecutionActive(sql, scope))
    ) {
      return controlError("organisation_placement_conflict", 409);
    }
    if (matched.checksOrganisationRecord) {
      const organisation = validateOrganisation(authorized.organisationId);
      if (!organisation.ok) return controlError(organisation.error.code, 404);
    }
    return authorized.respond(scope);
  }
  return controlError("not_found", 404);
}
