import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type { OrganisationId } from "../ids";
import type { UserId } from "@purin-labs/control-api/ids";
import type { Result } from "../result";
import type { OrganisationEnvironment } from "./control-plane";
import type { Variant } from "@purin-labs/type-utils";
import type { OrganisationQuerySource } from "./query-source";
import { isRecord, sha256Hex } from "@purin-labs/std";
import { prepareOrganisationControlMutationReceipt as prepareOrganisationReceipt } from "./shared-rows/mutation-receipt";

export {
  prepareControlMutationReceipt,
  prepareControlMutationReceiptAfterWrite,
  prepareControlMutationReceiptCompletion,
  readControlMutationReplay,
} from "./shared-rows/mutation-receipt";

export type ControlMutationBoundary =
  | {
      readonly kind: "unversioned";
      readonly idempotencyKey: string;
      readonly requestHash: string;
    }
  | {
      readonly kind: "configuration_versioned";
      readonly idempotencyKey: string;
      readonly requestHash: string;
      readonly expectedConfigurationVersion: number;
    };

export type UnversionedControlMutationBoundary = Variant<
  ControlMutationBoundary,
  "unversioned"
>;

type ControlMutationBoundaryError =
  | { readonly code: "idempotency_key_missing" }
  | { readonly code: "idempotency_key_invalid" }
  | { readonly code: "configuration_version_missing" }
  | { readonly code: "configuration_version_invalid" };

export type ControlMutationIdentity = {
  readonly receiptId: string;
  readonly auditEventId: string;
  readonly correlationId: string;
  readonly causationId: string;
  readonly portalSubjectHash: string;
  readonly createdAt: number;
};

export type ControlMutationReceiptScope = {
  readonly userId: UserId;
  readonly organisationScope: string;
  readonly route: string;
  readonly operation: string;
};

export type StoredControlMutationReceipt = {
  readonly responseStatus: number;
  readonly responseBody: unknown;
};

export type ControlMutationReplay =
  | { readonly kind: "absent" }
  | { readonly kind: "replay"; readonly receipt: StoredControlMutationReceipt }
  | { readonly kind: "conflict" };

type OnboardingAuditEvidence = {
  readonly organisationId: OrganisationId;
  readonly environment: OrganisationEnvironment;
  readonly actorUserId: UserId;
  readonly operation: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly oldLifecycle: string | null;
  readonly newLifecycle: string | null;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
  readonly reasonCode: string;
};

type OnboardingEventBase = {
  readonly eventId: string;
  readonly organisationId: OrganisationId;
  readonly environment: OrganisationEnvironment;
  readonly projectionRevision: number;
};

type OnboardingEventAttributes = {
  readonly onboarding_started: {
    readonly stage: string;
    readonly receipt_id: string;
  };
  readonly onboarding_resumed:
    | { readonly previous_lifecycle: string; readonly receipt_id: string }
    | {
        readonly activation_attempt_id: string;
        readonly readiness_version: number;
      };
  readonly onboarding_stage_viewed: { readonly stage: string };
  readonly onboarding_stage_completed: {
    readonly stage: string;
    readonly receipt_id: string;
  };
  readonly organisation_created: {
    readonly lifecycle: "configuring";
    readonly receipt_id: string;
  };
  readonly organisation_archived: {
    readonly previous_lifecycle: string;
    readonly receipt_id: string;
  };
  readonly provider_attempt_started: {
    readonly attempt_id: string;
    readonly provider: string;
  };
  readonly provider_attempt_connected: {
    readonly attempt_id: string;
    readonly provider: string;
    readonly connection_id: string;
  };
  readonly provider_attempt_cancelled: {
    readonly attempt_id: string;
    readonly provider: string;
  };
  readonly provider_attempt_failed: {
    readonly attempt_id: string;
    readonly provider: string;
    readonly reason_code: string;
    readonly retryable: boolean;
  };
  readonly provider_attempt_expired: {
    readonly attempt_id: string;
    readonly provider: string;
  };
  readonly provider_reconciliation_started: {
    readonly reconciliation_run_id: string;
    readonly subject_kind: string;
  };
  readonly provider_reconciliation_completed: {
    readonly reconciliation_run_id: string;
    readonly subject_kind: string;
    readonly repair_count: number;
  };
  readonly provider_reconciliation_failed: {
    readonly reconciliation_run_id: string;
    readonly subject_kind: string;
    readonly reason_code: string;
  };
  readonly default_account_changed: {
    readonly provider: string;
    readonly integration_account_id: string;
  };
  readonly setup_saved: {
    readonly capability_profile: string;
    readonly receipt_id: string;
  };
  readonly readiness_assessed: {
    readonly readiness_version: number;
    readonly configuration_version: number;
    readonly result: "ready" | "blocked";
    readonly blocker_count: number;
  };
  readonly readiness_invalidated:
    | { readonly reason_code: string; readonly configuration_version: number }
    | { readonly reason_code: string; readonly integration_account_id: string };
  readonly activation_started: {
    readonly activation_attempt_id: string;
    readonly readiness_version: number;
  };
  readonly activation_phase_completed: {
    readonly activation_attempt_id: string;
    readonly phase: string;
  };
  readonly activation_succeeded: {
    readonly activation_attempt_id: string;
    readonly activation_receipt_id: string;
  };
  readonly activation_failed: {
    readonly activation_attempt_id: string;
    readonly reason_code: string;
    readonly retryable: boolean;
    readonly support_reference: string;
  };
  readonly first_task_presented: {
    readonly activation_receipt_id: string;
    readonly task_kind: string;
  };
  readonly support_reference_created:
    | {
        readonly attempt_id: string;
        readonly provider: string;
        readonly reason_code: string;
        readonly support_reference: string;
      }
    | {
        readonly activation_attempt_id: string;
        readonly reason_code: string;
        readonly support_reference: string;
      };
};

