import type { OrganisationDatabase } from "../../database-handles";
import { parseControlRole } from "../../data/control-plane";
import {
  isUserId,
  type ConversationId,
  type ProjectId,
  type UserId,
} from "@purin-labs/control-api";
import type { CapabilityDefinition, RequestAuthority } from "@purin-labs/contracts";

import {
  CAPABILITY_CATALOGUE,
  CAPABILITY_KEYS,
  type ActiveCapabilityId,
} from "../../authorization/capability-catalogue";
import type {
  AccessGrant,
  AccessGrantTarget,
  FileResourceAccessGrantTarget,
  ContextVisibility,
  GrantSubject,
} from "../../authorization/access-grants/types";
import { listAccessGrants } from "../../data/access-grants";
import { resolveOrganisationCommerceSystemAuthority } from "../../data/organisation-commerce-system";
import {
  parseIntegrationAccountId,
  parseOrganisationId,
  type OrganisationId,
} from "../../ids";
import { readCurrentOrganisationPolicySnapshot } from "../../policy-snapshot";
import { validateNativeRequestAuthority } from "../../request-authority";
import type { Result } from "../../result";
import { FlowLabel } from "./labels";
import { sourceReaderForAuthority } from "./source-readers";
import type {
  CurrentSourceFlowLabelError,
  FlowAudience,
  FlowPolicyInput,
  FlowWriter,
  IntegrationResourceFlowSource,
} from "./types";
import type { Variant } from "@purin-labs/type-utils";
import { assertNever } from "@purin-labs/std";

/**
 * The access checks of a native chat source: a Project that the person may
 * read, or a conversation that the person sees. The conversation module owns
 * them, and its callers give them with the source.
 */
export type NativeChatSourceAccess = Readonly<{
  authorizeProject(
    db: OrganisationDatabase,
    scope: Readonly<{ organisationId: OrganisationId; userId: UserId }>,
    projectId: ProjectId,
    permission: "read",
  ): Promise<unknown>;
  authorizeConversation(
    db: OrganisationDatabase,
    scope: Readonly<{ organisationId: OrganisationId; userId: UserId }>,
    conversationId: ConversationId,
  ): Promise<Readonly<{ access: Readonly<{ kind: string }> }> | null>;
}>;

type CurrentSourceFlowLabelInput =
  | Readonly<{
      kind: "saved_bakery_run";
      db: OrganisationDatabase;
      authority: RequestAuthority;
    }>
  | Readonly<{
      /** The shop's gateways and devices, which every member may read. */
      kind: "device_fleet";
      db: OrganisationDatabase;
      authority: RequestAuthority;
    }>
  | Readonly<{
      /** A recipe's applied workflow and its findings, which every member may read. */
      kind: "recipe_workflow";
      db: OrganisationDatabase;
      authority: RequestAuthority;
    }>
  | Readonly<{
      /** The Bakes page: stock levels and bake proposals, which every member may read. */
      kind: "bake_board";
      db: OrganisationDatabase;
      authority: RequestAuthority;
    }>
  | Readonly<{
      /** The Jev settings of Settings › Jev, which every member may read. */
      kind: "jev_settings";
      db: OrganisationDatabase;
      authority: RequestAuthority;
    }>
  | Readonly<{
      kind: "native_chat";
      db: OrganisationDatabase;
      authority: Variant<RequestAuthority, "control">;
      source: import("./types").NativeChatFlowSource;
      access: NativeChatSourceAccess;
    }>
  | Readonly<{
      readonly kind: "ingress";
      readonly db: OrganisationDatabase;
      readonly authority: RequestAuthority;
    }>
  | Readonly<{
      readonly kind: "integration_resource";
      readonly db: OrganisationDatabase;
      readonly organisationId: OrganisationId;
      readonly integrationAccountId: string;
      readonly capabilityId: string;
      readonly resourceScope: string;
      readonly grantIds: readonly string[];
    }>
  | Readonly<{
      readonly kind: "integration_metadata";
      readonly db: OrganisationDatabase;
      readonly organisationId: OrganisationId;
      readonly grantIds: readonly string[];
    }>
  | Readonly<{
      /** What the merchant pays its suppliers, Pantry's own records. */
      readonly kind: "supplier_payouts";
      readonly db: OrganisationDatabase;
      readonly organisationId: OrganisationId;
      readonly grantIds: readonly string[];
    }>;

