import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";

import type { CustomConnectorAuthentication } from "./egress";
import type { CredentialVaultBindings } from "@purin-labs/authority/credential-vault/keyring";
import {
  resolveVaultHandle,
  revokeVaultSecret,
  storeVaultSecret,
} from "@purin-labs/authority/credential-vault/service";
import type { VaultHandle, VaultSecret } from "@purin-labs/authority/credential-vault/domain";
import { parseVaultHandle } from "@purin-labs/authority/credential-vault/domain";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type IntegrationAccountId,
  type OrganisationId,
} from "@purin-labs/kernel/ids";
import { parseUserId, type UserId } from "@purin-labs/control-api/ids";
import {
  digestCanonical,
  serializeCanonical,
} from "@purin-labs/authority/policy/information-flow/digest";
import type { Result } from "@purin-labs/kernel/result";
import type {
  CustomConnectorDefinitionV1,
  CustomConnectorOperation,
  JsonObject,
  JsonValue,
} from "./definition";
import {
  newCustomConnectorSetupAttemptId,
  parseCustomConnectorDefinitionDigest,
  parseCustomConnectorId,
  parseCustomConnectorRevision,
  parseCustomConnectorSetupAttemptId,
  type CustomConnectorDefinitionDigest,
  type CustomConnectorId,
  type CustomConnectorRevision,
  type CustomConnectorSetupAttemptId,
} from "@purin-labs/connections/custom-connectors/identity";
import { resolveCustomConnectorRevision } from "./revisions";
import type { ChatConnectorSetup } from "@purin-labs/area-integrations-contract/server/custom-connector-chat";
import {
  customConnectorSetupLifecycleAllows,
  parseCustomConnectorSetupAccountLifecycle,
} from "./setup-target";

const CUSTOM_CONNECTOR_SETUP_TTL_MS = 30 * 60 * 1_000;
const MAX_CREDENTIAL_CHARACTERS = 16 * 1024;
const MAX_TEST_PREVIEW_BYTES = 8 * 1024;
const authorizedSetupCommitBrand: unique symbol = Symbol(
  "AuthorizedCustomConnectorSetupCommit",
);

export type CustomConnectorIdentityTestRequest = {
  readonly organisationId: OrganisationId;
  readonly origin: string;
  readonly authentication: CustomConnectorAuthentication;
  readonly operation: CustomConnectorOperation;
  readonly arguments: JsonObject;
  readonly accountIdPointer: string;
  readonly displayNamePointer: string;
  readonly limits: CustomConnectorDefinitionV1["limits"];
};

export type CustomConnectorIdentityTestResult = {
  readonly providerAccountId: string;
  readonly displayName: string;
  readonly preview: JsonValue;
};

export type CustomConnectorIdentityTestExecutor = (
  request: CustomConnectorIdentityTestRequest,
) => Promise<
  Result<
    CustomConnectorIdentityTestResult,
    { readonly code: string; readonly correlationId: string }
  >
>;

type CustomConnectorVerification = {
  readonly providerAccountId: string;
  readonly displayName: string;
  readonly resultSchemaDigest: string;
  readonly testedAt: number;
};

export type CustomConnectorSetupTarget =
  | Readonly<{
      readonly kind: "new_account";
      readonly environment: OrganisationEnvironment;
      readonly integrationAccountId?: never;
      readonly expectedBindingRevision?: never;
    }>
  | Readonly<{
      readonly kind: "rotate_account" | "upgrade_account" | "resume_account";
      readonly integrationAccountId: IntegrationAccountId;
      readonly expectedBindingRevision: number;
      readonly environment?: never;
    }>;