type OnboardingEventEvidence = {
  readonly [
    EventType in keyof OnboardingEventAttributes
  ]: OnboardingEventBase & {
    readonly eventType: EventType;
    readonly attributes: OnboardingEventAttributes[EventType];
  };
}[keyof OnboardingEventAttributes];

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export async function parseControlMutationBoundary(input: {
  readonly request: Request;
  readonly body: Readonly<Record<string, unknown>>;
  readonly requireConfigurationVersion: boolean;
}): Promise<Result<ControlMutationBoundary, ControlMutationBoundaryError>> {
  const idempotencyKey = input.request.headers.get("idempotency-key");
  if (idempotencyKey === null) {
    return { ok: false, error: { code: "idempotency_key_missing" } };
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return { ok: false, error: { code: "idempotency_key_invalid" } };
  }
  const requestHash = await hashCanonicalJson(input.body);
  if (!input.requireConfigurationVersion) {
    return {
      ok: true,
      value: { kind: "unversioned", idempotencyKey, requestHash },
    };
  }
  const versionHeader = input.request.headers.get(
    "x-satyr-configuration-version",
  );
  if (versionHeader === null) {
    return { ok: false, error: { code: "configuration_version_missing" } };
  }
  const expectedConfigurationVersion = Number(versionHeader);
  if (
    !Number.isSafeInteger(expectedConfigurationVersion) ||
    expectedConfigurationVersion < 1
  ) {
    return { ok: false, error: { code: "configuration_version_invalid" } };
  }
  return {
    ok: true,
    value: {
      kind: "configuration_versioned",
      idempotencyKey,
      requestHash,
      expectedConfigurationVersion,
    },
  };
}

export function requireStoredConfigurationVersionedBoundary(input: {
  readonly idempotencyKey: unknown;
  readonly requestHash: unknown;
  readonly expectedConfigurationVersion: unknown;
}): Variant<ControlMutationBoundary, "configuration_versioned"> {
  if (
    typeof input.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    typeof input.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(input.requestHash) ||
    typeof input.expectedConfigurationVersion !== "number" ||
    !Number.isSafeInteger(input.expectedConfigurationVersion) ||
    input.expectedConfigurationVersion < 1
  ) {
    throw new Error("stored control mutation boundary is corrupt");
  }
  return {
    kind: "configuration_versioned",
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    expectedConfigurationVersion: input.expectedConfigurationVersion,
  };
}

export async function hashPortalSubject(
  issuer: string,
  subject: string,
): Promise<string> {
  return sha256Hex(`${issuer}\u0000${subject}`);
}

export function newControlMutationIdentity(input: {
  readonly portalSubjectHash: string;
  readonly causationId: string;
  readonly now: number;
}): ControlMutationIdentity {
  return {
    receiptId: `receipt_${crypto.randomUUID()}`,
    auditEventId: `audit_${crypto.randomUUID()}`,
    correlationId: `correlation_${crypto.randomUUID()}`,
    causationId: input.causationId,
    portalSubjectHash: input.portalSubjectHash,
    createdAt: input.now,
  };
}

