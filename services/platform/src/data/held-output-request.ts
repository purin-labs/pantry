import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import type { RequestAuthority } from "@seams/contracts";
import {
  parseHeldEffectAction,
  type HeldEffectAction,
} from "@seams/control-api";
import { isNonNegativeInteger, isRecord } from "@seams/std";

import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { parseStoredRequestAuthority } from "../request-authority";
import type { Result } from "../result";

/**
 * Something that the exit check stopped and that waits for a person (Plan
 * 27C). An output stays in the Case outbox. Allow sends that one output, and
 * deny and expiry drop it. A tool effect cannot wait inside its turn, so its
 * turn ends. Allow gives one pass to that effect of that Session, which a
 * later turn uses for the rest of that turn. The row holds no agent text: only
 * where it goes, why it waits and the label that decides who may answer, and
 * which content the pass covers.
 */
export type HeldOutputStatus = "pending" | "allowed" | "denied" | "expired";

/**
 * Why it waits. `outside_written` is an effect of a Session that read text of
 * a person outside the Organisation (Plan 89): the person who asked decides if
 * they wanted this action.
 */
export type HeldOutputReason =
  "private_source" | "outside_organisation" | "outside_written";

/** The one tool effect that an allow lets through, and its Session. */
export type HeldEffect = Readonly<{
  sessionId: string;
  authorityPartitionDigest: string;
  capabilityId: string;
  integrationAccountId: string;
  resourceScope: string;
  consumedAt: number | null;
  /**
   * The exact action of an `outside_written` step: the digest of its operation
   * and arguments, and what the prompt shows (Plan 89). A pass of that reason
   * lets only this action through. Null for each other reason.
   */
  action: Readonly<{ digest: string; view: HeldEffectAction }> | null;
}>;

export type HeldOutputRequest = Readonly<{
  organisationId: string;
  requestId: string;
  subject: "output" | "effect";
  caseId: string | null;
  connectorId: string | null;
  channelId: string | null;
  outputId: string | null;
  effect: HeldEffect | null;
  reason: HeldOutputReason;
  requesterPersonId: string | null;
  requestAuthority: RequestAuthority;
  flowLabelJson: string;
  status: HeldOutputStatus;
  decidedByUserId: string | null;
  createdAt: number;
  decidedAt: number | null;
  releasedAt: number | null;
}>;

/** A request older than this can no longer be decided. */
export const HELD_OUTPUT_REQUEST_LIFETIME_MS = 7 * 24 * 60 * 60_000;

type StoreError = Readonly<{ code: "held_output_store_failed" }>;

const COLUMNS = `organisation_id AS organisationId, request_id AS requestId,
  subject, case_id AS caseId, connector_id AS connectorId,
  output_id AS outputId, channel_id AS channelId, session_id AS sessionId,
  authority_partition_digest AS authorityPartitionDigest,
  capability_id AS capabilityId,
  integration_account_id AS integrationAccountId,
  resource_scope AS resourceScope, consumed_at AS consumedAt,
  action_digest AS actionDigest, action_json AS actionJson, reason,
  requester_person_id AS requesterPersonId,
  request_authority_json AS requestAuthorityJson,
  flow_label_json AS flowLabelJson, status,
  decided_by_user_id AS decidedByUserId, created_at AS createdAt,
  decided_at AS decidedAt, released_at AS releasedAt`;

const PLACEMENT_FENCE = `EXISTS (SELECT 1 FROM organisation_placement
  WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ?
    AND fence_token = ? AND status = 'active')`;

function fenceBindings(
  scope: OrganisationExecutionScope,
): readonly (string | number)[] {
  return [
    scope.organisationId,
    scope.placement.placementEpoch,
    scope.placement.placementCellId,
    scope.fenceToken,
  ];
}

