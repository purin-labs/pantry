import type { MailboxSetupPlan } from "@purin-labs/control-api";
import {
  controlRead,
  controlSignal,
  controlMutation,
} from "@purin-labs/control/portal/control-client";
import type { BrainTransport } from "@purin-labs/area-brain/ui/features/brain/api";
import { readMailboxSetup } from "@purin-labs/area-inbox/ui/features/mail-setup/run";
import type { OrganisationActions } from "@purin-labs/area-organisation/ui/pages/workspaces";
import type { ProductDescriptionActionTransport } from "./features/commerce/description-draft/editor";
import type {
  IntegrationsRouteTransport,
  WhatsAppRouteTransport,
  WorkspaceSettingsRouteTransport,
} from "./features/integrations/settings-types";
import {
  type CommerceActionRecord,
  parseCommerceActionRecordResponse,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import type { CommerceOperationsTransport } from "./features/commerce/operations";
import type { AgentOperationsTransport } from "@purin-labs/area-organisation/ui/pages/automation";
import { createAccessRouteTransport } from "@purin-labs/area-organisation/ui/features/access/api";
import { pickGoogleDriveFile } from "@purin-labs/area-organisation/ui/features/access/google-drive-picker";
import {
  readEmailOperationalPreview,
  readEmailReplyPreview,
} from "./features/integrations/mailbox-transport";
import {
  executeIntegrationsRoute,
  executeWorkspaceSettingsRoute,
  lastIntegrationsOverview,
  notImplementedWhatsAppConnect,
  readIntegrationDetail,
  readIntegrationsOverview,
  readWorkspaceSettingsRoute,
  runWhatsAppAccountAction,
} from "./features/integrations/settings-transport";
import {
  archiveControlOrganisation,
  deleteControlOrganisation,
  renameControlOrganisation,
  restoreControlOrganisation,
} from "./portal-reads";
import { MAILBOX_SETUP_TRANSPORT } from "./portal-support";
import { StripePaymentAccountSetup } from "./features/payment-accounts/stripe-account";

export const AGENT_OPERATIONS_TRANSPORT: AgentOperationsTransport = {
  read: readAgentOperationsTransport,
  mutate: mutateAgentOperationsTransport,
  readRevisions: readAgentRevisionsTransport,
};

export const COMMERCE_OPERATIONS_TRANSPORT: CommerceOperationsTransport = {
  previewTrackingBatch: previewTrackingBatchTransport,
  proposeAction: proposeCommerceActionTransport,
};

export const PRODUCT_DESCRIPTION_ACTION_TRANSPORT: ProductDescriptionActionTransport =
  {
    proposeAction: proposeProductDescriptionActionTransport,
  };

export const ORGANISATION_ACTIONS: OrganisationActions = {
  rename: renameControlOrganisation,
  archive: archiveControlOrganisation,
  restore: restoreControlOrganisation,
  delete: deleteControlOrganisation,
};

const WHATSAPP_ROUTE_TRANSPORT: WhatsAppRouteTransport = {
  connect: notImplementedWhatsAppConnect,
  accountAction: runWhatsAppAccountAction,
};

function readMailboxSetupTransport(
  organisationId: string,
  integrationAccountId: string,
): Promise<MailboxSetupPlan> {
  return readMailboxSetup(
    MAILBOX_SETUP_TRANSPORT,
    { organisationId, integrationAccountId },
    { kind: "automatic" },
  );
}

export const INTEGRATIONS_ROUTE_TRANSPORT: IntegrationsRouteTransport = {
  readOverview: readIntegrationsOverview,
  readMailboxSetup: readMailboxSetupTransport,
  lastOverview: lastIntegrationsOverview,
  readDetail: readIntegrationDetail,
  execute: executeIntegrationsRoute,
  readEmailReply: readEmailReplyPreview,
  readEmailOperational: readEmailOperationalPreview,
  whatsapp: WHATSAPP_ROUTE_TRANSPORT,
  stripeSetup: StripePaymentAccountSetup,
};

export const WORKSPACE_SETTINGS_ROUTE_TRANSPORT: WorkspaceSettingsRouteTransport = {
  read: readWorkspaceSettingsRoute,
  execute: executeWorkspaceSettingsRoute,
};

export const BRAIN_TRANSPORT: BrainTransport = {
  read: controlRead,
  mutate: controlMutation,
};

export const ACCESS_ROUTE_TRANSPORT = createAccessRouteTransport(
  controlRead,
  controlMutation,
  pickGoogleDriveFile,
);

function readAgentOperationsTransport(
  organisationId: string,
): Promise<unknown> {
  return controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/operations`,
  );
}

function readAgentRevisionsTransport(
  organisationId: string,
  target: { readonly kind: "agent_definition" | "skill"; readonly id: string },
): Promise<unknown> {
  const segment = target.kind === "agent_definition" ? "definitions" : "skills";
  return controlRead(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/operations/${segment}/${encodeURIComponent(target.id)}/revisions`,
  );
}

function mutateAgentOperationsTransport(
  organisationId: string,
  command: Parameters<AgentOperationsTransport["mutate"]>[1],
  mutationIntent: string,
): Promise<unknown> {
  return controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/operations`,
    "POST",
    command,
    undefined,
    mutationIntent,
  );
}

function previewTrackingBatchTransport(
  organisationId: string,
  exceptionIds: readonly string[],
): Promise<unknown> {
  return controlSignal(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/operations/tracking-batches/preview`,
    { exceptionIds },
  );
}

function proposeCommerceActionTransport(
  organisationId: string,
  action: Parameters<CommerceOperationsTransport["proposeAction"]>[1],
  intent: string,
): Promise<unknown> {
  return controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions`,
    "POST",
    action,
    undefined,
    intent,
  );
}

async function proposeProductDescriptionActionTransport(
  organisationId: string,
  action: Parameters<ProductDescriptionActionTransport["proposeAction"]>[1],
  intent: string,
): Promise<CommerceActionRecord> {
  const raw = await controlMutation(
    `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions`,
    "POST",
    action,
    undefined,
    intent,
  );
  return parseCommerceActionRecordResponse(raw);
}
