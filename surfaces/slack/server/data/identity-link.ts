import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "@purin-labs/tenancy/organisation-execution-scope";
import {
  parseProviderConnectionId,
  parseOrganisationId,
  parseWorkspaceId,
  type ProviderConnectionId,
  type OrganisationId,
  type WorkspaceId,
} from "@purin-labs/kernel/ids";
import { type UserId } from "@purin-labs/control-api/ids";
import type { Result } from "@purin-labs/kernel/result";
import {
  parseSlackUserId,
  type SlackEventId,
  type SlackUserId,
} from "../events";
import { assertNever, encodeBase64Url, sha256Hex } from "@purin-labs/std";

declare const identityLinkChallengeIdBrand: unique symbol;
declare const identityLinkTokenBrand: unique symbol;

type IdentityLinkChallengeId = string & {
  readonly [identityLinkChallengeIdBrand]: "IdentityLinkChallengeId";
};
type IdentityLinkToken = string & {
  readonly [identityLinkTokenBrand]: "IdentityLinkToken";
};
type IdentityVerificationMethod = "google" | "passkey" | "seams";

type IdentityLinkChallenge = {
  readonly challengeId: IdentityLinkChallengeId;
  readonly organisationId: OrganisationId;
  readonly workspaceConnectionId: ProviderConnectionId;
  readonly workspaceId: WorkspaceId;
  readonly externalUserId: SlackUserId;
  readonly expiresAt: number;
};

type IssuedIdentityLink = IdentityLinkChallenge & {
  readonly token: IdentityLinkToken;
};

type ExternalIdentityLink = {
  readonly kind: "slack";
  readonly userId: UserId;
  readonly organisationId: OrganisationId;
  readonly workspaceConnectionId: ProviderConnectionId;
  readonly workspaceId: WorkspaceId;
  readonly externalUserId: SlackUserId;
  readonly verifiedAt: number;
  readonly verifiedBy: IdentityVerificationMethod;
};

type IssueIdentityLinkError =
  | { readonly code: "invalid_expiry" }
  | { readonly code: "slack_workspace_not_found" }
  | { readonly code: "identity_already_linked" }
  | { readonly code: "link_event_replayed" }
  | { readonly code: "link_issue_conflict" };

type IdentityLinkIssueSource =
  | { readonly kind: "admin"; readonly eventId?: never }
  | { readonly kind: "slack_event"; readonly eventId: SlackEventId };

export type ResolveIdentityLinkError =
  | { readonly code: "link_not_found" }
  | { readonly code: "link_expired" }
  | { readonly code: "link_consumed" }
  | { readonly code: "invalid_link_record" };

export type ConsumeIdentityLinkError =
  | ResolveIdentityLinkError
  | { readonly code: "organisation_membership_missing" }
  | { readonly code: "identity_provider_unsupported" }
  | { readonly code: "identity_conflict" }
  | { readonly code: "link_race_lost" };

type ChallengeRow = {
  readonly challengeId: unknown;
  readonly organisationId: unknown;
  readonly workspaceConnectionId: unknown;
  readonly workspaceId: unknown;
  readonly externalUserId: unknown;
  readonly expiresAt: unknown;
  readonly consumedAt: unknown;
};

type WorkspaceConnectionRow = {
  readonly workspaceConnectionId: unknown;
};

const MAX_IDENTITY_LINK_TTL_MS = 15 * 60 * 1000;

