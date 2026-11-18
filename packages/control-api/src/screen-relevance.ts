import { Type, type Static } from "typebox";
import { recordParser } from "@seams/commerce-contracts/schema";
import {
  surfaceObservationSchema,
  type SurfaceObservationV2,
} from "./surface-observation.ts";

/**
 * The Jev relevance suggestion of the composer (Plan 87 section 3A). While the
 * person types with the page chip off, the Portal asks if the draft is about
 * the page on screen. Jev only suggests: the person's click attaches a page.
 */

/** The shortest draft that the composer checks. */
export const SCREEN_RELEVANCE_MIN_DRAFT = 12;
/** The longest draft that goes to Jev. The composer allows 8,000 characters. */
export const SCREEN_RELEVANCE_MAX_DRAFT = 4_000;
/** The pause after the last key press before the composer checks. */
export const SCREEN_RELEVANCE_PAUSE_MS = 500;

export const screenRelevanceRequestSchema = Type.Object({
  draft: Type.String({
    minLength: SCREEN_RELEVANCE_MIN_DRAFT,
    maxLength: SCREEN_RELEVANCE_MAX_DRAFT,
  }),
  /**
   * The default observation of the page on screen. Jev gets only its title,
   * its area, its open record and its section titles.
   */
  observation: surfaceObservationSchema,
});

export type ScreenRelevanceRequest = Static<
  typeof screenRelevanceRequestSchema
>;

export type ScreenRelevanceBand = "quiet" | "hint" | "ask";

/** Why the check sent nothing to Jev. The chip shows it. */
export type ScreenRelevanceRefusal =
  "page_not_shared" | "canvas" | "chat_read_only" | "chat_history_unavailable";

export type ScreenRelevanceView =
  | Readonly<{
      kind: ScreenRelevanceBand;
      offerNewChat: boolean;
      /** The record of a hint or a question; null for quiet. */
      checkId: string | null;
    }>
  | Readonly<{ kind: "refused"; reason: ScreenRelevanceRefusal }>
  | Readonly<{ kind: "unavailable" }>;

/** What the person did with a hint or a question. */
export type ScreenRelevanceChoice =
  "attached" | "sent_without" | "new_chat" | "no_action";

export const SCREEN_RELEVANCE_CHOICES: readonly ScreenRelevanceChoice[] = [
  "attached",
  "sent_without",
  "new_chat",
  "no_action",
];

export function isScreenRelevanceChoice(
  raw: unknown,
): raw is ScreenRelevanceChoice {
  return SCREEN_RELEVANCE_CHOICES.some((choice) => choice === raw);
}

const SCREEN_RELEVANCE_CHECK_ID = /^src_[a-f0-9]{32}$/u;

export function isScreenRelevanceCheckId(raw: unknown): raw is string {
  return typeof raw === "string" && SCREEN_RELEVANCE_CHECK_ID.test(raw);
}

const decodeRequest = recordParser(screenRelevanceRequestSchema);

export function parseScreenRelevanceRequest(
  raw: unknown,
): ScreenRelevanceRequest | null {
  const decoded = decodeRequest(raw);
  return decoded.ok ? decoded.value : null;
}

/**
 * The observation that the composer sends for the check: the page's sections
 * keep their titles and lose their facts and rows.
 */
export function screenRelevanceObservation(
  observation: SurfaceObservationV2,
): SurfaceObservationV2 {
  return {
    ...observation,
    view: observation.view.map((section) => ({
      title: section.title,
      facts: [],
      table: null,
    })),
    state: null,
    commands: [],
    sources: [],
  };
}

export function parseScreenRelevanceView(
  raw: unknown,
): ScreenRelevanceView | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  switch (value.kind) {
    case "quiet":
    case "hint":
    case "ask":
      return typeof value.offerNewChat === "boolean" &&
        (value.checkId === null || isScreenRelevanceCheckId(value.checkId))
        ? {
            kind: value.kind,
            offerNewChat: value.offerNewChat,
            checkId: value.checkId,
          }
        : null;
    case "refused":
      return value.reason === "page_not_shared" ||
        value.reason === "canvas" ||
        value.reason === "chat_read_only" ||
        value.reason === "chat_history_unavailable"
        ? { kind: "refused", reason: value.reason }
        : null;
    case "unavailable":
      return { kind: "unavailable" };
    default:
      return null;
  }
}
