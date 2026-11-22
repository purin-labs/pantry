import type { IntegrationRouteId, IntegrationRouteSelection } from "./model";

export const overviewSelection: IntegrationRouteSelection = {
  kind: "overview",
  query: "drive",
  focusId: "integration:google_drive",
};

export const detailSelection: IntegrationRouteSelection = {
  kind: "detail",
  integrationId: "google_drive",
  accountId: "account-1",
  query: "drive",
};

// @ts-expect-error An overview cannot select an account.
export const invalidOverview: IntegrationRouteSelection = {
  kind: "overview",
  query: "",
  focusId: null,
  accountId: "account-1",
};

// @ts-expect-error A detail route cannot carry an overview focus target.
export const invalidDetail: IntegrationRouteSelection = {
  kind: "detail",
  integrationId: "slack",
  accountId: null,
  query: "",
  focusId: "integration:slack",
};

// @ts-expect-error Changing the discriminant cannot retain detail-only fields.
export const invalidSpread: IntegrationRouteSelection = {
  ...detailSelection,
  kind: "overview",
  focusId: null,
};

// @ts-expect-error Route ids must be members of the supported catalog.
export const invalidRouteId: IntegrationRouteId = "linear";