/** One receipt of a commerce mutation in the Organisation's database. */
export async function recordOrganisationCommerceMutationReceipt(input: {
  readonly executionScope: OrganisationExecutionScope;
  readonly identity: {
    readonly issuer: string;
    readonly subject: string;
  };
  readonly scope: ControlMutationReceiptScope;
  readonly boundary: UnversionedControlMutationBoundary;
  readonly causationId: string;
  readonly responseBody: unknown;
  readonly responseStatus?: number;
  readonly now: number;
}): Promise<
  Result<null, { readonly code: "organisation_placement_conflict" }>
> {
  const mutationIdentity = newControlMutationIdentity({
    portalSubjectHash: await hashPortalSubject(
      input.identity.issuer,
      input.identity.subject,
    ),
    causationId: input.causationId,
    now: input.now,
  });
  const executionScope = input.executionScope;
  const session = executionScope.database.withSession("first-primary");
  const results = await session.batch([
    prepareOrganisationReceipt(session, {
      executionScope,
      scope: input.scope,
      boundary: input.boundary,
      identity: mutationIdentity,
      responseStatus: input.responseStatus ?? 200,
      responseBody: input.responseBody,
    }),
  ]);
  return results[0]?.meta.changes === 1 && (await executionScope.isActive())
    ? { ok: true, value: null }
    : { ok: false, error: { code: "organisation_placement_conflict" } };
}

export function prepareOnboardingAuditEvent(
  db: OrganisationQuerySource,
  identity: ControlMutationIdentity,
  evidence: OnboardingAuditEvidence,
): D1PreparedStatement {
  return onboardingAuditEventStatement(db, identity, evidence, "");
}

export function prepareOnboardingAuditEventAfterWrite(
  db: OrganisationQuerySource,
  identity: ControlMutationIdentity,
  evidence: OnboardingAuditEvidence,
): D1PreparedStatement {
  return onboardingAuditEventStatement(
    db,
    identity,
    evidence,
    " WHERE changes() = 1",
  );
}

function onboardingAuditEventStatement(
  db: OrganisationQuerySource,
  identity: ControlMutationIdentity,
  evidence: OnboardingAuditEvidence,
  condition: "" | " WHERE changes() = 1",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO onboarding_audit_event (
       audit_event_id, organisation_id, environment, actor_user_id,
       operation, target_kind, target_id, old_lifecycle, new_lifecycle,
       configuration_version, projection_revision, idempotency_receipt_id,
       correlation_id, causation_id, reason_code, occurred_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${condition}`,
    )
    .bind(
      identity.auditEventId,
      evidence.organisationId,
      evidence.environment,
      evidence.actorUserId,
      evidence.operation,
      evidence.targetKind,
      evidence.targetId,
      evidence.oldLifecycle,
      evidence.newLifecycle,
      evidence.configurationVersion,
      evidence.projectionRevision,
      identity.receiptId,
      identity.correlationId,
      identity.causationId,
      evidence.reasonCode,
      identity.createdAt,
    );
}

export function prepareOnboardingEvent(
  db: OrganisationQuerySource,
  identity: ControlMutationIdentity,
  evidence: OnboardingEventEvidence,
): D1PreparedStatement {
  return onboardingEventStatement(db, identity, evidence, "");
}

export function prepareOnboardingEventAfterWrite(
  db: OrganisationQuerySource,
  identity: ControlMutationIdentity,
  evidence: OnboardingEventEvidence,
): D1PreparedStatement {
  return onboardingEventStatement(
    db,
    identity,
    evidence,
    " WHERE changes() = 1",
  );
}

function onboardingEventStatement(
  db: OrganisationQuerySource,
  identity: ControlMutationIdentity,
  evidence: OnboardingEventEvidence,
  condition: "" | " WHERE changes() = 1",
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO onboarding_event (
       event_id, schema_version, event_type, occurred_at, organisation_id, environment,
       portal_subject_hash, correlation_id, causation_id, projection_revision, attributes
     ) SELECT ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?${condition}`,
    )
    .bind(
      evidence.eventId,
      evidence.eventType,
      identity.createdAt,
      evidence.organisationId,
      evidence.environment,
      identity.portalSubjectHash,
      identity.correlationId,
      identity.causationId,
      evidence.projectionRevision,
      JSON.stringify(evidence.attributes),
    );
}

async function hashCanonicalJson(value: unknown): Promise<string> {
  return sha256Hex(canonicalizeJsonValue(value));
}

function canonicalizeJsonValue(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("control mutation body contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeJsonValue).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    const fields: string[] = [];
    for (const key of keys) {
      fields.push(
        `${JSON.stringify(key)}:${canonicalizeJsonValue(value[key])}`,
      );
    }
    return `{${fields.join(",")}}`;
  }
  throw new Error("control mutation body is not JSON");
}
