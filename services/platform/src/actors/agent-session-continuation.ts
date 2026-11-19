import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  assertTableExists,
  runSchemaMigrations,
  type SchemaMigrationPlan,
} from "./schema-migrations";
import {
  parseBakeryBrowserContext,
  type BakeryBrowserContext,
} from "@purin-labs/bakery-model/bakery-context";
import {
  parseRequestId,
  parseOrganisationId,
  type RequestId,
  type OrganisationId,
} from "../ids";

export type HarnessTurnContinuation = Readonly<{
  kind: "harness_turn_continuation.v1";
  organisationId: OrganisationId;
  requestId: RequestId;
  turnId: string;
  leaseId: string;
  harnessInstructions: string;
  turnPrompt: string;
  thinkingLevel: "low" | "medium" | "high" | null;
  browserContext: BakeryBrowserContext;
  completion: Readonly<{ completionId: string; acceptedAt: number }>;
  binding: Readonly<{
    instructionDigest: string;
    toolCatalogDigest: string;
    modelRouteDigest: string;
    workspaceRevision: string;
    policyRevision: string;
  }>;
}>;

/**
 * The continuation of the Session's running turn lives in its own table
 * (Refactor 15, refactor 3). It is not effect work: it says that a turn is
 * pending, and the cutover check counts it as a pending turn. It used to
 * share `actor_outbox` with the effects, under one fixed effect id.
 */
const SESSION_TURN_CONTINUATION_PLAN: SchemaMigrationPlan = {
  key: "session_turn_continuation",
  currentVersion: 1,
  preservedTables: [],
  baseline: {
    version: 1,
    apply: createTurnContinuationTable,
    validate: (sql) => assertTableExists(sql, "session_turn_continuation"),
  },
  steps: [],
};

/** Runs after the Session and outbox plans, in the same transaction. */
export function runTurnContinuationSchemaMigrations(sql: SqlStorage): void {
  runSchemaMigrations(sql, SESSION_TURN_CONTINUATION_PLAN, (operation) =>
    operation(),
  );
}

