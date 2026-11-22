import type { CustomConnectorSetupAttempt, CustomConnectorWritePreview } from "@purin-labs/control-api/portal/custom-connectors";
import type { AccessGrantTargetSelection } from "@purin-labs/control-api/portal/access-models";

// @ts-expect-error An existing account setup requires its current binding revision.
const missingBinding: CustomConnectorSetupAttempt["target"] = {
  kind: "rotate_account",
  integrationAccountId: "account",
};
const newAccount = {
  kind: "new_account" as const,
  environment: "production" as const,
};
// @ts-expect-error A new account setup cannot acquire existing-account identity through a spread.
const mixedTarget: CustomConnectorSetupAttempt["target"] = {
  ...newAccount,
  integrationAccountId: "account",
};
// @ts-expect-error An available preview always includes the actual field values.
const missingFields: CustomConnectorWritePreview = {
  kind: "available",
  accountDisplayName: "Inventory",
  operationLabel: "Create product",
  origin: "https://example.com",
  method: "POST",
  path: "/products",
};
// @ts-expect-error A custom grant cannot omit the exact reviewed definition digest.
const incompleteGrant: AccessGrantTargetSelection = {
  kind: "custom_connector_operation",
  capabilityRef: {
    capabilityId: "custom_connector.read",
    capabilityVersion: 1,
  },
  integrationRef: "integration:account",
  connectorId: "connector",
  definitionRevision: 1,
  operationId: "list",
};
void missingBinding;
void mixedTarget;
void missingFields;
void incompleteGrant;
