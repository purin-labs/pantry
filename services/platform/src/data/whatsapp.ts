import type {
  OrganisationDatabase,
  OrganisationDatabaseSession,
} from "../database-handles";
import {
  WHATSAPP_DEFAULT_ALWAYS_WAIT_TOPICS,
  type WhatsAppAgentMode,
} from "@purin-labs/control-api";
import { listOrganisationActorRegistryEntries } from "../actors/actor-registry";
import { actorStub } from "../actors/actor-stubs";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import type {
  D1PreparedStatement,
} from "@cloudflare/workers-types";

import {
  parseCaseId,
  parseConnectorId,
  parseUserId,
  type CaseId,
  type ConnectorId,
  type UserId,
  type IntegrationAccountId,
  type ProviderConnectionId,
  type OrganisationId,
} from "../ids";
import type { Result } from "../result";
import {
  parseE164PhoneNumber,
  parseMetaBusinessPortfolioId,
  parseWhatsAppBusinessAccountId,
  parseWhatsAppCustomerId,
  parseWhatsAppPhoneNumberId,
  type E164PhoneNumber,
  type MetaBusinessPortfolioId,
  type WhatsAppBusinessAccountId,
  type WhatsAppCustomerId,
  type WhatsAppPhoneNumberId,
} from "../whatsapp/identifiers";
import { CAPABILITY_KEYS } from "../authorization/capability-catalogue";
import { prepareSupportBindingContextGrant } from "./access-grants";
import { parseVaultHandle, revokeCredential } from "../credential-vault";
import type { OrganisationEnvironment } from "./control-plane";
import {
  exhaustiveList,
  isRecord,
  parseJsonOrNull,
  positiveIntegerOrNull,
} from "@purin-labs/std";
import type { WhatsAppProviderHealth } from "@purin-labs/control-api";
import type { Env } from "../env";

/**
 * Durable WhatsApp metadata. Every row here holds identifiers, digests,
 * counters, lifecycle facts, and instants. Customer text, proposal bodies,
 * prompts, and model output never reach D1: the active envelope lives
 * application-encrypted in `ConnectorActor` storage for the open Case only.
 */

export type WhatsAppPhoneNumber = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly environment: OrganisationEnvironment;
  readonly businessPortfolioId: MetaBusinessPortfolioId;
  readonly wabaId: WhatsAppBusinessAccountId;
  readonly phoneNumberId: WhatsAppPhoneNumberId;
  readonly displayPhoneNumber: E164PhoneNumber;
  readonly verifiedName: string;
  readonly providerHealth: WhatsAppProviderHealth;
  /** Null until the owner selects this discovered number. */
  readonly selectedAt: number | null;
};

type WhatsAppSupportBinding = {
  readonly supportBindingId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly currentRevision: number;
  readonly installationId: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
};

/** V1 sends operator notices to the organisation's already-selected destination. */
export type OperatorDestination = {
  readonly kind: "organisation_communication_destination";
};

export type WhatsAppIngressOverflow = "pause_and_notify";
const WHATSAPP_RELEVANT_MESSAGE_TOPICS_MAX_CHARS = 2_000;
const WHATSAPP_AUTOMATIC_ACKNOWLEDGEMENT_MAX_CHARS = 1_000;

export type WhatsAppIngressPolicy =
  | { readonly kind: "disabled_by_default"; readonly connectedAt: number }
  | {
      readonly kind: "disabled_by_operator";
      readonly policyVersion: number;
      readonly publishedBy: string;
      readonly publishedAt: number;
    }
  | {
      readonly kind: "enabled";
      readonly policyVersion: number;
      readonly maxActiveCases: number;
      readonly maxMessagesPerHour: number;
      readonly dailyAgentTokenBudget: number;
      readonly maxMessageBytes: number;
      readonly maxActiveCaseMessages: number;
      readonly maxActiveCaseBytes: number;
      readonly debounceSeconds: number;
      readonly relevantMessageTopics: string;
      readonly automaticAcknowledgementText: string;
      readonly agentMode: WhatsAppAgentMode;
      readonly alwaysWaitTopics: string;
      readonly overflow: WhatsAppIngressOverflow;
      readonly notificationDestination: OperatorDestination;
      readonly publishedBy: string;
      readonly publishedAt: number;
    };

export type WhatsAppIngressPolicyPublishRequest =
  | { readonly kind: "disabled_by_operator" }
  | {
      readonly kind: "enabled";
      readonly maxActiveCases: number;
      readonly maxMessagesPerHour: number;
      readonly dailyAgentTokenBudget: number;
      readonly maxMessageBytes: number;
      readonly maxActiveCaseMessages: number;
      readonly maxActiveCaseBytes: number;
      readonly debounceSeconds: number;
      readonly relevantMessageTopics: string;
      readonly automaticAcknowledgementText: string;
      readonly agentMode: WhatsAppAgentMode;
      readonly alwaysWaitTopics: string;
      readonly overflow: WhatsAppIngressOverflow;
      readonly notificationDestination: OperatorDestination;
    };

export type WhatsAppConversationOwnership =
  | { readonly kind: "agent_active" }
  | {
      readonly kind: "human_owned";
      readonly ownerId: UserId;
      readonly startedAt: number;
      readonly reason: "operator_takeover" | "agent_handoff";
    };

export type WhatsAppCaseConversationWindow = {
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly customerWaId: WhatsAppCustomerId;
  readonly conversationWindowSequence: number;
  readonly caseId: CaseId;
  readonly supportBindingId: string;
  readonly bindingRevision: number;
  readonly policyVersion: number;
  readonly ownership: WhatsAppConversationOwnership;
  /** Set while the agent has asked for a human and no operator has answered. */
  readonly handoffRequestedAt: number | null;
  readonly handoffReason: string | null;
  readonly serviceWindowExpiresAt: number;
  readonly openedAt: number;
  readonly closedAt: number | null;
};

export type WhatsAppProposalDisposal =
  | { readonly kind: "cleanup_pending" }
  | { readonly kind: "cleaned"; readonly deletedAt: number };

export type WhatsAppReplyProposalLifecycle =
  | { readonly kind: "awaiting_approval" }
  | {
      readonly kind: "approved";
      readonly approvedBy: string;
      readonly approvedAt: number;
      readonly approvedBodyDigest: string;
    }
  | {
      readonly kind: "sent";
      readonly whatsappMessageId: string;
      readonly sentAt: number;
    }
  | { readonly kind: "send_indeterminate"; readonly fencedAt: number }
  | {
      readonly kind: "rejected";
      readonly rejectedBy: string;
      readonly rejectedAt: number;
      readonly disposal: WhatsAppProposalDisposal;
    }
  | {
      readonly kind: "expired";
      readonly expiredAt: number;
      readonly disposal: WhatsAppProposalDisposal;
    }
  | {
      readonly kind: "superseded";
      readonly supersededByVersion: number;
      readonly disposal: WhatsAppProposalDisposal;
    }
  | {
      readonly kind: "taken_over";
      readonly takenOverBy: string;
      readonly takenOverAt: number;
      readonly disposal: WhatsAppProposalDisposal;
    }
  | {
      readonly kind: "revoked";
      readonly revokedAt: number;
      readonly disposal: WhatsAppProposalDisposal;
    };

