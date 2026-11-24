import type { RequestAuthority } from "@purin-labs/contracts";
import {
  OrganisationExecutionScope,
  type OrganisationPlacementBindings,
} from "@purin-labs/tenancy/organisation-execution-scope";
import {
  parseOrganisationId,
  type IntegrationAccountId,
} from "@purin-labs/kernel/ids";
import type { FlowLabel } from "@purin-labs/authority/policy/information-flow/labels";
import { digestCanonical } from "@purin-labs/authority/policy/information-flow/digest";
import { selectActiveGrants } from "@purin-labs/authority/authorization/access-grants/compiler";
import {
  CAPABILITY_KEYS,
  EMAIL_MAILBOX_RESOURCE_SCOPE,
  EMAIL_OPERATIONAL_RESOURCE_SCOPE,
} from "@purin-labs/authority/authorization/capability-catalogue";
import { listAccessGrants } from "@purin-labs/authority/data/access-grants";
import {
  resolveActiveProviderAccountContext,
  resolveIntegrationAccount,
  resolveProviderConnection,
} from "@purin-labs/connections/data/integration-account";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import { validateNativeRequestAuthority } from "@purin-labs/authority/request-authority/index";
import { readCurrentOrganisationPolicySnapshot } from "@purin-labs/authority/policy-snapshot";
import {
  createCurrentSourceFlowLabel,
  evaluateFlowLabelSink,
} from "@purin-labs/authority/policy/index";
import {
  parseControlRole,
  roleMayConfigure,
} from "@purin-labs/tenancy/data/control-plane";
import type { Variant } from "@purin-labs/type-utils";
export async function authorizeMailSource(
  env: OrganisationPlacementBindings,
  authority: Variant<RequestAuthority, "control">,
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
  const grantIds = await accountGrantIds(
    execution.value.database,
    authority,
    integrationAccountId,
    MAILBOX_READ,
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
  authority: Variant<RequestAuthority, "control">,
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
    (await accountGrantIds(
      execution.value.database,
      authority,
      integrationAccountId,
      MAILBOX_READ,
    )) !== null
  );
}

/**
 * Whether the person may read the preview of an operational email draft of
 * this account: recipient, subject and body. An owner or an admin decides
 * the draft, so reads it. Any other member needs a grant for the mailbox:
 * on a full mailbox the read of a reply draft (`authorizeMailSource`), on a
 * send-only mailbox `email.operational.propose` on this exact account.
 */
export async function mayReadOperationalEmailDraft(
  env: OrganisationPlacementBindings,
  authority: Variant<RequestAuthority, "control">,
  integrationAccountId: IntegrationAccountId,
): Promise<boolean> {
  const role = parseControlRole(authority.role);
  if (!role.ok) return false;
  if (roleMayConfigure(role.value)) return true;
  const organisationId = parseOrganisationId(authority.organisationId);
  if (!organisationId.ok) return false;
  const execution = await OrganisationExecutionScope.resolve(
    env,
    organisationId.value,
  );
  if (!execution.ok) return false;
  const context = await resolveActiveProviderAccountContext({
    db: execution.value.database,
    organisationId: organisationId.value,
    integrationAccountId,
  });
  if (
    !context.ok ||
    context.value.account.provider !== "gmail" ||
    context.value.connection.authorizationProduct.kind !== "gmail"
  )
    return false;
  switch (context.value.connection.authorizationProduct.product) {
    case "full_mailbox_pilot":
      return (
        (await authorizeMailSource(env, authority, integrationAccountId)) !==
        null
      );
    case "send_only":
      return (
        (await accountGrantIds(
          execution.value.database,
          authority,
          integrationAccountId,
          OPERATIONAL_PROPOSE,
        )) !== null
      );
  }
}

/** A capability and its resource scope on one connected account. */
type AccountCapability = Readonly<{
  capabilityId: string;
  resourceScope: string;
}>;

const MAILBOX_READ: AccountCapability = {
  capabilityId: CAPABILITY_KEYS.emailMailboxRead,
  resourceScope: EMAIL_MAILBOX_RESOURCE_SCOPE,
};

const OPERATIONAL_PROPOSE: AccountCapability = {
  capabilityId: CAPABILITY_KEYS.emailOperationalPropose,
  resourceScope: EMAIL_OPERATIONAL_RESOURCE_SCOPE,
};

/**
 * The person's active grants of the capability on this account, or null when
 * the person's authority is not live, the Organisation's policy turns the
 * capability off, or no grant gives it.
 */
async function accountGrantIds(
  db: OrganisationDatabase,
  authority: Variant<RequestAuthority, "control">,
  integrationAccountId: IntegrationAccountId,
  capability: AccountCapability,
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
    !policy.value.authz.allowedTools.includes(capability.capabilityId)
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
      target.capabilityId === capability.capabilityId &&
      target.capabilityVersion === 1 &&
      target.integrationAccountId === integrationAccountId &&
      target.resourceScope === capability.resourceScope
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
