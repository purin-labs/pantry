import type { FirstOperationalTask, OnboardingActivation, OrganisationOnboardingLifecycle } from "@purin-labs/contracts";
import type { CommerceSystemSyncView, CommerceSystemView } from "@purin-labs/control-api/portal/portal-types";
import React from "react";
import type { ControlErrorKind } from "@purin-labs/control-api/portal/errors";
import type { CredentialInventory, CredentialRotationReceipt } from "@purin-labs/control-api/portal/credential-inventory";
import type { PageContent } from "@purin-labs/control/portal/page-content";
import type { WhatsAppSurface } from "@purin-labs/control-api/portal/whatsapp";
import type { WhatsAppPanelActions } from "../../pages/whatsapp";
import {
  MutationLedger,
  type MutationProvider,
  type OrganisationMutation,
} from "@purin-labs/control/portal/mutation-state";
import type { AgentMailboxView, EmailReplyPreviewResult, EmailReplyQueueItem, EmailOperationalPreviewResult, EmailOperationalQueueItem } from "@purin-labs/control-api/portal/agent-mailbox";
import type { MailboxInstallationOption } from "@purin-labs/area-inbox-contract/ui/pages/agent-mailbox";
import type { IntegrationRouteId } from "./model";
import type { EmailReviewActions } from "@purin-labs/area-inbox-contract/ui/features/email-review/api";
import type { Variant } from "@purin-labs/type-utils";
import type {
  MailboxModelReview,
  MailboxSetupAgentChoice,
  MailboxSetupPlan,
} from "@purin-labs/control-api";
import type { MailboxSetupRequest } from "./mailbox-actions";
import type { ReadMailboxSetup } from "@purin-labs/area-inbox-contract/ui/features/mail-setup/use-mailbox-setup";
import type { CapabilityProfile, ControlRole, IntegrationAccount, OrganisationCodexConnection, OrganisationInferenceSelection, OrganisationInvitation, OrganisationMember, ProviderResource, ReadinessAssessment, SelectInferenceCommand, SetupSelection, SlackRoutingConnection, SupportDiagnostics } from "@purin-labs/control-api/portal/settings";

type OrganisationLifecycle = OrganisationOnboardingLifecycle["kind"];

export type CommerceSystemSync = CommerceSystemSyncView;

export type CommerceSystem = CommerceSystemView;

export type SlackWorkspaceCatalog = {
  readonly integrationAccountId: string;
  readonly workspaceId: string;
  readonly channels: readonly ProviderResource[];
};

export type SetupFormDefaults = {
  readonly key: string;
  readonly capabilityProfile: CapabilityProfile;
  readonly cuePresetId:
    "observe_commerce" | "commerce_operator" | "proactive_triage";
  readonly workspaceId: string;
  readonly channelId: string;
};

export type SetupFeedback =
  | { readonly kind: "idle" }
  | { readonly kind: "success"; readonly message: string }
  | {
      readonly kind: "error";
      readonly field: "workspace" | "channel" | "form";
      readonly message: string;
    };

export type SettingsMouseHandler = (
  event: React.MouseEvent<HTMLButtonElement>,
) => Promise<void>;

type SettingsFormHandler = (
  event: React.FormEvent<HTMLFormElement>,
) => Promise<void>;

export type SettingsSelectHandler = (
  userId: string,
  role: string,
) => Promise<void>;

export type SettingsMutationFeedback = {
  readonly mutation: OrganisationMutation;
  readonly message: string;
  readonly link?: Readonly<{ label: string; href: string }>;
} | null;

/**
 * A provider consent window the route is waiting on. The popup is the only
 * evidence that an operator is mid-sign-in, so the route holds it until the
 * completion handshake arrives, the window closes, or the operator cancels.
 */
export type PendingProviderAuthorization =
  | { readonly kind: "connect"; readonly provider: MutationProvider }
  | {
      readonly kind: "existing_account";
      readonly integrationAccountId: string;
      readonly provider: string;
    };

export type ProviderAuthorizationWatch = {
  readonly pending: PendingProviderAuthorization;
  readonly popup: Window;
};

/** An inference source that a sign-in connects, not a pasted key. */
export type SignedInInferenceSelection = Variant<
  OrganisationInferenceSelection,
  "claude_oauth" | "codex_subscription"
