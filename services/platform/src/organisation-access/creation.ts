import { canonicalJson, sha256Hex } from "@purin-labs/std";
import type { Env } from "../env";
import { bootstrapOrganisation, type User } from "../data/control-plane";
import {
  hashPortalSubject,
  newControlMutationIdentity,
} from "../data/control-mutation";
import { readControlMutationReplay } from "../data/shared-rows/mutation-receipt";
import type { OrganisationId } from "../ids";
import { configuredOrganisationDatabases } from "../organisation-execution-scope";
import { parseOrganisationPlacementCells } from "../placement";
import type { Result } from "../result";
import type { OrganisationCreationRequest } from "@purin-labs/control-api";

/**
 * Plan 95 step 2: a signed-in person makes an organisation in Pantry, with no
 * outside account. The person becomes its owner. A person owns at most this
 * many active organisations, so that one person cannot make many.
 */
const ORGANISATION_OWNER_LIMIT = 5;

export type OrganisationCreationError = Readonly<{
  code:
    | "organisation_create_invalid"
    | "organisation_owner_unverified"
    | "organisation_limit_reached"
    | "idempotency_key_conflict"
    | "authority_unavailable";
}>;

export type CreatedOrganisation = Readonly<{
  organisationId: OrganisationId;
  organisationHandle: string;
}>;

/**
 * Makes the organisation, or returns the organisation that an earlier request
 * with the same operation id made. A repeat makes no second organisation, and
 * the owner limit does not refuse it.
 */
export async function createOwnedOrganisation(
  input: Readonly<{
    env: Env;
    owner: User;
    request: OrganisationCreationRequest;
    now: number;
  }>,
): Promise<Result<CreatedOrganisation, OrganisationCreationError>> {
  const { env, owner, request, now } = input;
  if (owner.issuer !== "https://accounts.google.com" || !owner.emailVerified)
    return failure("organisation_owner_unverified");
  const cells = parseOrganisationPlacementCells(
    env.PANTRY_ORGANISATION_PLACEMENT_PROFILE,
  );
  if (!cells.ok) return failure("authority_unavailable");
  // The root cell is the onboarding default (`parseOrganisationPlacementCells`).
  const cell = cells.value[0];
  if (cell === undefined) return failure("authority_unavailable");
  const mutation = {
    boundary: {
      kind: "unversioned" as const,
      idempotencyKey: request.operationId,
      requestHash: await sha256Hex(
        canonicalJson({
          name: request.name,
          placementCellId: cell.placement.placementCellId,
        }),
      ),
    },
    scope: {
      userId: owner.userId,
      organisationScope: "organisation:create",
      route: "/v1/control/organisations",
      operation: "organisation.create",
    },
  };
  try {
    const replay = await readControlMutationReplay({
      db: env.DB,
      scope: mutation.scope,
      boundary: mutation.boundary,
    });
    if (replay.kind === "conflict") return failure("idempotency_key_conflict");
    if (
      replay.kind === "absent" &&
      (await countOwnedActiveOrganisations(env, owner)) >=
        ORGANISATION_OWNER_LIMIT
    )
      return failure("organisation_limit_reached");
    const created = await bootstrapOrganisation({
      env,
      owner,
      organisationName: request.name,
      environment:
        env.PANTRY_DEPLOYMENT_PROFILE === "production"
          ? "production"
          : "development",
      placement: cell.placement,
      mutation: {
        ...mutation,
        identity: newControlMutationIdentity({
          portalSubjectHash: await hashPortalSubject(
            owner.issuer,
            owner.subject,
          ),
          causationId: request.operationId,
          now,
        }),
      },
      now,
    });
    if (!created.ok)
      return failure(
        created.error.code === "idempotency_key_conflict"
          ? "idempotency_key_conflict"
          : "authority_unavailable",
      );
    return {
      ok: true,
      value: {
        organisationId: created.value.organisationId,
        organisationHandle: created.value.organisationHandle,
      },
    };
  } catch {
    return failure("authority_unavailable");
  }
}

/** The active organisations that the person owns, in every placement cell. */
async function countOwnedActiveOrganisations(
  env: Env,
  owner: User,
): Promise<number> {
  const counts = await Promise.all(
    configuredOrganisationDatabases(env).map(async (database) => {
      const row = await database
        .withSession("first-primary")
        .prepare(
          `SELECT COUNT(*) AS count FROM service_role_grant AS grant_row
           JOIN organisation ON organisation.organisation_id = grant_row.organisation_id
           WHERE grant_row.user_id = ? AND grant_row.role = 'owner'
             AND grant_row.status = 'active' AND organisation.status = 'active'`,
        )
        .bind(owner.userId)
        .first<{ count: number }>();
      return row?.count ?? 0;
    }),
  );
  return counts.reduce((total, count) => total + count, 0);
}

function failure(
  code: OrganisationCreationError["code"],
): Result<never, OrganisationCreationError> {
  return { ok: false, error: { code } };
}
