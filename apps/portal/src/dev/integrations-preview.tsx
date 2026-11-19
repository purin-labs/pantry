/**
 * Dev-only visual harness for provider onboarding on the Integrations page.
 *
 * Serves at /integrations-preview.html under `pnpm portal`. Mounts the real
 * IntegrationsPage against fixture props so the file storage, email, and
 * WhatsApp onboarding states can be reviewed without the control plane:
 *
 *   ?integration=dropbox | gmail | whatsapp (omit for the overview)
 *   &scenario=empty | mixed | multiple-account | incomplete-setup | attention
 *             | viewer | loading | stale-refresh | search-empty
 *   &provider=dropbox | google_drive | gmail | whatsapp   (which provider the scenario is about)
 *   &account=<integrationAccountId>   (opens one account; omit it for the list)
 *   &detailDelay=<ms>   (route mode: holds each detail read, as a slow one)
 *
 * `?integration=codex` shows a connected ChatGPT subscription;
 * `&scenario=viewer` shows it to a member who cannot change it.
 * `&claude=disconnected | authorizing | connected` selects Claude instead,
 * over a stand-in for its connection route (add `&codex=disconnected`).
 *
 * Email has two views. `?integration=gmail&scenario=connected` lists five
 * connections: one on, one off, one paused, one with no agent and one that
 * only sends. Add `&account=intacc_gmail_orders` (or click a row) for one
 * mailbox's own view. A mailbox with no agent shows its setup: `&setup=new`
 * for a workspace with no agent, `&setup=nuki` for an agent that is not
 * active, `&setup=model` for a model that is not approved, and
 * `&setup=failed` for a setup that cannot be read.
 *
 * Route mode (`?mode=route&integration=<tile>&scenario=…`) mounts the real
 * IntegrationsRoute over an in-memory transport, so the consent-window watch
 * and the completion handshake run for real. Connecting opens
 * `?popup=<provider>`, a stand-in for the provider's window that can approve
 * through the same handshake the platform's callback page uses, come back
 * through a portal path like the failure page's link, or simply be closed.
 * An approved Slack window adds the Slack workspace and its channels to the
 * reads that follow; `&setup=1` shows the setup steps that start it.
 */
import { isRecord } from "@purin-labs/std";
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useSearchParams } from "react-router";
import { Toaster } from "sonner";

import "../styles.css";
import { installClaudeConnectionPreview } from "./claude-connection-preview";
import { installVaultIntegrationPreview } from "./vault-integration-preview";
import { installCustomConnectorPreview } from "./custom-connector-preview";
import { MutationLedger, type MutationProvider } from "../mutation-state";
import type { AgentMailboxView, EmailReplyPreviewResult, EmailReplyQueueItem } from "@purin-labs/control-api/portal/agent-mailbox";
import { IntegrationsPage } from "../features/integrations/integrations-page";
import {
  IntegrationsRoute,
  MailboxSettingsRoute,
} from "../features/integrations/settings-routes";
import type { IntegrationAccount, SupportDiagnostics } from "@purin-labs/control-api/portal/settings";
import type { IntegrationsCommand, IntegrationsCommandResult, IntegrationsPageActions, IntegrationsPageProps, IntegrationDetailRouteData, IntegrationsRouteData, IntegrationsRouteTransport, SettingsMutationFeedback } from "../features/integrations/settings-types";
import type { WhatsAppPanelActions } from "../pages/whatsapp";
import type {
  MailboxSetupAgent,
  MailboxSetupAgentChoice,
  MailboxSetupPlan,
} from "@purin-labs/control-api";
import type { WhatsAppAccountView } from "@purin-labs/control-api/portal/whatsapp";
import type { Variant } from "@purin-labs/type-utils";

type Scenario =
  | "empty"
  | "mixed"
  | "multiple-account"
  | "incomplete-setup"
  | "attention"
  | "loading"
  | "stale-refresh"
  | "search-empty"
  | "available"
  | "opening"
  | "waiting"
  | "connected"
  | "failed"
  | "attempt_failed"
  | "reconnect"
  | "unconfigured"
  | "viewer";
type PreviewProvider = Extract<
  MutationProvider,
  "dropbox" | "google_drive" | "gmail" | "whatsapp"
>;

const NOW = Date.parse("2026-09-05T09:00:00+09:00");

const settle = async (): Promise<void> => {};

/**
 * The mailbox forms post nowhere in page mode. Keep the page in place and log
 * the fields, so a reviewer can read what each control sends.
 */
async function logPreviewForm(
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  console.log(
    "[preview] submit",
    Object.fromEntries(new FormData(event.currentTarget)),
  );
}

async function logPreviewClick(
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  console.log("[preview] click", event.currentTarget.textContent, {
    ...event.currentTarget.dataset,
  });
}
const unavailable = async (): Promise<never> => {
  throw new Error("Preview only.");
};
const nothing = (): void => {};

const ACTIONS: IntegrationsPageActions = {
  syncCommerceSystem: settle,
  syncCommerceSystemQuietly: settle,
  setupSatyrCommerce: settle,
  publishExportCoordination: settle,
  selectShopifyCommerce: settle,
  connectShopify: settle,
  connectAirtable: settle,
  connectDropbox: settle,
  connectGmail: settle,
  connectGmailSendOnly: settle,
  connectGoogleDrive: settle,
  connectWhatsApp: settle,
  connectNotion: settle,
  connectStripe: settle,
  connectSquare: settle,
  connectSlack: settle,
  cancelProviderAuthorization: nothing,
  refreshOverview: nothing,
  connectCodex: settle,
  reconnectCodex: settle,
  cancelCodexAuthorization: settle,
  completeCodexAuthorization: settle,
  disconnectCodex: settle,
  saveInferenceSelection: settle,
  disableAccount: settle,
  reconnectAccount: settle,
  rotateAccount: settle,
  setDefaultAccount: settle,
  removeAccount: settle,
  refreshAccountResources: settle,
  selectSlackDmOrganisation: settle,
  saveSetup: settle,
  activate: settle,
  rotateCredential: async () => ({
    kind: "failed",
    errorKind: "unknown",
    message: "Preview only.",
  }),
  revokeCredential: async () => ({
    kind: "failed",
    errorKind: "unknown",
    message: "Preview only.",
  }),
  publishMailboxPolicy: logPreviewForm,
  readMailboxSetup: previewMailboxSetup,
  setUpMailbox: (request) => {
    console.log("[preview] set up mailbox", request);
  },
  resumeMailbox: logPreviewClick,
  skipAndResumeMailbox: logPreviewClick,
  reconnectMailbox: logPreviewClick,
  disableMailbox: logPreviewClick,
  revokeMailbox: logPreviewClick,
  loadEmailReply: async () => REPLY_PREVIEW,
  editEmailReply: settle,
  saveEmailReplyDraft: settle,
  reloadEmailReplyDraft: settle,
  approveEmailReply: settle,
  rejectEmailReply: settle,
  resolveEmailReply: settle,
  loadEmailOperational: async () => ({ kind: "expired" }),
  approveEmailOperational: settle,
  rejectEmailOperational: settle,
  editEmailOperational: settle,
  attestEmailOperational: settle,
};