export type WhatsAppReplyProposalProjection = {
  readonly proposalId: string;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: string;
  readonly caseId: string;
  readonly customerWaId: string;
  readonly currentVersion: number;
  readonly lifecycleKind: WhatsAppReplyProposalLifecycle["kind"];
  readonly author: WhatsAppReplyAuthor;
  readonly serviceWindowExpiresAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type WhatsAppReplyAuthor = "agent" | "human";

type WhatsAppDeliveryStatusKind = "sent" | "delivered" | "read" | "failed";

type WhatsAppFieldError = {
  readonly code: "missing_field" | "invalid_field";
  readonly field: string;
};

type WhatsAppAccountError =
  | { readonly code: "whatsapp_phone_number_claimed" }
  | { readonly code: "whatsapp_account_missing" }
  | { readonly code: "whatsapp_account_write_failed" };

type WhatsAppSupportAssignmentError =
  | { readonly code: "organisation_placement_conflict" }
  | { readonly code: "whatsapp_account_missing" }
  | { readonly code: "whatsapp_installation_inactive" }
  | { readonly code: "whatsapp_binding_write_failed" };

type WhatsAppPolicyPublishError =
  | { readonly code: "whatsapp_account_missing" }
  | { readonly code: "whatsapp_policy_publish_conflict" };

const WHATSAPP_MIN_DEBOUNCE_SECONDS = 10;
const WHATSAPP_MAX_DEBOUNCE_SECONDS = 30;

const SHA256_HEX = /^[0-9a-f]{64}$/u;

export function whatsappConnectorIdValue(integrationAccountId: string): string {
  return `connector_whatsapp_${integrationAccountId}`;
}

export function whatsappConnectorId(
  integrationAccountId: string,
): Result<ConnectorId, WhatsAppFieldError> {
  const parsed = parseConnectorId(
    whatsappConnectorIdValue(integrationAccountId),
  );
  return parsed.ok
    ? parsed
    : {
        ok: false,
        error: { code: "invalid_field", field: "integrationAccountId" },
      };
}

/**
 * One Case per support conversationWindow. The conversationWindow sequence is part of the key so a
 * customer who returns after the service window opens a new Case instead of
 * reviving a closed one.
 */
export function whatsappConversationWindowCaseId(
  integrationAccountId: string,
  customerWaId: string,
  conversationWindowSequence: number,
): Result<CaseId, WhatsAppFieldError> {
  const parsed = parseCaseId(
    `case_whatsapp_${integrationAccountId}_${customerWaId}_${conversationWindowSequence}`,
  );
  return parsed.ok
    ? parsed
    : { ok: false, error: { code: "invalid_field", field: "customerWaId" } };
}

export async function readWhatsAppPhoneNumberClaimant(input: {
  readonly db: OrganisationDatabase;
  readonly phoneNumberId: string;
}): Promise<{
  readonly organisationId: string;
  readonly integrationAccountId: string;
} | null> {
  return input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId, organisation_id AS organisationId
       FROM whatsapp_phone_number_account
       WHERE phone_number_id = ? AND selected_at IS NOT NULL`,
    )
    .bind(input.phoneNumberId)
    .first<{
      readonly integrationAccountId: string;
      readonly organisationId: string;
    }>();
}

/**
 * Webhook routing. Meta addresses the payload by phone-number asset id, and
 * that id is globally unique at this boundary, so exactly one organisation account
 * can ever answer for it. The WABA id in the payload must also match the
 * stored asset; a mismatch is an unroutable event, not a fallback.
 */
export async function routeWhatsAppWebhookAccount(input: {
  readonly db: OrganisationDatabase;
  readonly wabaId: string;
  readonly phoneNumberId: string;
}): Promise<WhatsAppWebhookRoute | null> {
  const row = await input.db
    .prepare(
      `SELECT account.integration_account_id AS integrationAccountId,
            account.organisation_id AS organisationId,
            account.provider_health AS providerHealth,
            connection.lifecycle AS connectionLifecycle,
            connection.credential_generation AS credentialGeneration,
            integration.lifecycle AS accountLifecycle
       FROM whatsapp_phone_number_account AS account
       JOIN integration_account AS integration
         ON integration.integration_account_id = account.integration_account_id
        AND integration.organisation_id = account.organisation_id
       JOIN provider_connection AS connection
         ON connection.provider_connection_id = account.provider_connection_id
        AND connection.organisation_id = account.organisation_id
      WHERE account.phone_number_id = ? AND account.waba_id = ?
        AND connection.authority_kind = 'connection_credential'
        AND account.selected_at IS NOT NULL
      LIMIT 1`,
    )
    .bind(input.phoneNumberId, input.wabaId)
    .first<Record<string, unknown>>();
  if (row === null) return null;
  const organisationId =
    typeof row.organisationId === "string" ? row.organisationId : null;
  const integrationAccountId =
    typeof row.integrationAccountId === "string"
      ? row.integrationAccountId
      : null;
  if (organisationId === null || integrationAccountId === null) return null;
  if (row.connectionLifecycle !== "active" || row.accountLifecycle !== "active")
    return null;
  if (typeof row.credentialGeneration !== "number") {
    return null;
  }
  return {
    organisationId,
    integrationAccountId,
    credentialGeneration: row.credentialGeneration,
  };
}

type WhatsAppWebhookRoute = {
  readonly organisationId: string;
  readonly integrationAccountId: string;
  readonly credentialGeneration: number;
};

export async function registerWhatsAppPhoneNumberAccount(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly environment: OrganisationEnvironment;
  readonly businessPortfolioId: MetaBusinessPortfolioId;
  readonly wabaId: WhatsAppBusinessAccountId;
  readonly phoneNumberId: WhatsAppPhoneNumberId;
  readonly displayPhoneNumber: E164PhoneNumber;
  readonly verifiedName: string;
  readonly now: number;
}): Promise<Result<WhatsAppPhoneNumber, WhatsAppAccountError>> {
  try {
    await input.db
      .prepare(
        `INSERT INTO whatsapp_phone_number_account (
         integration_account_id, organisation_id, provider_connection_id, environment,
         business_portfolio_id, waba_id, phone_number_id, display_phone_number,
         verified_name, provider_health, provider_health_reason, webhook_verified_at,
         selected_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)
       ON CONFLICT (integration_account_id) DO UPDATE SET
         provider_connection_id = excluded.provider_connection_id,
         business_portfolio_id = excluded.business_portfolio_id,
         waba_id = excluded.waba_id,
         display_phone_number = excluded.display_phone_number,
         verified_name = excluded.verified_name,
         updated_at = excluded.updated_at`,
      )
      .bind(
        input.integrationAccountId,
        input.organisationId,
        input.providerConnectionId,
        input.environment,
        input.businessPortfolioId,
        input.wabaId,
        input.phoneNumberId,
        input.displayPhoneNumber,
        input.verifiedName,
        input.now,
        input.now,
      )
      .run();
  } catch {
    return { ok: false, error: { code: "whatsapp_account_write_failed" } };
  }
  return readWhatsAppPhoneNumberAccount({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
}

/**
 * Turns a discovered candidate into a live number. This is the owner's
 * selection step: it is the only place a phone-number id becomes globally
 * claimed, so a number already answered for by another organisation rejects here —
 * and rejects alone, without taking the rest of the connection with it.
 */
export async function selectWhatsAppPhoneNumberAccount(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly now: number;
}): Promise<Result<WhatsAppPhoneNumber, WhatsAppAccountError>> {
  const account = await readWhatsAppPhoneNumberAccount({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!account.ok) return account;
  if (account.value.selectedAt !== null) return account;
  const claimant = await readWhatsAppPhoneNumberClaimant({
    db: input.db,
    phoneNumberId: account.value.phoneNumberId,
  });
  if (
    claimant !== null &&
    claimant.integrationAccountId !== input.integrationAccountId
  ) {
    return { ok: false, error: { code: "whatsapp_phone_number_claimed" } };
  }
  try {
    await input.db
      .prepare(
        `UPDATE whatsapp_phone_number_account
          SET selected_at = ?, updated_at = ?
        WHERE integration_account_id = ? AND organisation_id = ? AND selected_at IS NULL`,
      )
      .bind(
        input.now,
        input.now,
        input.integrationAccountId,
        input.organisationId,
      )
      .run();
  } catch {
    // The partial unique index is the real arbiter: two organisations selecting the
    // same number concurrently both pass the read above, and exactly one write
    // survives.
    return { ok: false, error: { code: "whatsapp_phone_number_claimed" } };
  }
  return readWhatsAppPhoneNumberAccount({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
}

export async function setWhatsAppProviderHealth(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly health: WhatsAppProviderHealth;
  readonly now: number;
}): Promise<Result<null, WhatsAppAccountError>> {
  const columns = providerHealthColumns(input.health);
  const updated = await input.db
    .prepare(
      `UPDATE whatsapp_phone_number_account
        SET provider_health = ?, provider_health_reason = ?, webhook_verified_at = ?,
            updated_at = ?
      WHERE integration_account_id = ? AND organisation_id = ?`,
    )
    .bind(
      input.health.kind,
      columns.reasonCode,
      columns.webhookVerifiedAt,
      input.now,
      input.integrationAccountId,
      input.organisationId,
    )
    .run();
  return updated.meta.changes === 0
    ? { ok: false, error: { code: "whatsapp_account_missing" } }
    : { ok: true, value: null };
}

export async function readWhatsAppPhoneNumberAccount(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}): Promise<Result<WhatsAppPhoneNumber, WhatsAppAccountError>> {
  const row = await input.db
    .prepare(
      `${PHONE_NUMBER_SELECT}
      WHERE integration_account_id = ? AND organisation_id = ?`,
    )
    .bind(input.integrationAccountId, input.organisationId)
    .first<Record<string, unknown>>();
  const parsed = row === null ? null : parseWhatsAppPhoneNumberRow(row);
  return parsed === null
    ? { ok: false, error: { code: "whatsapp_account_missing" } }
    : { ok: true, value: parsed };
}

export async function listWhatsAppPhoneNumberAccounts(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
}): Promise<readonly WhatsAppPhoneNumber[]> {
  const rows = await input.db
    .prepare(
      `${PHONE_NUMBER_SELECT}
      WHERE organisation_id = ?
      ORDER BY created_at`,
    )
    .bind(input.organisationId)
    .all<Record<string, unknown>>();
  return rows.results.map(parseWhatsAppPhoneNumberRow).filter(isPresent);
}

async function listWhatsAppAccountsForConnection(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
}): Promise<readonly WhatsAppPhoneNumber[]> {
  const rows = await input.db
    .prepare(
      `${PHONE_NUMBER_SELECT}
      WHERE organisation_id = ? AND provider_connection_id = ?
      ORDER BY created_at`,
    )
    .bind(input.organisationId, input.providerConnectionId)
    .all<Record<string, unknown>>();
  return rows.results.map(parseWhatsAppPhoneNumberRow).filter(isPresent);
}

export async function assignWhatsAppSupportAgent(input: {
  readonly scope: OrganisationExecutionScope;
  readonly integrationAccountId: IntegrationAccountId;
  readonly supportBindingId: string;
  readonly installationId: string;
  readonly grantsDigest: string;
  readonly policyDigest: string;
  readonly createdBy: string;
  readonly now: number;
}): Promise<Result<WhatsAppSupportBinding, WhatsAppSupportAssignmentError>> {
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  if (
    !SHA256_HEX.test(input.grantsDigest) ||
    !SHA256_HEX.test(input.policyDigest)
  ) {
    return { ok: false, error: { code: "whatsapp_binding_write_failed" } };
  }
  const account = await readWhatsAppPhoneNumberAccount({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!account.ok)
    return { ok: false, error: { code: "whatsapp_account_missing" } };
  const existing = await readWhatsAppSupportBinding({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  const bindingId = existing.ok
    ? existing.value.supportBindingId
    : input.supportBindingId;
  const revision = existing.ok ? existing.value.currentRevision + 1 : 1;
  const session = input.scope.database.withSession("first-primary");
  try {
    const [admission] = await session.batch([
      session
        .prepare(
          `INSERT INTO whatsapp_support_binding (
           support_binding_id, organisation_id, integration_account_id, current_revision,
           created_by_user_id, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM organisation_placement
           WHERE organisation_id = ? AND placement_epoch = ? AND placement_cell_id = ? AND fence_token = ? AND status = 'active')
           AND COALESCE((SELECT current_revision FROM whatsapp_support_binding WHERE integration_account_id = ?), 0) = ?
         ON CONFLICT (integration_account_id) DO UPDATE SET
           current_revision = excluded.current_revision,
           updated_at = excluded.updated_at`,
        )
        .bind(
          bindingId,
          input.scope.organisationId,
          input.integrationAccountId,
          revision,
          input.createdBy,
          input.now,
          input.now,
          input.scope.organisationId,
          input.scope.placement.placementEpoch,
          input.scope.placement.placementCellId,
          input.scope.fenceToken,
          input.integrationAccountId,
          revision - 1,
        ),
      session
        .prepare(
          `INSERT INTO whatsapp_support_binding_revision (
           support_binding_id, revision, organisation_id, installation_id, response_policy,
           grants_digest, policy_digest, created_by_user_id, created_at
         ) SELECT ?, ?, ?, ?, 'approval_required', ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(
          bindingId,
          revision,
          input.scope.organisationId,
          input.installationId,
          input.grantsDigest,
          input.policyDigest,
          input.createdBy,
          input.now,
        ),
      prepareWhatsAppSupportContextGrant(
        session,
        {
          scope: input.scope,
          integrationAccountId: input.integrationAccountId,
          supportBindingId: bindingId,
          bindingRevision: revision,
          now: input.now,
        },
        " AND changes() = 1",
      ),
    ]);
    if (admission?.meta.changes !== 1)
      return {
        ok: false,
        error: {
          code: (await input.scope.isActive())
            ? "whatsapp_binding_write_failed"
            : "organisation_placement_conflict",
        },
      };
  } catch {
    return { ok: false, error: { code: "whatsapp_installation_inactive" } };
  }
  const binding = await readWhatsAppSupportBinding({
    db: input.scope.database,
    organisationId: input.scope.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  return binding.ok
    ? binding
    : { ok: false, error: { code: "whatsapp_binding_write_failed" } };
}

export async function ensureWhatsAppSupportContextGrant(input: {
  readonly scope: OrganisationExecutionScope;
  readonly integrationAccountId: IntegrationAccountId;
  readonly supportBindingId: string;
  readonly bindingRevision: number;
  readonly now: number;
}): Promise<
  Result<
    null,
    {
      readonly code:
        "whatsapp_binding_write_failed" | "organisation_placement_conflict";
    }
  >
> {
  if (!(await input.scope.isActive()))
    return { ok: false, error: { code: "organisation_placement_conflict" } };
  try {
    await prepareWhatsAppSupportContextGrant(
      input.scope.database,
      input,
      "",
    ).run();
    if (!(await input.scope.isActive()))
      return { ok: false, error: { code: "organisation_placement_conflict" } };
    const binding = await readWhatsAppSupportBinding({
      db: input.scope.database,
      organisationId: input.scope.organisationId,
      integrationAccountId: input.integrationAccountId,
    });
    if (
      !binding.ok ||
      binding.value.supportBindingId !== input.supportBindingId ||
      binding.value.currentRevision !== input.bindingRevision
    )
      return { ok: false, error: { code: "whatsapp_binding_write_failed" } };
    return { ok: true, value: null };
  } catch {
    return { ok: false, error: { code: "whatsapp_binding_write_failed" } };
  }
}

function prepareWhatsAppSupportContextGrant(
  source:
    | Pick<OrganisationDatabase, "prepare">
    | Pick<OrganisationDatabaseSession, "prepare">,
  input: Readonly<{
    readonly scope: OrganisationExecutionScope;
    readonly integrationAccountId: IntegrationAccountId;
    readonly supportBindingId: string;
    readonly bindingRevision: number;
    readonly now: number;
  }>,
  precedingWrite: "" | " AND changes() = 1",
): D1PreparedStatement {
  const materializationReceiptId = [
    "whatsapp_support",
    input.supportBindingId,
    input.bindingRevision,
  ].join(":");
  return prepareSupportBindingContextGrant(source, {
    organisationId: input.scope.organisationId,
    grantId: `grant_${materializationReceiptId}_context_case_read`,
    subjectJson: JSON.stringify({
      kind: "whatsapp_support",
      integrationAccountId: input.integrationAccountId,
      supportBindingId: input.supportBindingId,
      bindingRevision: input.bindingRevision,
    }),
    targetJson: JSON.stringify({
      kind: "platform_capability",
      capabilityId: CAPABILITY_KEYS.contextCaseRead,
      capabilityVersion: 1,
    }),
    provenanceJson: JSON.stringify({
      kind: "integration_setup",
      integrationAccountId: input.integrationAccountId,
      setupRevision: input.bindingRevision,
      materializationReceiptId,
    }),
    changedAt: input.now,
    placement: {
      placementEpoch: input.scope.placement.placementEpoch,
      placementCellId: input.scope.placement.placementCellId,
      fenceToken: input.scope.fenceToken,
    },
    integrationAccountId: input.integrationAccountId,
    supportBindingId: input.supportBindingId,
    bindingRevision: input.bindingRevision,
    precedingWrite,
  });
}

export async function readWhatsAppSupportBinding(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
}): Promise<
  Result<WhatsAppSupportBinding, { readonly code: "whatsapp_unassigned" }>