export async function issueIdentityLink(input: {
  readonly env: OrganisationPlacementBindings;
  readonly organisationId: OrganisationId;
  readonly workspaceId: WorkspaceId;
  readonly externalUserId: SlackUserId;
  readonly source: IdentityLinkIssueSource;
  readonly now: number;
  readonly expiresAt: number;
}): Promise<Result<IssuedIdentityLink, IssueIdentityLinkError>> {
  const ttl = input.expiresAt - input.now;
  if (ttl <= 0 || ttl > MAX_IDENTITY_LINK_TTL_MS) {
    return { ok: false, error: { code: "invalid_expiry" } };
  }
  const scope = await OrganisationExecutionScope.resolve(
    input.env,
    input.organisationId,
  );
  if (!scope.ok) return { ok: false, error: { code: "link_issue_conflict" } };
  const session = scope.value.database.withSession("first-primary");
  const connection = await session
    .prepare(
      `SELECT connection.provider_connection_id AS workspaceConnectionId
     FROM surface_installation AS installation
     JOIN integration_account AS account
       ON account.integration_account_id = installation.integration_account_id
      AND account.organisation_id = installation.organisation_id
      AND account.provider = 'slack'
      AND account.account_kind = 'workspace'
      AND account.lifecycle = 'active'
     JOIN provider_connection AS connection
       ON connection.provider_connection_id = account.provider_connection_id
      AND connection.organisation_id = account.organisation_id
      AND connection.provider = 'slack'
      AND connection.provider_subject_id = installation.workspace_id
      AND connection.lifecycle = 'active'
     WHERE installation.surface_kind = 'slack'
       AND installation.organisation_id = ?
       AND installation.workspace_id = ?
     LIMIT 1`,
    )
    .bind(input.organisationId, input.workspaceId)
    .first<WorkspaceConnectionRow>();
  if (
    connection === null ||
    typeof connection.workspaceConnectionId !== "string"
  ) {
    return { ok: false, error: { code: "slack_workspace_not_found" } };
  }
  const workspaceConnectionId = parseProviderConnectionId(
    connection.workspaceConnectionId,
  );
  if (!workspaceConnectionId.ok) {
    return { ok: false, error: { code: "slack_workspace_not_found" } };
  }
  const existing = await session
    .prepare(
      `SELECT 1 AS present FROM external_identity_link
     WHERE organisation_id = ? AND workspace_id = ? AND external_user_id = ?`,
    )
    .bind(input.organisationId, input.workspaceId, input.externalUserId)
    .first<{ readonly present: unknown }>();
  if (existing !== null) {
    return { ok: false, error: { code: "identity_already_linked" } };
  }
  const challengeId = newIdentityLinkChallengeId();
  const token = newIdentityLinkToken(input.organisationId);
  try {
    await session
      .prepare(
        `INSERT INTO external_identity_link_challenge (
         challenge_id, token_hash, organisation_id, workspace_connection_id,
         workspace_id, external_user_id, created_at, expires_at,
         consumed_at, consuming_user_id, source_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .bind(
        challengeId,
        await sha256Hex(token),
        input.organisationId,
        workspaceConnectionId.value,
        input.workspaceId,
        input.externalUserId,
        input.now,
        input.expiresAt,
        identityLinkSourceEventId(input.source),
      )
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("external_identity_link_workspace_mismatch")) {
      return { ok: false, error: { code: "slack_workspace_not_found" } };
    }
    return message.includes("external_identity_link_challenge.source_event_id")
      ? { ok: false, error: { code: "link_event_replayed" } }
      : { ok: false, error: { code: "link_issue_conflict" } };
  }
  return {
    ok: true,
    value: {
      challengeId,
      token,
      organisationId: input.organisationId,
      workspaceConnectionId: workspaceConnectionId.value,
      workspaceId: input.workspaceId,
      externalUserId: input.externalUserId,
      expiresAt: input.expiresAt,
    },
  };
}

function identityLinkSourceEventId(
  source: IdentityLinkIssueSource,
): SlackEventId | null {
  switch (source.kind) {
    case "admin":
      return null;
    case "slack_event":
      return source.eventId;
    default:
      return assertNever(source);
  }
}

export async function resolveIdentityLink(input: {
  readonly env: OrganisationPlacementBindings;
  readonly token: IdentityLinkToken;
  readonly now: number;
}): Promise<Result<IdentityLinkChallenge, ResolveIdentityLinkError>> {
  const scope = await resolveIdentityLinkScope(input.env, input.token);
  if (scope === null) return { ok: false, error: { code: "link_not_found" } };
  return readIdentityLinkChallenge({
    db: scope.database,
    token: input.token,
    now: input.now,
  });
}

async function resolveIdentityLinkScope(
  env: OrganisationPlacementBindings,
  token: IdentityLinkToken,
): Promise<OrganisationExecutionScope | null> {
  const organisationId = parseOrganisationId(
    token.slice(0, token.indexOf(".")),
  );
  if (!organisationId.ok) return null;
  const scope = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  return scope.ok ? scope.value : null;
}

async function readIdentityLinkChallenge(input: {
  readonly db: OrganisationDatabase;
  readonly token: IdentityLinkToken;
  readonly now: number;
}): Promise<Result<IdentityLinkChallenge, ResolveIdentityLinkError>> {
  const row = await input.db
    .prepare(
      `SELECT challenge_id AS challengeId, organisation_id AS organisationId,
            workspace_connection_id AS workspaceConnectionId,
            workspace_id AS workspaceId, external_user_id AS externalUserId,
            expires_at AS expiresAt, consumed_at AS consumedAt
     FROM external_identity_link_challenge WHERE token_hash = ?`,
    )
    .bind(await sha256Hex(input.token))
    .first<ChallengeRow>();
  if (row === null) return { ok: false, error: { code: "link_not_found" } };
  return parseChallengeRow(row, input.now);
}

export async function consumeIdentityLink(input: {
  readonly env: OrganisationPlacementBindings;
  readonly token: IdentityLinkToken;
  readonly userId: UserId;
  readonly now: number;
}): Promise<Result<ExternalIdentityLink, ConsumeIdentityLinkError>> {
  const scope = await resolveIdentityLinkScope(input.env, input.token);
  if (scope === null) return { ok: false, error: { code: "link_not_found" } };
  const challenge = await readIdentityLinkChallenge({
    db: scope.database,
    token: input.token,
    now: input.now,
  });
  if (!challenge.ok) return challenge;
  const membership = await scope.database
    .prepare(
      "SELECT 1 FROM service_role_grant WHERE organisation_id = ? AND user_id = ? AND status = 'active'",
    )
    .bind(challenge.value.organisationId, input.userId)
    .first();
  if (membership === null)
    return { ok: false, error: { code: "organisation_membership_missing" } };
  const authority = await input.env.DB.prepare(
    "SELECT issuer FROM app_user WHERE user_id = ?",
  )
    .bind(input.userId)
    .first<{ readonly issuer: unknown }>();
  if (authority === null)
    return { ok: false, error: { code: "identity_provider_unsupported" } };
  const verifiedBy = parseVerificationMethod(authority.issuer);
  if (verifiedBy === null) {
    return { ok: false, error: { code: "identity_provider_unsupported" } };
  }
  const verifiedIssuer = authority.issuer;
  if (typeof verifiedIssuer !== "string") {
    return { ok: false, error: { code: "identity_provider_unsupported" } };
  }
  const session = scope.database.withSession("first-primary");
  try {
    const results = await session.batch([
      session
        .prepare(
          `UPDATE external_identity_link_challenge
         SET consumed_at = ?, consuming_user_id = ?
         WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM service_role_grant AS membership
             WHERE membership.organisation_id = external_identity_link_challenge.organisation_id
               AND membership.user_id = ?
               AND membership.status = 'active'
           )
           AND EXISTS (
             SELECT 1
             FROM provider_connection AS connection
             JOIN integration_account AS account
               ON account.provider_connection_id = connection.provider_connection_id
              AND account.organisation_id = connection.organisation_id
              AND account.provider = 'slack'
              AND account.account_kind = 'workspace'
              AND account.lifecycle = 'active'
             JOIN surface_installation AS installation
               ON installation.integration_account_id = account.integration_account_id
              AND installation.organisation_id = account.organisation_id
              AND installation.surface_kind = 'slack'
             WHERE connection.provider_connection_id =
                     external_identity_link_challenge.workspace_connection_id
               AND connection.organisation_id = external_identity_link_challenge.organisation_id
               AND connection.provider = 'slack'
               AND connection.lifecycle = 'active'
               AND installation.workspace_id = external_identity_link_challenge.workspace_id
           )`,
        )
        .bind(
          input.now,
          input.userId,
          challenge.value.challengeId,
          input.now,
          input.userId,
        ),
      session
        .prepare(
          `INSERT INTO external_identity_link (
           organisation_id, workspace_connection_id, workspace_id, external_user_id,
           user_id, verified_at, verified_by
         )
         SELECT organisation_id, workspace_connection_id, workspace_id, external_user_id,
                consuming_user_id, consumed_at, ?
         FROM external_identity_link_challenge
         WHERE challenge_id = ? AND consumed_at = ?
           AND consuming_user_id = ?`,
        )
        .bind(verifiedBy, challenge.value.challengeId, input.now, input.userId),
    ]);
    if (!changedExactlyOnce(results[0]) || !changedExactlyOnce(results[1])) {
      return { ok: false, error: { code: "link_race_lost" } };
    }
  } catch (error) {
    return classifyConsumptionFailure(error);
  }
  return {
    ok: true,
    value: {
      kind: "slack",
      userId: input.userId,
      organisationId: challenge.value.organisationId,
      workspaceConnectionId: challenge.value.workspaceConnectionId,
      workspaceId: challenge.value.workspaceId,
      externalUserId: challenge.value.externalUserId,
      verifiedAt: input.now,
      verifiedBy,
    },
  };
}

export function parseIdentityLinkToken(raw: unknown): IdentityLinkToken | null {
  if (typeof raw !== "string") return null;
  const separator = raw.indexOf(".");
  if (
    separator < 1 ||
    !parseOrganisationId(raw.slice(0, separator)).ok ||
    !/^[A-Za-z0-9_-]{43}$/u.test(raw.slice(separator + 1))
  )
    return null;
  return raw as IdentityLinkToken;
}

function parseChallengeRow(
  row: ChallengeRow,
  now: number,
): Result<IdentityLinkChallenge, ResolveIdentityLinkError> {
  if (row.consumedAt !== null)
    return { ok: false, error: { code: "link_consumed" } };
  const challengeId = parseIdentityLinkChallengeId(row.challengeId);
  const organisationId =
    typeof row.organisationId === "string"
      ? parseOrganisationId(row.organisationId)
      : null;
  const workspaceConnectionId =
    typeof row.workspaceConnectionId === "string"
      ? parseProviderConnectionId(row.workspaceConnectionId)
      : null;
  const workspaceId =
    typeof row.workspaceId === "string"
      ? parseWorkspaceId(row.workspaceId)
      : null;
  const externalUserId =
    typeof row.externalUserId === "string"
      ? parseSlackUserId(row.externalUserId, "externalUserId")
      : null;
  if (
    challengeId === null ||
    organisationId === null ||
    !organisationId.ok ||
    workspaceConnectionId === null ||
    !workspaceConnectionId.ok ||
    workspaceId === null ||
    !workspaceId.ok ||
    externalUserId === null ||
    !externalUserId.ok ||
    typeof row.expiresAt !== "number" ||
    !Number.isSafeInteger(row.expiresAt)
  ) {
    return { ok: false, error: { code: "invalid_link_record" } };
  }
  if (row.expiresAt <= now)
    return { ok: false, error: { code: "link_expired" } };
  return {
    ok: true,
    value: {
      challengeId,
      organisationId: organisationId.value,
      workspaceConnectionId: workspaceConnectionId.value,
      workspaceId: workspaceId.value,
      externalUserId: externalUserId.value,
      expiresAt: row.expiresAt,
    },
  };
}

function parseVerificationMethod(
  raw: unknown,
): IdentityVerificationMethod | null {
  if (raw === "https://accounts.google.com" || raw === "accounts.google.com")
    return "google";
  if (raw === "urn:pantry:passkey") return "passkey";
  if (raw === "urn:pantry:seams") return "seams";
  return null;
}

function parseIdentityLinkChallengeId(
  raw: unknown,
): IdentityLinkChallengeId | null {
  return typeof raw === "string" && /^identity_link_[A-Za-z0-9-]+$/u.test(raw)
    ? (raw as IdentityLinkChallengeId)
    : null;
}

function newIdentityLinkChallengeId(): IdentityLinkChallengeId {
  return `identity_link_${crypto.randomUUID()}` as IdentityLinkChallengeId;
}

function newIdentityLinkToken(
  organisationId: OrganisationId,
): IdentityLinkToken {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = parseIdentityLinkToken(
    `${organisationId}.${encodeBase64Url(bytes)}`,
  );
  if (token === null) throw new Error("identity_link_token_invalid");
  return token;
}

function changedExactlyOnce(result: D1Result<unknown> | undefined): boolean {
  return result?.meta.changes === 1;
}

function classifyConsumptionFailure(
  error: unknown,
): Result<never, ConsumeIdentityLinkError> {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("external_identity_link")
    ? { ok: false, error: { code: "identity_conflict" } }
    : { ok: false, error: { code: "link_race_lost" } };
}