export type HeldOutputRequestInsert = Pick<
  HeldOutputRequest,
  | "requestId"
  | "subject"
  | "caseId"
  | "connectorId"
  | "outputId"
  | "channelId"
  | "effect"
  | "reason"
  | "requesterPersonId"
  | "requestAuthority"
  | "flowLabelJson"
  | "createdAt"
>;

/** Store a held output. The same output again keeps the first row. */
export async function insertHeldOutputRequest(
  scope: OrganisationExecutionScope,
  request: HeldOutputRequestInsert,
): Promise<Result<HeldOutputRequest, StoreError>> {
  try {
    const db = scope.database.withSession("first-primary");
    await db
      .prepare(
        `INSERT INTO held_output_request (
           organisation_id, request_id, subject, case_id, connector_id,
           output_id, channel_id, session_id, authority_partition_digest,
           capability_id, integration_account_id, resource_scope,
           action_digest, action_json, reason,
           requester_person_id, request_authority_json, flow_label_json,
           status, created_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           'pending', ?
         WHERE ${PLACEMENT_FENCE}
         ON CONFLICT (organisation_id, request_id) DO NOTHING`,
      )
      .bind(
        scope.organisationId,
        request.requestId,
        request.subject,
        request.caseId,
        request.connectorId,
        request.outputId,
        request.channelId,
        request.effect?.sessionId ?? null,
        request.effect?.authorityPartitionDigest ?? null,
        request.effect?.capabilityId ?? null,
        request.effect?.integrationAccountId ?? null,
        request.effect?.resourceScope ?? null,
        request.effect?.action?.digest ?? null,
        request.effect?.action === null || request.effect?.action === undefined
          ? null
          : JSON.stringify(request.effect.action.view),
        request.reason,
        request.requesterPersonId,
        JSON.stringify(request.requestAuthority),
        request.flowLabelJson,
        request.createdAt,
        ...fenceBindings(scope),
      )
      .run();
    const stored = await readHeldOutputRequest(
      db,
      scope.organisationId,
      request.requestId,
    );
    return stored === null
      ? { ok: false, error: { code: "held_output_store_failed" } }
      : { ok: true, value: stored };
  } catch {
    return { ok: false, error: { code: "held_output_store_failed" } };
  }
}

export async function readHeldOutputRequest(
  db: OrganisationDatabase | OrganisationDatabaseSession,
  organisationId: string,
  requestId: string,
): Promise<HeldOutputRequest | null> {
  const row = await db
    .prepare(
      `SELECT ${COLUMNS} FROM held_output_request
       WHERE organisation_id = ? AND request_id = ?`,
    )
    .bind(organisationId, requestId)
    .first();
  return parseHeldOutputRequest(row);
}

/** The held outputs that may still be decided, newest first. */
export async function listPendingHeldOutputRequests(
  db: OrganisationDatabase | OrganisationDatabaseSession,
  organisationId: string,
  now: number,
): Promise<readonly HeldOutputRequest[]> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM held_output_request
       WHERE organisation_id = ? AND status = 'pending' AND created_at > ?
       ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(organisationId, now - HELD_OUTPUT_REQUEST_LIFETIME_MS)
    .all();
  return parseRows(rows.results);
}

/**
 * Record the end of a request. Only a pending request changes; the stored row
 * is returned either way, so the caller sees the first decision. Expiry has
 * no person, so it stores no user.
 */
export async function decideHeldOutputRequest(
  scope: OrganisationExecutionScope,
  input: Readonly<{
    requestId: string;
    status: "allowed" | "denied" | "expired";
    userId: string | null;
    now: number;
  }>,
): Promise<Result<HeldOutputRequest, StoreError>> {
  try {
    const db = scope.database.withSession("first-primary");
    await db
      .prepare(
        `UPDATE held_output_request
         SET status = ?, decided_by_user_id = ?, decided_at = ?
         WHERE organisation_id = ? AND request_id = ? AND status = 'pending'
           AND ${PLACEMENT_FENCE}`,
      )
      .bind(
        input.status,
        input.userId,
        input.now,
        scope.organisationId,
        input.requestId,
        ...fenceBindings(scope),
      )
      .run();
    const stored = await readHeldOutputRequest(
      db,
      scope.organisationId,
      input.requestId,
    );
    return stored === null
      ? { ok: false, error: { code: "held_output_store_failed" } }
      : { ok: true, value: stored };
  } catch {
    return { ok: false, error: { code: "held_output_store_failed" } };
  }
}

