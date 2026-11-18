import type { RequestAuthority } from "@seams/contracts";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "../organisation-execution-scope";
import { parseOrganisationId, type IntegrationAccountId } from "../ids";
import type { FlowLabel } from "../policy/information-flow/labels";
import { digestCanonical } from "../policy/information-flow/digest";
import { selectActiveGrants } from "../authorization/access-grants/compiler";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
} from "../authorization/capability-catalogue";
import { listAccessGrants } from "../data/access-grants";
import {
  resolveActiveProviderAccountContext,
  resolveIntegrationAccount,
  resolveProviderConnection,
} from "../data/integration-account";
import type { OrganisationDatabase } from "../database-handles";
import { validateNativeRequestAuthority } from "../request-authority";
import { readCurrentOrganisationPolicySnapshot } from "../policy-snapshot";
import { createCurrentSourceFlowLabel, evaluateFlowLabelSink } from "../policy";
export async function authorizeMailSource(
  env: OrganisationPlacementBindings,
  authority: Extract<RequestAuthority, { kind: "control" }>,
  integrationAccountId: IntegrationAccountId,
): Promise<Readonly<{
  label: FlowLabel;
  sourcePin: string;
}> | null> {
  if (authority.kind !== "control") return null;
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok) return null;
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return null;
  const context = await resolveActiveProviderAccountContext({
    db: execution.value.database,
    organisationId: organisationId.value,
    integrationAccountId,
  });
  if (
    !context.ok ||
    context.value.account.provider !== "gmail" ||
    context.value.connection.authorizationProduct.kind !== "gmail" ||
    context.value.connection.authorizationProduct.product !==
      "full_mailbox_pilot"
  )
    return null;
  const grantIds = await mailboxReadGrantIds(
    execution.value.database,
    authority,
    integrationAccountId,
  );
  if (grantIds === null) return null;
  const label = await createCurrentSourceFlowLabel({
    kind: "integration_resource",
    db: execution.value.database,
    organisationId: organisationId.value,
    integrationAccountId,
    capabilityId: CAPABILITY_KEYS.emailMailboxRead,
    resourceScope: EMAIL_MAILBOX_RESOURCE_SCOPE,
    grantIds,
  });
  if (
    !label.ok ||
    evaluateFlowLabelSink({
      flowLabel: label.value,
      organisationAuthz: null,
      sink: { kind: "conversation_delivery", destinationAuthority: authority },
    }).kind !== "allow"
  )
    return null;
  const sourcePin = await mailSourcePin(context.value.connection);
  return { label: label.value, sourcePin };
}

/**
 * True when the person may read the mailbox but Google refused its sign-in:
 * the account records the refusal, and Pantry reads no mail of it until
 * someone reconnects it. The Inbox then names the mailbox and asks for the
 * reconnect, and it shows nothing of the mail.
 */
export async function mailboxAwaitsReconnect(
  env: OrganisationPlacementBindings,
  authority: Extract<RequestAuthority, { kind: "control" }>,
  integrationAccountId: IntegrationAccountId,
): Promise<boolean> {
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok) return false;
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return false;
  const account = await resolveIntegrationAccount({
    db: execution.value.database,
    organisationId: organisationId.value,
    integrationAccountId,
  });
  if (
    !account.ok ||
    account.value.provider !== "gmail" ||
    account.value.lifecycle.kind !== "reauth_required"
  )
    return false;
  const connection = await resolveProviderConnection({
    db: execution.value.database,
    organisationId: organisationId.value,
    providerConnectionId: account.value.providerConnectionId,
  });
  if (
    !connection.ok ||
    connection.value.lifecycle.kind !== "active" ||
    connection.value.authorizationProduct.kind !== "gmail" ||
    connection.value.authorizationProduct.product !== "full_mailbox_pilot"
  )
    return false;
  return (
    (await mailboxReadGrantIds(
      execution.value.database,
      authority,
      integrationAccountId,
    )) !== null
  );
}

/**
 * The person's active grants that read this mailbox, or null when the
 * person's authority is not live, the Organisation's policy turns the read
 * off, or no grant reads it.
 */
async function mailboxReadGrantIds(
  db: OrganisationDatabase,
  authority: Extract<RequestAuthority, { kind: "control" }>,
  integrationAccountId: IntegrationAccountId,
): Promise<readonly string[] | null> {
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok) return null;
  const live = await validateNativeRequestAuthority({ db, authority });
  if (!live.ok) return null;
  const policy = await readCurrentOrganisationPolicySnapshot(
    db,
    organisationId.value,
  );
  if (
    !policy.ok ||
    !policy.value.authz.allowedTools.includes(CAPABILITY_KEYS.emailMailboxRead)
  )
    return null;
  const grants = await listAccessGrants({
    db,
    organisationId: organisationId.value,
    lifecycle: "active",
  });
  if (!grants.ok) return null;
  const selected = selectActiveGrants({
    organisationId: organisationId.value,
    authority,
    grants: grants.value,
  });
  if (!selected.ok) return null;
  const grantIds: string[] = [];
  for (const grant of selected.value) {
    const target = grant.target;
    if (
      target.kind === "provider_resource" &&
      target.capabilityId === CAPABILITY_KEYS.emailMailboxRead &&
      target.capabilityVersion === 1 &&
      target.integrationAccountId === integrationAccountId &&
      target.resourceScope === EMAIL_MAILBOX_RESOURCE_SCOPE
    )
      grantIds.push(grant.grantId);
  }
  return grantIds.length === 0 ? null : grantIds;
}

/** The pin of one Gmail connection; a reconnect gives a new pin. */
export function mailSourcePin(
  connection: Readonly<{
    providerConnectionId: string;
    authority: unknown;
    updatedAt: number;
  }>,
): Promise<string> {
  return digestCanonical({
    providerConnectionId: connection.providerConnectionId,
    authority: connection.authority,
    updatedAt: connection.updatedAt,
  });
}