>;

export type IntegrationsPageActions = EmailReviewActions & {
  readonly activate: () => Promise<void>;
  readonly syncCommerceSystem: () => Promise<void>;
  readonly syncCommerceSystemQuietly: () => Promise<void>;
  readonly setupBuiltInCommerce: () => Promise<void>;
  readonly publishExportCoordination: () => Promise<void>;
  readonly selectShopifyCommerce: SettingsMouseHandler;
  readonly connectShopify: SettingsFormHandler;
  readonly connectAirtable: () => Promise<void>;
  readonly connectDropbox: () => Promise<void>;
  readonly connectGmail: () => Promise<void>;
  readonly connectGmailSendOnly: () => Promise<void>;
  readonly connectGoogleDrive: () => Promise<void>;
  readonly connectWhatsApp: () => Promise<void>;
  readonly connectNotion: () => Promise<void>;
  readonly connectStripe: () => Promise<void>;
  readonly connectSquare: () => Promise<void>;
  readonly connectSlack: () => Promise<void>;
  /** Closes the provider window the route is waiting on and returns to idle. */
  readonly cancelProviderAuthorization: () => void;
  /** Reads the overview again, readiness included. */
  readonly refreshOverview: () => void;
  readonly connectCodex: () => Promise<void>;
  readonly reconnectCodex: () => Promise<void>;
  readonly cancelCodexAuthorization: (attemptId: string) => Promise<void>;
  readonly completeCodexAuthorization: (
    attemptId: string,
    callbackUrl: string,
  ) => Promise<void>;
  readonly disconnectCodex: () => Promise<void>;
  readonly saveInferenceSelection: SettingsFormHandler;
  /** Selects the account that a sign-in has just connected. */
  readonly selectSignedInAccount: (
    selection: SignedInInferenceSelection,
  ) => Promise<void>;
  readonly disableAccount: SettingsMouseHandler;
  readonly reconnectAccount: SettingsMouseHandler;
  readonly rotateAccount: SettingsMouseHandler;
  readonly setDefaultAccount: SettingsMouseHandler;
  readonly removeAccount: SettingsMouseHandler;
  readonly refreshAccountResources: SettingsMouseHandler;
  readonly selectSlackDmOrganisation: SettingsMouseHandler;
  readonly saveSetup: SettingsFormHandler;
  readonly rotateCredential: (
    integrationAccountId: string,
    replacementSecret: string,
  ) => Promise<CredentialActionOutcome>;
  readonly readMailboxSetup: ReadMailboxSetup;
  readonly setUpMailbox: (request: MailboxSetupRequest) => void;
  readonly resumeMailbox: SettingsMouseHandler;
  readonly skipAndResumeMailbox: SettingsMouseHandler;
  readonly reconnectMailbox: SettingsMouseHandler;
  readonly disableMailbox: SettingsMouseHandler;
  readonly revokeMailbox: SettingsMouseHandler;
};

/**
 * Outcome of a credential recovery command, rendered inline beside the
 * account row. The rotate flow never receives the submitted secret back:
 * only receipts and mapped error guidance flow through this type.
 */
export type CredentialActionOutcome =
  | {
      readonly kind: "rotated";
      readonly receipt: CredentialRotationReceipt | null;
    }
  | {
      readonly kind: "failed";
      readonly errorKind: ControlErrorKind;
      readonly message: string;
    };