/** Where a pass is used: the turn, and whether its content may use it. */
export type HeldEffectPassUse = Readonly<{
  /** The turn that asks. The pass that it uses records this turn. */
  turnId: string;
  /**
   * Whether a pass that this turn used covers its later calls of the same
   * effect: true for a board edit, one request of the person (Plan 40B
   * phase 7). Other effects use one pass for each call.
   */
  repeatInRequest: boolean;
  /**
   * Whether the content of this edit is no more than what the person allowed,
   * from the label stored with the request. An edit with more private content
   * needs a new Allow.
   */
  covers: (allowedFlowLabelJson: string) => Promise<boolean>;
  /**
   * The block that the pass must answer. A pass that a person gave for
   * outside-written text lets through the exact action that they saw, and no
   * other pass answers that block (Plan 89).
   */
  outsideWritten: Readonly<{ actionDigest: string | null }> | null;
}>;

type PassRow = Readonly<{
  requestId: string;
  flowLabelJson: string;
  consumedTurnId: string | null;
}>;

/**
 * The allowed passes of this effect that this turn may use: the pass that
 * this turn already used first, then the oldest unused one.
 */
async function usablePasses(
  scope: OrganisationExecutionScope,
  effect: Pick<
    HeldEffect,
    "sessionId" | "capabilityId" | "integrationAccountId" | "resourceScope"
  >,
  now: number,
  portalChatRequester: string | null,
  use: HeldEffectPassUse,
): Promise<readonly PassRow[]> {
  const rows = await scope.database
    .prepare(
      `SELECT request_id AS requestId, flow_label_json AS flowLabelJson,
         consumed_turn_id AS consumedTurnId
       FROM held_output_request
       WHERE organisation_id = ? AND subject = 'effect'
         AND ${portalChatRequester === null ? "session_id = ?" : "requester_person_id = ? AND connector_id IS NULL"}
         AND capability_id = ? AND integration_account_id = ?
         AND resource_scope = ? AND status = 'allowed'
         AND (reason = 'outside_written') = ? AND action_digest IS ?
         AND (consumed_at IS NULL OR (? AND consumed_turn_id = ?))
         AND created_at > ? AND ${PLACEMENT_FENCE}
       ORDER BY consumed_turn_id IS NULL, created_at LIMIT 20`,
    )
    .bind(
      scope.organisationId,
      portalChatRequester ?? effect.sessionId,
      effect.capabilityId,
      effect.integrationAccountId,
      effect.resourceScope,
      use.outsideWritten === null ? 0 : 1,
      use.outsideWritten?.actionDigest ?? null,
      use.repeatInRequest ? 1 : 0,
      use.turnId,
      now - HELD_OUTPUT_REQUEST_LIFETIME_MS,
      ...fenceBindings(scope),
    )
    .all();
  return rows.results.filter(
    (row): row is PassRow =>
      isRecord(row) &&
      typeof row.requestId === "string" &&
      typeof row.flowLabelJson === "string" &&
      (row.consumedTurnId === null || typeof row.consumedTurnId === "string"),
  );
}

/**
 * Use an allowed pass of this effect, while the effect's content stays within
 * what the person allowed. For a board edit one Allow covers one request of
 * the person: the turn that uses the pass may make the same edit again, and
 * a later turn needs a new Allow. It returns false when no such pass waits,
 * so that two calls or two turns cannot use the same pass.
 */