type SetupAttemptBase = {
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
  readonly connectorId: CustomConnectorId;
  readonly connectorRevision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly environment: OrganisationEnvironment;
  readonly target: CustomConnectorSetupTarget;
  readonly attemptRevision: number;
  readonly createdByUserId: UserId;
  readonly expiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type CustomConnectorSetupAttempt =
  | (SetupAttemptBase & {
      readonly lifecycle: "awaiting_credential";
      readonly candidateGeneration: 0;
      readonly testStartedAt?: never;
      readonly verification?: never;
      readonly failure?: never;
      readonly completedAt?: never;
      readonly committedIntegrationAccountId?: never;
      readonly cancelledByUserId?: never;
    })
  | (SetupAttemptBase & {
      readonly lifecycle: "credential_stored";
      readonly candidateGeneration: 1;
      readonly testStartedAt?: never;
      readonly verification?: never;
      readonly failure?: never;
      readonly completedAt?: never;
      readonly committedIntegrationAccountId?: never;
      readonly cancelledByUserId?: never;
    })
  | (SetupAttemptBase & {
      readonly lifecycle: "testing";
      readonly candidateGeneration: 1;
      readonly testStartedAt: number;
      readonly verification?: never;
      readonly failure?: never;
      readonly completedAt?: never;
      readonly committedIntegrationAccountId?: never;
      readonly cancelledByUserId?: never;
    })
  | (SetupAttemptBase & {
      readonly lifecycle: "verified";
      readonly candidateGeneration: 1;
      readonly testStartedAt: number;
      readonly verification: CustomConnectorVerification;
      readonly failure?: never;
      readonly completedAt?: never;
      readonly committedIntegrationAccountId?: never;
      readonly cancelledByUserId?: never;
    })
  | (SetupAttemptBase & {
      readonly lifecycle: "committed";
      readonly candidateGeneration: 1;
      readonly testStartedAt: number;
      readonly verification: CustomConnectorVerification;
      readonly committedIntegrationAccountId: IntegrationAccountId;
      readonly completedAt: number;
      readonly failure?: never;
      readonly cancelledByUserId?: never;
    })
  | (SetupAttemptBase & {
      readonly lifecycle: "failed";
      readonly candidateGeneration: 1;
      readonly failure: {
        readonly code: string;
        readonly correlationId: string;
      };
      readonly completedAt: number;
      readonly testStartedAt?: never;
      readonly verification?: never;
      readonly committedIntegrationAccountId?: never;
      readonly cancelledByUserId?: never;
    })
  | (SetupAttemptBase & {
      readonly lifecycle: "cancelled";
      readonly candidateGeneration: 0 | 1;
      readonly cancelledByUserId: UserId;
      readonly completedAt: number;
      readonly testStartedAt?: never;
      readonly verification?: never;
      readonly failure?: never;
      readonly committedIntegrationAccountId?: never;
    })
  | (SetupAttemptBase & {
      readonly lifecycle: "expired";
      readonly candidateGeneration: 0 | 1;
      readonly completedAt: number;
      readonly testStartedAt?: never;
      readonly verification?: never;
      readonly failure?: never;
      readonly committedIntegrationAccountId?: never;
      readonly cancelledByUserId?: never;
    });

type CustomConnectorSetupError =
  | { readonly code: "custom_connector_revision_not_available" }
  | { readonly code: "custom_connector_account_not_available" }
  | { readonly code: "custom_connector_account_identity_mismatch" }
  | { readonly code: "custom_connector_setup_not_found" }
  | { readonly code: "custom_connector_setup_conflict" }
  | { readonly code: "custom_connector_setup_expired" }
  | { readonly code: "custom_connector_credential_invalid" }
  | { readonly code: "custom_connector_vault_unavailable" }
  | { readonly code: "custom_connector_test_result_invalid" }
  | {
      readonly code: "custom_connector_identity_test_failed";
      readonly reasonCode: string;
      readonly correlationId: string;
    }
  | {
      readonly code: "custom_connector_setup_persistence_corrupt";
      readonly field: string;
    };

type ExistingSetupTargetState = Readonly<{
  readonly integrationAccountId: IntegrationAccountId;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly bindingRevision: number;
  readonly credentialGeneration: number;
}>;

type ResolvedSetupTarget = Readonly<{
  readonly environment: OrganisationEnvironment;
  readonly integrationAccountId: IntegrationAccountId | null;
  readonly expectedBindingRevision: number | null;
  readonly existing: ExistingSetupTargetState | null;
}>;

type ExistingSetupTargetRow = {
  accountLifecycle: unknown;
  connectionLifecycle: unknown;
  bindingLifecycle: unknown;
  connectorLifecycle: unknown;
  environment: unknown;
  providerAccountId: unknown;
  bindingRevision: unknown;
  credentialGeneration: unknown;
  acceptedRevision: unknown;
  definitionDigest: unknown;
};

type TestedCustomConnectorSetup = {
  readonly attempt: VariantBy<
    CustomConnectorSetupAttempt,
    "lifecycle",
    "verified"
  >;
  readonly preview: JsonValue;
};

export type AuthorizedCustomConnectorSetupCommit = {
  readonly [authorizedSetupCommitBrand]: "AuthorizedCustomConnectorSetupCommit";
  readonly attempt: VariantBy<
    CustomConnectorSetupAttempt,
    "lifecycle",
    "verified"
  >;
  readonly definition: CustomConnectorDefinitionV1;
  readonly candidateCredentialRef: VaultHandle;
};

type SetupAttemptRow = {
  organisationId: unknown;
  attemptId: unknown;
  connectorId: unknown;
  connectorRevision: unknown;
  definitionDigest: unknown;
  environment: unknown;
  targetKind: unknown;
  targetIntegrationAccountId: unknown;
  expectedBindingRevision: unknown;
  lifecycle: unknown;
  attemptRevision: unknown;
  candidateGeneration: unknown;
  candidateCredentialRef: unknown;
  testedCandidateGeneration: unknown;
  testStartedAt: unknown;
  verifiedProviderAccountId: unknown;
  verifiedDisplayName: unknown;
  resultSchemaDigest: unknown;
  testedAt: unknown;
  committedIntegrationAccountId: unknown;
  cancelledByUserId: unknown;
  failureCode: unknown;
  failureCorrelationId: unknown;
  createdByUserId: unknown;
  expiresAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  completedAt: unknown;
};

type ParsedSetupAttemptRow = {
  readonly projection: CustomConnectorSetupAttempt;
  readonly candidateCredentialRef: VaultHandle | null;
};

const SETUP_ATTEMPT_SELECT = `SELECT
  organisation_id AS organisationId,
  attempt_id AS attemptId,
  connector_id AS connectorId,
  connector_revision AS connectorRevision,
  definition_digest AS definitionDigest,
  environment,
  target_kind AS targetKind,
  target_integration_account_id AS targetIntegrationAccountId,
  expected_binding_revision AS expectedBindingRevision,
  lifecycle,
  attempt_revision AS attemptRevision,
  candidate_generation AS candidateGeneration,
  candidate_credential_ref AS candidateCredentialRef,
  tested_candidate_generation AS testedCandidateGeneration,
  test_started_at AS testStartedAt,
  verified_provider_account_id AS verifiedProviderAccountId,
  verified_display_name AS verifiedDisplayName,
  result_schema_digest AS resultSchemaDigest,
  tested_at AS testedAt,
  committed_integration_account_id AS committedIntegrationAccountId,
  cancelled_by_user_id AS cancelledByUserId,
  failure_code AS failureCode,
  failure_correlation_id AS failureCorrelationId,
  created_by_user_id AS createdByUserId,
  expires_at AS expiresAt,
  created_at AS createdAt,
  updated_at AS updatedAt,
  completed_at AS completedAt
FROM custom_connector_setup_attempt`;

export async function startCustomConnectorSetup(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly connectorRevision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly target: CustomConnectorSetupTarget;
  readonly createdByUserId: UserId;
  readonly now: number;
}): Promise<Result<CustomConnectorSetupAttempt, CustomConnectorSetupError>> {
  const definition = await resolveSetupDefinition(input);
  if (!definition.ok) return definition;
  const target = await resolveSetupTargetAtStart(input);
  if (!target.ok) return target;
  const attemptId = newCustomConnectorSetupAttemptId();
  const expiresAt = input.now + CUSTOM_CONNECTOR_SETUP_TTL_MS;
  try {
    await input.db
      .prepare(
        `INSERT INTO custom_connector_setup_attempt (
           organisation_id, attempt_id, connector_id, connector_revision,
           definition_digest, environment, target_kind, lifecycle,
           target_integration_account_id, expected_binding_revision,
           attempt_revision, candidate_generation,
           created_by_user_id, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_credential', ?, ?,
                   1, 0, ?, ?, ?, ?)`,
      )
      .bind(
        input.organisationId,
        attemptId,
        input.connectorId,
        input.connectorRevision,
        input.definitionDigest,
        target.value.environment,
        input.target.kind,
        target.value.integrationAccountId,
        target.value.expectedBindingRevision,
        input.createdByUserId,
        expiresAt,
        input.now,
        input.now,
      )
      .run();
  } catch {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  return resolveCustomConnectorSetupAttempt({
    db: input.db,
    organisationId: input.organisationId,
    attemptId,
  });
}

async function resolveSetupTargetAtStart(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly connectorRevision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly target: CustomConnectorSetupTarget;
}): Promise<Result<ResolvedSetupTarget, CustomConnectorSetupError>> {
  if (input.target.kind === "new_account") {
    return {
      ok: true,
      value: {
        environment: input.target.environment,
        integrationAccountId: null,
        expectedBindingRevision: null,
        existing: null,
      },
    };
  }
  if (
    !Number.isSafeInteger(input.target.expectedBindingRevision) ||
    input.target.expectedBindingRevision <= 0
  ) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const existing = await readExistingSetupTarget({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: input.connectorId,
    connectorRevision: input.connectorRevision,
    definitionDigest: input.definitionDigest,
    target: input.target,
  });
  return existing.ok
    ? {
        ok: true,
        value: {
          environment: existing.value.environment,
          integrationAccountId: existing.value.integrationAccountId,
          expectedBindingRevision: existing.value.bindingRevision,
          existing: existing.value,
        },
      }
    : existing;
}