const WHATSAPP_ACTIONS: WhatsAppPanelActions = {
  connect: settle,
  cancelConnection: nothing,
  select: settle,
  bindAgent: settle,
  publishPolicy: settle,
  disable: settle,
  reconnect: settle,
  revoke: settle,
  resume: settle,
};

function account(
  fields: Pick<
    IntegrationAccount,
    | "integrationAccountId"
    | "provider"
    | "providerAccountId"
    | "accountKind"
    | "displayName"
  > &
    Partial<
      Pick<
        IntegrationAccount,
        | "lifecycle"
        | "credentialHealth"
        | "selectedResources"
        | "eventRecency"
        | "scopes"
        | "capabilities"
        | "isDefaultForProvider"
      >
    >,
): IntegrationAccount {
  return {
    environment: "development",
    lifecycle: { kind: "active" },
    isDefaultForProvider: true,
    capabilities: [],
    scopes: [],
    credentialHealth: { kind: "healthy" },
    webhookHealth: { kind: "missing" },
    eventRecency: { kind: "unavailable" },
    selectedResources: [],
    ...fields,
  };
}

const DROPBOX_ACCOUNT = account({
  integrationAccountId: "intacc_dropbox",
  provider: "dropbox",
  providerAccountId: "dbid:nuki",
  accountKind: "account",
  displayName: "Nuki Cafe",
  scopes: ["files.metadata.read", "files.content.read"],
  selectedResources: [
    {
      resource_kind: "dropbox_folder",
      canonical_resource_id: "id:menus",
      display_label: "/Business/Menus",
    },
  ],
  eventRecency: { kind: "available", at: NOW - 3_600_000 },
});

const GOOGLE_DRIVE_ACCOUNT = account({
  integrationAccountId: "intacc_drive",
  provider: "google_drive",
  providerAccountId: "drive:nuki",
  accountKind: "account",
  displayName: "owner@nuki.cafe",
  scopes: ["https://www.googleapis.com/auth/drive.file"],
});

const SECOND_GOOGLE_DRIVE_ACCOUNT = account({
  integrationAccountId: "intacc_drive_supplier",
  provider: "google_drive",
  providerAccountId: "drive:supplier",
  accountKind: "account",
  displayName: "seasonal-supplier-records@nuki-cafe.example",
  scopes: ["https://www.googleapis.com/auth/drive.file"],
  selectedResources: [
    {
      resource_kind: "google_drive_file",
      canonical_resource_id: "drive-file:supplier-orders",
      display_label: "Supplier orders",
    },
  ],
  isDefaultForProvider: false,
});

const GMAIL_ACCOUNT = account({
  integrationAccountId: "intacc_gmail",
  provider: "gmail",
  providerAccountId: "gmail:support",
  accountKind: "mailbox",
  displayName: "support@nuki.cafe",
  capabilities: ["mailbox.ingress"],
  eventRecency: { kind: "available", at: NOW - 600_000 },
});

const GMAIL_ORDERS_ACCOUNT = account({
  integrationAccountId: "intacc_gmail_orders",
  provider: "gmail",
  providerAccountId: "gmail:orders",
  accountKind: "mailbox",
  displayName: "orders@nuki.cafe",
  capabilities: ["mailbox.ingress"],
  isDefaultForProvider: false,
});

const GMAIL_BILLING_ACCOUNT = account({
  integrationAccountId: "intacc_gmail_billing",
  provider: "gmail",
  providerAccountId: "gmail:billing",
  accountKind: "mailbox",
  displayName: "billing@nuki.cafe",
  capabilities: ["mailbox.ingress"],
  isDefaultForProvider: false,
});

const GMAIL_EVENTS_ACCOUNT = account({
  integrationAccountId: "intacc_gmail_events",
  provider: "gmail",
  providerAccountId: "gmail:events",
  accountKind: "mailbox",
  displayName: "events@nuki.cafe",
  capabilities: ["mailbox.ingress"],
  isDefaultForProvider: false,
});

const GMAIL_SEND_ONLY_ACCOUNT = account({
  integrationAccountId: "intacc_gmail_send_only",
  provider: "gmail",
  providerAccountId: "gmail:notices",
  accountKind: "mailbox",
  displayName: "notices@nuki.cafe",
  capabilities: ["email.operational.propose"],
  isDefaultForProvider: false,
});

/** A removed account stays as a revoked row; the overview leaves it out. */
const REMOVED_GOOGLE_DRIVE_ACCOUNT = account({
  integrationAccountId: "intacc_google_drive_removed",
  provider: "google_drive",
  providerAccountId: "removed:google-drive",
  accountKind: "account",
  displayName: "Removed account",
  lifecycle: { kind: "revoked" },
  isDefaultForProvider: false,
});

const REAUTH_REQUIRED: IntegrationAccount["lifecycle"] = {
  kind: "reauth_required",
  reasonCode: "oauth_scope_revoked",
};

const MAILBOX: AgentMailboxView = {
  integrationAccountId: GMAIL_ACCOUNT.integrationAccountId,
  observedAddress: GMAIL_ACCOUNT.displayName,
  connectionLifecycle: "active",
  authorization: {
    authorizedAt: NOW - 86_400_000,
    expiresAt: NOW + 86_400_000 * 150,
    expiryWindowDays: 180,
  },
  binding: null,
  policy: { kind: "disabled_by_default" },
  runtime: null,
};

const MAILBOX_AGENT: NonNullable<AgentMailboxView["binding"]> = {
  mailboxBindingId: "mailbox_binding_preview",
  currentRevision: 1,
  installationId: "inst_urk",
};

const MAILBOX_LIMITS: Variant<AgentMailboxView["policy"], "enabled"> =
  {
    kind: "enabled",
    policyVersion: 2,
    maxActiveCases: 3,
    maxMessagesPerHour: 20,
    dailyTokenBudget: 250_000,
    maxMessageBytes: 262_144,
    maxAttachmentBytes: 5_242_880,
  };

const MAILBOX_USAGE: NonNullable<AgentMailboxView["runtime"]>["usage"] = {
  activeCases: 1,
  admittedLastHour: 2,
  tokensReserved: 0,
  tokensConsumed: 12_000,
  nextEvaluationAt: null,
};

