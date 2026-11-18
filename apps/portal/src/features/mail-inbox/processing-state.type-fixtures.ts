import type { MailOrganizationView } from "@seams/control-api";
import type { MailProcessingState } from "./processing-state";

declare const view: MailOrganizationView;
declare const ready: Extract<MailProcessingState, { kind: "ready" }>;

// @ts-expect-error A known processing state requires its saved view.
export const missingView: MailProcessingState = { kind: "ready", notice: "" };
// @ts-expect-error An unavailable read cannot represent a known toggle value.
export const unavailableView: MailProcessingState = {
  kind: "unavailable",
  message: "Unavailable",
  view,
};
// @ts-expect-error Broad spreads cannot carry a ready view into unknown state.
export const mixedState: MailProcessingState = { ...ready, kind: "loading" };
