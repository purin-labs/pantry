import { isRecord } from "@purin-labs/std";
import {
  type JevFeatureCommand,
  type JevFeaturesView,
  type JevPaidUseCommand,
  parseJevFeaturesView,
} from "@purin-labs/control-api/portal/jev-features";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "@purin-labs/control/portal/control-client";

function jevFeaturesPath(organisationId: string): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/jev-features`;
}

export async function readJevFeatures(
  organisationId: string,
): Promise<JevFeaturesView> {
  return parseJevFeaturesView(
    answerValue(await controlRead(jevFeaturesPath(organisationId))),
  );
}

export async function changeJevFeature(
  organisationId: string,
  command: JevFeatureCommand,
): Promise<JevFeaturesView> {
  return parseJevFeaturesView(
    answerValue(
      await controlMutation(
        jevFeaturesPath(organisationId),
        "POST",
        command,
        undefined,
        // Each change is its own: off and on again are two changes.
        { kind: "prepared", idempotencyKey: `portal-${crypto.randomUUID()}` },
      ),
    ),
  );
}

/** Turns paid use on or off with its monthly limit. Only the owner may. */
export async function changeJevPaidUse(
  organisationId: string,
  command: JevPaidUseCommand,
): Promise<JevFeaturesView> {
  try {
    return parseJevFeaturesView(
      answerValue(
        await controlMutation(
          `${jevFeaturesPath(organisationId)}/paid-use`,
          "POST",
          command,
          undefined,
          { kind: "prepared", idempotencyKey: `portal-${crypto.randomUUID()}` },
        ),
      ),
    );
  } catch (error) {
    // The control role check hides the route from a member who is not the owner.
    if (error instanceof ControlApiError && error.status === 404)
      throw new Error("Only the owner can turn on paid use.");
    if (
      error instanceof ControlApiError &&
      isRecord(error.details) &&
      error.details.error === "jev_paid_use_invalid"
    )
      throw new Error("Enter a spending limit that your plan allows.");
    if (
      error instanceof ControlApiError &&
      isRecord(error.details) &&
      error.details.error === "jev_payment_setup_required"
    )
      throw new Error("Set up payment in Settings › Billing first.");
    throw error;
  }
}

/** The `value` of an `{ ok: true, value }` answer. */
function answerValue(raw: unknown): unknown {
  if (!isRecord(raw) || raw.ok !== true)
    throw new Error("Jev settings are unavailable.");
  return raw.value;
}

/** A short sentence for a refused read or change. */
export function jevFeatureErrorMessage(error: unknown): string {
  const code =
    error instanceof ControlApiError &&
    isRecord(error.details) &&
    typeof error.details.error === "string"
      ? error.details.error
      : null;
  if (error instanceof ControlApiError && error.status === 403)
    return "Only an admin can change this switch.";
  switch (code) {
    case "jev_key_unavailable":
      return "Set a TypeSafe key first.";
    case "jev_feature_source_unavailable":
      return "Connect a Gmail mailbox first.";
    case "jev_feature_invalid":
      return "Pantry could not read this change. Reload the page and try again.";
    case "jev_features_unavailable":
      return "Pantry could not reach the Jev settings. Try again.";
    default:
      return error instanceof Error
        ? error.message
        : "Pantry could not change this switch. Try again.";
  }
}