/** On: an agent reads new mail. */
const MAILBOX_ON: AgentMailboxView = {
  ...MAILBOX,
  binding: MAILBOX_AGENT,
  policy: MAILBOX_LIMITS,
  runtime: {
    processing: { kind: "waiting" },
    acceptedHistoryId: "9001",
    watchExpiresAt: NOW + 86_400_000 * 5,
    usage: MAILBOX_USAGE,
  },
};

/** Off: an agent is assigned, and the operator turned processing off. */
const MAILBOX_OFF: AgentMailboxView = {
  ...MAILBOX,
  integrationAccountId: GMAIL_ORDERS_ACCOUNT.integrationAccountId,
  observedAddress: GMAIL_ORDERS_ACCOUNT.displayName,
  binding: MAILBOX_AGENT,
  policy: { kind: "disabled_by_operator", policyVersion: 3 },
};

/** Paused: three Cases are open and the limit is three. */
const MAILBOX_PAUSED: AgentMailboxView = {
  ...MAILBOX_ON,
  integrationAccountId: GMAIL_BILLING_ACCOUNT.integrationAccountId,
  observedAddress: GMAIL_BILLING_ACCOUNT.displayName,
  runtime: {
    processing: {
      kind: "paused",
      reason: {
        kind: "active_case_limit",
        observed: 3,
        limit: 3,
        providerMessageId: null,
      },
      pausedAt: NOW - 900_000,
    },
    acceptedHistoryId: "9002",
    watchExpiresAt: NOW + 86_400_000 * 5,
    usage: { ...MAILBOX_USAGE, activeCases: 3 },
  },
};

/** Needs setup: connected, and no agent is assigned yet. */
const MAILBOX_NEEDS_SETUP: AgentMailboxView = {
  ...MAILBOX,
  integrationAccountId: GMAIL_EVENTS_ACCOUNT.integrationAccountId,
  observedAddress: GMAIL_EVENTS_ACCOUNT.displayName,
};

/** The sample mailboxes that an agent answers. */
const ASSIGNED_MAILBOXES: readonly string[] = [
  MAILBOX_ON.integrationAccountId,
  MAILBOX_OFF.integrationAccountId,
  MAILBOX_PAUSED.integrationAccountId,
];

function previewSetupAgent(
  choice: MailboxSetupAgentChoice,
  assigned: boolean,
  variant: string | null,
): MailboxSetupAgent {
  const merchantAgent: MailboxSetupAgent = {
    choice: { kind: "installation", installationId: "inst_urk" },
    name: "Sous Chef (support agent)",
    state: assigned ? "assigned" : "ready",
  };
  const nuki: MailboxSetupAgent = {
    choice: { kind: "definition", agentDefinitionId: "agent_nuki" },
    name: "Nuki",
    state: "inactive",
  };
  const created: MailboxSetupAgent = {
    choice: { kind: "new" },
    name: "Mail assistant",
    state: "absent",
  };
  switch (choice.kind) {
    case "installation":
      return merchantAgent;
    case "definition":
      return nuki;
    case "new":
      return created;
    case "automatic":
      if (assigned) return merchantAgent;
      return variant === "new" ? created : variant === "nuki" ? nuki : merchantAgent;
  }
}

/** The setup of a sample mailbox, as the `setup` query value asks. */
async function previewMailboxSetup(
  integrationAccountId: string,
  choice: MailboxSetupAgentChoice,
): Promise<MailboxSetupPlan> {
  const variant = new URLSearchParams(window.location.search).get("setup");
  if (variant === "failed") throw new Error("Preview only.");
  const assigned = ASSIGNED_MAILBOXES.includes(integrationAccountId);
  const agent = previewSetupAgent(choice, assigned, variant);
  const answers = agent.state === "assigned";
  const approved = variant !== "model";
  return {
    agent,
    requirements: [
      { id: "agent", state: answers ? "met" : "missing" },
      { id: "reply_drafts", state: assigned ? "met" : "missing" },
      { id: "agent_context", state: answers ? "met" : "missing" },
      { id: "review", state: assigned ? "met" : "missing" },
      { id: "model", state: approved ? "met" : "missing" },
    ],
    next: answers
      ? null
      : { kind: "assign_agent", body: { installationId: "inst_urk" } },
    model: { kind: approved ? "approved" : "not_approved" },
  };
}

/** One reply that waits for review, with the memories its draft used. */
const WAITING_REPLY: EmailReplyQueueItem = {
  proposalId: "proposal_preview_reply",
  integrationAccountId: GMAIL_ACCOUNT.integrationAccountId,
  caseId: "case_preview_reply",
  gmailThreadId: "thread_preview_reply",
  version: 1,
  lifecycleKind: "awaiting_approval",
  createdAt: NOW - 600_000,
  updatedAt: NOW - 600_000,
  headline: null,
};

/** A second mailbox's reply, so that each mailbox shows its own count. */
const WAITING_BILLING_REPLY: EmailReplyQueueItem = {
  ...WAITING_REPLY,
  proposalId: "proposal_preview_billing_reply",
  integrationAccountId: GMAIL_BILLING_ACCOUNT.integrationAccountId,
  caseId: "case_preview_billing_reply",
  gmailThreadId: "thread_preview_billing_reply",
  updatedAt: NOW - 1_200_000,
};

/** Closed replies: the mailbox's review list leaves them to Inbox. */
const CLOSED_REPLIES: readonly EmailReplyQueueItem[] = [
  {
    ...WAITING_REPLY,
    proposalId: "proposal_preview_sent_reply",
    lifecycleKind: "sent",
    updatedAt: NOW - 86_400_000,
  },
  {
    ...WAITING_REPLY,
    proposalId: "proposal_preview_expired_reply",
    lifecycleKind: "expired",
    updatedAt: NOW - 172_800_000,
  },
];

const REPLY_PREVIEW: EmailReplyPreviewResult = {
  kind: "current",
  proposal: {
    proposalId: WAITING_REPLY.proposalId,
    version: 1,
    bodyEdited: false,
    to: "orders@flour-supplier.example",
    subject: "Re: Tomorrow's order",
    gmailThreadId: WAITING_REPLY.gmailThreadId,
    body: "Tomorrow's order closed at noon, so we cannot change it now.",
    snapshotDigest: "0".repeat(64),
    expiresAt: NOW + 86_400_000,
  },
  challenge: "preview",
  memory: [
    {
      memoryId: "memory_preview_cutoff",
      revision: 1,
      statement:
        "Next-day orders close at noon. Changes after noon are refused.",
    },
    {
      memoryId: "memory_preview_contact",
      revision: 2,
      statement: "Send order questions to the supplier's orders address.",
    },
  ],
  sources: [],
};