async function validateCurrentSetupTarget(
  db: Pick<OrganisationDatabase, "prepare">,
  attempt: CustomConnectorSetupAttempt,
): Promise<Result<ResolvedSetupTarget, CustomConnectorSetupError>> {
  if (attempt.target.kind === "new_account") {
    return {
      ok: true,
      value: {
        environment: attempt.environment,
        integrationAccountId: null,
        expectedBindingRevision: null,
        existing: null,
      },
    };
  }
  return resolveSetupTargetAtStart({
    db,
    organisationId: attempt.organisationId,
    connectorId: attempt.connectorId,
    connectorRevision: attempt.connectorRevision,
    definitionDigest: attempt.definitionDigest,
    target: attempt.target,
  });
}

async function readExistingSetupTarget(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly connectorRevision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
  readonly target: Exclude<CustomConnectorSetupTarget, { kind: "new_account" }>;
}): Promise<Result<ExistingSetupTargetState, CustomConnectorSetupError>> {
  const row = await input.db
    .prepare(
      `SELECT
         account.lifecycle AS accountLifecycle,
         connection.lifecycle AS connectionLifecycle,
         binding.lifecycle AS bindingLifecycle,
         connector.lifecycle AS connectorLifecycle,
         account.environment,
         binding.provider_account_id AS providerAccountId,
         binding.binding_revision AS bindingRevision,
         binding.credential_generation AS credentialGeneration,
         binding.accepted_revision AS acceptedRevision,
         binding.accepted_definition_digest AS definitionDigest
       FROM integration_account AS account
       JOIN provider_connection AS connection
         ON connection.organisation_id = account.organisation_id
        AND connection.provider_connection_id = account.provider_connection_id
        AND connection.source_kind = 'custom_api'
        AND connection.custom_connector_id = account.custom_connector_id
       JOIN custom_connector_account_binding AS binding
         ON binding.organisation_id = account.organisation_id
        AND binding.integration_account_id = account.integration_account_id
        AND binding.connector_id = account.custom_connector_id
       JOIN custom_connector AS connector
         ON connector.organisation_id = binding.organisation_id
        AND connector.connector_id = binding.connector_id
       WHERE account.organisation_id = ? AND account.integration_account_id = ?
         AND account.source_kind = 'custom_api' AND account.custom_connector_id = ?
       LIMIT 1`,
    )
    .bind(input.organisationId, input.target.integrationAccountId, input.connectorId)
    .first<ExistingSetupTargetRow>();
  if (row === null) {
    return {
      ok: false,
      error: { code: "custom_connector_account_not_available" },
    };
  }
  const environment = parseEnvironment(row.environment);
  const acceptedRevision = parseCustomConnectorRevision(row.acceptedRevision);
  const definitionDigest = parseCustomConnectorDefinitionDigest(
    row.definitionDigest,
  );
  if (
    environment === null ||
    typeof row.providerAccountId !== "string" ||
    !isPositiveInteger(row.bindingRevision) ||
    !isPositiveInteger(row.credentialGeneration) ||
    !acceptedRevision.ok ||
    !definitionDigest.ok
  ) {
    return setupCorrupt("targetAccount");
  }
  if (row.bindingRevision !== input.target.expectedBindingRevision) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const lifecycle = parseCustomConnectorSetupAccountLifecycle({
    account: row.accountLifecycle,
    connection: row.connectionLifecycle,
    binding: row.bindingLifecycle,
  });
  if (
    lifecycle === null ||
    row.connectorLifecycle !== "active" ||
    !customConnectorSetupLifecycleAllows(input.target.kind, lifecycle) ||
    !setupTargetRevisionMatches(
      input.target.kind,
      acceptedRevision.value,
      definitionDigest.value,
      input.connectorRevision,
      input.definitionDigest,
    )
  ) {
    return {
      ok: false,
      error: { code: "custom_connector_account_not_available" },
    };
  }
  return {
    ok: true,
    value: {
      integrationAccountId: input.target.integrationAccountId,
      environment,
      providerAccountId: row.providerAccountId,
      bindingRevision: row.bindingRevision,
      credentialGeneration: row.credentialGeneration,
    },
  };
}

function setupTargetRevisionMatches(
  kind: Exclude<CustomConnectorSetupTarget["kind"], "new_account">,
  acceptedRevision: CustomConnectorRevision,
  acceptedDigest: CustomConnectorDefinitionDigest,
  requestedRevision: CustomConnectorRevision,
  requestedDigest: CustomConnectorDefinitionDigest,
): boolean {
  if (kind === "upgrade_account") {
    return requestedRevision !== acceptedRevision;
  }
  return (
    requestedRevision === acceptedRevision && requestedDigest === acceptedDigest
  );
}