export type IntegrationsCommand =
  | {
      readonly kind: "activate";
      readonly readinessVersion: number;
      readonly readinessHash: string;
    }
  | { readonly kind: "sync_commerce" }
  | { readonly kind: "provision_commerce" }
  | { readonly kind: "publish_export_coordination" }
  | {
      readonly kind: "select_shopify";
      readonly integrationAccountId: string;
      readonly expectedRevision: number;
    }
  | { readonly kind: "connect_slack" }
  | { readonly kind: "connect_stripe" }
  | { readonly kind: "connect_square" }
  | { readonly kind: "connect_shopify"; readonly shopDomain: string }
  | { readonly kind: "connect_airtable" }
  | { readonly kind: "connect_dropbox" }
  | { readonly kind: "connect_gmail" }
  | { readonly kind: "connect_gmail_send_only" }
  | { readonly kind: "connect_google_drive" }
  | { readonly kind: "connect_whatsapp" }
  | { readonly kind: "connect_notion" }
  | { readonly kind: "connect_codex" }
  | { readonly kind: "reconnect_codex" }
  | { readonly kind: "cancel_codex_authorization"; readonly attemptId: string }
  | {
      readonly kind: "complete_codex_authorization";
      readonly attemptId: string;
      readonly callbackUrl: string;
    }
  | { readonly kind: "disconnect_codex" }
  | SelectInferenceCommand
  | { readonly kind: "disable_account"; readonly integrationAccountId: string }
  | {
      readonly kind: "reconnect_account";
      readonly integrationAccountId: string;
    }
  | { readonly kind: "rotate_account"; readonly integrationAccountId: string }
  | {
      readonly kind: "set_default_account";
      readonly integrationAccountId: string;
    }
  | {
      readonly kind: "refresh_account_resources";
      readonly integrationAccountId: string;
    }
  | {
      readonly kind: "select_slack_dm_organisation";
      readonly installationId: string;
      readonly integrationAccountId: string;
    }
  | {
      readonly kind: "remove_connected_account";
      readonly integrationAccountId: string;
    }
  | { readonly kind: "remove_account"; readonly integrationAccountId: string }
  | { readonly kind: "save_setup"; readonly selection: SetupSelection }
  /** A further channel: it binds the channel and keeps the setup as it is. */
  | {
      readonly kind: "add_slack_channel";
      readonly cueTarget: SetupSelection["cueTarget"];
    }
  | {
      readonly kind: "rotate_credential";
      readonly integrationAccountId: string;
      readonly replacementSecret: string;
    }
  | {
      readonly kind: "set_up_mailbox";
      readonly integrationAccountId: string;
      readonly agent: MailboxSetupAgentChoice;
      /** Turn the mailbox on after the setup, with the server's limits. */
      readonly turnOn: boolean;
      /** The model review whose data terms the person accepted, if any. */
      readonly accepted: MailboxModelReview | null;
    }
  | { readonly kind: "resume_mailbox"; readonly integrationAccountId: string }
  | {
      readonly kind: "reconnect_mailbox";
      readonly integrationAccountId: string;
    }
  | { readonly kind: "disable_mailbox"; readonly integrationAccountId: string }
  | { readonly kind: "revoke_mailbox"; readonly integrationAccountId: string }
  | {
      readonly kind: "skip_and_resume_mailbox";
      readonly integrationAccountId: string;
      readonly providerMessageId: string;
    }
  | {
      readonly kind: "approve_email_reply";
      readonly proposalId: string;
      readonly version: number;
      readonly snapshotDigest: string;
      readonly challenge: string;
    }
  | { readonly kind: "reject_email_reply"; readonly proposalId: string }
  | {
      readonly kind: "resolve_email_reply";
      readonly proposalId: string;
      readonly dispatchVersion: number;
    }
  | {
      readonly kind: "approve_email_operational";
      readonly proposalId: string;
      readonly version: number;
      readonly snapshotDigest: string;
      readonly challenge: string;
      readonly selfTestOwnershipConfirmed?: true;
    }
  | { readonly kind: "reject_email_operational"; readonly proposalId: string }
  | {
      readonly kind: "edit_email_operational";
      readonly proposalId: string;
      readonly subject: string;
      readonly body: string;
    }
  | {
      readonly kind: "attest_email_operational";
      readonly proposalId: string;
      readonly attestation: "present" | "absent";
    };

export type IntegrationsCommandResult =
  | { readonly kind: "completed" }
  | { readonly kind: "authorization"; readonly authorizationUrl: string }
  | {
      readonly kind: "credential_rotation";
      readonly receipt: CredentialRotationReceipt | null;
    };

/**
 * The Stripe setup part of the payment accounts. The Portal wiring gives it,
 * so the integrations page imports no commerce file.
 */
type StripeSetupPart = React.ComponentType<{
  readonly organisationId: string;
  /** Null once a Stripe account is connected, or for a member who cannot. */
  readonly connectExisting: (() => void) | null;
  readonly connectBusy: boolean;
  readonly connectFeedback: React.ReactNode;
}>;

