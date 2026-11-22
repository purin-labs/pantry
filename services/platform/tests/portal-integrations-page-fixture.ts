// The portal owns its browser-only React runtime; the platform test harness renders it through the app-local package.
// @ts-expect-error React runtime declarations are scoped to apps/portal.
import React from "../../../apps/portal/node_modules/react";
// @ts-expect-error React DOM runtime declarations are scoped to apps/portal.
import { renderToStaticMarkup as renderStaticMarkup } from "../../../apps/portal/node_modules/react-dom/server";
import { StaticRouter } from "../../../apps/portal/node_modules/react-router";
import { MutationLedger } from "@purin-labs/control/portal/mutation-state";
import {
  IntegrationsPage,
  // @ts-expect-error The portal build type-checks this JSX module.
} from "../../../apps/portal/src/features/integrations/settings-routes";

const noOp = async (): Promise<void> => {};

/** Every page action resolves at once; a render test never calls one. */
export const PORTAL_ACTIONS = new Proxy({}, { get: () => noOp });

export const INTEGRATIONS_PAGE_PROPS = {
  organisationId: "organisation_onboarding",
  organisationHandle: "cafe",
  workspaceHandle: "central",
  commerceSystem: null,
  commerceSyncProblem: null,
  codexConnection: { kind: "disconnected", revision: 0 },
  inferenceSelection: { kind: "pantry_platform" },
  accounts: [],
  credentialInventory: null,
  destinations: [],
  slackRouting: [],
  supportDiagnostics: null,
  agentMailboxes: [],
  emailReplies: [],
  emailOperational: [],
  mailboxInstallations: [],
  whatsapp: { applicationConfigured: true, accounts: [], replies: [] },
  whatsappActions: PORTAL_ACTIONS,
  setupDefaults: {
    key: "read_and_propose:commerce_operator::",
    capabilityProfile: "read_and_propose",
    cuePresetId: "commerce_operator",
    workspaceId: "",
    channelId: "",
  },
  setupFeedback: { kind: "idle" },
  readiness: null,
  activation: { kind: "idle", organisation_id: "organisation_onboarding" },
  firstTask: null,
  organisationIsActive: true,
  canManage: true,
  canConnectCodex: true,
  mutations: MutationLedger.empty(),
  pendingAuthorization: null,
  pendingConfirm: null,
  requestConfirm: () => {},
  actions: PORTAL_ACTIONS,
  feedback: null,
};

/** Renders the Integrations page with the base props and the given changes. */
export function renderIntegrationsPage(
  overrides: Record<string, unknown>,
): string {
  return renderPortalMarkup(
    React.createElement(IntegrationsPage, {
      ...INTEGRATIONS_PAGE_PROPS,
      ...overrides,
    }),
  );
}

/** Renders a portal element inside the Integrations route. */
export function renderPortalMarkup(element: React.ReactNode): string {
  return renderStaticMarkup(
    React.createElement(
      StaticRouter,
      { location: "/portal/cafe/central/integrations" },
      element,
    ),
  );
}