export async function attachCustomConnectorCandidateCredential(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
  readonly expectedAttemptRevision: number;
  readonly credentialValue: unknown;
  readonly now: number;
}): Promise<Result<CustomConnectorSetupAttempt, CustomConnectorSetupError>> {
  const current = await readUsableSetupAttempt(input);
  if (!current.ok) return current;
  if (
    current.value.projection.lifecycle !== "awaiting_credential" ||
    current.value.projection.attemptRevision !== input.expectedAttemptRevision
  ) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const target = await validateCurrentSetupTarget(
    input.db,
    current.value.projection,
  );
  if (!target.ok) return target;
  const credentialValue = parseCredentialValue(input.credentialValue);
  if (!credentialValue.ok) return credentialValue;
  const definition = await resolveSetupDefinition({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: current.value.projection.connectorId,
    connectorRevision: current.value.projection.connectorRevision,
    definitionDigest: current.value.projection.definitionDigest,
  });
  if (!definition.ok) return definition;
  const handle = newCandidateVaultHandle();
  const secret = buildCandidateVaultSecret(
    definition.value.authentication,
    credentialValue.value,
  );
  if (secret === null)
    return {
      ok: false,
      error: { code: "custom_connector_credential_invalid" },
    };
  const stored = await storeVaultSecret({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle,
    secret,
    now: input.now,
  });
  if (!stored.ok) {
    return { ok: false, error: { code: "custom_connector_vault_unavailable" } };
  }

  const updated = await input.db
    .prepare(
      `UPDATE custom_connector_setup_attempt
       SET lifecycle = 'credential_stored', attempt_revision = attempt_revision + 1,
           candidate_generation = 1, candidate_credential_ref = ?, updated_at = ?
       WHERE organisation_id = ? AND attempt_id = ?
         AND lifecycle = 'awaiting_credential' AND attempt_revision = ?
         AND expires_at > ?`,
    )
    .bind(
      handle,
      input.now,
      input.organisationId,
      input.attemptId,
      input.expectedAttemptRevision,
      input.now,
    )
    .run();
  if (updated.meta.changes !== 1) {
    await revokeVaultSecret({
      db: input.db,
      organisationId: input.organisationId,
      handle,
      now: input.now,
    });
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  return resolveCustomConnectorSetupAttempt(input);
}

export async function testCustomConnectorCandidate(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
  readonly expectedAttemptRevision: number;
  readonly executor: CustomConnectorIdentityTestExecutor;
  readonly now: number;
}): Promise<Result<TestedCustomConnectorSetup, CustomConnectorSetupError>> {
  const current = await readUsableSetupAttempt(input);
  if (!current.ok) return current;
  if (
    (current.value.projection.lifecycle !== "credential_stored" &&
      current.value.projection.lifecycle !== "verified") ||
    current.value.projection.attemptRevision !==
      input.expectedAttemptRevision ||
    current.value.candidateCredentialRef === null
  ) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const target = await validateCurrentSetupTarget(
    input.db,
    current.value.projection,
  );
  if (!target.ok) return target;
  const definition = await resolveSetupDefinition({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: current.value.projection.connectorId,
    connectorRevision: current.value.projection.connectorRevision,
    definitionDigest: current.value.projection.definitionDigest,
  });
  if (!definition.ok) return definition;

  const reservedRevision = input.expectedAttemptRevision + 1;
  const reserved = await input.db
    .prepare(
      `UPDATE custom_connector_setup_attempt
       SET lifecycle = 'testing', attempt_revision = ?,
           tested_candidate_generation = candidate_generation,
           test_started_at = ?, verified_provider_account_id = NULL,
           verified_display_name = NULL, result_schema_digest = NULL,
           tested_at = NULL, updated_at = ?
       WHERE organisation_id = ? AND attempt_id = ? AND attempt_revision = ?
         AND lifecycle IN ('credential_stored', 'verified') AND expires_at > ?`,
    )
    .bind(
      reservedRevision,
      input.now,
      input.now,
      input.organisationId,
      input.attemptId,
      input.expectedAttemptRevision,
      input.now,
    )
    .run();
  if (reserved.meta.changes !== 1) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }

  const credential = await resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: current.value.candidateCredentialRef,
  });
  if (!credential.ok) {
    return failIdentityTest({
      ...input,
      reservedRevision,
      handle: current.value.candidateCredentialRef,
      reasonCode: "credential_unavailable",
      correlationId: `custom_connector_test_${crypto.randomUUID()}`,
    });
  }
  const authentication = parseCandidateAuthentication(
    definition.value.authentication,
    credential.value,
  );
  if (!authentication.ok) {
    return failIdentityTest({
      ...input,
      reservedRevision,
      handle: current.value.candidateCredentialRef,
      reasonCode: "credential_shape_mismatch",
      correlationId: `custom_connector_test_${crypto.randomUUID()}`,
    });
  }
  const identityOperation = findIdentityOperation(definition.value);
  const tested = await executeIdentityTest(input.executor, {
    organisationId: input.organisationId,
    origin: definition.value.origin,
    authentication: authentication.value,
    operation: identityOperation,
    arguments: definition.value.identity.arguments,
    accountIdPointer: definition.value.identity.accountIdPointer,
    displayNamePointer: definition.value.identity.displayNamePointer,
    limits: definition.value.limits,
  });
  if (!tested.ok) {
    return failIdentityTest({
      ...input,
      reservedRevision,
      handle: current.value.candidateCredentialRef,
      reasonCode: tested.error.code,
      correlationId: tested.error.correlationId,
    });
  }
  if (!isValidIdentityTestResult(tested.value)) {
    return failIdentityTest({
      ...input,
      reservedRevision,
      handle: current.value.candidateCredentialRef,
      reasonCode: "invalid_test_result",
      correlationId: `custom_connector_test_${crypto.randomUUID()}`,
    });
  }
  if (
    target.value.existing !== null &&
    target.value.existing.providerAccountId !== tested.value.providerAccountId
  ) {
    await failIdentityTest({
      ...input,
      reservedRevision,
      handle: current.value.candidateCredentialRef,
      reasonCode: "account_identity_mismatch",
      correlationId: `custom_connector_test_${crypto.randomUUID()}`,
    });
    return {
      ok: false,
      error: { code: "custom_connector_account_identity_mismatch" },
    };
  }

  const currentDefinition = await resolveSetupDefinition({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: current.value.projection.connectorId,
    connectorRevision: current.value.projection.connectorRevision,
    definitionDigest: current.value.projection.definitionDigest,
  });
  if (!currentDefinition.ok) {
    return failIdentityTest({
      ...input,
      reservedRevision,
      handle: current.value.candidateCredentialRef,
      reasonCode: "revision_unavailable",
      correlationId: `custom_connector_test_${crypto.randomUUID()}`,
    });
  }

  const resultSchemaDigest = await digestCanonical(
    identityOperation.response.outputSchema,
  );
  const completedRevision = reservedRevision + 1;
  const completed = await input.db
    .prepare(
      `UPDATE custom_connector_setup_attempt
       SET lifecycle = 'verified', attempt_revision = ?,
           verified_provider_account_id = ?, verified_display_name = ?,
           result_schema_digest = ?, tested_at = ?, updated_at = ?
       WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'testing'
         AND attempt_revision = ? AND candidate_generation = 1
         AND definition_digest = ? AND expires_at > ?`,
    )
    .bind(
      completedRevision,
      tested.value.providerAccountId,
      tested.value.displayName,
      resultSchemaDigest,
      input.now,
      input.now,
      input.organisationId,
      input.attemptId,
      reservedRevision,
      current.value.projection.definitionDigest,
      input.now,
    )
    .run();
  if (completed.meta.changes !== 1) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const attempt = await resolveCustomConnectorSetupAttempt(input);
  if (!attempt.ok) return attempt;
  if (attempt.value.lifecycle !== "verified") {
    return setupCorrupt("lifecycle");
  }
  return {
    ok: true,
    value: { attempt: attempt.value, preview: tested.value.preview },
  };
}