const WHATSAPP_NUMBER: WhatsAppAccountView = {
  integrationAccountId: "intacc_wa_main",
  wabaId: "100000000000001",
  phoneNumberId: "200000000000001",
  displayPhoneNumber: "+81 3-1234-5678",
  verifiedName: "Nuki Cafe",
  selectedAt: NOW - 86_400_000 * 3,
  providerHealth: { kind: "healthy", webhookVerifiedAt: NOW - 3_600_000 },
  policy: { kind: "disabled_by_default" },
  binding: null,
  runtime: null,
};

const WHATSAPP_CANDIDATE: WhatsAppAccountView = {
  ...WHATSAPP_NUMBER,
  integrationAccountId: "intacc_wa_second",
  phoneNumberId: "200000000000002",
  displayPhoneNumber: "+81 3-1234-9999",
  verifiedName: "",
  selectedAt: null,
  providerHealth: { kind: "pending" },
};

function scenarioAccounts(scenario: Scenario): readonly IntegrationAccount[] {
  switch (scenario) {
    case "empty":
    case "search-empty":
    case "available":
    case "opening":
    case "waiting":
    case "failed":
    case "attempt_failed":
    case "unconfigured":
      return [];
    case "mixed":
    case "loading":
    case "stale-refresh":
    case "viewer":
      return [DROPBOX_ACCOUNT, GOOGLE_DRIVE_ACCOUNT, GMAIL_ACCOUNT];
    case "connected":
      return [
        DROPBOX_ACCOUNT,
        GOOGLE_DRIVE_ACCOUNT,
        GMAIL_ACCOUNT,
        GMAIL_ORDERS_ACCOUNT,
        GMAIL_BILLING_ACCOUNT,
        GMAIL_EVENTS_ACCOUNT,
        GMAIL_SEND_ONLY_ACCOUNT,
      ];
    case "multiple-account":
      return [
        GOOGLE_DRIVE_ACCOUNT,
        SECOND_GOOGLE_DRIVE_ACCOUNT,
        REMOVED_GOOGLE_DRIVE_ACCOUNT,
      ];
    case "incomplete-setup":
      return [GOOGLE_DRIVE_ACCOUNT];
    case "attention":
    case "reconnect":
      return [
        {
          ...DROPBOX_ACCOUNT,
          lifecycle: REAUTH_REQUIRED,
          credentialHealth: { kind: "degraded" },
        },
        GOOGLE_DRIVE_ACCOUNT,
        {
          ...GMAIL_ACCOUNT,
          lifecycle: REAUTH_REQUIRED,
          credentialHealth: { kind: "degraded" },
        },
      ];
  }
}

function scenarioWhatsAppAccounts(
  scenario: Scenario,
): readonly WhatsAppAccountView[] {
  switch (scenario) {
    case "mixed":
    case "connected":
      return [WHATSAPP_NUMBER, WHATSAPP_CANDIDATE];
    case "viewer":
    case "reconnect":
    case "unconfigured":
      return [WHATSAPP_NUMBER];
    default:
      return [];
  }
}

function scenarioMutations(
  scenario: Scenario,
  provider: PreviewProvider,
): MutationLedger {
  const ledger = MutationLedger.empty();
  if (scenario !== "opening") return ledger;
  const added = ledger.add({ kind: "connect_provider", provider });
  return added.kind === "added" ? added.ledger : ledger;
}

function scenarioFeedback(
  scenario: Scenario,
  provider: PreviewProvider,
): SettingsMutationFeedback {
  if (scenario !== "failed") return null;
  return {
    mutation: { kind: "connect_provider", provider },
    message:
      provider === "whatsapp"
        ? "Meta sent you back without finishing the connection. Nothing was changed. Try again, and contact support if it keeps happening."
        : "This integration is unavailable. Ask your Seams Pantry administrator to configure it, then try again.",
  };
}

function scenarioDiagnostics(
  scenario: Scenario,
  provider: PreviewProvider,
): SupportDiagnostics | null {
  if (scenario !== "attempt_failed") return null;
  return {
    supportReference: "SATYR-3f2a9c0e-7d41-4b0a-9a6e-2c1d5e8f0b77",
    provider,
    displayAccount: null,
    reasonCode:
      provider === "whatsapp"
        ? "provider_asset_missing"
        : provider === "gmail"
          ? "provider_scope_missing"
          : "authorization_cancelled",
    occurredAt: NOW - 25 * 60_000,
    retryStatus: "terminal",
    lastSuccessfulPhase: "discovering_identity",
    webhookHealth: { live: 0, degraded: 0, disabled: 0, revoked: 0 },
    projectionRevision: 41,
  };
}

function scenarioMailboxes(scenario: Scenario): readonly AgentMailboxView[] {
  switch (scenario) {
    case "mixed":
    case "loading":
    case "stale-refresh":
    case "viewer":
      return [MAILBOX];
    case "connected":
      return [MAILBOX_ON, MAILBOX_OFF, MAILBOX_PAUSED, MAILBOX_NEEDS_SETUP];
    case "reconnect":
      return [{ ...MAILBOX, connectionLifecycle: "reauth_required" }];
    default:
      return [];
  }
}

const CODEX_CONNECTED: IntegrationsPageProps["codexConnection"] = {
  kind: "connected",
  revision: 3,
  signIn: "chatgpt_agent",
  planType: "pro",
  allowance: { kind: "not_reported" },
  connectedAt: Date.now() - 86_400_000,
  verifiedAt: Date.now() - 120_000,
};

const CODEX_DEVICE_CONNECTED: IntegrationsPageProps["codexConnection"] = {
  kind: "connected",
  revision: 2,
  signIn: "codex_device",
  planType: "pro",
  allowance: {
    kind: "available",
    usedPercent: 12,
    resetsAt: null,
    secondaryUsedPercent: null,
    secondaryResetsAt: null,
    credits: "available",
  },
  connectedAt: Date.now() - 86_400_000,
  verifiedAt: Date.now() - 120_000,
};

/**
 * `?codex=disconnected|authorizing|device|old` shows the other ChatGPT
 * states,
 * `?commerce=none|syncing|ready` the states of Pantry Commerce, and `?setup`
 * the setup checklist of a workspace that is not active yet.
 */
function previewParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function previewCodexConnection(
  integration: string,
): IntegrationsPageProps["codexConnection"] {
  switch (previewParam("codex")) {
    case "disconnected":
      return { kind: "disconnected", revision: 0 };
    case "authorizing":
      return {
        kind: "authorizing",
        revision: 1,
        attempt: {
          attemptId: "codex_authorization_preview",
          method: "pasted_callback",
          verificationUrl:
            "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client",
          userCode: null,
          expiresAt: Date.now() + 15 * 60_000,
        },
      };
    case "device":
      return {
        kind: "authorizing",
        revision: 1,
        attempt: {
          attemptId: "codex_authorization_preview",
          method: "device_code",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "VU8Y-L4MAW",
          expiresAt: Date.now() + 15 * 60_000,
        },
      };
    case "old":
      return CODEX_DEVICE_CONNECTED;
    case "connected":
      return CODEX_CONNECTED;
    default:
      return integration === "codex"
        ? CODEX_CONNECTED
        : { kind: "disconnected", revision: 0 };
  }
}

function previewCommerceSystem(): IntegrationsPageProps["commerceSystem"] {
  const commerce = previewParam("commerce");
  if (commerce === null || commerce === "none") return null;
  return {
    kind: "satyr_commerce",
    bindingId: "underclerk_binding_preview",
    merchantId: "merchant_preview",
    revision: 1,
    sync:
      commerce === "syncing"
        ? {
            kind: "syncing",
            acceptedResourceCount: 0,
            requestedAt: Date.now() - 5_000,
            previousLastSyncedAt: null,
          }
        : {
            kind: "ready",
            acceptedResourceCount: 42,
            lastSyncedAt: Date.now() - 120_000,
          },
  };
}

/** `?slack=connected` adds one Slack workspace with two channels to choose. */
const SLACK_ACCOUNT = account({
  integrationAccountId: "intacc_slack",
  provider: "slack",
  providerAccountId: "T0CAFEOS",
  accountKind: "workspace",
  displayName: "CafeOS",
  scopes: ["chat:write", "channels:read"],
});

const SLACK_DESTINATIONS: IntegrationsPageProps["destinations"] = [
  {
    integrationAccountId: SLACK_ACCOUNT.integrationAccountId,
    workspaceId: SLACK_ACCOUNT.providerAccountId,
    channels: [
      {
        canonicalResourceId: "C0KITCHEN",
        displayLabel: "#kitchen",
        accessState: "accessible",
      },
      {
        canonicalResourceId: "C0ORDERS",
        displayLabel: "#orders",
        accessState: "accessible",
      },
    ],
  },
];

function previewSlack(): Pick<
  IntegrationsPageProps,
  "destinations" | "slackRouting"
> & { readonly accounts: readonly IntegrationAccount[] } {
  if (previewParam("slack") === null)
    return { accounts: [], destinations: [], slackRouting: [] };
  return {
    accounts: [SLACK_ACCOUNT],
    destinations: SLACK_DESTINATIONS,
    slackRouting: [
      {
        installationId: "slack_installation_preview",
        connectionId: "slack_connection_preview",
        integrationAccountId: SLACK_ACCOUNT.integrationAccountId,
        workspaceId: SLACK_ACCOUNT.providerAccountId,
        lifecycle: "active",
        channelDefaults: [
          { channelId: "C0KITCHEN", revision: 1, boundAt: Date.now() },
        ],
        sharedWorkspace: previewParam("shared") !== null,
      },
    ],
  };
}

function previewReadiness(): IntegrationsPageProps["readiness"] {
  if (previewParam("setup") === null) return null;
  return {
    kind: "blocked",
    blockers: [
      "runtime_admission_unavailable",
      "commerce_system_missing",
      "communication_connection_missing",
      "communication_destination_missing",
      "policy_snapshot_missing",
      "cue_snapshot_missing",
    ].map((code) => ({ code, integrationAccountId: null })),
    approvalAuthentication: [],
  };
}

function buildProps(
  scenario: Scenario,
  provider: PreviewProvider,
  integration: string,
  initialQuery = "",
  initialAccountId?: string,
  initialFocusId?: string,
): IntegrationsPageProps {
  return {
    organisationId: "organisation_preview",
    organisationHandle: "nuki",
    workspaceHandle: "cafe",
    commerceSystem: previewCommerceSystem(),
    commerceSyncProblem: null,
    codexConnection: previewCodexConnection(integration),
    inferenceSelection:
      previewParam("claude") !== null
        ? { kind: "claude_oauth" }
        : integration === "codex" || previewParam("codex") !== null
          ? { kind: "codex_subscription" }
          : { kind: "satyr_platform" },
    accounts: [...scenarioAccounts(scenario), ...previewSlack().accounts],
    credentialInventory: null,
    destinations: previewSlack().destinations,
    slackRouting: previewSlack().slackRouting,
    supportDiagnostics: scenarioDiagnostics(scenario, provider),
    agentMailboxes: scenarioMailboxes(scenario),
    emailReplies:
      scenario === "connected"
        ? [WAITING_REPLY, WAITING_BILLING_REPLY, ...CLOSED_REPLIES]
        : [],
    emailOperational: [],
    mailboxInstallations: [
      {
        kind: "ready",
        installationId: "inst_urk",
        label: "Sous Chef (support agent)",
      },
      {
        kind: "setup_needed",
        agentDefinitionId: "agent_nuki",
        label: "Nuki",
      },
    ],
    whatsapp: {
      applicationConfigured: scenario !== "unconfigured",
      accounts: scenarioWhatsAppAccounts(scenario),
      replies: [],
    },
    whatsappActions: WHATSAPP_ACTIONS,
    setupDefaults: {
      key: "read_and_propose:commerce_operator::",
      capabilityProfile: "read_and_propose",
      cuePresetId: "commerce_operator",
      workspaceId: "",
      channelId: "",
    },
    setupFeedback: { kind: "idle" },
    readiness: previewReadiness(),
    activation: { kind: "idle", organisation_id: "organisation_preview" },
    firstTask: null,
    organisationIsActive: previewParam("setup") === null,
    configurationVersion: 1,
    canManage: scenario !== "viewer",
    canConnectCodex: scenario !== "viewer",
    mutations: scenarioMutations(scenario, provider),
    pendingAuthorization:
      scenario === "waiting" ? { kind: "connect", provider } : null,
    pendingConfirm: null,
    requestConfirm: nothing,
    actions: ACTIONS,
    feedback: scenarioFeedback(scenario, provider),
    initialIntegrationId: integration === "overview" ? undefined : integration,
    initialAccountId,
    initialQuery,
    initialFocusId,
    integrationBasePath: previewBasePath("page", scenario, provider),
  };
}

const SCENARIOS: readonly Scenario[] = [
  "empty",
  "mixed",
  "multiple-account",
  "incomplete-setup",
  "attention",
  "loading",
  "stale-refresh",
  "search-empty",
  "available",
  "opening",
  "waiting",
  "connected",
  "failed",
  "attempt_failed",
  "reconnect",
  "unconfigured",
  "viewer",
];
const PROVIDERS: readonly PreviewProvider[] = [
  "dropbox",
  "google_drive",
  "gmail",
  "whatsapp",
];

