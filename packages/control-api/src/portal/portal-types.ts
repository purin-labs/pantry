import type { UserId } from "../index.ts";
import type {
  FirstOperationalTask,
  OnboardingIntegrationAccountLifecycle,
  OnboardingActivation,
  OnboardingNextAction,
  OnboardingStepProjection,
  OrganisationOnboardingLifecycle,
} from "@purin-labs/contracts";
import type {
  CapabilityProfile,
  ControlRole,
  IntegrationAccount,
  ReadinessAssessment,
  SetupSelection,
  OrganisationEnvironment,
} from "./settings.ts";

export type IntegrationLifecycleKind =
  OnboardingIntegrationAccountLifecycle["kind"];

export type User = {
  readonly userId: UserId;
  readonly email: string;
  readonly displayName: string;
};

export type Membership = {
  readonly organisationId: string;
  readonly organisationHandle: string;
  readonly role: ControlRole;
  readonly workspaces: readonly [
    OrganisationWorkspace,
    ...OrganisationWorkspace[],
  ];
};

export type OrganisationWorkspace = {
  readonly workspaceId: string;
  readonly workspaceHandle: string;
  readonly name: string;
  readonly createdAt: number;
};

export type SupportRole = "support_agent" | "support_admin";

export type OperatorOrganisationCase = {
  readonly organisationId: string;
  readonly environment: OrganisationEnvironment;
  readonly lifecycle: string;
  readonly configurationVersion: number;
  readonly projectionRevision: number;
};

export type OrganisationSummary = {
  readonly organisationId: string;
  readonly name: string;
  readonly plan: string;
  readonly lifecycle: OrganisationOnboardingLifecycle["kind"];
  readonly environment: OrganisationEnvironment;
  readonly capabilityProfile: CapabilityProfile;
};

export type OrganisationSnapshot = {
  readonly organisation: OrganisationSummary;
  readonly steps: readonly OnboardingStepProjection[];
  readonly setupSelection: SetupSelection | null;
  readonly accounts: readonly IntegrationAccount[];
  readonly readiness: ReadinessAssessment;
  readonly activation: OnboardingActivation;
  readonly nextAction: OnboardingNextAction;
  readonly firstTask: FirstOperationalTask | null;
  readonly projectionRevision: number;
  readonly configurationVersion: number;
  readonly supportReference: string | null;
};

export type CommerceSystemSyncView =
  | {
      readonly kind: "syncing";
      readonly acceptedResourceCount: number;
      readonly requestedAt: number;
      readonly previousLastSyncedAt: number | null;
    }
  | {
      readonly kind: "delayed";
      readonly acceptedResourceCount: number;
      readonly lastSyncedAt: number;
    }
  | {
      readonly kind: "ready";
      readonly acceptedResourceCount: number;
      readonly lastSyncedAt: number;
    };

/** The selected commerce system, as the control API gives it. */
export type CommerceSystemIdentityView =
  | Readonly<{
      kind: "satyr_commerce";
      bindingId: string;
      merchantId: string;
      revision: number;
    }>
  | Readonly<{
      kind: "shopify";
      integrationAccountId: string;
      shopDomain: string;
      revision: number;
    }>;

export type CommerceSystemView = CommerceSystemIdentityView &
  Readonly<{ sync: CommerceSystemSyncView }>;

export type ReadinessBlocker = {
  readonly code: string;
  readonly integrationAccountId: string | null;
};