export async function cancelCustomConnectorSetup(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
  readonly expectedAttemptRevision: number;
  readonly cancelledByUserId: UserId;
  readonly now: number;
}): Promise<Result<CustomConnectorSetupAttempt, CustomConnectorSetupError>> {
  const current = await readSetupAttemptRow(input);
  if (!current.ok) return current;
  if (
    isTerminalLifecycle(current.value.projection.lifecycle) ||
    current.value.projection.attemptRevision !== input.expectedAttemptRevision
  ) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const updated = await input.db
    .prepare(
      `UPDATE custom_connector_setup_attempt
       SET lifecycle = 'cancelled', attempt_revision = attempt_revision + 1,
           cancelled_by_user_id = ?, completed_at = ?, updated_at = ?,
           tested_candidate_generation = NULL, test_started_at = NULL,
           verified_provider_account_id = NULL, verified_display_name = NULL,
           result_schema_digest = NULL, tested_at = NULL
       WHERE organisation_id = ? AND attempt_id = ? AND attempt_revision = ?
         AND lifecycle IN ('awaiting_credential', 'credential_stored', 'testing', 'verified')`,
    )
    .bind(
      input.cancelledByUserId,
      input.now,
      input.now,
      input.organisationId,
      input.attemptId,
      input.expectedAttemptRevision,
    )
    .run();
  if (updated.meta.changes !== 1) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  if (current.value.candidateCredentialRef !== null) {
    await revokeVaultSecret({
      db: input.db,
      organisationId: input.organisationId,
      handle: current.value.candidateCredentialRef,
      now: input.now,
    });
  }
  return resolveCustomConnectorSetupAttempt(input);
}

export async function authorizeCustomConnectorSetupCommit(input: {
  readonly db: OrganisationDatabase;
  readonly keys: CredentialVaultBindings;
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
  readonly expectedAttemptRevision: number;
  readonly now: number;
}): Promise<
  Result<AuthorizedCustomConnectorSetupCommit, CustomConnectorSetupError>
> {
  const current = await readUsableSetupAttempt(input);
  if (!current.ok) return current;
  if (
    current.value.projection.lifecycle !== "verified" ||
    current.value.projection.attemptRevision !==
      input.expectedAttemptRevision ||
    current.value.candidateCredentialRef === null
  ) {
    return { ok: false, error: { code: "custom_connector_setup_conflict" } };
  }
  const target = await validateCurrentSetupTarget(
    input.db,
    current.value.projection,
  );
  if (!target.ok) return target;
  const revision = await resolveCustomConnectorRevision({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: current.value.projection.connectorId,
    revision: current.value.projection.connectorRevision,
  });
  if (
    !revision.ok ||
    revision.value.reviewState !== "approved" ||
    revision.value.definitionDigest !==
      current.value.projection.definitionDigest
  ) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_not_available" },
    };
  }
  const parent = await input.db
    .prepare(
      `SELECT lifecycle FROM custom_connector
       WHERE organisation_id = ? AND connector_id = ?`,
    )
    .bind(input.organisationId, current.value.projection.connectorId)
    .first<{ lifecycle: unknown }>();
  if (
    parent === null ||
    (parent.lifecycle !== "draft" && parent.lifecycle !== "active")
  ) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_not_available" },
    };
  }
  const credential = await resolveVaultHandle({
    db: input.db,
    keys: input.keys,
    organisationId: input.organisationId,
    handle: current.value.candidateCredentialRef,
  });
  if (
    !credential.ok ||
    !parseCandidateAuthentication(
      revision.value.definition.authentication,
      credential.value,
    ).ok
  ) {
    return { ok: false, error: { code: "custom_connector_vault_unavailable" } };
  }
  return {
    ok: true,
    value: {
      [authorizedSetupCommitBrand]: "AuthorizedCustomConnectorSetupCommit",
      attempt: current.value.projection,
      definition: revision.value.definition,
      candidateCredentialRef: current.value.candidateCredentialRef,
    },
  };
}

/** The state of a setup attempt that the chat prompt shows, or null. */
export async function readChatConnectorSetup(
  input: Parameters<typeof resolveCustomConnectorSetupAttempt>[0],
): Promise<ChatConnectorSetup | null> {
  const result = await resolveCustomConnectorSetupAttempt(input);
  if (!result.ok) return null;
  const attempt = result.value;
  return {
    connectorId: attempt.connectorId,
    revision: attempt.connectorRevision,
    state: attempt.lifecycle,
    failure: attempt.lifecycle === "failed" ? attempt.failure : null,
  };
}

export async function resolveCustomConnectorSetupAttempt(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
}): Promise<Result<CustomConnectorSetupAttempt, CustomConnectorSetupError>> {
  const parsed = await readSetupAttemptRow(input);
  return parsed.ok ? { ok: true, value: parsed.value.projection } : parsed;
}

async function resolveSetupDefinition(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly connectorId: CustomConnectorId;
  readonly connectorRevision: CustomConnectorRevision;
  readonly definitionDigest: CustomConnectorDefinitionDigest;
}): Promise<Result<CustomConnectorDefinitionV1, CustomConnectorSetupError>> {
  const revision = await resolveCustomConnectorRevision({
    db: input.db,
    organisationId: input.organisationId,
    connectorId: input.connectorId,
    revision: input.connectorRevision,
  });
  if (
    !revision.ok ||
    (revision.value.reviewState !== "validated" &&
      revision.value.reviewState !== "approved") ||
    revision.value.definitionDigest !== input.definitionDigest
  ) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_not_available" },
    };
  }
  const parent = await input.db
    .prepare(
      `SELECT lifecycle FROM custom_connector
       WHERE organisation_id = ? AND connector_id = ?`,
    )
    .bind(input.organisationId, input.connectorId)
    .first<{ lifecycle: unknown }>();
  if (
    parent === null ||
    (parent.lifecycle !== "draft" && parent.lifecycle !== "active")
  ) {
    return {
      ok: false,
      error: { code: "custom_connector_revision_not_available" },
    };
  }
  return { ok: true, value: revision.value.definition };
}

async function executeIdentityTest(
  executor: CustomConnectorIdentityTestExecutor,
  request: CustomConnectorIdentityTestRequest,
): ReturnType<CustomConnectorIdentityTestExecutor> {
  try {
    return await executor(request);
  } catch {
    return {
      ok: false,
      error: {
        code: "executor_unavailable",
        correlationId: `custom_connector_test_${crypto.randomUUID()}`,
      },
    };
  }
}

