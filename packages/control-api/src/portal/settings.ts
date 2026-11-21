import type {
  OnboardingCapabilityProfile,
  OnboardingControlRole,
  OnboardingCredentialHealth,
  OnboardingEnvironment,
  OnboardingEventRecency,
  OnboardingIntegrationAccountLifecycle,
  OnboardingProvider,
  OnboardingSelectedResource,
  OnboardingWebhookHealth,
} from "@purin-labs/contracts";
import type { Variant } from "@purin-labs/type-utils";
import type { CodexAllowance } from "../index.ts";

export type OrganisationCodexConnection =
  | { readonly kind: "disconnected"; readonly revision: 0 }
  | {
      readonly kind: "authorizing";
      readonly revision: number;
      readonly attempt: {
        readonly attemptId: string;
        /**
         * `device_code`: the person types `userCode` at OpenAI.
         * `pasted_callback`: "Sign in with ChatGPT" (Plan 74B); the person
         * pastes the address of the callback page.
         */
        readonly method: "device_code" | "pasted_callback";
        readonly verificationUrl: string;
        /** Null for the pasted-callback sign-in, which has no code to type. */
        readonly userCode: string | null;
        readonly expiresAt: number;
      };
    }
  | {
      readonly kind: "connected";
      readonly revision: number;
      readonly signIn: ChatGptSignIn;
      readonly planType: string;
      readonly allowance: CodexAllowance;
      readonly connectedAt: number;
      readonly verifiedAt: number;
    }
  | {
      readonly kind: "action_required";
      readonly revision: number;
      readonly signIn: ChatGptSignIn;
      readonly planType: string;
      readonly allowance: CodexAllowance;
      readonly reason:
        | "authorization_expired"
        | "workspace_access_revoked"
        | "device_authorization_unavailable"
        | "allowance_exhausted"
        | "account_unavailable";
      readonly observedAt: number;
    };

/**
 * `codex_device`: the old Codex sign-in on chatgpt.com (Plan 72).
 * `chatgpt_agent`: "Sign in with ChatGPT" on api.openai.com (Plan 74B).
 */
export type ChatGptSignIn = "codex_device" | "chatgpt_agent";

export type OrganisationInferenceSelection =
  | { readonly kind: "claude_oauth" }
  | { readonly kind: "codex_subscription" }
  | { readonly kind: "satyr_platform" }
  | { readonly kind: "organisation_openai_api_key" }
  | { readonly kind: "organisation_anthropic_api_key" }
  | { readonly kind: "organisation_google_api_key" };

/** The selections that store an Organisation's own API key. */
export type ApiKeyInferenceSelectionKind =
  | "organisation_openai_api_key"
  | "organisation_anthropic_api_key"
  | "organisation_google_api_key";

export type CapabilityProfile = OnboardingCapabilityProfile;

export type ControlRole = OnboardingControlRole;

export type OrganisationEnvironment = OnboardingEnvironment;

export type IntegrationLifecycle =
  OnboardingIntegrationAccountLifecycle["kind"];

/**
 * The projection reports why a connection went unhealthy. Carrying the code up
 * to the page lets the row explain the failure in the operator's words instead
 * of showing a bare "Reconnect required" chip.
 */
export type IntegrationAccountLifecycle =
  | {
      readonly kind: Exclude<
        IntegrationLifecycle,
        "degraded" | "reauth_required"
      >;
    }
  | {
      readonly kind: "degraded" | "reauth_required";
      readonly reasonCode: string;
    };

export type IntegrationAccount = {
  readonly integrationAccountId: string;
  readonly provider: OnboardingProvider;
  readonly environment: OrganisationEnvironment;
  readonly providerAccountId: string;
  readonly accountKind: string;
  readonly displayName: string;
  readonly lifecycle: IntegrationAccountLifecycle;
  readonly isDefaultForProvider: boolean;
  readonly capabilities: readonly string[];
  readonly scopes: readonly string[];
  readonly selectedResources: readonly OnboardingSelectedResource[];
  readonly credentialHealth: OnboardingCredentialHealth;
  readonly webhookHealth: OnboardingWebhookHealth;
  readonly eventRecency: OnboardingEventRecency;
};

export type ProviderResource = {
  readonly canonicalResourceId: string;
  readonly displayLabel: string;
  readonly accessState: "accessible" | "inaccessible";
};

export type SlackRoutingConnection = {
  readonly installationId: string;
  readonly connectionId: string;
  readonly integrationAccountId: string;
  readonly workspaceId: string;
  readonly lifecycle: "active" | "disabled" | "revoked";
  readonly channelDefaults: readonly {
    readonly channelId: string;
    readonly revision: number;
    readonly boundAt: number;
  }[];
  /** Another organisation shares this Slack workspace. */
  readonly sharedWorkspace: boolean;
};

export type SupportDiagnostics = {
  readonly supportReference: string;
  readonly provider: string | null;
  readonly displayAccount: string | null;
  readonly reasonCode: string;
  readonly occurredAt: number;
  readonly retryStatus: "retryable" | "terminal";
  readonly lastSuccessfulPhase: string | null;
  readonly webhookHealth: {
    readonly live: number;
    readonly degraded: number;
    readonly disabled: number;
    readonly revoked: number;
  };
  readonly projectionRevision: number;
};

export type ApprovalAuthenticationReport = {
  readonly actionClass: string;
  readonly branch: string;
  readonly ready: boolean;
  readonly reason: string | null;
};

export type ReadinessAssessment =
  | {
      readonly kind: "ready";
      readonly readinessVersion: number;
      readonly readinessHash: string;
      readonly approvalAuthentication: readonly ApprovalAuthenticationReport[];
    }
  | {
      readonly kind: "blocked";
      readonly blockers: readonly {
        readonly code: string;
        readonly integrationAccountId: string | null;
      }[];
      readonly approvalAuthentication: readonly ApprovalAuthenticationReport[];
    };

export type OrganisationMember = {
  readonly kind: "active";
  readonly userId: string;
  readonly personId: string;
  readonly role: ControlRole;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: number;
};

export type OrganisationInvitation = Readonly<{
  organisationInvitationId: string;
  invitedEmail: string;
  role: Exclude<ControlRole, "owner">;
  createdAt: number;
  expiresAt: number;
  kind: "pending";
}>;

export type SetupSelection = {
  readonly policyTemplateId: "commerce_operator";
  readonly capabilityProfile: CapabilityProfile;
  readonly cuePresetId:
    "observe_commerce" | "commerce_operator" | "proactive_triage";
  readonly cueTarget: {
    readonly workspaceId: string;
    readonly channelId: string;
  };
};

export type SelectInferenceCommand =
  | {
      readonly kind: "select_inference";
      readonly selection: Variant<
        OrganisationInferenceSelection,
        "claude_oauth" | "codex_subscription" | "satyr_platform"
      >;
      readonly apiKey?: never;
    }
  | {
      readonly kind: "select_inference";
      readonly selection: Variant<
        OrganisationInferenceSelection,
        ApiKeyInferenceSelectionKind
      >;
      readonly apiKey: string;
    };