function parseScenario(value: string | null): Scenario {
  return SCENARIOS.find((scenario) => scenario === value) ?? "available";
}

function parseProvider(
  value: string | null,
  integration: string,
): PreviewProvider {
  const named = PROVIDERS.find((provider) => provider === value);
  if (named !== undefined) return named;
  return integration === "gmail"
    ? "gmail"
    : integration === "whatsapp"
      ? "whatsapp"
      : "dropbox";
}

function providerTab(provider: PreviewProvider): string {
  return provider;
}

type PreviewMode = "page" | "route";

function previewPath(
  mode: PreviewMode,
  integration: string,
  scenario: Scenario,
  provider: PreviewProvider,
): string {
  const query = new URLSearchParams({ scenario, provider });
  if (mode === "route") query.set("mode", mode);
  keepDetailDelay(query);
  if (integration !== "overview") query.set("integration", integration);
  if (scenario === "search-empty") query.set("q", "quickbooks");
  return `/integrations-preview.html?${query.toString()}`;
}

function previewBasePath(
  mode: PreviewMode,
  scenario: Scenario,
  provider: PreviewProvider,
): string {
  const query = new URLSearchParams({ scenario, provider });
  if (mode === "route") query.set("mode", mode);
  keepDetailDelay(query);
  return `/integrations-preview.html?${query.toString()}`;
}

function keepDetailDelay(query: URLSearchParams): void {
  const delay = previewParam("detailDelay");
  if (delay !== null) query.set("detailDelay", delay);
}

function buildRouteData(
  scenario: Scenario,
  provider: PreviewProvider,
): IntegrationsRouteData {
  const page = buildProps(scenario, provider, provider);
  return {
    commerceSystem: page.commerceSystem,
    commerceSyncProblem: page.commerceSyncProblem,
    codexConnection: page.codexConnection,
    inferenceSelection: page.inferenceSelection,
    accounts: page.accounts,
    supportReference:
      page.supportDiagnostics === null
        ? null
        : page.supportDiagnostics.supportReference,
    whatsappApplicationConfigured: page.whatsapp.applicationConfigured,
    setupDefaults: page.setupDefaults,
    readiness: page.readiness,
    activation: page.activation,
    firstTask: page.firstTask,
    organisationIsActive: page.organisationIsActive,
    configurationVersion: 1,
  };
}

function buildRouteDetailData(
  scenario: Scenario,
  provider: PreviewProvider,
): IntegrationDetailRouteData {
  const page = buildProps(scenario, provider, provider);
  return {
    destinations: page.destinations,
    slackRouting: [],
    supportDiagnostics: page.supportDiagnostics,
    credentialInventory: page.credentialInventory,
    agentMailboxes: page.agentMailboxes,
    emailReplies: page.emailReplies,
    emailOperational: page.emailOperational,
    mailboxInstallations: page.mailboxInstallations,
    whatsapp: page.whatsapp,
  };
}

function providerWindowUrl(provider: string): string {
  const query = new URLSearchParams({ popup: provider });
  return `${window.location.origin}/integrations-preview.html?${query.toString()}`;
}

function executePreviewCommand(
  data: IntegrationsRouteData,
  command: IntegrationsCommand,
): IntegrationsCommandResult {
  switch (command.kind) {
    case "connect_dropbox":
      return {
        kind: "authorization",
        authorizationUrl: providerWindowUrl("dropbox"),
      };
    case "connect_google_drive":
      return {
        kind: "authorization",
        authorizationUrl: providerWindowUrl("google_drive"),
      };
    case "connect_gmail":
      return {
        kind: "authorization",
        authorizationUrl: providerWindowUrl("gmail"),
      };
    case "connect_whatsapp":
      return {
        kind: "authorization",
        authorizationUrl: providerWindowUrl("whatsapp"),
      };
    case "connect_square":
      return {
        kind: "authorization",
        authorizationUrl: providerWindowUrl("square"),
      };
    case "connect_slack":
      return {
        kind: "authorization",
        authorizationUrl: providerWindowUrl("slack"),
      };
    case "reconnect_account":
    case "rotate_account": {
      const account = data.accounts.find(
        (entry) => entry.integrationAccountId === command.integrationAccountId,
      );
      return {
        kind: "authorization",
        authorizationUrl: providerWindowUrl(account?.provider ?? "dropbox"),
      };
    }
    default:
      return { kind: "completed" };
  }
}

function buildRouteTransport(
  scenario: Scenario,
  provider: PreviewProvider,
): IntegrationsRouteTransport {
  const data = buildRouteData(scenario, provider);
  const detailData = buildRouteDetailData(scenario, provider);
  const readState = { overviewCount: 0 };
  return {
    readOverview: readPreviewOverview.bind(null, scenario, data, readState),
    readDetail:
      scenario === "loading"
        ? readPendingPreviewDetail
        : readPreviewDetail.bind(null, detailData, previewDetailDelay()),
    readMailboxSetup: (_organisationId, integrationAccountId, choice) =>
      previewMailboxSetup(integrationAccountId, choice),
    execute: async (
      _organisationId,
      _organisationHandle,
      _workspaceHandle,
      _configurationVersion,
      command,
    ) => {
      console.log("[preview] execute", command);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return executePreviewCommand(data, command);
    },
    readEmailReply: unavailable,
    readEmailOperational: unavailable,
    whatsapp: {
      connect: settle,
      accountAction: settle,
    },
  };
}

function readPreviewOverview(
  scenario: Scenario,
  data: IntegrationsRouteData,
  state: { overviewCount: number },
): Promise<IntegrationsRouteData> {
  state.overviewCount += 1;
  if (scenario === "stale-refresh" && state.overviewCount > 1) {
    return Promise.reject(new Error("Preview refresh failed."));
  }
  if (previewParam("codex") === "authorizing" && state.overviewCount >= 3)
    return Promise.resolve(signedInPreviewOverview(data, state.overviewCount));
  return Promise.resolve(withApprovedSlack(data));
}

/**
 * The stand-in Slack window marks its approval here; the popup and the page
 * share this origin's storage. Each page load clears it.
 */
const APPROVED_SLACK_KEY = "satyr-preview-slack-approved";

function slackApproved(): boolean {
  try {
    return window.localStorage.getItem(APPROVED_SLACK_KEY) === "1";
  } catch {
    return false;
  }
}