async function readUsableSetupAttempt(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
  readonly now: number;
}): Promise<Result<ParsedSetupAttemptRow, CustomConnectorSetupError>> {
  const current = await readSetupAttemptRow(input);
  if (!current.ok) return current;
  if (
    !isTerminalLifecycle(current.value.projection.lifecycle) &&
    input.now >= current.value.projection.expiresAt
  ) {
    await expireSetupAttempt(input, current.value);
    return { ok: false, error: { code: "custom_connector_setup_expired" } };
  }
  return current;
}

async function expireSetupAttempt(
  input: {
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly attemptId: CustomConnectorSetupAttemptId;
    readonly now: number;
  },
  current: ParsedSetupAttemptRow,
): Promise<void> {
  await input.db
    .prepare(
      `UPDATE custom_connector_setup_attempt
       SET lifecycle = 'expired', attempt_revision = attempt_revision + 1,
           completed_at = ?, updated_at = ?, tested_candidate_generation = NULL,
           test_started_at = NULL, verified_provider_account_id = NULL,
           verified_display_name = NULL, result_schema_digest = NULL, tested_at = NULL
       WHERE organisation_id = ? AND attempt_id = ? AND attempt_revision = ?
         AND lifecycle IN ('awaiting_credential', 'credential_stored', 'testing', 'verified')`,
    )
    .bind(
      input.now,
      input.now,
      input.organisationId,
      input.attemptId,
      current.projection.attemptRevision,
    )
    .run();
  if (current.candidateCredentialRef !== null) {
    await revokeVaultSecret({
      db: input.db,
      organisationId: input.organisationId,
      handle: current.candidateCredentialRef,
      now: input.now,
    });
  }
}

async function failIdentityTest(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
  readonly reservedRevision: number;
  readonly handle: VaultHandle;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly now: number;
}): Promise<Result<never, CustomConnectorSetupError>> {
  await input.db
    .prepare(
      `UPDATE custom_connector_setup_attempt
       SET lifecycle = 'failed', attempt_revision = attempt_revision + 1,
           failure_code = ?, failure_correlation_id = ?,
           completed_at = ?, updated_at = ?, tested_candidate_generation = NULL,
           test_started_at = NULL, verified_provider_account_id = NULL,
           verified_display_name = NULL, result_schema_digest = NULL, tested_at = NULL
       WHERE organisation_id = ? AND attempt_id = ? AND lifecycle = 'testing'
         AND attempt_revision = ?`,
    )
    .bind(
      boundedFailureCode(input.reasonCode),
      input.correlationId,
      input.now,
      input.now,
      input.organisationId,
      input.attemptId,
      input.reservedRevision,
    )
    .run();
  await revokeVaultSecret({
    db: input.db,
    organisationId: input.organisationId,
    handle: input.handle,
    now: input.now,
  });
  return {
    ok: false,
    error: {
      code: "custom_connector_identity_test_failed",
      reasonCode: boundedFailureCode(input.reasonCode),
      correlationId: input.correlationId,
    },
  };
}

async function readSetupAttemptRow(input: {
  readonly db: Pick<OrganisationDatabase, "prepare">;
  readonly organisationId: OrganisationId;
  readonly attemptId: CustomConnectorSetupAttemptId;
}): Promise<Result<ParsedSetupAttemptRow, CustomConnectorSetupError>> {
  const row = await input.db
    .prepare(`${SETUP_ATTEMPT_SELECT} WHERE organisation_id = ? AND attempt_id = ?`)
    .bind(input.organisationId, input.attemptId)
    .first<SetupAttemptRow>();
  return row === null
    ? { ok: false, error: { code: "custom_connector_setup_not_found" } }
    : parseSetupAttemptRow(row);
}

function parseSetupAttemptRow(
  row: SetupAttemptRow,
): Result<ParsedSetupAttemptRow, CustomConnectorSetupError> {
  const base = parseSetupAttemptBase(row);
  if (!base.ok) return base;
  const credentialRef = parseNullableVaultHandle(row.candidateCredentialRef);
  if (!credentialRef.ok) return credentialRef;
  const candidateGeneration = parseCandidateGeneration(row.candidateGeneration);
  if (candidateGeneration === null) return setupCorrupt("candidateGeneration");
  switch (row.lifecycle) {
    case "awaiting_credential":
      if (candidateGeneration !== 0) return setupCorrupt("candidateGeneration");
      return parsedSetup(
        { ...base.value, lifecycle: row.lifecycle, candidateGeneration },
        credentialRef.value,
      );
    case "credential_stored":
      if (candidateGeneration !== 1) return setupCorrupt("candidateGeneration");
      return parsedSetup(
        { ...base.value, lifecycle: row.lifecycle, candidateGeneration },
        credentialRef.value,
      );
    case "testing": {
      if (candidateGeneration !== 1) return setupCorrupt("candidateGeneration");
      const testStartedAt = requireTimestamp(
        row.testStartedAt,
        "testStartedAt",
      );
      if (!testStartedAt.ok) return testStartedAt;
      return parsedSetup(
        {
          ...base.value,
          lifecycle: row.lifecycle,
          candidateGeneration,
          testStartedAt: testStartedAt.value,
        },
        credentialRef.value,
      );
    }
    case "verified":
    case "committed":
      return parseVerifiedSetup(
        base.value,
        row,
        candidateGeneration,
        credentialRef.value,
      );
    case "failed":
      return parseFailedSetup(
        base.value,
        row,
        candidateGeneration,
        credentialRef.value,
      );
    case "cancelled":
      return parseCancelledSetup(
        base.value,
        row,
        candidateGeneration,
        credentialRef.value,
      );
    case "expired":
      return parseExpiredSetup(
        base.value,
        row,
        candidateGeneration,
        credentialRef.value,
      );
    default:
      return setupCorrupt("lifecycle");
  }
}

