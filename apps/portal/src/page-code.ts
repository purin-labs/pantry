// The code of each Portal page, loaded when the page first renders.
import React from "react";
import type { WorkspaceDetailPage } from "./route";

export const WorkflowSimulatorRoute = React.lazy(loadWorkflowSimulator);
export const ChatPage = React.lazy(loadChatPage);
export const MailInboxRoute = React.lazy(loadMailInboxRoute);
export const InventoryPage = React.lazy(loadInventoryPage);
export const RecipesPage = React.lazy(loadRecipesPage);
export const CostsPage = React.lazy(loadCostsPage);

export const InventoryProductionRequestsPage = React.lazy(
  loadInventoryProductionRequestsPage,
);
export const HomePage = React.lazy(loadHomePage);
export const CommerceEntityPlaneRoute = React.lazy(
  loadCommerceEntityPlaneRoute,
);
export const CheckoutProfilesRoute = React.lazy(loadCheckoutProfilesRoute);
export const MenuDraftRoute = React.lazy(loadMenuDraftRoute);
export const OrderQueueRoute = React.lazy(loadOrderQueueRoute);
export const RegisterRoute = React.lazy(loadRegisterRoute);
export const DevicesRoute = React.lazy(loadDevicesRoute);
export const BakesRoute = React.lazy(loadBakesRoute);
export const PaymentsRoute = React.lazy(loadPaymentsRoute);
export const BankPayoutsRoute = React.lazy(loadBankPayoutsRoute);
export const TerminalOperationsPanel = React.lazy(loadTerminalOperationsPanel);
export const SupplierPayoutsPanel = React.lazy(loadSupplierPayoutsPanel);
export const BrainRoute = React.lazy(loadBrainRoute);
export const VaultRoute = React.lazy(loadVaultRoute);
export const CommerceApiKeysRoute = React.lazy(loadCommerceApiKeysRoute);
export const JevFeaturesRoute = React.lazy(loadJevFeaturesRoute);
export const BillingRoute = React.lazy(loadBillingRoute);
export const IntegrationsRoute = React.lazy(loadIntegrationsRoute);
export const MailboxSettingsRoute = React.lazy(loadMailboxSettingsRoute);
export const WorkspaceSettingsRoute = React.lazy(loadWorkspaceSettingsRoute);
export const AgentOperationsRoute = React.lazy(loadAgentOperationsRoute);
export const AgentsRoute = React.lazy(loadAgentsRoute);
export const AccessRoute = React.lazy(loadAccessRoute);

/**
 * Starts the load of the code of a page that reads early, so that the page
 * mounts with the shell and takes its reads then.
 */
export function startWorkspacePageCode(page: WorkspaceDetailPage): void {
  switch (page) {
    case "overview":
      loadHomePage().catch(ignoreFailedPageCode);
      loadIntegrationsRoute().catch(ignoreFailedPageCode);
      return;
    case "integrations":
      loadIntegrationsRoute().catch(ignoreFailedPageCode);
      return;
    case "brain":
    case "knowledge":
    case "activity":
    case "tests":
      loadBrainRoute().catch(ignoreFailedPageCode);
      return;
    case "vault":
      loadVaultRoute().catch(ignoreFailedPageCode);
      return;
    case "api-keys":
      loadCommerceApiKeysRoute().catch(ignoreFailedPageCode);
      return;
    case "jev":
      loadJevFeaturesRoute().catch(ignoreFailedPageCode);
      return;
    case "billing":
      loadBillingRoute().catch(ignoreFailedPageCode);
      return;
    case "inbox":
      loadMailInboxRoute().catch(ignoreFailedPageCode);
      return;
    default:
      return;
  }
}

/** The page loads its code again when it renders, and reports a failure then. */
function ignoreFailedPageCode(): void {}

function loadWorkflowSimulator() {
  return import("./features/workflow-simulator/route");
}