export type IntegrationsPageProps = {
  readonly organisationId: string;
  readonly stripeSetup: StripeSetupPart;
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly commerceSystem: CommerceSystem | null;
  readonly commerceSyncProblem: string | null;
  readonly codexConnection: OrganisationCodexConnection;
  readonly inferenceSelection: OrganisationInferenceSelection;
  readonly accounts: readonly IntegrationAccount[];
  readonly credentialInventory: CredentialInventory | null;
  readonly destinations: readonly SlackWorkspaceCatalog[];
  readonly slackRouting: readonly SlackRoutingConnection[];
  readonly supportDiagnostics: SupportDiagnostics | null;
  readonly agentMailboxes: readonly AgentMailboxView[];
  readonly emailReplies: readonly EmailReplyQueueItem[];
  readonly emailOperational: readonly EmailOperationalQueueItem[];
  readonly mailboxInstallations: readonly MailboxInstallationOption[];
  readonly whatsapp: WhatsAppSurface;
  readonly whatsappActions: WhatsAppPanelActions;
  readonly setupDefaults: SetupFormDefaults;
  readonly setupFeedback: SetupFeedback;
  readonly readiness: ReadinessAssessment | null;
  readonly activation: OnboardingActivation;
  readonly firstTask: FirstOperationalTask | null;
  readonly organisationIsActive: boolean;
  readonly configurationVersion: number;
  readonly canManage: boolean;
  readonly canConnectCodex: boolean;
  readonly mutations: MutationLedger;
  /** The consent window the route is waiting on, if any. */
  readonly pendingAuthorization: PendingProviderAuthorization | null;
  readonly pendingConfirm: string | null;
  readonly requestConfirm: (key: string) => void;
  readonly actions: IntegrationsPageActions;
  readonly feedback: SettingsMutationFeedback;
  /** Exact integration detail to open; omission shows the overview. */
  readonly initialIntegrationId?: string;
  /** Exact provider account to bring into view inside its connection modal. */
  readonly initialAccountId?: string;
  /** Search text restored when browser navigation returns to the overview. */
  readonly initialQuery?: string;
  readonly initialFocusId?: string;
  /** Dev preview override for same-page catalogue links. */
  readonly integrationBasePath?: string;
  readonly whatsappConfigurationKnown?: boolean;
  readonly detailContent?: SelectedIntegrationDetailContent;
  readonly retryDetail?: () => void;
};

export type IntegrationsRouteData = {
  readonly commerceSystem: CommerceSystem | null;
  readonly commerceSyncProblem: string | null;
  readonly codexConnection: OrganisationCodexConnection;
  readonly inferenceSelection: OrganisationInferenceSelection;
  readonly accounts: readonly IntegrationAccount[];
  readonly supportReference: string | null;
  readonly whatsappApplicationConfigured: boolean | null;
  readonly setupDefaults: SetupFormDefaults;
  readonly readiness: ReadinessAssessment | null;
  readonly activation: OnboardingActivation;
  readonly firstTask: FirstOperationalTask | null;
  readonly organisationIsActive: boolean;
  readonly configurationVersion: number;
};

export type IntegrationDetailRouteData = {
  readonly destinations: readonly SlackWorkspaceCatalog[];
  readonly slackRouting: readonly SlackRoutingConnection[];
  readonly supportDiagnostics: SupportDiagnostics | null;
  readonly credentialInventory: CredentialInventory | null;
  readonly agentMailboxes: readonly AgentMailboxView[];
  readonly emailReplies: readonly EmailReplyQueueItem[];
  readonly emailOperational: readonly EmailOperationalQueueItem[];
  readonly mailboxInstallations: readonly MailboxInstallationOption[];
  readonly whatsapp: WhatsAppSurface;
};

export type IntegrationDetailReadContext = {
  readonly integrationId: IntegrationRouteId;
  readonly supportReference: string | null;
  readonly accounts: readonly IntegrationAccount[];
  readonly organisationIsActive: boolean;
};

export type SelectedIntegrationDetailContent =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly integrationId: IntegrationRouteId }
  | {
      readonly kind: "ready";
      readonly integrationId: IntegrationRouteId;
      readonly data: IntegrationDetailRouteData;
    }
  | {
      readonly kind: "failed";
      readonly integrationId: IntegrationRouteId;
      readonly problem: string;
    };