function parseSetupAttemptBase(
  row: SetupAttemptRow,
): Result<SetupAttemptBase, CustomConnectorSetupError> {
  const organisationId = parseStoredOrganisationId(row.organisationId);
  if (!organisationId.ok) return organisationId;
  const attemptId = parseCustomConnectorSetupAttemptId(row.attemptId);
  if (!attemptId.ok) return setupCorrupt("attemptId");
  const connectorId = parseCustomConnectorId(row.connectorId);
  if (!connectorId.ok) return setupCorrupt("connectorId");
  const connectorRevision = parseCustomConnectorRevision(row.connectorRevision);
  if (!connectorRevision.ok) return setupCorrupt("connectorRevision");
  const definitionDigest = parseCustomConnectorDefinitionDigest(
    row.definitionDigest,
  );
  if (!definitionDigest.ok) return setupCorrupt("definitionDigest");
  const environment = parseEnvironment(row.environment);
  if (environment === null) return setupCorrupt("environment");
  const target = parseSetupTarget(row, environment);
  if (!target.ok) return target;
  const attemptRevision = requirePositiveInteger(
    row.attemptRevision,
    "attemptRevision",
  );
  if (!attemptRevision.ok) return attemptRevision;
  const createdBy = parseStoredUserId(
    row.createdByUserId,
    "createdByUserId",
  );
  if (!createdBy.ok) return createdBy;
  const expiresAt = requireTimestamp(row.expiresAt, "expiresAt");
  if (!expiresAt.ok) return expiresAt;
  const createdAt = requireTimestamp(row.createdAt, "createdAt");
  if (!createdAt.ok) return createdAt;
  const updatedAt = requireTimestamp(row.updatedAt, "updatedAt");
  if (!updatedAt.ok) return updatedAt;
  return {
    ok: true,
    value: {
      organisationId: organisationId.value,
      attemptId: attemptId.value,
      connectorId: connectorId.value,
      connectorRevision: connectorRevision.value,
      definitionDigest: definitionDigest.value,
      environment,
      target: target.value,
      attemptRevision: attemptRevision.value,
      createdByUserId: createdBy.value,
      expiresAt: expiresAt.value,
      createdAt: createdAt.value,
      updatedAt: updatedAt.value,
    },
  };
}

function parseSetupTarget(
  row: SetupAttemptRow,
  environment: OrganisationEnvironment,
): Result<CustomConnectorSetupTarget, CustomConnectorSetupError> {
  if (row.targetKind === "new_account") {
    return row.targetIntegrationAccountId === null &&
      row.expectedBindingRevision === null
      ? { ok: true, value: { kind: "new_account", environment } }
      : setupCorrupt("target");
  }
  if (
    row.targetKind !== "rotate_account" &&
    row.targetKind !== "upgrade_account" &&
    row.targetKind !== "resume_account"
  ) {
    return setupCorrupt("targetKind");
  }
  if (typeof row.targetIntegrationAccountId !== "string") {
    return setupCorrupt("targetIntegrationAccountId");
  }
  const integrationAccountId = parseIntegrationAccountId(
    row.targetIntegrationAccountId,
  );
  const expectedBindingRevision = requirePositiveInteger(
    row.expectedBindingRevision,
    "expectedBindingRevision",
  );
  if (!integrationAccountId.ok) {
    return setupCorrupt("targetIntegrationAccountId");
  }
  return expectedBindingRevision.ok
    ? {
        ok: true,
        value: {
          kind: row.targetKind,
          integrationAccountId: integrationAccountId.value,
          expectedBindingRevision: expectedBindingRevision.value,
        },
      }
    : expectedBindingRevision;
}

function parseVerifiedSetup(
  base: SetupAttemptBase,
  row: SetupAttemptRow,
  candidateGeneration: 0 | 1,
  credentialRef: VaultHandle | null,
): Result<ParsedSetupAttemptRow, CustomConnectorSetupError> {
  if (candidateGeneration !== 1) return setupCorrupt("candidateGeneration");
  const testStartedAt = requireTimestamp(row.testStartedAt, "testStartedAt");
  if (!testStartedAt.ok) return testStartedAt;
  const verification = parseVerification(row);
  if (!verification.ok) return verification;
  if (row.lifecycle === "verified") {
    return parsedSetup(
      {
        ...base,
        lifecycle: row.lifecycle,
        candidateGeneration,
        testStartedAt: testStartedAt.value,
        verification: verification.value,
      },
      credentialRef,
    );
  }
  const accountId = parseStoredIntegrationAccountId(
    row.committedIntegrationAccountId,
  );
  if (!accountId.ok) return accountId;
  const completedAt = requireTimestamp(row.completedAt, "completedAt");
  if (!completedAt.ok) return completedAt;
  return parsedSetup(
    {
      ...base,
      lifecycle: "committed",
      candidateGeneration,
      testStartedAt: testStartedAt.value,
      verification: verification.value,
      committedIntegrationAccountId: accountId.value,
      completedAt: completedAt.value,
    },
    credentialRef,
  );
}

function parseFailedSetup(
  base: SetupAttemptBase,
  row: SetupAttemptRow,
  candidateGeneration: 0 | 1,
  credentialRef: VaultHandle | null,
): Result<ParsedSetupAttemptRow, CustomConnectorSetupError> {
  if (
    candidateGeneration !== 1 ||
    typeof row.failureCode !== "string" ||
    typeof row.failureCorrelationId !== "string"
  ) {
    return setupCorrupt("failure");
  }
  const completedAt = requireTimestamp(row.completedAt, "completedAt");
  if (!completedAt.ok) return completedAt;
  return parsedSetup(
    {
      ...base,
      lifecycle: "failed",
      candidateGeneration,
      failure: {
        code: row.failureCode,
        correlationId: row.failureCorrelationId,
      },
      completedAt: completedAt.value,
    },
    credentialRef,
  );
}

function parseCancelledSetup(
  base: SetupAttemptBase,
  row: SetupAttemptRow,
  candidateGeneration: 0 | 1,
  credentialRef: VaultHandle | null,
): Result<ParsedSetupAttemptRow, CustomConnectorSetupError> {
  const cancelledBy = parseStoredUserId(
    row.cancelledByUserId,
    "cancelledByUserId",
  );
  if (!cancelledBy.ok) return cancelledBy;
  const completedAt = requireTimestamp(row.completedAt, "completedAt");
  if (!completedAt.ok) return completedAt;
  return parsedSetup(
    {
      ...base,
      lifecycle: "cancelled",
      candidateGeneration,
      cancelledByUserId: cancelledBy.value,
      completedAt: completedAt.value,
    },
    credentialRef,
  );
}

function parseExpiredSetup(
  base: SetupAttemptBase,
  row: SetupAttemptRow,
  candidateGeneration: 0 | 1,
  credentialRef: VaultHandle | null,
): Result<ParsedSetupAttemptRow, CustomConnectorSetupError> {
  const completedAt = requireTimestamp(row.completedAt, "completedAt");
  if (!completedAt.ok) return completedAt;
  return parsedSetup(
    {
      ...base,
      lifecycle: "expired",
      candidateGeneration,
      completedAt: completedAt.value,
    },
    credentialRef,
  );
}

