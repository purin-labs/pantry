import type {
  IntegrationDetailRouteData,
  SelectedIntegrationDetailContent,
} from "./settings-types";

declare const detailData: IntegrationDetailRouteData;

export const loadingDetail: SelectedIntegrationDetailContent = {
  kind: "loading",
  integrationId: "slack",
};

export const readyDetail: SelectedIntegrationDetailContent = {
  kind: "ready",
  integrationId: "google_drive",
  data: detailData,
};

export const invalidIdleDetail: SelectedIntegrationDetailContent = {
  kind: "idle",
  // @ts-expect-error Idle state cannot target an integration.
  integrationId: "slack",
};

// @ts-expect-error A loading detail must identify a supported integration.
export const invalidLoadingDetail: SelectedIntegrationDetailContent = {
  kind: "loading",
};

// @ts-expect-error A ready detail must include the selected integration data.
export const invalidReadyDetail: SelectedIntegrationDetailContent = {
  kind: "ready",
  integrationId: "google_drive",
};
