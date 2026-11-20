import type {
  GlobalDatabase,
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import { parseVaultHandle, type VaultHandle } from "../credential-vault/domain";
import type { UserId, IntegrationAccountId, OrganisationId } from "../ids";
import {
  prepareAccountContactVerificationsDelete,
  whatsappErasureStatements,
} from "../mail-inbox/contract/account-erasure";
import { prepareProviderAccountCleanup } from "../integrations/contract/provider-account-cleanup";
import type { Result } from "../result";
import {
  resolveIntegrationAccount,
  resolveProviderConnection,
  type IntegrationAccountMutation,
} from "./integration-account";
import {
  prepareControlMutationReceipt,
  prepareOnboardingAuditEvent,
  prepareOnboardingEvent,
} from "./control-mutation";
import { readProviderCleanupContext } from "../provider-adapters/catalogue";
import { parseActiveIntegrationProvider } from "./integration-provider-directory";
import { fileAccountErasureStatements } from "../context/files";
import { sha256Hex } from "@purin-labs/std";
import {
  prepareRemovedAccountPseudonymization,
  prepareRemovedAccountWebhooksDelete,
} from "./integration-account-writes";
import { prepareRemovedAccountResourcesErasure } from "./provider-resource";
import { prepareRemovedAccountInstallationDelete } from "./surface-installation-writes";
import { prepareRemovedConnectionRevocation } from "./provider-connection-writes";
import { prepareRemovedConnectionGenerationsRevocation } from "./provider-credential-generation";
import {
  hasSlackOrganisationConnection,
  revokeDisabledSlackOrganisationConnection,
} from "../slack/organisation-routing";
import {
  prepareConfigurationVersionBump,
} from "./organisation-onboarding-row";

type RemoveIntegrationAccountError =
  | { readonly code: "integration_account_not_found" }
  | { readonly code: "integration_account_not_disabled" }
  | { readonly code: "integration_account_is_default_for_provider" }
  | { readonly code: "integration_account_in_use" }
  | { readonly code: "provider_attempt_in_progress" }
  | { readonly code: "configuration_version_conflict" }
  | { readonly code: "provider_connection_corrupt" };

type RemoveIntegrationAccountResult = {
  readonly receiptId: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

type OrganisationStateRow = {
  readonly configurationVersion: unknown;
  readonly projectionRevision: unknown;
};

type VaultReferenceRow = {
  readonly vaultHandle: unknown;
  readonly providerNativeId: unknown;
};

type ProviderCleanupMetadata = {
  readonly credentialHandles: readonly VaultHandle[];
  readonly providerWebhookIds: readonly string[];
};

export async function removeIntegrationAccount(input: {
  readonly db: OrganisationDatabase;
  // The global directory, which holds the Slack connection records.
  readonly directory: GlobalDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly removedByUserId: UserId;
  readonly mutation: IntegrationAccountMutation;
  readonly now: number;
}): Promise<
  Result<RemoveIntegrationAccountResult, RemoveIntegrationAccountError>
> {
  const session = input.db.withSession("first-primary");
  const account = await resolveIntegrationAccount({
    db: session,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!account.ok) {
    return { ok: false, error: { code: "integration_account_not_found" } };
  }
  if (account.value.lifecycle.kind !== "disabled") {
    return { ok: false, error: { code: "integration_account_not_disabled" } };
  }
  // The default flag protects providers where one account is *the* one used, so
  // removing it would leave the rest without a target. A mailbox is never
  // resolved that way — it is always addressed explicitly — so refusing here
  // would strand an organisation whose only mailbox happens to hold the flag, with no
  // second account to hand it to.
  if (
    account.value.isDefaultForProvider &&
    account.value.accountKind !== "mailbox"
  ) {
    return {
      ok: false,
      error: { code: "integration_account_is_default_for_provider" },
    };
  }
  const state = await readOrganisationState(session, input.organisationId);
  if (state === null) {
    return { ok: false, error: { code: "integration_account_not_found" } };
  }
  if (
    state.configurationVersion !==
    input.mutation.boundary.expectedConfigurationVersion
  ) {
    return { ok: false, error: { code: "configuration_version_conflict" } };
  }
  if (
    await commerceSystemReferencesAccount(
      session,
      input.organisationId,
      input.integrationAccountId,
    )
  ) {
    return { ok: false, error: { code: "integration_account_in_use" } };
  }
  if (
    await openAttemptReferencesAccount(
      session,
      input.organisationId,
      input.integrationAccountId,
    )
  ) {
    return { ok: false, error: { code: "provider_attempt_in_progress" } };
  }
  const connection = await resolveProviderConnection({
    db: session,
    organisationId: input.organisationId,
    providerConnectionId: account.value.providerConnectionId,
  });
  if (!connection.ok) {
    return { ok: false, error: { code: "provider_connection_corrupt" } };
  }
  const provider = parseActiveIntegrationProvider(account.value.provider);
  if (provider === null) {
    return { ok: false, error: { code: "provider_connection_corrupt" } };
  }
  const otherAccountCount = await countOtherRetainedAccounts(
    session,
    account.value.providerConnectionId,
    input.integrationAccountId,
  );
  const sharedSlackInstallation =
    account.value.provider === "slack" &&
    (await hasSlackOrganisationConnection(
      input.directory,
      input.organisationId,
      input.integrationAccountId,
    ));
  const cleanupMetadata = sharedSlackInstallation
    ? { credentialHandles: [], providerWebhookIds: [] }
    : await listProviderCleanupMetadata(
        session,
        input.organisationId,
        input.integrationAccountId,
        otherAccountCount === 0 ? account.value.providerConnectionId : null,
      );
  const providerContext = sharedSlackInstallation
    ? null
    : await readProviderCleanupContext({
        db: session,
        integrationAccountId: input.integrationAccountId,
        provider,
        removeApplicationSubscription: otherAccountCount === 0,
      });
  if (!sharedSlackInstallation && providerContext === null) {
    return { ok: false, error: { code: "provider_connection_corrupt" } };
  }
  const configurationVersion = state.configurationVersion + 1;
  const projectionRevision = state.projectionRevision + 1;
  const providerAccountHash = await sha256Hex(account.value.providerAccountId);
  const responseBody = {
    receipt_id: input.mutation.identity.receiptId,
    organisation_id: input.organisationId,
    integration_account_id: input.integrationAccountId,
  };
  const cleanupId = `provider_cleanup_${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [];
  statements.push(
    prepareAccountContactVerificationsDelete(
      session,
      input.organisationId,
      input.integrationAccountId,
    ),
    ...prepareRemovedAccountResourcesErasure(
      session,
      input.integrationAccountId,
    ),
    prepareRemovedAccountWebhooksDelete(session, input.integrationAccountId),
    prepareRemovedAccountInstallationDelete(
      session,
      input.integrationAccountId,
    ),
    session
      .prepare(
        `DELETE FROM organisation_communication_destination
       WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(input.organisationId, input.integrationAccountId),
    session
      .prepare(
        `DELETE FROM organisation_slack_channel
       WHERE organisation_id = ? AND integration_account_id = ?`,
      )
      .bind(input.organisationId, input.integrationAccountId),
    ...fileAccountErasureStatements(
      session,
      input.organisationId,
      input.integrationAccountId,
    ),
    ...whatsappErasureStatements(session, {
      kind: "account",
      integrationAccountId: input.integrationAccountId,
    }),
    prepareRemovedAccountPseudonymization(session, {
      providerAccountHash,
      now: input.now,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
    }),
    session
      .prepare(
        `INSERT INTO provider_account_tombstone (
         integration_account_id, organisation_id, provider, environment,
         provider_account_hash, removed_by_user_id,
         removal_receipt_id, removed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.integrationAccountId,
        input.organisationId,
        account.value.provider,
        account.value.environment,
        providerAccountHash,
        input.removedByUserId,
        input.mutation.identity.receiptId,
        input.now,
      ),
  );
  if (sharedSlackInstallation) {
    statements.push(
      prepareRemovedConnectionGenerationsRevocation(session, {
        now: input.now,
        organisationId: input.organisationId,
        providerConnectionId: account.value.providerConnectionId,
      }),
      prepareRemovedConnectionRevocation(session, {
        now: input.now,
        organisationId: input.organisationId,
        providerConnectionId: account.value.providerConnectionId,
      }),
    );
  } else {
    statements.push(
      prepareProviderAccountCleanup(session, {
        cleanupId,
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        provider: account.value.provider,
        environment: account.value.environment,
        now: input.now,
        providerAccountId: account.value.providerAccountId,
        providerConnectionId: account.value.providerConnectionId,
        credentialHandles: JSON.stringify(cleanupMetadata.credentialHandles),
        providerWebhookIds: JSON.stringify(cleanupMetadata.providerWebhookIds),
        providerContext,
      }),
    );
  }
  statements.push(
    prepareConfigurationVersionBump(session, input.organisationId, input.now, { atConfigurationVersion: state.configurationVersion }),
    prepareControlMutationReceipt(session, {
      scope: input.mutation.scope,
      boundary: input.mutation.boundary,
      identity: input.mutation.identity,
      responseStatus: 200,
      responseBody,
    }),
    prepareOnboardingAuditEvent(session, input.mutation.identity, {
      organisationId: input.organisationId,
      environment: account.value.environment,
      actorUserId: input.removedByUserId,
      operation: "provider.account.remove",
      targetKind: "integration_account",
      targetId: input.integrationAccountId,
      oldLifecycle: "disabled",
      newLifecycle: "revoked",
      configurationVersion,
      projectionRevision,
      reasonCode: "merchant_removed",
    }),
    prepareOnboardingEvent(session, input.mutation.identity, {
      eventId: `event_${crypto.randomUUID()}`,
      eventType: "readiness_invalidated",
      organisationId: input.organisationId,
      environment: account.value.environment,
      projectionRevision,
      attributes: {
        reason_code: "provider_account_removed",
        integration_account_id: input.integrationAccountId,
      },
    }),
  );
  await session.batch(statements);
  // The account's directory record follows the removal. It is already
  // disabled, so it routes nothing if this statement has to be repeated.
  if (sharedSlackInstallation)
    await revokeDisabledSlackOrganisationConnection(input.directory, {
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      now: input.now,
    });
  return {
    ok: true,
    value: {
      receiptId: input.mutation.identity.receiptId,
      configurationVersion,
      projectionRevision,
    },
  };
}

async function readOrganisationState(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  organisationId: OrganisationId,
): Promise<{
  readonly configurationVersion: number;
  readonly projectionRevision: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT configuration_version AS configurationVersion,
            projection_revision AS projectionRevision
     FROM organisation_onboarding WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<OrganisationStateRow>();
  return row !== null &&
    typeof row.configurationVersion === "number" &&
    typeof row.projectionRevision === "number"
    ? {
        configurationVersion: row.configurationVersion,
        projectionRevision: row.projectionRevision,
      }
    : null;
}

async function commerceSystemReferencesAccount(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS referenced
     WHERE EXISTS (
       SELECT 1 FROM organisation_commerce_system
       WHERE organisation_id = ?
         AND system_kind = 'shopify'
         AND shopify_integration_account_id = ?
     )
     LIMIT 1`,
    )
    .bind(organisationId, integrationAccountId)
    .first<{ readonly referenced: unknown }>();
  return row?.referenced === 1;
}

async function openAttemptReferencesAccount(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS referenced
     FROM provider_connection_attempt
     WHERE organisation_id = ? AND existing_integration_account_id = ?
       AND lifecycle IN ('created', 'authorizing', 'callback_received', 'provisioning')
     LIMIT 1`,
    )
    .bind(organisationId, integrationAccountId)
    .first<{ readonly referenced: unknown }>();
  return row?.referenced === 1;
}

async function countOtherRetainedAccounts(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  providerConnectionId: string,
  integrationAccountId: IntegrationAccountId,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
     FROM integration_account
     WHERE provider_connection_id = ? AND integration_account_id != ?
       AND lifecycle != 'revoked'`,
    )
    .bind(providerConnectionId, integrationAccountId)
    .first<{ readonly count: unknown }>();
  return typeof row?.count === "number" ? row.count : 0;
}

async function listProviderCleanupMetadata(
  db: Pick<OrganisationDatabaseSession, "prepare">,
  organisationId: OrganisationId,
  integrationAccountId: IntegrationAccountId,
  providerConnectionId: string | null,
): Promise<ProviderCleanupMetadata> {
  const connectionFilter =
    providerConnectionId === null
      ? "AND 0"
      : "AND generation.provider_connection_id = ?";
  const statement = db.prepare(
    `SELECT webhook.provider_native_id AS providerNativeId,
            webhook.signing_secret_ref AS vaultHandle
     FROM provider_webhook AS webhook
     WHERE webhook.organisation_id = ? AND webhook.integration_account_id = ?
     UNION ALL
     SELECT NULL AS providerNativeId, generation.credential_ref AS vaultHandle
     FROM provider_credential_generation AS generation
     WHERE generation.organisation_id = ? ${connectionFilter}`,
  );
  const bound =
    providerConnectionId === null
      ? statement.bind(organisationId, integrationAccountId, organisationId)
      : statement.bind(
          organisationId,
          integrationAccountId,
          organisationId,
          providerConnectionId,
        );
  const rows = await bound.all<VaultReferenceRow>();
  const credentialHandles: VaultHandle[] = [];
  const providerWebhookIds: string[] = [];
  for (const row of rows.results ?? []) {
    if (typeof row.vaultHandle !== "string") {
      throw new Error("provider account vault reference is invalid");
    }
    const handle = parseVaultHandle(row.vaultHandle);
    if (!handle.ok) {
      throw new Error("provider account vault reference is invalid");
    }
    credentialHandles.push(handle.value);
    if (
      typeof row.providerNativeId === "string" &&
      row.providerNativeId.length > 0
    ) {
      providerWebhookIds.push(row.providerNativeId);
    }
  }
  return { credentialHandles, providerWebhookIds };
}
