import type { MailOrganizationView } from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";
import type { StrictUnion } from "@purin-labs/type-utils";

export type MailProcessingState = StrictUnion<
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; message: string }>
  | Readonly<{ kind: "updating"; view: MailOrganizationView }>
  | Readonly<{ kind: "ready"; view: MailOrganizationView; notice: string }>
>;

export function mailProcessingView(
  state: MailProcessingState,
): MailOrganizationView | null {
  switch (state.kind) {
    case "loading":
    case "unavailable":
      return null;
    case "updating":
    case "ready":
      return state.view;
    default:
      return assertNever(state);
  }
}

/**
 * The page's notice. A read or an update in progress has none: the header's
 * busy mark shows it without moving the list.
 */
export function processingNotice(state: MailProcessingState): string {
  switch (state.kind) {
    case "loading":
    case "updating":
      return "";
    case "unavailable":
      return state.message;
    case "ready":
      return state.notice;
    default:
      return assertNever(state);
  }
}
