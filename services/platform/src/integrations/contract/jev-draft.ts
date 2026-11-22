import {
  parseJevFeatureCommand,
  type JevFeatureCommand,
} from "@purin-labs/control-api/portal/jev-features";
import { requireActiveOrganisationActor } from "../../actors/actor-router";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import type { Result } from "@purin-labs/kernel/result";

/**
 * A change to a Jev switch that the chat agent proposed (Plan 88 section 6).
 * It is the `JevFeatureCommand` of Settings › Jev, so a card cannot express a
 * change that the page could not.
 */
export type JevDraftCommand = JevFeatureCommand;

/** Why a confirmed switch did not turn on, as Settings › Jev names it. */
export type JevDraftRefusal =
  | Readonly<{ code: "jev_key_unavailable" }>
  | Readonly<{ code: "jev_feature_source_unavailable" }>
  | Readonly<{ code: "jev_feature_unavailable" }>;

export function parseJevDraftCommand(raw: unknown): JevDraftCommand | null {
  return parseJevFeatureCommand(raw);
}

const FEATURE_NAME: Readonly<Record<JevFeatureCommand["feature"], string>> = {
  mail_classification: "Mail classification",
  related_cases: "Related Cases",
  screen_relevance: "Screen relevance",
};

const SENT_DATA: Readonly<Record<JevFeatureCommand["feature"], string>> = {
  mail_classification:
    "The subject, sender and text of each new email go to TypeSafe.",
  related_cases: "Parts of the email and Case summaries go to TypeSafe.",
  screen_relevance: "The page title and visible labels go to TypeSafe.",
};

/** The words of the card. Each field names the change, never "Confirm". */
export function presentJevDraftCommand(command: JevDraftCommand): Readonly<{
  summary: string;
  actionLabel: string;
  consequence: string;
}> {
  const name = FEATURE_NAME[command.feature];
  const mode =
    command.feature === "related_cases" && command.mode !== undefined
      ? command.mode === "shadow"
        ? " in Measure only mode"
        : " in Suggestions mode"
      : "";
  return command.enabled
    ? {
        summary: `Turn on ${name}${mode} in Settings › Jev.`,
        actionLabel: `Turn on ${name}`,
        consequence: `${SENT_DATA[command.feature]} The use counts toward the Jev allowance. An admin can turn it off at any time.`,
      }
    : {
        summary: `Turn off ${name} in Settings › Jev.`,
        actionLabel: `Turn off ${name}`,
        consequence:
          "Purin Pantry stops new Jev calls for this feature at once. Calls that started finish.",
      };
}

/** The receipt scope of one switch change. */
export function jevDraftOperation(command: JevDraftCommand): string {
  return `jev.${command.feature}.${command.enabled ? "on" : "off"}`;
}

/**
 * Applies a confirmed change through the Organisation Actor, the same method
 * that the Settings › Jev route calls. The person who confirms is the actor.
 * A switch that is already in that state stays as it is, so a repeat is safe.
 */
export async function applyJevDraftCommand(
  env: Env,
  organisationId: OrganisationId,
  command: JevDraftCommand,
  actorUserId: string,
): Promise<Result<true, JevDraftRefusal>> {
  const organisation = await requireActiveOrganisationActor({
    env,
    organisationId,
    now: Date.now(),
  });
  const changed = await organisation.manageJevFeature({
    organisationId,
    actorId: actorUserId,
    body: command,
  });
  if (changed.ok) return { ok: true, value: true };
  switch (changed.error.code) {
    case "jev_key_unavailable":
    case "jev_feature_source_unavailable":
      return { ok: false, error: { code: changed.error.code } };
    default:
      return { ok: false, error: { code: "jev_feature_unavailable" } };
  }
}
