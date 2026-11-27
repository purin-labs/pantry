import type {
  OnboardingControlRole,
  OrganisationOnboardingLifecycle,
} from "@purin-labs/contracts";

/** The logo calls of the Logos dialog. */
export type LogoActions = Readonly<{
  set: (
    organisationId: string,
    workspaceId: string | null,
    file: File,
  ) => Promise<void>;
  remove: (organisationId: string, workspaceId: string | null) => Promise<void>;
}>;

export type OrganisationWorkspaceListItem = {
  readonly workspaceId: string;
  readonly workspaceHandle: string;
  readonly name: string;
  readonly createdAt: number;
  /** The SHA-256 of the workspace's logo, or null for the gradient tile. */
  readonly logo: string | null;
};

export type OrganisationListItem = {
  readonly organisationId: string;
  readonly organisationHandle: string;
  readonly name: string;
  readonly role: OnboardingControlRole;
  readonly plan: string;
  readonly lifecycle: OrganisationOnboardingLifecycle["kind"];
  readonly configurationVersion: number;
  /** The SHA-256 of the organisation's logo, or null for the gradient tile. */
  readonly organisationLogo: string | null;
  readonly workspaces: readonly OrganisationWorkspaceListItem[];
};

export type OrganisationActions = {
  readonly rename: (
    organisation: OrganisationListItem,
    name: string,
  ) => Promise<void>;
  readonly archive: (organisation: OrganisationListItem) => Promise<void>;
  readonly restore: (organisation: OrganisationListItem) => Promise<void>;
  readonly delete: (organisation: OrganisationListItem) => Promise<void>;
  /** The logo calls; the control API when absent. A preview gives its own. */
  readonly logos?: LogoActions;
};

/** Where the account setup leads once the organisation is in the list. */
export type AccountSetupListing =
  | Readonly<{
      kind: "listed";
      organisationHandle: string;
      /** The first workspace, for the link to Settings › Jev. */
      workspaceHandle: string | null;
    }>
  | Readonly<{ kind: "missing" }>;
