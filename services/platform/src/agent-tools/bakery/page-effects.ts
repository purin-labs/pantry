import {
  parseBakerySurfaceAttachment,
  verifyBakerySurfaceAttachment,
  type BakerySurfaceAttachmentV1,
} from "@purin-labs/bakery-model/bakery-surface";
import type { HarnessTurnLease } from "@purin-labs/contracts";
import {
  COSTS_VIEW_COMMANDS,
  PASTRY_BENCH_VIEW_COMMANDS,
  REGISTER_VIEW_COMMANDS,
} from "@purin-labs/control-api";
import {
  rebindBakerySurfaceRecovery,
  reconcileBakerySurfaceEffects,
  settleBakerySurfaceEffect,
} from "../../actors/bakery-surface-effect";
import type { SessionPageEffects } from "../../actors/session/tool-wiring";
import type { Result } from "../../result";
import { installedBakerySurfaceCommands } from "./surface";

/**
 * The surface commands that a Portal turn offers (Plan 87, D16): the Pantry
 * Kitchen commands and the Costs & margins view commands, to an owner or an
 * admin, whose browser may read the commands. A command checks the page when
 * it runs.
 */
export function authorizedBakerySurfaceCommands(
  authority: HarnessTurnLease["requestAuthority"],
): readonly string[] {
  if (authority.kind !== "control") return [];
  if (authority.role === "admin" || authority.role === "owner") {
    return [
      ...installedBakerySurfaceCommands(),
      ...COSTS_VIEW_COMMANDS,
      ...PASTRY_BENCH_VIEW_COMMANDS,
      ...REGISTER_VIEW_COMMANDS,
    ];
  }
  if (authority.role === "operator") {
    return [...REGISTER_VIEW_COMMANDS];
  }
  return [];
}

async function normalizeBakerySurfaceContext(
  raw: unknown,
): Promise<
  Result<BakerySurfaceAttachmentV1 | null, { readonly code: string }>
> {
  if (raw === null) return { ok: true, value: null };
  const parsed = parseBakerySurfaceAttachment(raw);
  if (
    parsed.kind === "invalid" ||
    !(await verifyBakerySurfaceAttachment(parsed.value))
  )
    return { ok: false, error: { code: "bakery_surface_context_invalid" } };
  return { ok: true, value: parsed.value };
}

/** The effects on a person's page, as Kitchen gives them to the Session. */
export const KITCHEN_PAGE_EFFECTS: SessionPageEffects = {
  authorizedCommands: authorizedBakerySurfaceCommands,
  normalizeState: normalizeBakerySurfaceContext,
  settle: settleBakerySurfaceEffect,
  reconcile: reconcileBakerySurfaceEffects,
  rebindRecovery: rebindBakerySurfaceRecovery,
};
