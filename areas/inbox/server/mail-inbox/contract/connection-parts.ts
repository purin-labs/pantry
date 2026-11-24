import type { WhatsAppProviderHealth } from "@purin-labs/control-api";
import type {
  E164PhoneNumber,
  MetaBusinessPortfolioId,
  WhatsAppBusinessAccountId,
  WhatsAppPhoneNumberId,
} from "@purin-labs/connections/whatsapp/identifiers";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type {
  IntegrationAccountId,
  OrganisationId,
  ProviderConnectionId,
} from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";
import type { OrganisationEnvironment } from "@purin-labs/tenancy/data/control-plane";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";

export type EmailEnvironment = "development" | "production";

export type EmailMailboxAccount = {
  readonly integrationAccountId: IntegrationAccountId;
  readonly organisationId: OrganisationId;
  readonly environment: EmailEnvironment;
  readonly googleSubject: string;
  readonly observedAddress: string;
  readonly addressObservedAt: number;
};

export type EmailMailboxAccountError =
  | { readonly code: "email_mailbox_identity_claimed" }
  | { readonly code: "email_mailbox_account_missing" }
  | { readonly code: "email_mailbox_write_failed" };

export type EmailOperationalDirectoryError = Readonly<{
  readonly code:
    | "email_operational_contact_not_found"
    | "email_operational_contact_suppressed"
    | "email_operational_contact_inactive"
    | "email_operational_contact_invalid"
    | "email_sender_account_not_found"
    | "email_sender_account_invalid"
    | "email_sender_identity_claimed"
    | "email_operational_directory_write_failed";
}>;

/** The Google account whose mailbox or sender record a query names. */
export type EmailIdentityClaimQuery = Readonly<{
  readonly db: OrganisationDatabase;
  readonly environment: EmailEnvironment;
  readonly googleSubject: string;
}>;

/** The Organisation and the account that hold a Google account's record. */
export type EmailIdentityClaimant = {
  readonly organisationId: string;
  readonly integrationAccountId: string;
};

/** The Google account that a mailbox or a sender record registers. */
export type EmailAccountRegistration = Readonly<{
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly environment: EmailEnvironment;
  readonly googleSubject: string;
  readonly observedAddress: string;
  readonly now: number;
}>;

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

export type WhatsAppAccountError =
  | { readonly code: "whatsapp_phone_number_claimed" }
  | { readonly code: "whatsapp_account_missing" }
  | { readonly code: "whatsapp_account_write_failed" };

/** The WhatsApp number that a connection registers. */
export type WhatsAppPhoneNumberRegistration = Readonly<{
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
}>;

/** The provider health of one WhatsApp number, as a connection reports it. */
export type WhatsAppProviderHealthUpdate = Readonly<{
  readonly db: OrganisationDatabase;
  readonly organisationId: OrganisationId;
  readonly integrationAccountId: IntegrationAccountId;
  readonly health: WhatsAppProviderHealth;
  readonly now: number;
}>;

export type AgentMailboxTeardown =
  | { readonly kind: "not_a_mailbox" }
  | { readonly kind: "connector_unavailable" }
  | {
      readonly kind: "torn_down";
      readonly watchStopped: boolean;
      readonly cleanupNeeded: readonly {
        readonly proposalId: string;
        readonly version: number;
        readonly state: string;
      }[];
    };

type ReadEmailIdentityClaimant = (
  input: EmailIdentityClaimQuery,
) => Promise<EmailIdentityClaimant | null>;

type RegisterEmailSenderAccount = (
  input: EmailAccountRegistration,
) => Promise<Result<null, EmailOperationalDirectoryError>>;

type RegisterEmailMailboxAccount = (
  input: EmailAccountRegistration,
) => Promise<Result<EmailMailboxAccount, EmailMailboxAccountError>>;

type TearDownAgentMailboxForRemoval = (
  env: Env,
  scope: OrganisationExecutionScope,
  integrationAccountId: IntegrationAccountId,
  kind: "stand_down" | "erase",
) => Promise<AgentMailboxTeardown>;

/**
 * The mailbox part of a Gmail connection. The Inbox owns the mailbox and the
 * sender records of a Google account. The connection workflow claims and
 * registers them, and the integrations routes tear the mailbox agent down
 * before an account goes.
 */
export type MailboxConnectionPart = Readonly<{
  readEmailSenderIdentityClaimant: ReadEmailIdentityClaimant;
  readEmailMailboxIdentityClaimant: ReadEmailIdentityClaimant;
  registerEmailSenderAccount: RegisterEmailSenderAccount;
  registerEmailMailboxAccount: RegisterEmailMailboxAccount;
  tearDownAgentMailboxForRemoval: TearDownAgentMailboxForRemoval;
}>;

type RegisterWhatsAppPhoneNumberAccount = (
  input: WhatsAppPhoneNumberRegistration,
) => Promise<Result<WhatsAppPhoneNumber, WhatsAppAccountError>>;

type SetWhatsAppProviderHealth = (
  input: WhatsAppProviderHealthUpdate,
) => Promise<Result<null, WhatsAppAccountError>>;

/**
 * The WhatsApp part of a WhatsApp connection: the Inbox owns the phone
 * number record and its provider health.
 */
export type WhatsAppConnectionPart = Readonly<{
  registerWhatsAppPhoneNumberAccount: RegisterWhatsAppPhoneNumberAccount;
  setWhatsAppProviderHealth: SetWhatsAppProviderHealth;
}>;
