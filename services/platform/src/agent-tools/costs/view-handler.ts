import {
  COSTS_SURFACE,
  KITCHEN_SURFACE,
  REGISTER_SURFACE,
  isConversationId,
  pageViewCommandSurface,
  type PageViewCommand,
  type SurfaceObservationV2,
  type SurfacePageCommandV1,
} from "@purin-labs/control-api";
import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import type { OrganisationDatabase } from "../../database-handles";
import { parseUserId, type OrganisationId } from "../../ids";
import type { AccountPlatformAccess } from "../../account-platform/access";
import { dispatchBakerySurfaceEffect } from "../../actors/bakery-surface-effect";
import { timelineVisibleMessages } from "../../chat/conversation";
import { readConversation } from "../../chat/store";
import { BakeryContextRequestError } from "../kitchen/services";
import { requireLiveBakeryAuthority } from "../bakery/handlers";

/**
 * Runs one Portal page view command in the person's browser (Plan 87 phase 4,
 * shared across Costs & margins and the Kitchen Pie Pastry Bench). The
 * command goes only to a page that the person's current message carried, as
 * it was admitted: a chip that was off keeps the page out, and the command
 * names that page instance. It travels through the Kitchen outbox, with
 * its receipt, recovery and push signal.
 */
export async function executeCostsViewForHarness(
  authority: {
    readonly db: OrganisationDatabase;
    readonly accountAccess: AccountPlatformAccess;
    readonly storage: DurableObjectStorage;
    readonly organisationId: OrganisationId;
    readonly sessionId: string;
    readonly requestId: string;
    readonly lease: HarnessTurnLease;
    readonly browserContext: BakeryBrowserContext;
    readonly agentLabel: () => Promise<string>;
    readonly announceEffect: () => void;
  },
  command: PageViewCommand,
  callId: string,
): Promise<unknown> {
  const surface = pageViewCommandSurface(command);
  const pageName =
    surface === COSTS_SURFACE
      ? "Costs & margins"
      : surface === REGISTER_SURFACE
        ? "Café Register"
        : "Kitchen Pastry Bench";
  const requester = authority.lease.requestAuthority;
  if (
    requester.kind !== "control" ||
    authority.browserContext.kind === "unavailable"
  )
    throw new BakeryContextRequestError(
      `This request has no eligible browser. Open chat in the Portal to use ${pageName} commands.`,
    );
  const binding = authority.browserContext.binding;
  const observation = await currentPageObservation(
    authority.db,
    authority.organisationId,
    requester.userId,
    binding.conversationId,
    surface,
  );
  if (
    observation === null ||
    observation.instance === null ||
    !observation.commands.includes(command.name)
  )
    throw new BakeryContextRequestError(
      `The person's current message does not carry ${pageName}. Ask them to send it from the page with the screen chip on.`,
    );
  await requireLiveBakeryAuthority(
    authority.db,
    authority.storage,
    authority.organisationId,
    authority.lease,
    authority.accountAccess,
    { allowOperator: surface === REGISTER_SURFACE },
  );
  const agentLabel = await authority.agentLabel();
  const target = {
    surfaceSessionId: observation.instance.surfaceSessionId,
    epoch: observation.instance.epoch,
  };
  const pageCommand: SurfacePageCommandV1 =
    command.name === "configure_pastry_bench" ||
    command.name === "prepare_pastry_bench"
      ? {
          kind: "page_command",
          schemaVersion: 1,
          surface: KITCHEN_SURFACE,
          binding,
          target,
          command,
          agentLabel,
        }
      : command.name === "register_add_item" ||
          command.name === "register_update_line" ||
          command.name === "register_remove_line" ||
          command.name === "register_clear_basket"
        ? {
            kind: "page_command",
            schemaVersion: 1,
            surface: REGISTER_SURFACE,
            binding,
            target,
            command,
            agentLabel,
          }
        : {
            kind: "page_command",
            schemaVersion: 1,
            surface: COSTS_SURFACE,
            binding,
            target,
            command,
            agentLabel,
          };
  const dispatched = await dispatchBakerySurfaceEffect({
    db: authority.db,
    storage: authority.storage,
    organisationId: authority.organisationId,
    sessionId: authority.sessionId,
    requestId: authority.requestId,
    userId: requester.userId,
    lease: authority.lease,
    callId,
    command: pageCommand,
    announce: authority.announceEffect,
  });
  return {
    ...dispatched,
    saveVerification: { kind: "none" },
    scenarioSaveResult: { kind: "none" },
  };
}

/** The page observation of the person's current message, as admitted. */
async function currentPageObservation(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  userId: string,
  conversationId: string,
  surface: typeof COSTS_SURFACE | typeof KITCHEN_SURFACE | typeof REGISTER_SURFACE,
): Promise<SurfaceObservationV2 | null> {
  if (!isConversationId(conversationId)) return null;
  const user = parseUserId(userId);
  if (!user.ok) return null;
  const stored = await readConversation(
    db,
    { organisationId, userId: user.value },
    conversationId,
  );
  if (stored === null) return null;
  const message = timelineVisibleMessages(stored.conversation).findLast(
    (candidate) => candidate.kind === "user",
  );
  const observation =
    message?.kind === "user" ? message.surfaceObservation : undefined;
  return observation?.surface === surface ? observation : null;
}