function withApprovedSlack(data: IntegrationsRouteData): IntegrationsRouteData {
  if (
    !slackApproved() ||
    data.accounts.some((entry) => entry.provider === "slack")
  )
    return data;
  return {
    ...data,
    accounts: [...data.accounts, SLACK_ACCOUNT],
    readiness:
      data.readiness?.kind === "blocked"
        ? {
            ...data.readiness,
            blockers: data.readiness.blockers.filter(
              (blocker) => blocker.code !== "communication_connection_missing",
            ),
          }
        : data.readiness,
  };
}

function forgetApprovedSlack(): void {
  try {
    window.localStorage.removeItem(APPROVED_SLACK_KEY);
  } catch {
    // Storage is optional here: without it the preview stays unconnected.
  }
}

/**
 * `?codex=authorizing` in route mode finishes the sign-in on the third read.
 * That read still carries the readiness of the moment before the sign-in, as
 * the parallel reads of the Portal can; the reads after it do not.
 */
function signedInPreviewOverview(
  data: IntegrationsRouteData,
  read: number,
): IntegrationsRouteData {
  const readiness = data.readiness;
  return {
    ...data,
    codexConnection: CODEX_CONNECTED,
    readiness:
      read === 3 || readiness?.kind !== "blocked"
        ? readiness
        : {
            ...readiness,
            blockers: readiness.blockers.filter(
              (blocker) => blocker.code !== "runtime_admission_unavailable",
            ),
          },
  };
}

async function readPreviewDetail(
  detail: IntegrationDetailRouteData,
  delay: number,
): Promise<IntegrationDetailRouteData> {
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  return slackApproved() && detail.destinations.length === 0
    ? { ...detail, destinations: SLACK_DESTINATIONS }
    : detail;
}

/**
 * `&detailDelay=<ms>` holds each detail read, as a slow production read
 * does, so the sheet first shows its loading state.
 */
function previewDetailDelay(): number {
  const delay = Number(previewParam("detailDelay") ?? "0");
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

function readPendingPreviewDetail(): Promise<IntegrationDetailRouteData> {
  return new Promise<IntegrationDetailRouteData>(nothing);
}

function scheduleStalePreviewRefresh(
  scenario: Scenario,
  setRefreshVersion: React.Dispatch<React.SetStateAction<number>>,
): () => void {
  if (scenario !== "stale-refresh") return nothing;
  const timeout = window.setTimeout(
    incrementPreviewRefresh.bind(null, setRefreshVersion),
    600,
  );
  return window.clearTimeout.bind(window, timeout);
}

function incrementPreviewRefresh(
  setRefreshVersion: React.Dispatch<React.SetStateAction<number>>,
): void {
  setRefreshVersion(incrementNumber);
}

function incrementNumber(value: number): number {
  return value + 1;
}

type ProviderWindowStatus = "waiting" | "sent" | "acknowledged";

function providerWindowCopy(status: ProviderWindowStatus): string {
  switch (status) {
    case "waiting":
      return "This stands in for the provider's sign-in window. Approve to run the completion handshake, go back the way the failure page's link does, or close the window.";
    case "sent":
      return "Completion sent. Waiting for the portal to acknowledge…";
    case "acknowledged":
      return "Acknowledged. Closing…";
  }
}

function acknowledgesAttempt(attemptId: string, data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { readonly type?: unknown }).type ===
      "satyr.provider-attempt.ack" &&
    (data as { readonly attempt_id?: unknown }).attempt_id === attemptId
  );
}

function approveInProviderWindow(
  provider: string,
  attemptId: string,
  setStatus: React.Dispatch<React.SetStateAction<ProviderWindowStatus>>,
): void {
  const completion = {
    type: "satyr.provider-attempt.completed",
    attempt_id: attemptId,
    terminal_state: "connected",
    failure_reason_code: null,
    provider,
  };
  if (provider === "slack") {
    try {
      window.localStorage.setItem(APPROVED_SLACK_KEY, "1");
    } catch {
      // Without storage the next read stays unconnected.
    }
  }
  const channel = new BroadcastChannel("satyr-provider-attempt");
  const settleWindow = (): void => {
    setStatus("acknowledged");
    window.close();
  };
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (
      event.origin === window.location.origin &&
      acknowledgesAttempt(attemptId, event.data)
    )
      settleWindow();
  });
  channel.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (acknowledgesAttempt(attemptId, event.data)) settleWindow();
  });
  const send = (): void => {
    if (window.opener !== null)
      window.opener.postMessage(completion, window.location.origin);
    channel.postMessage(completion);
  };
  send();
  window.setInterval(send, 1_000);
  setStatus("sent");
}

function returnThroughPortalPath(): void {
  window.location.replace("/portal/nuki/cafe/integrations");
}

function closeProviderWindow(): void {
  window.close();
}

function ProviderWindow(props: { readonly provider: string }): React.ReactNode {
  const [status, setStatus] = React.useState<ProviderWindowStatus>("waiting");
  const attemptId = React.useRef(`preview_${Date.now()}`);
  return (
    <main
      style={{
        padding: "24px",
        display: "grid",
        gap: "12px",
        maxWidth: "420px",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "20px" }}>
        Stand-in for the {props.provider} window
      </h1>
      <p style={{ margin: 0 }}>{providerWindowCopy(status)}</p>
      <button
        type="button"
        onClick={approveInProviderWindow.bind(
          null,
          props.provider,
          attemptId.current,
          setStatus,
        )}
      >
        Approve
      </button>
      <button type="button" onClick={returnThroughPortalPath}>
        Back to Seams Pantry
      </button>
      <button type="button" onClick={closeProviderWindow}>
        Close this window
      </button>
    </main>
  );
}

function RoutePreview(props: {
  readonly scenario: Scenario;
  readonly provider: PreviewProvider;
}): React.ReactNode {
  const [refreshVersion, setRefreshVersion] = React.useState(0);
  const transport = React.useMemo(
    () => buildRouteTransport(props.scenario, props.provider),
    [props.scenario, props.provider],
  );
  React.useEffect(
    scheduleStalePreviewRefresh.bind(null, props.scenario, setRefreshVersion),
    [props.scenario],
  );
  return (
    <IntegrationsRoute
      organisationId="organisation_preview"
      organisationHandle="nuki"
      workspaceHandle="cafe"
      refreshKey={`${props.scenario}:${props.provider}:${refreshVersion}`}
      canManage={true}
      canConnectCodex={true}
      signedInAs="Camille Laurent"
      integrationBasePath={previewBasePath(
        "route",
        props.scenario,
        props.provider,
      )}
      transport={transport}
    />
  );
}

/**
 * `?mode=mailbox&account=<id>`: one mailbox's settings page, as the Inbox
 * shows it, on the route transport of the scenario.
 */