export type IntegrationsRouteTransport = {
  readonly readOverview: (
    organisationId: string,
  ) => Promise<IntegrationsRouteData>;
  /**
   * The overview of an earlier visit, or null. The page shows it only while
   * `readOverview` runs.
   */
  readonly lastOverview?: (
    organisationId: string,
  ) => IntegrationsRouteData | null;
  readonly readDetail: (
    organisationId: string,
    context: IntegrationDetailReadContext,
  ) => Promise<IntegrationDetailRouteData>;
  readonly execute: (
    organisationId: string,
    organisationHandle: string,
    workspaceHandle: string,
    configurationVersion: number,
    command: IntegrationsCommand,
  ) => Promise<IntegrationsCommandResult>;
  readonly readMailboxSetup: (
    organisationId: string,
    integrationAccountId: string,
  ) => Promise<MailboxSetupPlan>;
  readonly readEmailReply: (
    organisationId: string,
    proposalId: string,
  ) => Promise<EmailReplyPreviewResult>;
  readonly readEmailOperational: (
    organisationId: string,
    proposalId: string,
  ) => Promise<EmailOperationalPreviewResult>;
  readonly whatsapp: WhatsAppRouteTransport;
  readonly stripeSetup: StripeSetupPart;
};

/**
 * WhatsApp setup calls stay outside the shared mutation ledger: each one is a
 * single operator decision on one number, and the panel reloads the route
 * afterwards so it shows what actually happened.
 */
export type WhatsAppRouteTransport = {
  readonly connect: (organisationId: string) => Promise<void>;
  readonly accountAction: (
    organisationId: string,
    integrationAccountId: string,
    action: string,
    body: Record<string, unknown>,
  ) => Promise<void>;
};

export type IntegrationsRouteProps = Omit<
  IntegrationsPageProps,
  | "commerceSystem"
  | "commerceSyncProblem"
  | "codexConnection"
  | "inferenceSelection"
  | "accounts"
  | "credentialInventory"
  | "destinations"
  | "slackRouting"
  | "supportDiagnostics"
  | "agentMailboxes"
  | "emailReplies"
  | "emailOperational"
  | "mailboxInstallations"
  | "whatsapp"
  | "whatsappActions"
  | "setupDefaults"
  | "setupFeedback"
  | "readiness"
  | "activation"
  | "firstTask"
  | "organisationIsActive"
  | "configurationVersion"
  | "mutations"
  | "pendingAuthorization"
  | "pendingConfirm"
  | "requestConfirm"
  | "actions"
  | "feedback"
  | "stripeSetup"
> & {
  readonly organisationId: string;
  readonly refreshKey: string;
  readonly transport: IntegrationsRouteTransport;
  /** The signed-in person, shown on the sign-in consent screen. */
  readonly signedInAs?: string;
};

export type WorkspaceSettingsPageActions = {
  readonly changeMemberRole: SettingsSelectHandler;
  readonly removeMember: SettingsMouseHandler;
  readonly revokeInvitation: SettingsMouseHandler;
  readonly inviteMember: SettingsFormHandler;
  readonly archiveOrganisation: () => Promise<void>;
  readonly restoreOrganisation: () => Promise<void>;
};

export type WorkspaceSettingsCommand =
  | {
      readonly kind: "change_member_role";
      readonly userId: string;
      readonly role: ControlRole;
    }
  | { readonly kind: "remove_member"; readonly userId: string }
  | { readonly kind: "revoke_invitation"; readonly invitationId: string }
  | {
      readonly kind: "invite_member";
      readonly email: string;
      readonly role: Exclude<ControlRole, "owner">;
    }
  | { readonly kind: "archive_workspace" }
  | { readonly kind: "restore_workspace" };