function createTurnContinuationTable(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS session_turn_continuation (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      organisation_id TEXT NOT NULL CHECK (length(organisation_id) > 0),
      turn_id TEXT NOT NULL CHECK (length(turn_id) > 0),
      request_envelope TEXT NOT NULL CHECK (json_valid(request_envelope)),
      state_projection TEXT NOT NULL CHECK (json_valid(state_projection)),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    )`,
  );
  // A Session that ran before this plan keeps its continuation.
  const outbox = sql
    .exec(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'actor_outbox'",
    )
    .toArray();
  if (outbox.length === 0) return;
  sql.exec(
    `INSERT INTO session_turn_continuation (
       singleton, organisation_id, turn_id, request_envelope, state_projection,
       updated_at
     )
     SELECT 1, organisation_id, originating_event_id, request_envelope,
       state_projection, updated_at
     FROM actor_outbox WHERE effect_id = 'harness_turn_continuation'`,
  );
  sql.exec(
    "DELETE FROM actor_outbox WHERE effect_id = 'harness_turn_continuation'",
  );
}

export function discardHarnessTurnContinuation(sql: SqlStorage): void {
  sql.exec("DELETE FROM session_turn_continuation");
}

/** The stored continuation: its request and its recovery phase. */
export function readTurnContinuationRow(
  sql: SqlStorage,
):
  Readonly<{ request_envelope: string; state_projection: string }> | undefined {
  return sql
    .exec<{ request_envelope: string; state_projection: string }>(
      "SELECT request_envelope, state_projection FROM session_turn_continuation",
    )
    .toArray()[0];
}

/** Records the recovery phase of the stored continuation. */
export function setTurnContinuationPhase(
  sql: SqlStorage,
  phase: unknown,
): void {
  sql.exec(
    "UPDATE session_turn_continuation SET state_projection = ?, updated_at = ?",
    JSON.stringify(phase),
    Date.now(),
  );
}

export function writeHarnessTurnContinuation(
  sql: SqlStorage,
  continuation: HarnessTurnContinuation,
): void {
  sql.exec(
    `INSERT INTO session_turn_continuation (
       singleton, organisation_id, turn_id, request_envelope, state_projection,
       updated_at
     )
     VALUES (1, ?, ?, ?, '{"kind":"turn_running"}', ?)
     ON CONFLICT (singleton) DO UPDATE SET
       organisation_id = excluded.organisation_id, turn_id = excluded.turn_id,
       request_envelope = excluded.request_envelope,
       state_projection = excluded.state_projection,
       updated_at = excluded.updated_at`,
    continuation.organisationId,
    continuation.turnId,
    JSON.stringify(continuation),
    Date.now(),
  );
}

export function finishHarnessTurnContinuation(
  sql: SqlStorage,
  turnId: string,
): void {
  sql.exec("DELETE FROM session_turn_continuation WHERE turn_id = ?", turnId);
}

export function parseContinuation(
  raw: unknown,
): HarnessTurnContinuation | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "kind",
      "organisationId",
      "requestId",
      "turnId",
      "leaseId",
      "harnessInstructions",
      "turnPrompt",
      "thinkingLevel",
      "browserContext",
      "completion",
      "binding",
    ]) ||
    raw.kind !== "harness_turn_continuation.v1" ||
    typeof raw.organisationId !== "string" ||
    typeof raw.requestId !== "string"
  )
    return null;
  const organisationId = parseOrganisationId(raw.organisationId);
  const requestId = parseRequestId(raw.requestId);
  const browserContext = parseBakeryBrowserContext(raw.browserContext);
  if (
    !organisationId.ok ||
    !requestId.ok ||
    browserContext === null ||
    typeof raw.turnId !== "string" ||
    typeof raw.leaseId !== "string" ||
    typeof raw.harnessInstructions !== "string" ||
    typeof raw.turnPrompt !== "string" ||
    (raw.thinkingLevel !== null &&
      raw.thinkingLevel !== "low" &&
      raw.thinkingLevel !== "medium" &&
      raw.thinkingLevel !== "high") ||
    !isRecord(raw.completion) ||
    !hasExactKeys(raw.completion, ["completionId", "acceptedAt"]) ||
    typeof raw.completion.completionId !== "string" ||
    typeof raw.completion.acceptedAt !== "number" ||
    !Number.isSafeInteger(raw.completion.acceptedAt) ||
    !isRecord(raw.binding) ||
    !hasExactKeys(raw.binding, [
      "instructionDigest",
      "toolCatalogDigest",
      "modelRouteDigest",
      "workspaceRevision",
      "policyRevision",
    ]) ||
    !digest(raw.binding.instructionDigest) ||
    !digest(raw.binding.toolCatalogDigest) ||
    !digest(raw.binding.modelRouteDigest) ||
    typeof raw.binding.workspaceRevision !== "string" ||
    typeof raw.binding.policyRevision !== "string"
  )
    return null;
  return {
    kind: "harness_turn_continuation.v1",
    organisationId: organisationId.value,
    requestId: requestId.value,
    turnId: raw.turnId,
    leaseId: raw.leaseId,
    harnessInstructions: raw.harnessInstructions,
    turnPrompt: raw.turnPrompt,
    thinkingLevel: raw.thinkingLevel,
    browserContext,
    completion: {
      completionId: raw.completion.completionId,
      acceptedAt: raw.completion.acceptedAt,
    },
    binding: {
      instructionDigest: raw.binding.instructionDigest,
      toolCatalogDigest: raw.binding.toolCatalogDigest,
      modelRouteDigest: raw.binding.modelRouteDigest,
      workspaceRevision: raw.binding.workspaceRevision,
      policyRevision: raw.binding.policyRevision,
    },
  };
}
function digest(raw: unknown): raw is string {
  return typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw);
}
