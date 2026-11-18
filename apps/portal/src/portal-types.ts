import type { ControlMembershipAvailability } from "@seams/control-api";
import type { FirstOperationalTask, OnboardingActivation, OnboardingNextAction, OnboardingProvider, OnboardingStepProjection } from "@seams/contracts";
import type { WorkspaceDetailPage } from "./route";
import type { OrganisationChoice } from "./shell";
import {
  MutationLedger,
  type OrganisationMutation,
} from "./mutation-state";
import type { IntegrationAccount, ReadinessAssessment, SetupSelection } from "@seams/control-api/portal/settings";
import type { CommerceActionRecord } from "@seams/control-api/portal/commerce-actions";
import type { CommerceSystemView, Membership, OperatorOrganisationCase, OrganisationSummary, OrganisationWorkspace, SupportRole, User } from "@seams/control-api/portal/portal-types";

export type Provider = Extract<
  OnboardingProvider,
  | "airtable"
  | "dropbox"
  | "gmail"
  | "google_drive"
  | "notion"
  | "slack"
  | "square"
  | "stripe"
  | "shopify"
  | "whatsapp"
>;

export type WorkspacePageFeedback = {
  readonly page: WorkspaceDetailPage;
  readonly message: string;
  readonly mutation: OrganisationMutation | null;
};

export type PortalOrganisation = {
  readonly membership: Membership;
  readonly organisation: OrganisationSummary;
  readonly configurationVersion: number;
};

export type PortalState =
  | { readonly kind: "loading" }
  | { readonly kind: "signed_out" }
  | { readonly kind: "load_failed"; readonly message: string }
  | {
      readonly kind: "route_not_found";
      readonly reason: "page" | "organisation" | "workspace";
      readonly identity: User;
      readonly organisation: PortalOrganisation | null;
      readonly workspace: OrganisationWorkspace | null;
    }
  | {
      readonly kind: "organisation_list";
      readonly identity: User;
      readonly memberships: readonly Membership[];
      readonly membershipAvailability: ControlMembershipAvailability;
      readonly supportRole: SupportRole | null;
      readonly operatorCase: OperatorOrganisationCase | null;
      readonly busy: boolean;
      readonly error: string | null;
    }
  | {
      readonly kind: "workspace_detail";
      readonly identity: User;
      readonly organisation: PortalOrganisation;
      readonly workspace: OrganisationWorkspace;
      readonly organisationChoices: readonly OrganisationChoice[];
      readonly steps: readonly OnboardingStepProjection[];
      readonly setupSelection: SetupSelection | null;
      readonly accounts: readonly IntegrationAccount[];
      readonly commerceSystem: CommerceSystemView | null;
      readonly commerceSyncProblem: string | null;
      readonly readiness: ReadinessAssessment | null;
      readonly activation: OnboardingActivation;
      readonly nextAction: OnboardingNextAction;
      readonly firstTask: FirstOperationalTask | null;
      readonly projectionRevision: number;
      readonly configurationVersion: number;
      readonly supportReference: string | null;
      readonly page: WorkspaceDetailPage;
      readonly commerceAction: CommerceActionRecord | null;
      readonly mutations: MutationLedger;
      readonly error: WorkspacePageFeedback | null;
    };

export type SessionSnapshot = {
  readonly identity: User;
  readonly supportRole: SupportRole | null;
  readonly memberships: readonly Membership[];
  readonly membershipAvailability: ControlMembershipAvailability;
};

export type PendingCommerceApproval = {
  readonly organisationId: string;
  readonly actionNonce: string;
  readonly returnPath: string;
  readonly createdAt: number;
};