> {
  const row = await input.db
    .prepare(
      `SELECT binding.support_binding_id AS supportBindingId,
            binding.current_revision AS currentRevision,
            binding.created_by_user_id AS createdBy,
            binding.created_at AS createdAt,
            binding.updated_at AS updatedAt,
            revision.installation_id AS installationId
       FROM whatsapp_support_binding AS binding
       JOIN whatsapp_support_binding_revision AS revision
         ON revision.support_binding_id = binding.support_binding_id
        AND revision.revision = binding.current_revision
      WHERE binding.integration_account_id = ? AND binding.organisation_id = ?`,
    )
    .bind(input.integrationAccountId, input.organisationId)
    .first<Record<string, unknown>>();
  if (
    row === null ||
    typeof row.supportBindingId !== "string" ||
    typeof row.currentRevision !== "number" ||
    typeof row.installationId !== "string" ||
    typeof row.createdBy !== "string" ||
    typeof row.createdAt !== "number" ||
    typeof row.updatedAt !== "number"
  ) {
    return { ok: false, error: { code: "whatsapp_unassigned" } };
  }
  return {
    ok: true,
    value: {
      supportBindingId: row.supportBindingId,
      organisationId: input.organisationId,
      integrationAccountId: input.integrationAccountId,
      currentRevision: row.currentRevision,
      installationId: row.installationId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

export async function publishWhatsAppIngressPolicy(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly environment: OrganisationEnvironment;
  readonly request: WhatsAppIngressPolicyPublishRequest;
  readonly publishedBy: string;
  readonly now: number;
}): Promise<Result<WhatsAppIngressPolicy, WhatsAppPolicyPublishError>> {
  const account = await readWhatsAppPhoneNumberAccount({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
  });
  if (!account.ok)
    return { ok: false, error: { code: "whatsapp_account_missing" } };
  const current = await input.db
    .prepare(
      `SELECT current_version AS currentVersion FROM whatsapp_ingress_policy
      WHERE integration_account_id = ? AND organisation_id = ?`,
    )
    .bind(input.integrationAccountId, input.organisationId)
    .first<{ readonly currentVersion: number }>();
  const nextVersion = (current?.currentVersion ?? 0) + 1;
  const enabled = input.request.kind === "enabled" ? input.request : null;
  const session = input.db.withSession("first-primary");
  try {
    await session.batch([
      session
        .prepare(
          `INSERT INTO whatsapp_ingress_policy_revision (
           integration_account_id, policy_version, organisation_id, environment, processing,
           max_active_cases, max_messages_per_hour, daily_agent_token_budget,
           max_message_bytes, max_active_case_messages, max_active_case_bytes,
           debounce_seconds, relevant_message_topics, automatic_acknowledgement_text, overflow,
           notification_destination,
           published_by_user_id, published_at, agent_mode, always_wait_topics
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.integrationAccountId,
          nextVersion,
          input.organisationId,
          input.environment,
          enabled === null ? "disabled" : "enabled",
          enabled?.maxActiveCases ?? null,
          enabled?.maxMessagesPerHour ?? null,
          enabled?.dailyAgentTokenBudget ?? null,
          enabled?.maxMessageBytes ?? null,
          enabled?.maxActiveCaseMessages ?? null,
          enabled?.maxActiveCaseBytes ?? null,
          enabled?.debounceSeconds ?? null,
          enabled?.relevantMessageTopics ?? null,
          enabled?.automaticAcknowledgementText ?? null,
          enabled?.overflow ?? null,
          enabled === null
            ? null
            : JSON.stringify(enabled.notificationDestination),
          input.publishedBy,
          input.now,
          enabled?.agentMode ?? "answer",
          enabled?.alwaysWaitTopics ?? null,
        ),
      session
        .prepare(
          `INSERT INTO whatsapp_ingress_policy (
           integration_account_id, organisation_id, environment, current_version, updated_at
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (integration_account_id) DO UPDATE SET
           current_version = excluded.current_version,
           updated_at = excluded.updated_at
         WHERE whatsapp_ingress_policy.current_version = ?`,
        )
        .bind(
          input.integrationAccountId,
          input.organisationId,
          input.environment,
          nextVersion,
          input.now,
          nextVersion - 1,
        ),
    ]);
  } catch {
    return { ok: false, error: { code: "whatsapp_policy_publish_conflict" } };
  }
  const stored = await readWhatsAppIngressPolicy({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    connectedAt: input.now,
  });
  return stored.kind === "disabled_by_default" ||
    stored.policyVersion !== nextVersion
    ? { ok: false, error: { code: "whatsapp_policy_publish_conflict" } }
    : { ok: true, value: stored };
}

export async function readWhatsAppIngressPolicy(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly connectedAt: number;
}): Promise<WhatsAppIngressPolicy> {
  const row = await input.db
    .prepare(
      `SELECT revision.policy_version AS policyVersion,
            revision.processing AS processing,
            revision.max_active_cases AS maxActiveCases,
            revision.max_messages_per_hour AS maxMessagesPerHour,
            revision.daily_agent_token_budget AS dailyAgentTokenBudget,
            revision.max_message_bytes AS maxMessageBytes,
            revision.max_active_case_messages AS maxActiveCaseMessages,
            revision.max_active_case_bytes AS maxActiveCaseBytes,
            revision.debounce_seconds AS debounceSeconds,
            revision.relevant_message_topics AS relevantMessageTopics,
            revision.automatic_acknowledgement_text AS automaticAcknowledgementText,
            revision.overflow AS overflow,
            revision.notification_destination AS notificationDestination,
            revision.published_by_user_id AS publishedBy,
            revision.published_at AS publishedAt,
            revision.agent_mode AS agentMode,
            revision.always_wait_topics AS alwaysWaitTopics
       FROM whatsapp_ingress_policy AS policy
       JOIN whatsapp_ingress_policy_revision AS revision
         ON revision.integration_account_id = policy.integration_account_id
        AND revision.policy_version = policy.current_version
      WHERE policy.integration_account_id = ? AND policy.organisation_id = ?`,
    )
    .bind(input.integrationAccountId, input.organisationId)
    .first<Record<string, unknown>>();
  if (
    row === null ||
    typeof row.policyVersion !== "number" ||
    typeof row.publishedBy !== "string" ||
    typeof row.publishedAt !== "number"
  ) {
    return { kind: "disabled_by_default", connectedAt: input.connectedAt };
  }
  if (row.processing !== "enabled") {
    return {
      kind: "disabled_by_operator",
      policyVersion: row.policyVersion,
      publishedBy: row.publishedBy,
      publishedAt: row.publishedAt,
    };
  }
  const destination = parseOperatorDestination(row.notificationDestination);
  if (
    typeof row.maxActiveCases !== "number" ||
    typeof row.maxMessagesPerHour !== "number" ||
    typeof row.dailyAgentTokenBudget !== "number" ||
    typeof row.maxMessageBytes !== "number" ||
    typeof row.maxActiveCaseMessages !== "number" ||
    typeof row.maxActiveCaseBytes !== "number" ||
    typeof row.debounceSeconds !== "number" ||
    row.overflow !== "pause_and_notify" ||
    typeof row.relevantMessageTopics !== "string" ||
    typeof row.automaticAcknowledgementText !== "string" ||
    destination === null
  ) {
    return { kind: "disabled_by_default", connectedAt: input.connectedAt };
  }
  return {
    kind: "enabled",
    policyVersion: row.policyVersion,
    maxActiveCases: row.maxActiveCases,
    maxMessagesPerHour: row.maxMessagesPerHour,
    dailyAgentTokenBudget: row.dailyAgentTokenBudget,
    maxMessageBytes: row.maxMessageBytes,
    maxActiveCaseMessages: row.maxActiveCaseMessages,
    maxActiveCaseBytes: row.maxActiveCaseBytes,
    debounceSeconds: row.debounceSeconds,
    relevantMessageTopics: row.relevantMessageTopics,
    automaticAcknowledgementText: row.automaticAcknowledgementText,
    agentMode: isWhatsAppAgentMode(row.agentMode) ? row.agentMode : "answer",
    alwaysWaitTopics:
      typeof row.alwaysWaitTopics === "string" ? row.alwaysWaitTopics : "",
    overflow: "pause_and_notify",
    notificationDestination: destination,
    publishedBy: row.publishedBy,
    publishedAt: row.publishedAt,
  };
}

export function parseWhatsAppIngressPolicyPublishRequest(
  raw: unknown,
): Result<WhatsAppIngressPolicyPublishRequest, WhatsAppFieldError> {
  if (!isRecord(raw)) return invalidField("policy");
  if (raw.kind === "disabled_by_operator") {
    return Object.keys(raw).length === 1
      ? { ok: true, value: { kind: "disabled_by_operator" } }
      : invalidField("policy");
  }
  if (raw.kind !== "enabled") return invalidField("kind");
  const maxActiveCases = positiveIntegerOrNull(raw.maxActiveCases);
  const maxMessagesPerHour = positiveIntegerOrNull(raw.maxMessagesPerHour);
  const dailyAgentTokenBudget = positiveIntegerOrNull(
    raw.dailyAgentTokenBudget,
  );
  const maxMessageBytes = positiveIntegerOrNull(raw.maxMessageBytes);
  const maxActiveCaseMessages = positiveIntegerOrNull(
    raw.maxActiveCaseMessages,
  );
  const maxActiveCaseBytes = positiveIntegerOrNull(raw.maxActiveCaseBytes);
  const debounceSeconds = positiveIntegerOrNull(raw.debounceSeconds);
  const relevantMessageTopics = normalizeRelevantMessageTopics(
    raw.relevantMessageTopics,
  );
  const automaticAcknowledgementText = normalizeAutomaticAcknowledgementText(
    raw.automaticAcknowledgementText,
  );
  const notificationDestination = parseOperatorDestination(
    raw.notificationDestination,
  );
  if (maxActiveCases === null) return invalidField("maxActiveCases");
  if (maxMessagesPerHour === null) return invalidField("maxMessagesPerHour");
  if (dailyAgentTokenBudget === null)
    return invalidField("dailyAgentTokenBudget");
  if (maxMessageBytes === null) return invalidField("maxMessageBytes");
  if (maxActiveCaseMessages === null)
    return invalidField("maxActiveCaseMessages");
  if (maxActiveCaseBytes === null) return invalidField("maxActiveCaseBytes");
  if (
    debounceSeconds === null ||
    debounceSeconds < WHATSAPP_MIN_DEBOUNCE_SECONDS ||
    debounceSeconds > WHATSAPP_MAX_DEBOUNCE_SECONDS
  ) {
    return invalidField("debounceSeconds");
  }
  if (relevantMessageTopics === null)
    return invalidField("relevantMessageTopics");
  if (automaticAcknowledgementText === null) {
    return invalidField("automaticAcknowledgementText");
  }
  if (raw.overflow !== "pause_and_notify") return invalidField("overflow");
  if (notificationDestination === null)
    return invalidField("notificationDestination");
  // A form that does not name them keeps today's sends, with the default
  // topics that always wait for a person.
  const agentMode = raw.agentMode ?? "answer";
  if (!isWhatsAppAgentMode(agentMode)) return invalidField("agentMode");
  const alwaysWaitTopics =
    raw.alwaysWaitTopics ?? WHATSAPP_DEFAULT_ALWAYS_WAIT_TOPICS;
  if (
    typeof alwaysWaitTopics !== "string" ||
    alwaysWaitTopics.length > WHATSAPP_ALWAYS_WAIT_TOPICS_MAX
  )
    return invalidField("alwaysWaitTopics");
  return {
    ok: true,
    value: {
      kind: "enabled",
      maxActiveCases,
      maxMessagesPerHour,
      dailyAgentTokenBudget,
      maxMessageBytes,
      maxActiveCaseMessages,
      maxActiveCaseBytes,
      debounceSeconds,
      relevantMessageTopics,
      automaticAcknowledgementText,
      agentMode,
      alwaysWaitTopics: alwaysWaitTopics.trim(),
      overflow: "pause_and_notify",
      notificationDestination,
    },
  };
}

const WHATSAPP_ALWAYS_WAIT_TOPICS_MAX = 2000;

function isWhatsAppAgentMode(value: unknown): value is WhatsAppAgentMode {
  return value === "off" || value === "draft" || value === "answer";
}

/**
 * Opens or joins the current support conversationWindow. A customer message inside the
 * open conversationWindow's service window joins that Case; anything later starts the
 * next conversationWindow with a fresh Case.
 */
/**
 * Projects the Connector's conversationWindow decision into D1. The Connector, not this
 * function, decides which Case a message belongs to: it holds the durable
 * envelope and it is the only store consulted when an agent turn runs. If D1
 * re-derived its own sequence the two would drift apart the first time they
 * disagreed — after a disable and re-enable, or across a clock skew that
 * straddles the service window — and every later send for that customer would
 * be refused with `case_missing`, with no operator action able to clear it.
 *
 * An open row under a different Case id is therefore closed, not joined.
 */
export async function openWhatsAppCaseConversationWindow(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly customerWaId: WhatsAppCustomerId;
  readonly caseId: CaseId;
  readonly conversationWindowSequence: number;
  readonly supportBindingId: string;
  readonly bindingRevision: number;
  readonly policyVersion: number;
  readonly serviceWindowExpiresAt: number;
  readonly now: number;
}): Promise<
  Result<
    {
      readonly conversationWindow: WhatsAppCaseConversationWindow;
      readonly kind: "opened" | "joined";
    },
    { readonly code: "whatsapp_case_conversation_window_write_failed" }
  >
> {
  const current = await readOpenWhatsAppCaseConversationWindow({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: input.integrationAccountId,
    customerWaId: input.customerWaId,
    now: input.now,
  });
  if (current !== null && current.caseId === input.caseId) {
    await input.db
      .prepare(
        `UPDATE whatsapp_case_conversation_window SET service_window_expires_at = ?
        WHERE case_id = ? AND organisation_id = ?`,
      )
      .bind(input.serviceWindowExpiresAt, input.caseId, input.organisationId)
      .run();
    return {
      ok: true,
      value: {
        kind: "joined",
        conversationWindow: {
          ...current,
          serviceWindowExpiresAt: input.serviceWindowExpiresAt,
        },
      },
    };
  }
  if (current !== null) {
    // The Connector abandoned this conversationWindow; D1 must not keep it open, or the
    // next admission would join a Case that no longer exists.
    await closeWhatsAppCaseConversationWindow({
      db: input.db,
      organisationId: input.organisationId,
      caseId: current.caseId,
      now: input.now,
    });
  }
  try {
    await input.db
      .prepare(
        `INSERT INTO whatsapp_case_conversation_window (
         organisation_id, integration_account_id, customer_wa_id, conversation_window_sequence, case_id,
         support_binding_id, binding_revision, policy_version, ownership_kind,
         ownership_user_id, ownership_reason, ownership_started_at,
         handoff_requested_at, handoff_reason, service_window_expires_at, opened_at, closed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent_active', NULL, NULL, NULL, NULL, NULL, ?, ?, NULL)
       ON CONFLICT (case_id) DO UPDATE SET
         service_window_expires_at = excluded.service_window_expires_at,
         closed_at = NULL`,
      )
      .bind(
        input.organisationId,
        input.integrationAccountId,
        input.customerWaId,
        input.conversationWindowSequence,
        input.caseId,
        input.supportBindingId,
        input.bindingRevision,
        input.policyVersion,
        input.serviceWindowExpiresAt,
        input.now,
      )
      .run();
  } catch {
    return {
      ok: false,
      error: { code: "whatsapp_case_conversation_window_write_failed" },
    };
  }
  return {
    ok: true,
    value: {
      kind: "opened",
      conversationWindow: {
        organisationId: input.organisationId,
        integrationAccountId: input.integrationAccountId,
        customerWaId: input.customerWaId,
        conversationWindowSequence: input.conversationWindowSequence,
        caseId: input.caseId,
        supportBindingId: input.supportBindingId,
        bindingRevision: input.bindingRevision,
        policyVersion: input.policyVersion,
        ownership: { kind: "agent_active" },
        handoffRequestedAt: null,
        handoffReason: null,
        serviceWindowExpiresAt: input.serviceWindowExpiresAt,
        openedAt: input.now,
        closedAt: null,
      },
    },
  };
}

export async function readOpenWhatsAppCaseConversationWindow(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly customerWaId: WhatsAppCustomerId;
  readonly now: number;
}): Promise<WhatsAppCaseConversationWindow | null> {
  const row = await input.db
    .prepare(
      `${CONVERSATION_WINDOW_SELECT}
      WHERE integration_account_id = ? AND organisation_id = ? AND customer_wa_id = ?
        AND closed_at IS NULL AND service_window_expires_at > ?
      ORDER BY conversation_window_sequence DESC
      LIMIT 1`,
    )
    .bind(
      input.integrationAccountId,
      input.organisationId,
      input.customerWaId,
      input.now,
    )
    .first<Record<string, unknown>>();
  return row === null ? null : parseWhatsAppCaseConversationWindowRow(row);
}

/**
 * The conversation windows that the one Inbox lists, newest first: each open
 * one and the latest closed ones. It holds no message text.
 */
export async function listWhatsAppCaseConversationWindows(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly limit: number;
}): Promise<readonly WhatsAppCaseConversationWindow[]> {
  const rows = await input.db
    .prepare(
      `${CONVERSATION_WINDOW_SELECT}
      WHERE organisation_id = ? AND integration_account_id = ?
      ORDER BY closed_at IS NULL DESC, opened_at DESC
      LIMIT ?`,
    )
    .bind(input.organisationId, input.integrationAccountId, input.limit)
    .all<Record<string, unknown>>();
  return rows.results
    .map(parseWhatsAppCaseConversationWindowRow)
    .filter(isPresent);
}

export async function readWhatsAppCaseConversationWindowByCaseId(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: string;
}): Promise<WhatsAppCaseConversationWindow | null> {
  const row = await input.db
    .prepare(
      `${CONVERSATION_WINDOW_SELECT} WHERE case_id = ? AND organisation_id = ?`,
    )
    .bind(input.caseId, input.organisationId)
    .first<Record<string, unknown>>();
  return row === null ? null : parseWhatsAppCaseConversationWindowRow(row);
}

export async function setWhatsAppCaseOwnership(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: string;
  readonly ownership: WhatsAppConversationOwnership;
}): Promise<
  Result<null, { readonly code: "whatsapp_case_conversation_window_missing" }>
> {
  const updated = await input.db
    .prepare(
      `UPDATE whatsapp_case_conversation_window
        SET ownership_kind = ?, ownership_user_id = ?,
            ownership_reason = ?, ownership_started_at = ?
      WHERE case_id = ? AND organisation_id = ? AND closed_at IS NULL`,
    )
    .bind(
      input.ownership.kind,
      input.ownership.kind === "human_owned" ? input.ownership.ownerId : null,
      input.ownership.kind === "human_owned" ? input.ownership.reason : null,
      input.ownership.kind === "human_owned" ? input.ownership.startedAt : null,
      input.caseId,
      input.organisationId,
    )
    .run();
  return updated.meta.changes === 0
    ? {
        ok: false,
        error: { code: "whatsapp_case_conversation_window_missing" },
      }
    : { ok: true, value: null };
}

/**
 * The agent stopped and asked for a human. Ownership stays `agent_active`
 * until an operator actually takes the Case, so no fabricated identity is
 * ever written as an owner.
 */
export async function requestWhatsAppCaseHandoff(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: string;
  readonly reason: string;
  readonly now: number;
}): Promise<
  Result<null, { readonly code: "whatsapp_case_conversation_window_missing" }>
> {
  const updated = await input.db
    .prepare(
      `UPDATE whatsapp_case_conversation_window
        SET handoff_requested_at = ?, handoff_reason = ?
      WHERE case_id = ? AND organisation_id = ? AND closed_at IS NULL`,
    )
    .bind(input.now, input.reason, input.caseId, input.organisationId)
    .run();
  return updated.meta.changes === 0
    ? {
        ok: false,
        error: { code: "whatsapp_case_conversation_window_missing" },
      }
    : { ok: true, value: null };
}

export async function clearWhatsAppCaseHandoff(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: string;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE whatsapp_case_conversation_window SET handoff_requested_at = NULL, handoff_reason = NULL
      WHERE case_id = ? AND organisation_id = ?`,
    )
    .bind(input.caseId, input.organisationId)
    .run();
}

export async function closeWhatsAppCaseConversationWindow(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly caseId: string;
  readonly now: number;
}): Promise<void> {
  // The handoff reason is model output derived from customer text. It is
  // active content, not a lifecycle fact, so it does not outlive the Case.
  await input.db
    .prepare(
      `UPDATE whatsapp_case_conversation_window
        SET closed_at = ?, handoff_requested_at = NULL, handoff_reason = NULL
      WHERE case_id = ? AND organisation_id = ? AND closed_at IS NULL`,
    )
    .bind(input.now, input.caseId, input.organisationId)
    .run();
}

export type WhatsAppSendRefusal =
  | "account_missing"
  | "account_inactive"
  | "connection_inactive"
  | "policy_disabled"
  | "agent_unassigned"
  | "case_missing"
  | "case_closed";

type WhatsAppSendAuthority =
  | {
      readonly kind: "authorized";
      readonly phoneNumberId: WhatsAppPhoneNumberId;
      readonly customerWaId: WhatsAppCustomerId;
      readonly policyVersion: number;
      readonly supportBindingId: string;
      readonly bindingRevision: number;
      readonly credentialGeneration: number;
      readonly serviceWindowExpiresAt: number;
      readonly ownership: WhatsAppConversationOwnership;
      readonly handoffRequestedAt: number | null;
    }
  | { readonly kind: "unauthorized"; readonly reason: WhatsAppSendRefusal };

/**
 * One join that revalidates every durable precondition immediately before a
 * send: the organisation account and organisation credential are active, the policy still
 * enables processing, the agent binding still exists, and the Case conversationWindow is
 * still open. The caller compares the returned generations and revisions
 * against the generation frozen into the proposal.
 */
export async function readWhatsAppSendAuthority(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly caseId: string;
}): Promise<WhatsAppSendAuthority> {
  const row = await input.db
    .prepare(
      `SELECT account.phone_number_id AS phoneNumberId,
            integration.lifecycle AS accountLifecycle,
            connection.lifecycle AS connectionLifecycle,
            connection.credential_generation AS credentialGeneration,
            policy.current_version AS policyVersion,
            revision.processing AS processing,
            binding.support_binding_id AS supportBindingId,
            binding.current_revision AS bindingRevision,
            conversationWindow.customer_wa_id AS customerWaId,
            conversationWindow.service_window_expires_at AS serviceWindowExpiresAt,
            conversationWindow.ownership_kind AS ownershipKind,
            conversationWindow.ownership_user_id AS ownershipUserId,
            conversationWindow.ownership_reason AS ownershipReason,
            conversationWindow.ownership_started_at AS ownershipStartedAt,
            conversationWindow.handoff_requested_at AS handoffRequestedAt,
            conversationWindow.closed_at AS closedAt
       FROM whatsapp_phone_number_account AS account
       JOIN integration_account AS integration
         ON integration.integration_account_id = account.integration_account_id
        AND integration.organisation_id = account.organisation_id
       JOIN provider_connection AS connection
         ON connection.provider_connection_id = account.provider_connection_id
        AND connection.organisation_id = account.organisation_id
       LEFT JOIN whatsapp_ingress_policy AS policy
         ON policy.integration_account_id = account.integration_account_id
        AND policy.organisation_id = account.organisation_id
       LEFT JOIN whatsapp_ingress_policy_revision AS revision
         ON revision.integration_account_id = policy.integration_account_id
        AND revision.policy_version = policy.current_version
       LEFT JOIN whatsapp_support_binding AS binding
         ON binding.integration_account_id = account.integration_account_id
        AND binding.organisation_id = account.organisation_id
       LEFT JOIN whatsapp_case_conversation_window AS conversationWindow
         ON conversationWindow.case_id = ? AND conversationWindow.organisation_id = account.organisation_id
        AND conversationWindow.integration_account_id = account.integration_account_id
      WHERE account.integration_account_id = ? AND account.organisation_id = ?
        AND connection.authority_kind = 'connection_credential'
      LIMIT 1`,
    )
    .bind(input.caseId, input.integrationAccountId, input.organisationId)
    .first<Record<string, unknown>>();
  if (row === null) return { kind: "unauthorized", reason: "account_missing" };
  if (row.accountLifecycle !== "active") {
    return { kind: "unauthorized", reason: "account_inactive" };
  }
  if (
    row.connectionLifecycle !== "active" ||
    typeof row.credentialGeneration !== "number"
  ) {
    return { kind: "unauthorized", reason: "connection_inactive" };
  }
  if (row.processing !== "enabled" || typeof row.policyVersion !== "number") {
    return { kind: "unauthorized", reason: "policy_disabled" };
  }
  if (
    typeof row.supportBindingId !== "string" ||
    typeof row.bindingRevision !== "number"
  ) {
    return { kind: "unauthorized", reason: "agent_unassigned" };
  }
  const phoneNumberId = parseWhatsAppPhoneNumberId(row.phoneNumberId);
  const customerWaId = parseWhatsAppCustomerId(row.customerWaId);
  const ownership = parseOwnershipRow(row);
  if (
    !phoneNumberId.ok ||
    !customerWaId.ok ||
    ownership === null ||
    typeof row.serviceWindowExpiresAt !== "number"
  ) {
    return { kind: "unauthorized", reason: "case_missing" };
  }
  if (row.closedAt !== null)
    return { kind: "unauthorized", reason: "case_closed" };
  return {
    kind: "authorized",
    phoneNumberId: phoneNumberId.value,
    customerWaId: customerWaId.value,
    policyVersion: row.policyVersion,
    supportBindingId: row.supportBindingId,
    bindingRevision: row.bindingRevision,
    credentialGeneration: row.credentialGeneration,
    serviceWindowExpiresAt: row.serviceWindowExpiresAt,
    ownership,
    handoffRequestedAt:
      typeof row.handoffRequestedAt === "number"
        ? row.handoffRequestedAt
        : null,
  };
}

type WhatsAppRevocation = {
  readonly credentialGeneration: number;
  readonly accounts: readonly WhatsAppPhoneNumber[];
};

/**
 * Revokes the customer business token and every phone-number account derived
 * from that connection. The generic credential revocation transaction fences
 * in-flight work before the provider cleanup result is known.
 */
export async function revokeWhatsAppConnection(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly providerConnectionId: ProviderConnectionId;
  readonly now: number;
}): Promise<
  Result<
    WhatsAppRevocation,
    { readonly code: "whatsapp_connection_not_revocable" }
  >
> {
  const accounts = await listWhatsAppAccountsForConnection(input);
  const current = await input.db
    .prepare(
      `SELECT credential_generation AS credentialGeneration,
            credential_ref AS credentialRef
       FROM provider_connection
      WHERE provider_connection_id = ? AND organisation_id = ?
        AND authority_kind = 'connection_credential'`,
    )
    .bind(input.providerConnectionId, input.organisationId)
    .first<{
      readonly credentialGeneration: number;
      readonly credentialRef: string;
    }>();
  const credentialRef =
    current === null ? null : parseVaultHandle(current.credentialRef);
  if (current === null || credentialRef === null || !credentialRef.ok) {
    return { ok: false, error: { code: "whatsapp_connection_not_revocable" } };
  }
  await revokeCredential({
    db: input.db,
    organisationId: input.organisationId,
    handle: credentialRef.value,
    now: input.now,
  });
  await input.db
    .prepare(
      `UPDATE whatsapp_phone_number_account
        SET provider_health = 'revoked', provider_health_reason = NULL,
            webhook_verified_at = NULL, updated_at = ?
      WHERE provider_connection_id = ? AND organisation_id = ?`,
    )
    .bind(input.now, input.providerConnectionId, input.organisationId)
    .run();
  return {
    ok: true,
    value: { credentialGeneration: current.credentialGeneration, accounts },
  };
}

/**
 * Durable receipts record a coarse size band, never the exact byte count.
 * An exact length plus a digest collapses the search space for short
 * messages — an order number, a yes/no, a postcode — into something a holder
 * of the database could enumerate. The band is enough to diagnose a limit
 * without being that lever.
 */
type WhatsAppBodySizeBucket = "tiny" | "small" | "medium" | "large";

function whatsAppBodySizeBucket(bytes: number): WhatsAppBodySizeBucket {
  if (bytes <= 64) return "tiny";
  if (bytes <= 512) return "small";
  if (bytes <= 2_048) return "medium";
  return "large";
}

export async function recordWhatsAppMessageReceipt(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly providerMessageId: string;
  readonly customerWaId: WhatsAppCustomerId;
  readonly caseId: string;
  readonly direction: "inbound" | "outbound";
  readonly bodyDigest: string;
  readonly bodyBytes: number;
  readonly policyVersion: number;
  readonly providerTimestamp: number;
  readonly now: number;
}): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO whatsapp_message_receipt (
       organisation_id, integration_account_id, provider_message_id, customer_wa_id, case_id,
       direction, body_digest, body_size_bucket, policy_version, provider_timestamp, admitted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (integration_account_id, provider_message_id) DO NOTHING`,
    )
    .bind(
      input.organisationId,
      input.integrationAccountId,
      input.providerMessageId,
      input.customerWaId,
      input.caseId,
      input.direction,
      input.bodyDigest,
      whatsAppBodySizeBucket(input.bodyBytes),
      input.policyVersion,
      input.providerTimestamp,
      input.now,
    )
    .run();
}

export async function projectWhatsAppReplyProposal(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly proposalId: string;
  readonly caseId: string;
  readonly customerWaId: string;
  readonly currentVersion: number;
  readonly lifecycleKind: WhatsAppReplyProposalLifecycle["kind"];
  readonly author: WhatsAppReplyAuthor;
  readonly serviceWindowExpiresAt: number;
  readonly now: number;
}): Promise<
  Result<null, { readonly code: "whatsapp_proposal_projection_failed" }>
> {
  try {
    await input.db
      .prepare(
        `INSERT INTO whatsapp_reply_proposal (
         proposal_id, organisation_id, integration_account_id, case_id, customer_wa_id,
         current_version, lifecycle_kind, author, service_window_expires_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (proposal_id) DO UPDATE SET
         current_version = excluded.current_version,
         lifecycle_kind = excluded.lifecycle_kind,
         service_window_expires_at = excluded.service_window_expires_at,
         updated_at = excluded.updated_at`,
      )
      .bind(
        input.proposalId,
        input.organisationId,
        input.integrationAccountId,
        input.caseId,
        input.customerWaId,
        input.currentVersion,
        input.lifecycleKind,
        input.author,
        input.serviceWindowExpiresAt,
        input.now,
        input.now,
      )
      .run();
  } catch {
    return {
      ok: false,
      error: { code: "whatsapp_proposal_projection_failed" },
    };
  }
  return { ok: true, value: null };
}

export async function readWhatsAppReplyProposalProjection(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly proposalId: string;
}): Promise<WhatsAppReplyProposalProjection | null> {
  const row = await input.db
    .prepare(`${PROPOSAL_SELECT} WHERE proposal_id = ? AND organisation_id = ?`)
    .bind(input.proposalId, input.organisationId)
    .first<Record<string, unknown>>();
  return row === null
    ? null
    : parseWhatsAppProposalRow(row, input.organisationId);
}

export async function listWhatsAppReplyProposalProjections(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly limit: number;
}): Promise<readonly WhatsAppReplyProposalProjection[]> {
  const rows = await input.db
    .prepare(
      `${PROPOSAL_SELECT} WHERE organisation_id = ? ORDER BY updated_at DESC LIMIT ?`,
    )
    .bind(input.organisationId, input.limit)
    .all<Record<string, unknown>>();
  return rows.results
    .map((row) => parseWhatsAppProposalRow(row, input.organisationId))
    .filter(isPresent);
}

/**
 * Every WhatsApp row that carries a customer identifier, a business phone
 * label, or the global phone-number claim. Account removal and organisation erasure
 * both delete these: leaving the claim behind would permanently block that
 * number from being connected again, by this organisation or any other.
 *
 * The statements are ordered so a referencing row is always deleted before
 * the row it points at.
 */
/**
 * Empties every WhatsApp Connector this organisation owns. The Connector, not D1,
 * holds the encrypted active envelope and any open proposal body, so organisation
 * erasure has to reach it: deleting only the D1 rows would leave the
 * ciphertext behind with nothing left pointing at it.
 *
 * Runs before the D1 rows are deleted, because those rows are how the
 * Connectors are found.
 */
export async function purgeOrganisationWhatsAppConnectors(input: {
  readonly db: OrganisationDatabase;
  readonly namespace: Env["CONNECTOR"];
  readonly organisationId: OrganisationId;
  readonly now: number;
}): Promise<number> {
  const accounts = await input.db
    .prepare(
      `SELECT integration_account_id AS integrationAccountId
       FROM whatsapp_phone_number_account WHERE organisation_id = ?`,
    )
    .bind(input.organisationId)
    .all<{ readonly integrationAccountId: string }>();
  if ((accounts.results ?? []).length === 0) return 0;
  // A relocated Connector answers to its placement's name, which the registry
  // holds. The name built from the identifiers alone is the instance it left.
  const entries = await listOrganisationActorRegistryEntries({
    db: input.db,
    organisationId: input.organisationId,
  });
  if (!entries.ok) throw new Error(entries.error.code);
  let purged = 0;
  for (const row of accounts.results ?? []) {
    const connectorId = parseConnectorId(
      whatsappConnectorIdValue(row.integrationAccountId),
    );
    if (!connectorId.ok) continue;
    const entry = entries.value.find(function isAccountConnector(candidate) {
      return (
        candidate.identity.objectKind === "connector" &&
        candidate.identity.logicalObjectId === connectorId.value
      );
    });
    // One the registry has not adopted is still the instance it started as.
    const stub =
      entry === undefined
        ? input.namespace.get(
            input.namespace.idFromName(
              `${input.organisationId}:${connectorId.value}`,
            ),
          )
        : actorStub(
            input.namespace,
            entry.physicalObjectName,
            entry.placement,
          );
    const disabled = await stub.disableWhatsAppProcessing({
      identity: {
        organisationId: input.organisationId,
        connectorId: connectorId.value,
      },
      now: input.now,
    });
    if (disabled.ok) purged += 1;
  }
  return purged;
}


export async function recordWhatsAppDeliveryStatus(input: {
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly whatsappMessageId: string;
  readonly status: WhatsAppDeliveryStatusKind;
  readonly statusAt: number;
  readonly failureCode: string | null;
  readonly now: number;
}): Promise<{ readonly kind: "recorded" | "duplicate" }> {
  const written = await input.db
    .prepare(
      `INSERT INTO whatsapp_delivery_status (
       integration_account_id, organisation_id, whatsapp_message_id, status, status_at,
       failure_code, observed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (integration_account_id, whatsapp_message_id, status) DO NOTHING`,
    )
    .bind(
      input.integrationAccountId,
      input.organisationId,
      input.whatsappMessageId,
      input.status,
      input.statusAt,
      input.status === "failed" ? input.failureCode : null,
      input.now,
    )
    .run();
  return { kind: written.meta.changes === 0 ? "duplicate" : "recorded" };
}

const PHONE_NUMBER_SELECT = `SELECT integration_account_id AS integrationAccountId,
            organisation_id AS organisationId,
            provider_connection_id AS providerConnectionId,
            environment,
            business_portfolio_id AS businessPortfolioId,
            waba_id AS wabaId,
            phone_number_id AS phoneNumberId,
            display_phone_number AS displayPhoneNumber,
            verified_name AS verifiedName,
            provider_health AS providerHealth,
            provider_health_reason AS providerHealthReason,
            webhook_verified_at AS webhookVerifiedAt,
            selected_at AS selectedAt,
            created_at AS createdAt
       FROM whatsapp_phone_number_account`;

const CONVERSATION_WINDOW_SELECT = `SELECT organisation_id AS organisationId,
            integration_account_id AS integrationAccountId,
            customer_wa_id AS customerWaId,
            conversation_window_sequence AS conversationWindowSequence,
            case_id AS caseId,
            support_binding_id AS supportBindingId,
            binding_revision AS bindingRevision,
            policy_version AS policyVersion,
            ownership_kind AS ownershipKind,
            ownership_user_id AS ownershipUserId,
            ownership_reason AS ownershipReason,
            ownership_started_at AS ownershipStartedAt,
            handoff_requested_at AS handoffRequestedAt,
            handoff_reason AS handoffReason,
            service_window_expires_at AS serviceWindowExpiresAt,
            opened_at AS openedAt,
            closed_at AS closedAt
       FROM whatsapp_case_conversation_window`;

const PROPOSAL_SELECT = `SELECT proposal_id AS proposalId,
            integration_account_id AS integrationAccountId,
            case_id AS caseId,
            customer_wa_id AS customerWaId,
            current_version AS currentVersion,
            lifecycle_kind AS lifecycleKind,
            author,
            service_window_expires_at AS serviceWindowExpiresAt,
            created_at AS createdAt,
            updated_at AS updatedAt
       FROM whatsapp_reply_proposal`;

const PROPOSAL_LIFECYCLE_KINDS = exhaustiveList<
  WhatsAppReplyProposalLifecycle["kind"]
>()([
  "awaiting_approval",
  "approved",
  "sent",
  "send_indeterminate",
  "rejected",
  "expired",
  "superseded",
  "taken_over",
  "revoked",
]);

function parseWhatsAppPhoneNumberRow(
  row: Record<string, unknown>,
): WhatsAppPhoneNumber | null {
  const businessPortfolioId = parseMetaBusinessPortfolioId(
    row.businessPortfolioId,
  );
  const wabaId = parseWhatsAppBusinessAccountId(row.wabaId);
  const phoneNumberId = parseWhatsAppPhoneNumberId(row.phoneNumberId);
  const displayPhoneNumber = parseE164PhoneNumber(row.displayPhoneNumber);
  const health = parseProviderHealth(row);
  if (
    !businessPortfolioId.ok ||
    !wabaId.ok ||
    !phoneNumberId.ok ||
    !displayPhoneNumber.ok ||
    health === null ||
    typeof row.integrationAccountId !== "string" ||
    typeof row.organisationId !== "string" ||
    typeof row.providerConnectionId !== "string" ||
    typeof row.verifiedName !== "string" ||
    (row.environment !== "development" && row.environment !== "production")
  ) {
    return null;
  }
  return {
    integrationAccountId: row.integrationAccountId as IntegrationAccountId,
    organisationId: row.organisationId as OrganisationId,
    providerConnectionId: row.providerConnectionId as ProviderConnectionId,
    environment: row.environment,
    businessPortfolioId: businessPortfolioId.value,
    wabaId: wabaId.value,
    phoneNumberId: phoneNumberId.value,
    displayPhoneNumber: displayPhoneNumber.value,
    verifiedName: row.verifiedName,
    providerHealth: health,
    selectedAt: typeof row.selectedAt === "number" ? row.selectedAt : null,
  };
}

function parseWhatsAppCaseConversationWindowRow(
  row: Record<string, unknown>,
): WhatsAppCaseConversationWindow | null {
  const customerWaId = parseWhatsAppCustomerId(row.customerWaId);
  const ownership = parseOwnershipRow(row);
  if (
    !customerWaId.ok ||
    ownership === null ||
    typeof row.organisationId !== "string" ||
    typeof row.integrationAccountId !== "string" ||
    typeof row.caseId !== "string" ||
    typeof row.conversationWindowSequence !== "number" ||
    typeof row.supportBindingId !== "string" ||
    typeof row.bindingRevision !== "number" ||
    typeof row.policyVersion !== "number" ||
    typeof row.serviceWindowExpiresAt !== "number" ||
    typeof row.openedAt !== "number"
  ) {
    return null;
  }
  const caseId = parseCaseId(row.caseId);
  if (!caseId.ok) return null;
  return {
    organisationId: row.organisationId as OrganisationId,
    integrationAccountId: row.integrationAccountId as IntegrationAccountId,
    customerWaId: customerWaId.value,
    conversationWindowSequence: row.conversationWindowSequence,
    caseId: caseId.value,
    supportBindingId: row.supportBindingId,
    bindingRevision: row.bindingRevision,
    policyVersion: row.policyVersion,
    ownership,
    handoffRequestedAt:
      typeof row.handoffRequestedAt === "number"
        ? row.handoffRequestedAt
        : null,
    handoffReason:
      typeof row.handoffReason === "string" ? row.handoffReason : null,
    serviceWindowExpiresAt: row.serviceWindowExpiresAt,
    openedAt: row.openedAt,
    closedAt: typeof row.closedAt === "number" ? row.closedAt : null,
  };
}

function parseOwnershipRow(
  row: Record<string, unknown>,
): WhatsAppConversationOwnership | null {
  if (row.ownershipKind === "agent_active") return { kind: "agent_active" };
  if (row.ownershipKind !== "human_owned") return null;
  const ownerId =
    typeof row.ownershipUserId === "string"
      ? parseUserId(row.ownershipUserId)
      : null;
  if (
    ownerId === null ||
    !ownerId.ok ||
    typeof row.ownershipStartedAt !== "number"
  )
    return null;
  if (
    row.ownershipReason !== "operator_takeover" &&
    row.ownershipReason !== "agent_handoff"
  ) {
    return null;
  }
  return {
    kind: "human_owned",
    ownerId: ownerId.value,
    startedAt: row.ownershipStartedAt,
    reason: row.ownershipReason,
  };
}

function parseWhatsAppProposalRow(
  row: Record<string, unknown>,
  organisationId: OrganisationId,
): WhatsAppReplyProposalProjection | null {
  if (
    typeof row.proposalId !== "string" ||
    typeof row.integrationAccountId !== "string" ||
    typeof row.caseId !== "string" ||
    typeof row.customerWaId !== "string" ||
    typeof row.currentVersion !== "number" ||
    typeof row.serviceWindowExpiresAt !== "number" ||
    typeof row.createdAt !== "number" ||
    typeof row.updatedAt !== "number" ||
    (row.author !== "agent" && row.author !== "human") ||
    !isProposalLifecycleKind(row.lifecycleKind)
  ) {
    return null;
  }
  return {
    proposalId: row.proposalId,
    organisationId,
    integrationAccountId: row.integrationAccountId,
    caseId: row.caseId,
    customerWaId: row.customerWaId,
    currentVersion: row.currentVersion,
    lifecycleKind: row.lifecycleKind,
    author: row.author,
    serviceWindowExpiresAt: row.serviceWindowExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseProviderHealth(
  row: Record<string, unknown>,
): WhatsAppProviderHealth | null {
  switch (row.providerHealth) {
    case "pending":
      return { kind: "pending" };
    case "healthy":
      return typeof row.webhookVerifiedAt === "number"
        ? { kind: "healthy", webhookVerifiedAt: row.webhookVerifiedAt }
        : null;
    case "degraded":
      return typeof row.providerHealthReason === "string"
        ? { kind: "degraded", reasonCode: row.providerHealthReason }
        : null;
    case "unsubscribed":
      return { kind: "unsubscribed" };
    case "revoked":
      return { kind: "revoked" };
    default:
      return null;
  }
}

function providerHealthColumns(health: WhatsAppProviderHealth): {
  readonly reasonCode: string | null;
  readonly webhookVerifiedAt: number | null;
} {
  switch (health.kind) {
    case "healthy":
      return { reasonCode: null, webhookVerifiedAt: health.webhookVerifiedAt };
    case "degraded":
      return { reasonCode: health.reasonCode, webhookVerifiedAt: null };
    case "pending":
    case "unsubscribed":
    case "revoked":
      return { reasonCode: null, webhookVerifiedAt: null };
  }
}

function parseOperatorDestination(raw: unknown): OperatorDestination | null {
  const value = typeof raw === "string" ? parseJsonOrNull(raw) : raw;
  return isRecord(value) &&
    value.kind === "organisation_communication_destination" &&
    Object.keys(value).length === 1
    ? { kind: "organisation_communication_destination" }
    : null;
}

function isProposalLifecycleKind(
  raw: unknown,
): raw is WhatsAppReplyProposalLifecycle["kind"] {
  return (
    typeof raw === "string" &&
    (PROPOSAL_LIFECYCLE_KINDS as readonly string[]).includes(raw)
  );
}

function normalizeAutomaticAcknowledgementText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 &&
    Array.from(text).length <= WHATSAPP_AUTOMATIC_ACKNOWLEDGEMENT_MAX_CHARS
    ? text
    : null;
}

function normalizeRelevantMessageTopics(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const topics = value.trim();
  return topics.length > 0 &&
    Array.from(topics).length <= WHATSAPP_RELEVANT_MESSAGE_TOPICS_MAX_CHARS
    ? topics
    : null;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function invalidField(field: string): Result<never, WhatsAppFieldError> {
  return { ok: false, error: { code: "invalid_field", field } };
}