export async function consumeHeldEffectPass(
  scope: OrganisationExecutionScope,
  effect: Pick<
    HeldEffect,
    "sessionId" | "capabilityId" | "integrationAccountId" | "resourceScope"
  >,
  now: number,
  /**
   * A Portal chat runs each message in its own Session, and the person asks
   * again in a later one. So the pass of a chat belongs to the person who
   * asked. A Slack thread keeps one Session, and its pass stays there.
   */
  portalChatRequester: string | null,
  use: HeldEffectPassUse,
): Promise<boolean> {
  const passes = await usablePasses(
    scope,
    effect,
    now,
    portalChatRequester,
    use,
  );
  for (const pass of passes) {
    if (!(await use.covers(pass.flowLabelJson))) continue;
    if (pass.consumedTurnId === use.turnId) return true;
    // One statement decides a race: two calls of one turn run at the same
    // time, and the call that reads the pass before the other takes it may
    // still use it when the pass repeats within the request.
    const result = await scope.database
      .prepare(
        `UPDATE held_output_request
         SET consumed_at = COALESCE(consumed_at, ?),
           consumed_turn_id = COALESCE(consumed_turn_id, ?)
         WHERE organisation_id = ? AND request_id = ? AND status = 'allowed'
           AND (consumed_at IS NULL OR (? AND consumed_turn_id = ?))
           AND ${PLACEMENT_FENCE}`,
      )
      .bind(
        now,
        use.turnId,
        scope.organisationId,
        pass.requestId,
        use.repeatInRequest ? 1 : 0,
        use.turnId,
        ...fenceBindings(scope),
      )
      .run();
    if ((result.meta.changes ?? 0) === 1) return true;
  }
  return false;
}

/**
 * Whether an allowed pass waits for this effect, as `consumeHeldEffectPass`
 * finds it, without taking it (Plan 40B phase 7: a draft preview shows only
 * what the edit will be allowed to change).
 */
export async function hasHeldEffectPass(
  scope: OrganisationExecutionScope,
  effect: Pick<
    HeldEffect,
    "sessionId" | "capabilityId" | "integrationAccountId" | "resourceScope"
  >,
  now: number,
  portalChatRequester: string | null,
  use: HeldEffectPassUse,
): Promise<boolean> {
  const passes = await usablePasses(
    scope,
    effect,
    now,
    portalChatRequester,
    use,
  );
  for (const pass of passes)
    if (await use.covers(pass.flowLabelJson)) return true;
  return false;
}

/** Record that the output left, or that the Case dropped it. */
export async function markHeldOutputRequestReleased(
  scope: OrganisationExecutionScope,
  requestId: string,
  now: number,
): Promise<void> {
  await scope.database
    .prepare(
      `UPDATE held_output_request SET released_at = ?
       WHERE organisation_id = ? AND request_id = ? AND status != 'pending'
         AND released_at IS NULL AND ${PLACEMENT_FENCE}`,
    )
    .bind(now, scope.organisationId, requestId, ...fenceBindings(scope))
    .run();
}

/**
 * The work that the scheduled reconciliation owes: pending requests whose
 * time ended, and decisions that did not reach their output yet. A decision
 * stops being tried after one more lifetime.
 */
export async function listHeldOutputReconciliation(
  db: OrganisationDatabase,
  organisationId: string,
  now: number,
): Promise<readonly HeldOutputRequest[]> {
  const rows = await db
    .prepare(
      `SELECT ${COLUMNS} FROM held_output_request
       WHERE organisation_id = ? AND (
         (status = 'pending' AND created_at <= ?)
         OR (status != 'pending' AND released_at IS NULL AND created_at >= ?)
       )
       ORDER BY created_at LIMIT 20`,
    )
    .bind(
      organisationId,
      now - HELD_OUTPUT_REQUEST_LIFETIME_MS,
      now - 2 * HELD_OUTPUT_REQUEST_LIFETIME_MS,
    )
    .all();
  return parseRows(rows.results);
}