type IntegrationAccountPolicyRow = Readonly<{
  readonly provider: unknown;
  readonly lifecycle: unknown;
}>;

type PresentRow = Readonly<{ readonly present: unknown }>;

export async function createCurrentSourceFlowLabel(
  input: CurrentSourceFlowLabelInput,
): Promise<Result<FlowLabel, CurrentSourceFlowLabelError>> {
  switch (input.kind) {
    case "native_chat":
      return createNativeChatLabel(input);
    case "saved_bakery_run":
    case "device_fleet":
    case "recipe_workflow":
    case "bake_board":
    case "jev_settings":
      return createSavedBakeryRunLabel(input);
    case "ingress":
      return createCurrentIngressFlowLabel(input);
    case "integration_resource":
      return createCurrentIntegrationResourceFlowLabel(input);
    case "integration_metadata":
      return createCurrentPlatformCapabilityFlowLabel(
        input,
        CAPABILITY_KEYS.integrationDiscoveryRead,
      );
    case "supplier_payouts":
      return createCurrentPlatformCapabilityFlowLabel(
        input,
        CAPABILITY_KEYS.commerceSupplierPayoutRead,
      );
    default:
      return assertNever(input);
  }
}

/**
 * The current label of a source that a turn read, derived from the active
 * grants that read it. `grants` limits the derivation to the grants that
 * one person's own authority selects; without it every active grant of the
 * organisation counts.
 */
export async function createCurrentObservedSourceFlowLabel(
  db: OrganisationDatabase,
  source: IntegrationResourceFlowSource,
  grants?: readonly AccessGrant[],
): Promise<Result<FlowLabel, CurrentSourceFlowLabelError>> {
  const organisation = parseOrganisationId(source.organisationId);
  if (!organisation.ok) return sourcePolicyInvalid("organisationId");
  let candidates = grants;
  if (candidates === undefined) {
    const active = await listAccessGrants({
      db,
      organisationId: organisation.value,
      lifecycle: "active",
    });
    if (!active.ok) return sourcePolicyUnavailable(active.error.code);
    candidates = active.value;
  }
  const matching: AccessGrant[] = [];
  for (const grant of candidates) {
    const capability = activeCapability(grant.target.capabilityId);
    if (capability === null || capability.risk !== "read") continue;
    if (
      grantMatchesReaderTarget(grant, organisation.value, {
        kind: "integration_resource",
        integrationAccountId: source.integrationAccountId,
        resourceScope: source.resourceScope,
        capabilityId: capability.capabilityId,
      })
    )
      matching.push(grant);
  }
  // A resource that one grant reads as outside-written text stays so.
  const first =
    matching.find((grant) =>
      OUTSIDE_WRITTEN_READ_CAPABILITIES.has(grant.target.capabilityId),
    ) ?? matching[0];
  if (first === undefined) return sourceGrantUnavailable(source.resourceScope);
  const capability = activeCapability(first.target.capabilityId);
  if (capability === null) return sourcePolicyInvalid("capabilityId");
  return createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db,
    organisationId: organisation.value,
    integrationAccountId: source.integrationAccountId,
    resourceScope: source.resourceScope,
    capabilityId: capability.capabilityId,
    grantIds: matching.map(sourceGrantId),
  });
}
function sourceGrantId(grant: AccessGrant): string {
  return grant.grantId;
}

/**
 * The label of an organisation's own records that one platform capability
 * reads: its grants' subjects are the readers, and the capability must be
 * enabled.
 */