function MailboxPreview(props: {
  readonly scenario: Scenario;
  readonly provider: PreviewProvider;
  readonly accountId: string;
}): React.ReactNode {
  const transport = React.useMemo(
    () => buildRouteTransport(props.scenario, props.provider),
    [props.scenario, props.provider],
  );
  return (
    <div
      className="portal-shell portal-shell-workspace"
      style={{ display: "block" }}
    >
      <main
        className="portal-main"
        style={{ padding: "24px", minHeight: "100vh" }}
      >
        <div className="portal-main-inner">
          <MailboxSettingsRoute
            organisationId="organisation_preview"
            organisationHandle="nuki"
            workspaceHandle="cafe"
            refreshKey={`${props.scenario}:${props.provider}`}
            canManage={true}
            canConnectCodex={true}
            signedInAs="Camille Laurent"
            transport={transport}
            accountId={props.accountId}
            back={{ href: "/integrations-preview.html", label: "Inbox" }}
          />
        </div>
      </main>
    </div>
  );
}

function PreviewApp(): React.ReactNode {
  const [params] = useSearchParams();
  const popup = params.get("popup");
  if (popup !== null) return <ProviderWindow provider={popup} />;
  const mode: PreviewMode = params.get("mode") === "route" ? "route" : "page";
  const integration = params.get("integration") ?? "overview";
  const scenario = parseScenario(params.get("scenario"));
  const provider = parseProvider(params.get("provider"), integration);
  const initialQuery =
    params.get("q") ?? (scenario === "search-empty" ? "quickbooks" : "");
  const initialAccountId = params.get("account") ?? undefined;
  const initialFocusId = params.get("focus") ?? undefined;
  if (params.get("mode") === "mailbox")
    return (
      <MailboxPreview
        scenario={scenario}
        provider={provider}
        accountId={initialAccountId ?? "intacc_gmail"}
      />
    );
  const props = React.useMemo(
    buildProps.bind(
      null,
      scenario,
      provider,
      integration,
      initialQuery,
      initialAccountId,
      initialFocusId,
    ),
    [
      scenario,
      provider,
      integration,
      initialQuery,
      initialAccountId,
      initialFocusId,
    ],
  );
  return (
    <div
      className="portal-shell portal-shell-workspace"
      style={{ display: "block" }}
    >
      <main
        className="portal-main"
        style={{ padding: "24px", minHeight: "100vh" }}
      >
        <div className="portal-main-inner">
          <nav
            aria-label="Preview scenarios"
            style={{
              display: "flex",
              gap: "12px",
              flexWrap: "wrap",
              marginBottom: "16px",
              fontSize: "13px",
            }}
          >
            <a
              href={previewPath(mode, "overview", scenario, provider)}
              aria-current={integration === "overview" ? "page" : undefined}
            >
              overview{integration === "overview" ? " ✓" : ""}
            </a>
            <span aria-hidden="true">·</span>
            {SCENARIOS.map((entry) => (
              <a
                key={entry}
                href={previewPath(mode, integration, entry, provider)}
                aria-current={entry === scenario ? "page" : undefined}
              >
                {entry}
                {entry === scenario ? " ✓" : ""}
              </a>
            ))}
            <span aria-hidden="true">·</span>
            {PROVIDERS.map((entry) => (
              <a
                key={entry}
                href={previewPath(mode, providerTab(entry), scenario, entry)}
                aria-current={entry === provider ? "page" : undefined}
              >
                {entry}
                {entry === provider ? " ✓" : ""}
              </a>
            ))}
            <span aria-hidden="true">·</span>
            <a
              href={previewPath(
                mode === "route" ? "page" : "route",
                integration,
                scenario,
                provider,
              )}
            >
              {mode === "route" ? "page mode" : "route mode (live popup watch)"}
            </a>
          </nav>
          <header className="portal-heading">
            <h1 id="portal-page-title" tabIndex={-1}>
              Integrations
            </h1>
            <p>
              Connect the apps your shop uses.
            </p>
          </header>
          {mode === "route" ? (
            <RoutePreview
              key={`${scenario}:${provider}`}
              scenario={scenario}
              provider={provider}
            />
          ) : (
            <IntegrationsPage key={`${scenario}:${provider}`} {...props} />
          )}
        </div>
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}

function installTypeSafePreview(): void {
  window.fetch = typeSafePreviewFetch.bind(null, window.fetch.bind(window));
}

async function typeSafePreviewFetch(
  original: typeof window.fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin,
  );
  if (
    url.pathname ===
    "/v1/control/organisations/organisation_preview/commerce/payment-accounts"
  ) {
    return previewPaymentAccounts();
  }
  if (
    url.pathname ===
    "/v1/control/organisations/organisation_preview/inference/slack-reasoning-effort"
  ) {
    return previewSlackReasoningEffort(input, init);
  }
  if (
    url.pathname !==
    "/v1/control/organisations/organisation_preview/integrations/typesafe"
  ) {
    return original(input, init);
  }
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method !== "GET")
    throw new Error("This preview does not save TypeSafe credentials.");
  return Response.json({
    ok: true,
    value: {
      connection: { kind: "disconnected", revision: 0 },
      credentialConfigured: false,
    },
  });
}

/** The level of Slack answers. A save lasts until the page reloads. */
let previewSlackEffort: unknown = null;

async function previewSlackReasoningEffort(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method =
    init?.method ?? (input instanceof Request ? input.method : "GET");
  if (method === "PUT" && typeof init?.body === "string") {
    const body: unknown = JSON.parse(init.body);
    if (isRecord(body)) previewSlackEffort = body.effort;
  }
  return Response.json({ ok: true, effort: previewSlackEffort });
}

/**
 * The shop's Stripe account in Commerce, for `&commerce=ready`:
 * `&stripeAccount=onboarding | active | restricted` (omit it for none).
 */
function previewPaymentAccounts(): Response {
  const state = previewParam("stripeAccount");
  const accounts =
    state === "onboarding" || state === "active" || state === "restricted"
      ? [
          {
            provider: "stripe",
            providerAccountId: "acct_1PreviewShop",
            country: "JP",
            currency: "jpy",
            state,
          },
        ]
      : [];
  return Response.json({ accounts });
}

installTypeSafePreview();
installCustomConnectorPreview();
installClaudeConnectionPreview();
installVaultIntegrationPreview("organisation_preview");
// A new page load starts unconnected; the stand-in window keeps the mark.
if (previewParam("popup") === null) forgetApprovedSlack();

const container = document.getElementById("root");
if (container !== null) {
  createRoot(container).render(
    <BrowserRouter>
      <Routes>
        <Route path="*" element={<PreviewApp />} />
      </Routes>
    </BrowserRouter>,
  );
}
