// The governed action that publishes the café menu (Plan 81 slice 4). The
// action path carries the exact Commerce menu and the names on the approval
// card, so an approval signs what goes live. Draft edits after the proposal
// stay in the draft for a later publication.
import { isRecord } from "@purin-labs/std";
import { parsePublishMenuCommand } from "@purin-labs/commerce-client";

import type { Result } from "../result";
import { CAFE_MENU_ID, type CafeMenuDefinition } from "../cafe/contract/menu-publication";

export const CAFE_MENU_PUBLISH_VERB = "commerce.menu.publish";

export type PublishCafeMenuAction = Readonly<{
  kind: "publish_cafe_menu";
  /** The draft revision that the proposal read, for the approval card. */
  documentRevision: number;
  /** The published revision that this menu replaces; null for the first. */
  expectedMenuRevision: number | null;
  menu: CafeMenuDefinition;
  /** Each entry's name in the draft, because a Commerce entry has none. */
  entryNames: readonly Readonly<{ menuEntryId: string; displayName: string }>[];
  addedEntryIds: readonly string[];
  removedNames: readonly string[];
}>;

type ParseError = Readonly<{ code: "commerce_action_invalid"; field: string }>;

function invalid(field: string): Result<never, ParseError> {
  return { ok: false, error: { code: "commerce_action_invalid", field } };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function isTextList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** The Commerce parser is the one rule for the shape of a menu. */
function parseMenu(value: unknown): CafeMenuDefinition | null {
  if (!isRecord(value) || value.menuId !== CAFE_MENU_ID) return null;
  try {
    return parsePublishMenuCommand({
      schemaVersion: "commerce.publish-menu.v1",
      merchantId: "merchant_action_path",
      expectedMerchantRevision: 1,
      idempotencyKey: "cafe_menu_action_path",
      requestedAt: "2026-01-01T00:00:00.000Z",
      menu: value,
    }).menu;
  } catch {
    return null;
  }
}

export function parsePublishCafeMenuRequest(
  raw: Record<string, unknown>,
): Result<PublishCafeMenuAction, ParseError> {
  const documentRevision = positiveInteger(raw.documentRevision);
  if (documentRevision === null) return invalid("documentRevision");
  const expectedMenuRevision =
    raw.expectedMenuRevision === null
      ? null
      : positiveInteger(raw.expectedMenuRevision);
  if (raw.expectedMenuRevision !== null && expectedMenuRevision === null)
    return invalid("expectedMenuRevision");
  const menu = parseMenu(raw.menu);
  if (menu === null) return invalid("menu");
  const entryIds = new Set(menu.entries.map((entry) => entry.menuEntryId));
  const entryNames: { menuEntryId: string; displayName: string }[] = [];
  if (!Array.isArray(raw.entryNames)) return invalid("entryNames");
  for (const entry of raw.entryNames as readonly unknown[]) {
    if (
      !isRecord(entry) ||
      typeof entry.menuEntryId !== "string" ||
      typeof entry.displayName !== "string" ||
      !entryIds.has(entry.menuEntryId)
    )
      return invalid("entryNames");
    entryNames.push({
      menuEntryId: entry.menuEntryId,
      displayName: entry.displayName,
    });
  }
  if (entryNames.length !== entryIds.size) return invalid("entryNames");
  if (!isTextList(raw.addedEntryIds) || !isTextList(raw.removedNames))
    return invalid("changes");
  return {
    ok: true,
    value: {
      kind: "publish_cafe_menu",
      documentRevision,
      expectedMenuRevision,
      menu,
      entryNames,
      addedEntryIds: raw.addedEntryIds,
      removedNames: raw.removedNames,
    },
  };
}

export function cafeMenuActionPath(action: PublishCafeMenuAction): string {
  const params = new URLSearchParams({
    document_revision: String(action.documentRevision),
    expected_menu_revision:
      action.expectedMenuRevision === null
        ? "none"
        : String(action.expectedMenuRevision),
    definition: JSON.stringify({
      menu: action.menu,
      entryNames: action.entryNames,
      addedEntryIds: action.addedEntryIds,
      removedNames: action.removedNames,
    }),
  });
  return `/menus/${encodeURIComponent(action.menu.menuId)}/publication?${params.toString()}`;
}

/** Null when the path names no menu publication. */
export function parseCafeMenuActionPath(
  verb: string,
  url: URL,
): Result<PublishCafeMenuAction, ParseError> | null {
  if (!/^\/menus\/[^/]+\/publication$/u.test(url.pathname)) return null;
  if (verb !== CAFE_MENU_PUBLISH_VERB) return invalid("path");
  const rawMenuRevision = url.searchParams.get("expected_menu_revision");
  let definition: unknown;
  try {
    definition = JSON.parse(url.searchParams.get("definition") ?? "");
  } catch {
    return invalid("path");
  }
  if (!isRecord(definition)) return invalid("path");
  return parsePublishCafeMenuRequest({
    ...definition,
    documentRevision: Number(url.searchParams.get("document_revision")),
    expectedMenuRevision:
      rawMenuRevision === "none" ? null : Number(rawMenuRevision),
  });
}
