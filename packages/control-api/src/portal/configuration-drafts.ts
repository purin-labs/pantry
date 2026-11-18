import { isNonNegativeInteger, isRecord } from "@seams/std";

/** A setup change or a price allowance that the agent staged in this chat. */
export type ConfigurationDraftView = Readonly<{
  draftId: string;
  summary: string;
  actionLabel: string;
  consequence: string;
  state: "pending" | "confirmed" | "settled" | "cancelled" | "expired";
  receiptCode: string | null;
  requestedByViewer: boolean;
  createdAt: number;
}>;

export function parseConfigurationDrafts(
  raw: unknown,
): readonly ConfigurationDraftView[] {
  // A server without these cards sends none.
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new Error("The server returned an invalid list of setup changes.");
  return raw.map(parseConfigurationDraft);
}

const STATES: Readonly<Record<ConfigurationDraftView["state"], true>> = {
  pending: true,
  confirmed: true,
  settled: true,
  cancelled: true,
  expired: true,
};

function isState(value: unknown): value is ConfigurationDraftView["state"] {
  return typeof value === "string" && Object.hasOwn(STATES, value);
}

export function parseConfigurationDraft(raw: unknown): ConfigurationDraftView {
  if (
    !isRecord(raw) ||
    typeof raw.draftId !== "string" ||
    typeof raw.summary !== "string" ||
    typeof raw.actionLabel !== "string" ||
    typeof raw.consequence !== "string" ||
    !isState(raw.state) ||
    (raw.receiptCode !== null && typeof raw.receiptCode !== "string") ||
    typeof raw.requestedByViewer !== "boolean" ||
    !isNonNegativeInteger(raw.createdAt)
  )
    throw new Error("The server returned an invalid setup change.");
  return {
    draftId: raw.draftId,
    summary: raw.summary,
    actionLabel: raw.actionLabel,
    consequence: raw.consequence,
    state: raw.state,
    receiptCode: raw.receiptCode,
    requestedByViewer: raw.requestedByViewer,
    createdAt: raw.createdAt,
  };
}