async function loadMailInboxRoute() {
  const module = await import("./features/mail-inbox/route");
  return { default: module.MailInboxRoute };
}

async function loadChatPage() {
  const module = await import("./features/chat/route");
  return { default: module.ConnectedChatPage };
}

async function loadInventoryPage() {
  const module = await import("./features/commerce/inventory");
  return { default: module.InventoryPage };
}

async function loadRecipesPage() {
  const module = await import("./features/recipes/route");
  return { default: module.RecipesPage };
}

async function loadCostsPage() {
  const module = await import("./features/costs/route");
  return { default: module.CostsPage };
}

async function loadInventoryProductionRequestsPage() {
  const module = await import("./features/commerce/inventory-production");
  return { default: module.InventoryProductionRequestsPage };
}

async function loadHomePage() {
  const module = await import("./pages/home");
  return { default: module.HomePage };
}

async function loadCommerceEntityPlaneRoute() {
  const module = await import("./features/commerce/entity-plane/route");
  return { default: module.CommerceEntityPlaneRoute };
}

async function loadCheckoutProfilesRoute() {
  const module = await import("./features/checkout-profiles/route");
  return { default: module.CheckoutProfilesRoute };
}

async function loadBankPayoutsRoute() {
  const { BankPayoutsRoute } = await import("./features/bank-payouts/route");
  return { default: BankPayoutsRoute };
}

async function loadPaymentsRoute() {
  const { PaymentsRoute } = await import("./features/payments/route");
  return { default: PaymentsRoute };
}

async function loadDevicesRoute() {
  const { DevicesRoute } = await import("./features/devices/route");
  return { default: DevicesRoute };
}

async function loadBakesRoute() {
  const { BakesRoute } = await import("./features/bakes/route");
  return { default: BakesRoute };
}

async function loadOrderQueueRoute() {
  const { OrderQueueRoute } = await import("./features/order-queue/route");
  return { default: OrderQueueRoute };
}

async function loadRegisterRoute() {
  const { RegisterRoute } = await import("./features/register/route");
  return { default: RegisterRoute };
}

async function loadMenuDraftRoute() {
  const module = await import("./features/content-studio/route");
  return { default: module.MenuDraftRoute };
}

async function loadTerminalOperationsPanel() {
  const module = await import("./features/terminals/route");
  return { default: module.TerminalOperationsPanel };
}

async function loadSupplierPayoutsPanel() {
  const module = await import("./features/payouts/route");
  return { default: module.SupplierPayoutsPanel };
}

async function loadCommerceApiKeysRoute() {
  const module = await import("./features/api-keys/route");
  return { default: module.CommerceApiKeysRoute };
}

async function loadJevFeaturesRoute() {
  const module = await import("./features/jev-features/route");
  return { default: module.JevFeaturesRoute };
}

async function loadBillingRoute() {
  const module = await import("./features/billing/route");
  return { default: module.BillingRoute };
}

async function loadVaultRoute() {
  const module = await import("./features/vault/route");
  return { default: module.VaultRoute };
}

async function loadBrainRoute() {
  const module = await import("./features/brain/route");
  return { default: module.BrainRoute };
}

async function loadIntegrationsRoute() {
  const module = await import("./features/integrations/settings-routes");
  return { default: module.IntegrationsRoute };
}

async function loadMailboxSettingsRoute() {
  const module = await import("./features/integrations/settings-routes");
  return { default: module.MailboxSettingsRoute };
}

async function loadWorkspaceSettingsRoute() {
  const module = await import("./features/integrations/settings-routes");
  return { default: module.WorkspaceSettingsRoute };
}

async function loadAgentsRoute() {
  const module = await import("./pages/automation");
  return { default: module.AgentsRoute };
}

async function loadAgentOperationsRoute() {
  const module = await import("./pages/automation");
  return { default: module.AgentOperationsRoute };
}

async function loadAccessRoute() {
  const module = await import("./features/access/route");
  return { default: module.AccessRoute };
}