function parseRows(rows: readonly unknown[] | undefined): HeldOutputRequest[] {
  const parsed: HeldOutputRequest[] = [];
  for (const row of rows ?? []) {
    const request = parseHeldOutputRequest(row);
    if (request !== null) parsed.push(request);
  }
  return parsed;
}

function parseHeldOutputRequest(row: unknown): HeldOutputRequest | null {
  if (
    !isRecord(row) ||
    typeof row.organisationId !== "string" ||
    typeof row.requestId !== "string" ||
    (row.subject !== "output" && row.subject !== "effect") ||
    !isTextOrNull(row.caseId) ||
    !isTextOrNull(row.connectorId) ||
    !isTextOrNull(row.outputId) ||
    !isTextOrNull(row.channelId) ||
    (row.reason !== "private_source" &&
      row.reason !== "outside_organisation" &&
      row.reason !== "outside_written") ||
    (row.requesterPersonId !== null &&
      typeof row.requesterPersonId !== "string") ||
    typeof row.requestAuthorityJson !== "string" ||
    typeof row.flowLabelJson !== "string" ||
    (row.status !== "pending" &&
      row.status !== "allowed" &&
      row.status !== "denied" &&
      row.status !== "expired") ||
    (row.decidedByUserId !== null && typeof row.decidedByUserId !== "string") ||
    !isNonNegativeInteger(row.createdAt) ||
    (row.decidedAt !== null && !isNonNegativeInteger(row.decidedAt)) ||
    (row.releasedAt !== null && !isNonNegativeInteger(row.releasedAt))
  )
    return null;
  const requestAuthority = parseRequestAuthorityJson(row.requestAuthorityJson);
  if (requestAuthority === null) return null;
  const effect = parseEffect(row);
  if (row.subject === "effect" && effect === null) return null;
  return {
    organisationId: row.organisationId,
    requestId: row.requestId,
    subject: row.subject,
    caseId: row.caseId,
    connectorId: row.connectorId,
    outputId: row.outputId,
    channelId: row.channelId,
    effect,
    reason: row.reason,
    requesterPersonId: row.requesterPersonId,
    requestAuthority,
    flowLabelJson: row.flowLabelJson,
    status: row.status,
    decidedByUserId: row.decidedByUserId,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    releasedAt: row.releasedAt,
  };
}

function parseEffect(row: Record<string, unknown>): HeldEffect | null {
  return typeof row.sessionId === "string" &&
    typeof row.authorityPartitionDigest === "string" &&
    typeof row.capabilityId === "string" &&
    typeof row.integrationAccountId === "string" &&
    typeof row.resourceScope === "string" &&
    (row.consumedAt === null || isNonNegativeInteger(row.consumedAt)) &&
    (row.actionDigest === null) === (row.actionJson === null) &&
    (row.actionDigest === null || typeof row.actionDigest === "string")
    ? {
        sessionId: row.sessionId,
        authorityPartitionDigest: row.authorityPartitionDigest,
        capabilityId: row.capabilityId,
        integrationAccountId: row.integrationAccountId,
        resourceScope: row.resourceScope,
        consumedAt: row.consumedAt,
        action:
          typeof row.actionDigest === "string"
            ? parseAction(row.actionDigest, row.actionJson)
            : null,
      }
    : null;
}

function parseAction(
  digest: string,
  json: unknown,
): NonNullable<HeldEffect["action"]> | null {
  if (typeof json !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const view = parseHeldEffectAction(raw);
  return view === null ? null : { digest, view };
}

function isTextOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function parseRequestAuthorityJson(json: string): RequestAuthority | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = parseStoredRequestAuthority(value);
  return parsed.ok ? parsed.value.requestAuthority : null;
}

/**
 * Whether one Allow covers every call of this effect in one request of the
 * person: true for a board edit (Plan 40B phase 7). Other effects use one
 * pass for each call. The pass and the prompt's text both use this rule.
 */
export function heldEffectCoversRequest(resourceScope: string): boolean {
  return resourceScope.startsWith("menu-board:");
}