function parseVerification(
  row: SetupAttemptRow,
): Result<CustomConnectorVerification, CustomConnectorSetupError> {
  if (
    typeof row.verifiedProviderAccountId !== "string" ||
    typeof row.verifiedDisplayName !== "string" ||
    !isSha256Hex(row.resultSchemaDigest)
  ) {
    return setupCorrupt("verification");
  }
  const testedAt = requireTimestamp(row.testedAt, "testedAt");
  return testedAt.ok
    ? {
        ok: true,
        value: {
          providerAccountId: row.verifiedProviderAccountId,
          displayName: row.verifiedDisplayName,
          resultSchemaDigest: row.resultSchemaDigest,
          testedAt: testedAt.value,
        },
      }
    : testedAt;
}

function parsedSetup(
  projection: CustomConnectorSetupAttempt,
  candidateCredentialRef: VaultHandle | null,
): Result<ParsedSetupAttemptRow, CustomConnectorSetupError> {
  if (
    (projection.candidateGeneration === 0 && candidateCredentialRef !== null) ||
    (projection.candidateGeneration === 1 && candidateCredentialRef === null)
  ) {
    return setupCorrupt("candidateCredentialRef");
  }
  return { ok: true, value: { projection, candidateCredentialRef } };
}

function parseCredentialValue(
  raw: unknown,
): Result<string, CustomConnectorSetupError> {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw.length <= MAX_CREDENTIAL_CHARACTERS
    ? { ok: true, value: raw }
    : { ok: false, error: { code: "custom_connector_credential_invalid" } };
}

function buildCandidateVaultSecret(
  authentication: CustomConnectorDefinitionV1["authentication"],
  value: string,
): VaultSecret | null {
  if (authentication.kind === "basic_api_key")
    return basicApiKeyVaultSecret(value);
  return authentication.kind === "bearer"
    ? { kind: "bearer", value }
    : { kind: "header", header: authentication.name, value };
}

function parseCandidateAuthentication(
  authentication: CustomConnectorDefinitionV1["authentication"],
  secret: VaultSecret,
): Result<CustomConnectorAuthentication, CustomConnectorSetupError> {
  if (authentication.kind === "basic_api_key") {
    const value = basicApiKeyFromVault(secret);
    return value === null
      ? { ok: false, error: { code: "custom_connector_vault_unavailable" } }
      : { ok: true, value: { kind: "basic_api_key", value } };
  }
  if (authentication.kind === "bearer" && secret.kind === "bearer") {
    return { ok: true, value: { kind: "bearer", value: secret.value } };
  }
  if (
    authentication.kind === "header" &&
    secret.kind === "header" &&
    secret.header === authentication.name
  ) {
    return {
      ok: true,
      value: { kind: "header", name: secret.header, value: secret.value },
    };
  }
  return { ok: false, error: { code: "custom_connector_vault_unavailable" } };
}

function findIdentityOperation(
  definition: CustomConnectorDefinitionV1,
): CustomConnectorOperation {
  for (const operation of definition.operations) {
    if (operation.id === definition.identity.operationId) return operation;
  }
  throw new Error("validated custom connector identity operation is missing");
}

function isValidIdentityTestResult(
  result: CustomConnectorIdentityTestResult,
): boolean {
  return (
    isBoundedIdentityText(result.providerAccountId, 256) &&
    isBoundedIdentityText(result.displayName, 256) &&
    serializedBytes(result.preview) <= MAX_TEST_PREVIEW_BYTES
  );
}

function isBoundedIdentityText(value: string, maximum: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function serializedBytes(value: JsonValue): number {
  return new TextEncoder().encode(serializeCanonical(value)).byteLength;
}

function newCandidateVaultHandle(): VaultHandle {
  const parsed = parseVaultHandle(
    `vault:custom_connector_candidate:${crypto.randomUUID()}`,
  );
  if (!parsed.ok)
    throw new Error("generated candidate Vault handle is invalid");
  return parsed.value;
}

function parseNullableVaultHandle(
  raw: unknown,
): Result<VaultHandle | null, CustomConnectorSetupError> {
  if (raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return setupCorrupt("candidateCredentialRef");
  const parsed = parseVaultHandle(raw);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : setupCorrupt("candidateCredentialRef");
}

function parseStoredOrganisationId(
  raw: unknown,
): Result<OrganisationId, CustomConnectorSetupError> {
  if (typeof raw !== "string") return setupCorrupt("organisationId");
  const parsed = parseOrganisationId(raw);
  return parsed.ok ? parsed : setupCorrupt("organisationId");
}

function parseStoredUserId(
  raw: unknown,
  field: string,
): Result<UserId, CustomConnectorSetupError> {
  if (typeof raw !== "string") return setupCorrupt(field);
  const parsed = parseUserId(raw);
  return parsed.ok ? parsed : setupCorrupt(field);
}

function parseStoredIntegrationAccountId(
  raw: unknown,
): Result<IntegrationAccountId, CustomConnectorSetupError> {
  if (typeof raw !== "string")
    return setupCorrupt("committedIntegrationAccountId");
  const parsed = parseIntegrationAccountId(raw);
  return parsed.ok ? parsed : setupCorrupt("committedIntegrationAccountId");
}

function parseEnvironment(raw: unknown): OrganisationEnvironment | null {
  return raw === "development" || raw === "production" ? raw : null;
}

function parseCandidateGeneration(raw: unknown): 0 | 1 | null {
  return raw === 0 || raw === 1 ? raw : null;
}

function requirePositiveInteger(
  raw: unknown,
  field: string,
): Result<number, CustomConnectorSetupError> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
    ? { ok: true, value: raw }
    : setupCorrupt(field);
}

function requireTimestamp(
  raw: unknown,
  field: string,
): Result<number, CustomConnectorSetupError> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? { ok: true, value: raw }
    : setupCorrupt(field);
}

function isTerminalLifecycle(
  lifecycle: CustomConnectorSetupAttempt["lifecycle"],
): boolean {
  return (
    lifecycle === "committed" ||
    lifecycle === "failed" ||
    lifecycle === "cancelled" ||
    lifecycle === "expired"
  );
}

function boundedFailureCode(raw: string): string {
  const normalized = raw.replace(/[^a-z0-9_]/gu, "_").slice(0, 96);
  return normalized.length === 0 ? "identity_test_failed" : normalized;
}

function setupCorrupt(field: string): Result<never, CustomConnectorSetupError> {
  return {
    ok: false,
    error: { code: "custom_connector_setup_persistence_corrupt", field },
  };
}
import {
  basicApiKeyFromVault,
  basicApiKeyVaultSecret,
} from "./basic-authentication";
import type { VariantBy } from "@purin-labs/type-utils";
import { isPositiveInteger, isSha256Hex } from "@purin-labs/std";
