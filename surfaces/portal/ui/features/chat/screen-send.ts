import {
  KITCHEN_SURFACE,
  parseSurfaceObservation,
  type SurfaceObservationV2,
} from "@purin-labs/control-api";
import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import { errorMessage } from "@purin-labs/std";
import { bakerySurfaceForOrganisation } from "@purin-labs/area-kitchen-contract/ui/features/bakery-surface-registry";
import { captureSurfaceObservation } from "@purin-labs/ui/features/surface-observation";
import { takeScreenChipDecision } from "./screen-chip";
import { settleScreenSuggestion } from "./screen-relevance";
import type { Chat } from "@purin-labs/control-api/portal/chat";
import { postChatCommand, type ChatCommand } from "./api";

type ScreenCommand = Readonly<{
  kind: string;
  conversationId?: string;
  browserContext?: BakeryBrowserContext;
}>;

/** Sends a chat command with the page on the screen, when the chip says so. */
export async function sendChat(
  organisationId: string,
  command: ChatCommand,
  files: readonly File[] = [],
): Promise<Chat> {
  return postChatCommand(
    organisationId,
    await withScreenObservation(organisationId, command),
    files,
  );
}

/**
 * A message carries the page on the screen when it is sent, so the agent sees
 * what the person sees, unsaved edits included (Plan 87). The composer chip
 * decides. On Kitchen the observation also carries the Kitchen's
 * current view as its `state` (phase 2), unless a Kitchen page with its own
 * view and commands, the Pie Pastry Bench, covers the workspace: the server
 * makes the commands of a state from the workspace, so the message carries
 * that page as it is, and its commands go to that page. With the chip off on
 * the Kitchen, the message also keeps the Kitchen's browser tools out, as the
 * Kitchen switch did before.
 */
async function withScreenObservation<T extends ScreenCommand>(
  organisationId: string,
  command: T,
): Promise<T | (T & { readonly surfaceObservation: SurfaceObservationV2 })> {
  if (
    command.kind !== "message" &&
    command.kind !== "steer" &&
    command.kind !== "next"
  )
    return command;
  // A send ends the person's choice.
  const decision = takeScreenChipDecision();
  // A Jev hint or question that the person saw records what they did.
  if (command.conversationId !== undefined)
    settleScreenSuggestion(command.conversationId, decision.attached);
  if (!decision.attached)
    return decision.screen?.page === KITCHEN_SURFACE
      ? withoutKitchen(command)
      : command;
  const observation = captureSurfaceObservation(organisationId);
  if (observation === null) return command;
  if (
    observation.surface !== KITCHEN_SURFACE ||
    observation.commands.length > 0
  )
    return { ...command, surfaceObservation: observation };
  return {
    ...command,
    surfaceObservation: await withKitchenState(
      organisationId,
      observation,
      command.browserContext,
    ),
  };
}

function withoutKitchen<T extends ScreenCommand>(command: T): T {
  const browser = command.browserContext;
  return browser?.kind === "available"
    ? {
        ...command,
        browserContext: { kind: "excluded", binding: browser.binding },
      }
    : command;
}

async function withKitchenState(
  organisationId: string,
  observation: SurfaceObservationV2,
  browser: BakeryBrowserContext | undefined,
): Promise<SurfaceObservationV2> {
  const surface = bakerySurfaceForOrganisation(organisationId);
  // The Kitchen is still loading: the message carries the page alone.
  if (surface === null) return observation;
  let context;
  try {
    context = (await surface.capture()).context;
  } catch (error) {
    throw new Error(
      `The Kitchen current view could not be captured: ${errorMessage(error, "Something went wrong. Try again.")}`,
    );
  }
  const withState = parseSurfaceObservation({
    ...observation,
    instance: {
      browserInstanceId:
        browser === undefined || browser.kind === "unavailable"
          ? (observation.instance?.browserInstanceId ?? "unbound")
          : browser.binding.browserInstanceId,
      surfaceSessionId: context.surfaceSessionId,
      epoch: context.surfaceEpoch,
    },
    capturedAt: context.capturedAt,
    // The server makes the view from the state.
    view: [],
    state: context,
  });
  if (withState === null)
    throw new Error("The Kitchen current view is too large to send.");
  return withState;
}