export type WorkspaceSettingsPageProps = {
  readonly organisation: {
    readonly name: string;
    readonly lifecycle: OrganisationLifecycle;
    readonly role: ControlRole;
  };
  readonly members: readonly OrganisationMember[];
  readonly invitations: readonly OrganisationInvitation[];
  readonly canManage: boolean;
  readonly mutations: MutationLedger;
  readonly pendingConfirm: string | null;
  readonly requestConfirm: (key: string) => void;
  readonly actions: WorkspaceSettingsPageActions;
  readonly feedback: SettingsMutationFeedback;
  /** The operational areas section, which reads the agent records itself.
   * The page shows it only to a member who can manage the workspace. */
  readonly operationalAreas?: React.ReactNode;
};

export type WorkspaceSettingsRouteData = {
  readonly members: readonly OrganisationMember[];
  readonly invitations: readonly OrganisationInvitation[];
  readonly lifecycle: OrganisationLifecycle;
  readonly configurationVersion: number;
};

export type WorkspaceSettingsCommandResult =
  | Readonly<{ kind: "applied"; acceptanceHref?: never }>
  | Readonly<{ kind: "invitation_created"; acceptanceHref: string }>
  | Readonly<{ kind: "invitation_open"; acceptanceHref?: never }>;

export type WorkspaceSettingsRouteTransport = {
  readonly read: (
    organisationId: string,
  ) => Promise<WorkspaceSettingsRouteData>;
  readonly execute: (
    organisationId: string,
    configurationVersion: number,
    command: WorkspaceSettingsCommand,
  ) => Promise<WorkspaceSettingsCommandResult>;
};

export type WorkspaceSettingsRouteProps = Omit<
  WorkspaceSettingsPageProps,
  | "members"
  | "invitations"
  | "mutations"
  | "pendingConfirm"
  | "requestConfirm"
  | "actions"
  | "feedback"
> & {
  readonly organisationId: string;
  readonly refreshKey: string;
  readonly transport: WorkspaceSettingsRouteTransport;
};

export type SettingsRouteContent<T> = PageContent<T>;

export type SettingsConfirmTimer = { current: number | null };

export type IntegrationsRouteMutationContext = {
  readonly props: IntegrationsRouteProps;
  readonly content: SettingsRouteContent<IntegrationsRouteData>;
  readonly requestRevision: { current: number };
  readonly setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >;
  readonly mutations: MutationLedger;
  readonly setMutations: React.Dispatch<React.SetStateAction<MutationLedger>>;
  readonly authorization: React.RefObject<ProviderAuthorizationWatch | null>;
  readonly setAuthorization: React.Dispatch<
    React.SetStateAction<ProviderAuthorizationWatch | null>
  >;
  readonly setPendingConfirm: React.Dispatch<
    React.SetStateAction<string | null>
  >;
  readonly setFeedback: React.Dispatch<
    React.SetStateAction<SettingsMutationFeedback>
  >;
  readonly setSetupFeedback: React.Dispatch<
    React.SetStateAction<SetupFeedback>
  >;
  readonly setConnectConsent: React.Dispatch<
    React.SetStateAction<PendingProviderConnection | null>
  >;
  /** Opens one connection's dialog over the current page. */
  readonly openIntegration: (integrationId: IntegrationRouteId) => void;
};

export type ProviderConnectionCommand = Variant<
  IntegrationsCommand,
  | "connect_slack"
  | "connect_stripe"
  | "connect_square"
  | "connect_shopify"
  | "connect_airtable"
  | "connect_dropbox"
  | "connect_gmail"
  | "connect_gmail_send_only"
  | "connect_google_drive"
  | "connect_whatsapp"
  | "connect_notion"
>;

/** A provider sign-in that waits for the operator to read what it does. */
export type PendingProviderConnection = Readonly<{
  command: ProviderConnectionCommand;
  mutation: Variant<OrganisationMutation, "connect_provider">;
}>;

export type WorkspaceSettingsRouteMutationContext = {
  readonly props: WorkspaceSettingsRouteProps;
  readonly content: SettingsRouteContent<WorkspaceSettingsRouteData>;
  readonly requestRevision: { current: number };
  readonly setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<WorkspaceSettingsRouteData>>
  >;
  readonly mutations: MutationLedger;
  readonly setMutations: React.Dispatch<React.SetStateAction<MutationLedger>>;
  readonly setPendingConfirm: React.Dispatch<
    React.SetStateAction<string | null>
  >;
  readonly setFeedback: React.Dispatch<
    React.SetStateAction<SettingsMutationFeedback>
  >;
};