async function createCurrentPlatformCapabilityFlowLabel(
  input: Variant<
    CurrentSourceFlowLabelInput,
    "integration_metadata" | "supplier_payouts"
  >,
  capabilityId: ActiveCapabilityId,
): Promise<Result<FlowLabel, CurrentSourceFlowLabelError>> {
  if (
    input.grantIds.length === 0 ||
    new Set(input.grantIds).size !== input.grantIds.length
  ) {
    return sourcePolicyInvalid("grantIds");
  }
  const policy = await readCurrentOrganisationPolicySnapshot(
    input.db,
    input.organisationId,
  );
  if (!policy.ok) return sourcePolicyUnavailable(policy.error.code);
  if (!policy.value.authz.allowedTools.includes(capabilityId)) {
    return sourceCapabilityDisabled(capabilityId);
  }
  const grants = await listAccessGrants({
    db: input.db,
    organisationId: input.organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) return sourcePolicyUnavailable(grants.error.code);
  const readers = await currentReadersForGrants({
    db: input.db,
    organisationId: input.organisationId,
    grantIds: input.grantIds,
    grants: grants.value,
    target: {
      kind: "platform_capability",
      capabilityId,
    },
  });
  if (!readers.ok) return readers;
  return createFlowLabel([
    {
      owner: { kind: "organisation", organisationId: input.organisationId },
      readers: readers.value,
    },
  ]);
}

export function integrationResourceScopeForGrant(
  grant: AccessGrant,
): string | null {
  switch (grant.target.kind) {
    case "provider_resource":
      return grant.target.resourceScope;
    case "file_resource":
      return fileGrantResourceScope(grant.target);
    case "custom_connector_operation":
      return customConnectorGrantResourceScope(grant.target);
    case "commerce_read":
      return `commerce_read:${encodeURIComponent(JSON.stringify(grant.target.scope))}`;
    case "platform_capability":
    case "commerce_command":
      return null;
    default:
      return assertNever(grant.target);
  }
}

async function createCurrentIngressFlowLabel(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly authority: RequestAuthority;
  }>,
): Promise<Result<FlowLabel, CurrentSourceFlowLabelError>> {
  const organisationId = parseOrganisationId(input.authority.organisationId);
  if (!organisationId.ok)
    return sourcePolicyInvalid("authority.organisationId");
  const currentAuthority = await validateNativeRequestAuthority({
    db: input.db,
    authority: input.authority,
  });
  if (!currentAuthority.ok) {
    return currentAuthority.error.code === "request_authority_inactive"
      ? sourceSubjectInactive(input.authority.kind)
      : sourcePolicyUnavailable(currentAuthority.error.detail);
  }
  const reader = sourceReaderForAuthority(input.authority);
  // What people say in a public channel of the workspace is internal. Any
  // other Slack conversation stays private to the people in it (Plan 27C).
  const publicChannel =
    reader.kind === "conversation" &&
    (await slackChannelIsPublic(input.db, organisationId.value, reader));
  return createFlowLabel([
    {
      owner: { kind: "organisation", organisationId: organisationId.value },
      readers: [reader],
      ...(publicChannel ? { level: "internal" as const } : {}),
    },
  ]);
}

/**
 * Whether the newest discovery of this Slack account lists the conversation
 * as a public channel. A conversation that Pantry never listed is not public.
 */
