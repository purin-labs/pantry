import type {
  AccountOnboardingSelection,
  AccountOnboardingResult,
} from "@seams/control-api";

// @ts-expect-error Existing projects cannot also request account creation.
const mixed: AccountOnboardingSelection = {
  kind: "existing_project",
  organizationId: "org",
  projectId: "project",
  organizationName: "New account",
};

// @ts-expect-error A new project requires an organization identity.
const missingAccount: AccountOnboardingSelection = {
  kind: "new_project",
  projectName: "Satyr",
};

// @ts-expect-error Pending setup cannot claim a ready native tenant.
const pendingTenant: AccountOnboardingResult = {
  kind: "pending",
  operationId: "operation",
  instanceId: "instance",
  nativeOrganizationId: "native",
};

declare const existing: Extract<
  AccountOnboardingSelection,
  { kind: "existing_project" }
>;
// @ts-expect-error A broad spread cannot combine creation and selection branches.
const spread: AccountOnboardingSelection = {
  ...existing,
  kind: "new_organization",
  organizationName: "New",
  projectName: "Satyr",
};

void mixed;
void missingAccount;
void pendingTenant;
void spread;