export async function slackChannelIsPublic(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  reader: Readonly<{ integrationAccountId: string; conversationId: string }>,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT r.resource_kind
       FROM provider_discovered_resource r
       JOIN provider_resource_snapshot s ON s.snapshot_revision = r.snapshot_revision
       WHERE s.organisation_id = ? AND s.integration_account_id = ?
         AND r.provider_resource_id = ?
       ORDER BY s.created_at DESC
       LIMIT 1`,
    )
    .bind(organisationId, reader.integrationAccountId, reader.conversationId)
    .first<{ resource_kind: unknown }>();
  return row?.resource_kind === "public_channel";
}

async function createCurrentIntegrationResourceFlowLabel(
  input: Variant<CurrentSourceFlowLabelInput, "integration_resource">,
): Promise<Result<FlowLabel, CurrentSourceFlowLabelError>> {
  if (
    input.resourceScope.trim() !== input.resourceScope ||
    input.resourceScope.length === 0
  ) {
    return sourcePolicyInvalid("resourceScope");
  }
  if (
    input.grantIds.length === 0 ||
    new Set(input.grantIds).size !== input.grantIds.length
  ) {
    return sourcePolicyInvalid("grantIds");
  }
  const integrationAccountId = parseIntegrationAccountId(
    input.integrationAccountId,
  );
  if (!integrationAccountId.ok)
    return sourcePolicyInvalid("integrationAccountId");
  const capability = activeCapability(input.capabilityId);
  if (capability === null) return sourcePolicyInvalid("capabilityId");
  const dependency = await currentResourceDependencyMatches({
    db: input.db,
    organisationId: input.organisationId,
    integrationAccountId: integrationAccountId.value,
    capability,
  });
  if (!dependency.ok) return dependency;
  const policy = await readCurrentOrganisationPolicySnapshot(
    input.db,
    input.organisationId,
  );
  if (!policy.ok) return sourcePolicyUnavailable(policy.error.code);
  if (!policy.value.authz.allowedTools.includes(capability.capabilityId)) {
    return sourceCapabilityDisabled(capability.capabilityId);
  }
  const grants = await listAccessGrants({
    db: input.db,
    organisationId: input.organisationId,
    lifecycle: "active",
  });
  if (!grants.ok) return sourcePolicyUnavailable(grants.error.code);
  const readers = await currentReadersForGrants({
    db: input.db,
    organisationId: input.organisationId,
    grantIds: input.grantIds,
    grants: grants.value,
    target: {
      kind: "integration_resource",
      integrationAccountId: integrationAccountId.value,
      capabilityId: capability.capabilityId,
      resourceScope: input.resourceScope,
    },
  });
  if (!readers.ok) return readers;
  return createFlowLabel(
    [
      {
        owner: {
          kind: "integration_resource",
          organisationId: input.organisationId,
          integrationAccountId: integrationAccountId.value,
          resourceScope: input.resourceScope,
        },
        readers: readers.value,
      },
    ],
    OUTSIDE_WRITTEN_READ_CAPABILITIES.has(capability.capabilityId)
      ? "outside"
      : undefined,
  );
}

async function currentResourceDependencyMatches(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: string;
    readonly capability: Pick<
      CapabilityDefinition,
      "providerDependency" | "target"
    >;
  }>,
): Promise<Result<true, CurrentSourceFlowLabelError>> {
  switch (input.capability.providerDependency.kind) {
    case "provider": {
      const account = await readActiveIntegrationAccountPolicy(input);
      if (!account.ok) return account;
      return providerDependencyMatches(
        input.capability.providerDependency.providers,
        account.value.provider,
      )
        ? { ok: true, value: true }
        : sourcePolicyInvalid("capabilityProvider");
    }
    case "commerce_system": {
      const authority = await resolveOrganisationCommerceSystemAuthority({
        db: input.db,
        organisationId: input.organisationId,
      });
      if (
        !authority.ok ||
        authority.value.integrationAccountId !== input.integrationAccountId ||
        !input.capability.providerDependency.systems.includes(
          authority.value.commerceSystem.kind,
        )
      ) {
        return sourceResourceInactive(input.integrationAccountId);
      }
      return { ok: true, value: true };
    }
    case "none":
      return input.capability.target === "custom_connector_operation"
        ? customConnectorAccountIsActive(input)
        : sourcePolicyInvalid("capabilityProvider");
    default:
      return assertNever(input.capability.providerDependency);
  }
}

async function customConnectorAccountIsActive(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: string;
  }>,
): Promise<Result<true, CurrentSourceFlowLabelError>> {
  const row = await input.db
    .prepare(
      `SELECT 1 AS present FROM integration_account
       WHERE organisation_id = ? AND integration_account_id = ?
         AND source_kind = 'custom_api' AND lifecycle = 'active'
       LIMIT 1`,
    )
    .bind(input.organisationId, input.integrationAccountId)
    .first<PresentRow>();
  return row?.present === 1
    ? { ok: true, value: true }
    : sourceResourceInactive(input.integrationAccountId);
}

type CurrentReaderGrantTarget =
  | Readonly<{
      readonly kind: "platform_capability";
      readonly capabilityId: ActiveCapabilityId;
    }>
  | Readonly<{
      readonly kind: "integration_resource";
      readonly integrationAccountId: string;
      readonly capabilityId: ActiveCapabilityId;
      readonly resourceScope: string;
    }>;

async function currentReadersForGrants(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly grantIds: readonly string[];
    readonly grants: readonly AccessGrant[];
    readonly target: CurrentReaderGrantTarget;
  }>,
): Promise<Result<readonly FlowAudience[], CurrentSourceFlowLabelError>> {
  const grantsById = new Map<string, AccessGrant>();
  for (const grant of input.grants) grantsById.set(grant.grantId, grant);
  const readers = new Map<string, FlowAudience>();
  for (const grantId of input.grantIds) {
    const grant = grantsById.get(grantId);
    if (
      grant === undefined ||
      !grantMatchesReaderTarget(grant, input.organisationId, input.target)
    ) {
      return sourceGrantUnavailable(grantId);
    }
    const current = await grantSubjectIsCurrent(
      input.db,
      input.organisationId,
      grant.subject,
    );
    if (!current.ok) return current;
    if (!current.value) return sourceSubjectInactive(grantId);
    const reader = visibilityForGrantSubject(grant.subject);
    readers.set(JSON.stringify(reader), reader);
  }
  return readers.size === 0
    ? sourcePolicyInvalid("readers")
    : { ok: true, value: [...readers.values()] };
}

function grantMatchesReaderTarget(
  grant: AccessGrant,
  organisationId: OrganisationId,
  target: CurrentReaderGrantTarget,
): boolean {
  if (
    grant.organisationId !== organisationId ||
    grant.lifecycle.kind !== "active" ||
    grant.target.capabilityId !== target.capabilityId ||
    grant.target.capabilityVersion !== 1
  ) {
    return false;
  }
  if (target.kind === "platform_capability") {
    return grant.target.kind === "platform_capability";
  }
  switch (grant.target.kind) {
    case "provider_resource":
    case "file_resource":
    case "custom_connector_operation":
      return (
        grant.target.integrationAccountId === target.integrationAccountId &&
        integrationResourceScopeForGrant(grant) === target.resourceScope
      );
    case "commerce_read":
      return integrationResourceScopeForGrant(grant) === target.resourceScope;
    case "platform_capability":
    case "commerce_command":
      return false;
    default:
      return assertNever(grant.target);
  }
}

function customConnectorGrantResourceScope(
  target: Variant<AccessGrantTarget, "custom_connector_operation">,
): string {
  return [
    "custom_connector",
    target.connectorId,
    String(target.definitionRevision),
    target.definitionDigest,
    target.operationId,
  ].join(":");
}

async function readActiveIntegrationAccountPolicy(
  input: Readonly<{
    readonly db: OrganisationDatabase;
    readonly organisationId: OrganisationId;
    readonly integrationAccountId: string;
  }>,
): Promise<
  Result<Readonly<{ readonly provider: string }>, CurrentSourceFlowLabelError>
> {
  try {
    const row = await input.db
      .prepare(
        `SELECT provider, lifecycle
         FROM integration_account
        WHERE organisation_id = ? AND integration_account_id = ?
        LIMIT 1`,
      )
      .bind(input.organisationId, input.integrationAccountId)
      .first<IntegrationAccountPolicyRow>();
    if (
      row === null ||
      typeof row.provider !== "string" ||
      row.lifecycle !== "active"
    ) {
      return sourceResourceInactive(input.integrationAccountId);
    }
    return { ok: true, value: { provider: row.provider } };
  } catch {
    return sourcePolicyUnavailable("integration_account");
  }
}

export async function grantSubjectIsCurrent(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  subject: GrantSubject,
): Promise<Result<boolean, CurrentSourceFlowLabelError>> {
  try {
    switch (subject.kind) {
      case "organisation_role":
        if (!parseControlRole(subject.role).ok)
          return { ok: true, value: false };
        // A role is an audience even when empty. Disclosure still checks each member.
        return present(
          await db
            .prepare(
              "SELECT 1 AS present FROM organisation WHERE organisation_id = ? AND status = 'active'",
            )
            .bind(organisationId)
            .first<PresentRow>(),
        );
      case "person":
        return present(
          await db
            .prepare(
              `SELECT 1 AS present FROM service_role_grant
            WHERE organisation_id = ? AND person_id = ? AND status = 'active' LIMIT 1`,
            )
            .bind(organisationId, subject.personId)
            .first<PresentRow>(),
        );
      case "conversation":
        return present(
          await db
            .prepare(
              `SELECT 1 AS present FROM integration_account
            WHERE organisation_id = ? AND integration_account_id = ?
              AND provider = 'slack' AND lifecycle = 'active' LIMIT 1`,
            )
            .bind(organisationId, subject.integrationAccountId)
            .first<PresentRow>(),
        );
      case "workflow":
        return grantWorkflowIsCurrent(db, organisationId, subject);
      case "agent_mailbox":
        return present(
          await db
            .prepare(
              `SELECT 1 AS present
             FROM integration_account AS account
             JOIN agent_mailbox_binding AS binding
               ON binding.organisation_id = account.organisation_id
              AND binding.integration_account_id = account.integration_account_id
            WHERE account.organisation_id = ? AND account.integration_account_id = ?
              AND account.lifecycle = 'active'
              AND binding.mailbox_binding_id = ? AND binding.current_revision = ?
            LIMIT 1`,
            )
            .bind(
              organisationId,
              subject.integrationAccountId,
              subject.mailboxBindingId,
              subject.bindingRevision,
            )
            .first<PresentRow>(),
        );
      case "whatsapp_support":
        return present(
          await db
            .prepare(
              `SELECT 1 AS present
             FROM integration_account AS account
             JOIN whatsapp_support_binding AS binding
               ON binding.organisation_id = account.organisation_id
              AND binding.integration_account_id = account.integration_account_id
            WHERE account.organisation_id = ? AND account.integration_account_id = ?
              AND account.lifecycle = 'active'
              AND binding.support_binding_id = ? AND binding.current_revision = ?
            LIMIT 1`,
            )
            .bind(
              organisationId,
              subject.integrationAccountId,
              subject.supportBindingId,
              subject.bindingRevision,
            )
            .first<PresentRow>(),
        );
      default:
        return assertNever(subject);
    }
  } catch {
    return sourcePolicyUnavailable("grant_subject");
  }
}

async function grantWorkflowIsCurrent(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  subject: Variant<GrantSubject, "workflow">,
): Promise<Result<boolean, CurrentSourceFlowLabelError>> {
  const cue = await db
    .prepare(
      `SELECT 1 AS present FROM cue_subscription
      WHERE organisation_id = ? AND subscription_id = ? AND version = ? AND enabled = 1 LIMIT 1`,
    )
    .bind(organisationId, subject.workflowId, subject.workflowRevision)
    .first<PresentRow>();
  if (cue?.present === 1) return { ok: true, value: true };
  return present(
    await db
      .prepare(
        `SELECT 1 AS present FROM schedule_binding
      WHERE organisation_id = ? AND binding_id = ? AND revision = ? AND enabled = 1 LIMIT 1`,
      )
      .bind(organisationId, subject.workflowId, subject.workflowRevision)
      .first<PresentRow>(),
  );
}

function present(
  row: PresentRow | null,
): Result<boolean, CurrentSourceFlowLabelError> {
  return { ok: true, value: row?.present === 1 };
}

function activeCapability(capabilityId: string): Readonly<{
  readonly capabilityId: ActiveCapabilityId;
  readonly providerDependency: CapabilityDefinition["providerDependency"];
  readonly target: CapabilityDefinition["target"];
  readonly risk: CapabilityDefinition["risk"];
}> | null {
  for (const definition of CAPABILITY_CATALOGUE) {
    const activeId = parseActiveCapabilityId(definition.capabilityId);
    if (activeId === capabilityId && definition.capabilityVersion === 1) {
      return {
        capabilityId: activeId,
        providerDependency: definition.providerDependency,
        target: definition.target,
        risk: definition.risk,
      };
    }
  }
  return null;
}

function parseActiveCapabilityId(
  capabilityId: string,
): ActiveCapabilityId | null {
  for (const activeCapabilityId of Object.values(CAPABILITY_KEYS)) {
    if (activeCapabilityId === capabilityId) return activeCapabilityId;
  }
  return null;
}

function providerDependencyMatches(
  providers: readonly string[],
  provider: string,
): boolean {
  for (const candidate of providers) {
    if (candidate === provider) return true;
  }
  return false;
}

function createFlowLabel(
  policies: readonly FlowPolicyInput[],
  writer?: FlowWriter,
): Promise<Result<FlowLabel, CurrentSourceFlowLabelError>> {
  return FlowLabel.create(policies, writer);
}

/**
 * The read capabilities whose result holds free text that a person outside
 * the Organisation wrote: an email, a customer's WhatsApp message (Plan 89).
 * The label of such a source states the writer `outside`. A typed fact of
 * Pantry's own records is not such a text. When a new read returns outside
 * text, add its capability here in the same change.
 */
const OUTSIDE_WRITTEN_READ_CAPABILITIES: ReadonlySet<string> = new Set([
  CAPABILITY_KEYS.emailMailboxRead,
  CAPABILITY_KEYS.whatsappSupportRead,
]);

export function visibilityForGrantSubject(
  subject: GrantSubject,
): ContextVisibility {
  switch (subject.kind) {
    case "organisation_role":
      return { kind: subject.kind, role: subject.role };
    case "person":
      return { kind: subject.kind, personId: subject.personId };
    case "conversation":
      return {
        kind: subject.kind,
        integrationAccountId: subject.integrationAccountId,
        conversationId: subject.conversationId,
      };
    case "workflow":
      return {
        kind: subject.kind,
        workflowKind: subject.workflowKind,
        workflowId: subject.workflowId,
        workflowRevision: subject.workflowRevision,
      };
    case "agent_mailbox":
      return {
        kind: subject.kind,
        integrationAccountId: subject.integrationAccountId,
        mailboxBindingId: subject.mailboxBindingId,
        bindingRevision: subject.bindingRevision,
      };
    case "whatsapp_support":
      return {
        kind: subject.kind,
        integrationAccountId: subject.integrationAccountId,
        supportBindingId: subject.supportBindingId,
        bindingRevision: subject.bindingRevision,
      };
    default:
      return assertNever(subject);
  }
}

function fileGrantResourceScope(target: FileResourceAccessGrantTarget): string {
  switch (target.scope.kind) {
    case "dropbox_folder":
      return `dropbox_folder:${target.scope.providerFolderId}`;
    case "dropbox_file":
      return `dropbox_file:${target.scope.providerFileId}`;
    case "gdrive_file":
      return `gdrive_file:${target.scope.providerFileId}`;
    default:
      return assertNever(target.scope);
  }
}

function sourcePolicyInvalid(
  field: string,
): Result<never, CurrentSourceFlowLabelError> {
  return { ok: false, error: { code: "source_policy_invalid", field } };
}

function sourcePolicyUnavailable(
  detail: string,
): Result<never, CurrentSourceFlowLabelError> {
  return { ok: false, error: { code: "source_policy_unavailable", detail } };
}

function sourceSubjectInactive(
  subject: string,
): Result<never, CurrentSourceFlowLabelError> {
  return { ok: false, error: { code: "source_subject_inactive", subject } };
}

function sourceResourceInactive(
  integrationAccountId: string,
): Result<never, CurrentSourceFlowLabelError> {
  return {
    ok: false,
    error: { code: "source_resource_inactive", integrationAccountId },
  };
}

function sourceCapabilityDisabled(
  capabilityId: string,
): Result<never, CurrentSourceFlowLabelError> {
  return {
    ok: false,
    error: { code: "source_capability_disabled", capabilityId },
  };
}

function sourceGrantUnavailable(
  grantId: string,
): Result<never, CurrentSourceFlowLabelError> {
  return { ok: false, error: { code: "source_grant_unavailable", grantId } };
}

async function createNativeChatLabel(
  input: Variant<CurrentSourceFlowLabelInput, "native_chat">,
): Promise<Result<FlowLabel, CurrentSourceFlowLabelError>> {
  if (
    input.authority.organisationId !== input.source.organisationId ||
    !isUserId(input.authority.userId)
  )
    return sourcePolicyInvalid("authority");
  const scope = {
    organisationId: input.source.organisationId,
    userId: input.authority.userId,
  };
  const authorized =
    input.source.kind === "project"
      ? await input.access.authorizeProject(
          input.db,
          scope,
          input.source.projectId,
          "read",
        )
      : await input.access.authorizeConversation(
          input.db,
          scope,
          input.source.conversationId,
        );
  if (authorized === null) return sourceSubjectInactive(input.source.kind);
  const base = await createCurrentIngressFlowLabel({
    db: input.db,
    authority: input.authority,
  });
  if (!base.ok) return base;
  if (input.source.kind === "chat_conversation") {
    const conversation = await input.access.authorizeConversation(
      input.db,
      scope,
      input.source.conversationId,
    );
    if (conversation === null) return sourceSubjectInactive(input.source.kind);
    if (conversation.access.kind === "workspace_canvas")
      return createFlowLabel(
        base.value.policies.map(organisationWorkspacePolicy),
      );
  }
  return FlowLabel.create(
    base.value.policies.map(nativeChatPolicy.bind(null, input.source)),
  );
}
function nativeChatPolicy(
  source: import("./types").NativeChatFlowSource,
  policy: FlowPolicyInput,
): FlowPolicyInput {
  return {
    owner: policy.owner,
    readers: [source],
  };
}

/** Saved bakery runs are readable by every active member of their organisation. */
async function createSavedBakeryRunLabel(
  input: Variant<
    CurrentSourceFlowLabelInput,
    | "saved_bakery_run"
    | "device_fleet"
    | "recipe_workflow"
    | "bake_board"
    | "jev_settings"
  >,
): Promise<Result<FlowLabel, CurrentSourceFlowLabelError>> {
  if (
    input.authority.kind !== "control" &&
    input.authority.kind !== "direct_conversation" &&
    input.authority.kind !== "shared_conversation"
  )
    return sourceSubjectInactive(input.authority.kind);
  const base = await createCurrentIngressFlowLabel(input);
  if (!base.ok) return base;
  return createFlowLabel(base.value.policies.map(organisationWorkspacePolicy));
}
function organisationWorkspacePolicy(policy: FlowPolicyInput): FlowPolicyInput {
  return {
    owner: policy.owner,
    readers: [
      { kind: "organisation_role", role: "owner" },
      { kind: "organisation_role", role: "admin" },
      { kind: "organisation_role", role: "operator" },
      { kind: "organisation_role", role: "viewer" },
    ],
  };
}
