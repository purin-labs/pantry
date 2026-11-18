import {
  assertNever,
  hasExactKeys,
  isPositiveInteger,
  isRecord,
} from "@seams/std";
import { isUserId, type UserId } from "./ids.ts";

export type PreferenceArea = "appearance" | "chat" | "bakeryos";
/** Each palette is a data-pantry-theme value in packages/frontend-themes. */
export const PORTAL_PALETTES = ["slate-coral", "espresso", "paper"] as const;
export type PortalPalette = (typeof PORTAL_PALETTES)[number];
export type AppearancePreferences = Readonly<{
  mode: "system" | "light" | "dark";
  palette: PortalPalette;
}>;
export type AppearanceOverride =
  | Readonly<{ kind: "inherit"; value?: never }>
  | Readonly<{ kind: "custom"; value: AppearancePreferences }>;
export type MultiplayerViewPreferences = Readonly<{
  showPointers: boolean;
  showSelections: boolean;
  showParticipantNames: boolean;
}>;
export type PreferenceValues = {
  appearance: AppearancePreferences;
  chat: Readonly<{
    dockedPanelWidthPx: number;
    fullscreenSidebarWidthPx: number;
  }>;
  bakeryos: Readonly<{
    appearance: AppearanceOverride;
    scene: Readonly<{ labels: "auto" | "all" | "off"; minimap: boolean }>;
  }>;
};
export type PreferenceDocument<A extends PreferenceArea> = Readonly<{
  userId: UserId;
  area: A;
  schemaVersion: 1;
  revision: number;
  updatedAt: number;
  values: PreferenceValues[A];
}>;
export type UserPreferenceDocument = {
  [A in PreferenceArea]: PreferenceDocument<A>;
}[PreferenceArea];

export type AppearanceCommand =
  | Readonly<{ kind: "set_appearance"; value: AppearancePreferences }>
  | Readonly<{ kind: "reset" }>;
export type ChatPreferenceCommand =
  | Readonly<{ kind: "set_docked_chat_width"; widthPx: number }>
  | Readonly<{ kind: "set_fullscreen_chat_sidebar_width"; widthPx: number }>
  | Readonly<{ kind: "reset" }>;
export type BakeryPreferenceCommand =
  | Readonly<{ kind: "set_scene_labels"; labels: "auto" | "all" | "off" }>
  | Readonly<{ kind: "set_minimap"; visible: boolean }>
  | Readonly<{ kind: "set_surface_appearance"; value: AppearanceOverride }>
  | Readonly<{ kind: "reset" }>;
export type PreferenceCommands = {
  appearance: AppearanceCommand;
  chat: ChatPreferenceCommand;
  bakeryos: BakeryPreferenceCommand;
};
export type UserPreferenceEdit = {
  [A in PreferenceArea]: Readonly<{ area: A; command: PreferenceCommands[A] }>;
}[PreferenceArea];
export type PreferenceParseResult =
  | Readonly<{ ok: true; value: UserPreferenceDocument }>
  | Readonly<{
      ok: false;
      code: "preferences_invalid" | "preferences_version_unsupported";
    }>;
export type PreferenceSaveResult =
  | Readonly<{ kind: "saved"; document: UserPreferenceDocument }>
  | Readonly<{ kind: "conflict"; document: UserPreferenceDocument }>;

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  mode: "system",
  palette: "slate-coral",
};
export const DEFAULT_CHAT_PREFERENCES: PreferenceValues["chat"] = {
  dockedPanelWidthPx: 600,
  fullscreenSidebarWidthPx: 360,
};
export const DEFAULT_BAKERY_PREFERENCES: PreferenceValues["bakeryos"] = {
  appearance: { kind: "inherit" },
  scene: { labels: "auto", minimap: false },
};
export const MAX_PREFERENCE_BYTES = 8192;

export function isPreferenceArea(raw: unknown): raw is PreferenceArea {
  return raw === "appearance" || raw === "chat" || raw === "bakeryos";
}
export function isDockedChatWidth(raw: unknown): raw is number {
  return isPositiveInteger(raw) && raw >= 340;
}
export function isFullscreenSidebarWidth(raw: unknown): raw is number {
  return isPositiveInteger(raw) && raw >= 200 && raw <= 500;
}
function isSceneLabels(raw: unknown): raw is "auto" | "all" | "off" {
  return raw === "auto" || raw === "all" || raw === "off";
}
export function isPortalPalette(raw: unknown): raw is PortalPalette {
  return PORTAL_PALETTES.some((palette) => palette === raw);
}
export function parseAppearance(raw: unknown): AppearancePreferences | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["mode", "palette"]) ||
    (raw.mode !== "system" && raw.mode !== "light" && raw.mode !== "dark")
  )
    return null;
  // "sage" was the only palette before themes could be chosen; stored
  // preferences and older clients still send it, and it always meant the
  // default theme. "porcelain" was Espresso's first name.
  const palette =
    raw.palette === "sage"
      ? "slate-coral"
      : raw.palette === "porcelain"
        ? "espresso"
        : raw.palette;
  return isPortalPalette(palette) ? { mode: raw.mode, palette } : null;
}
export function parseAppearanceOverride(
  raw: unknown,
): AppearanceOverride | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "inherit" && hasExactKeys(raw, ["kind"]))
    return { kind: "inherit" };
  if (raw.kind !== "custom" || !hasExactKeys(raw, ["kind", "value"]))
    return null;
  const value = parseAppearance(raw.value);
  return value === null ? null : { kind: "custom", value };
}
export function resolveSurfaceAppearance(
  account: AppearancePreferences,
  override: AppearanceOverride,
): AppearancePreferences {
  switch (override.kind) {
    case "inherit":
      return account;
    // A surface chooses its own light or dark mode; the theme stays the
    // account's.
    case "custom":
      return { mode: override.value.mode, palette: account.palette };
    default:
      return assertNever(override);
  }
}
export function parseUserPreferenceDocument(
  raw: unknown,
): PreferenceParseResult {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "userId",
      "area",
      "schemaVersion",
      "revision",
      "updatedAt",
      "values",
    ]) ||
    !isUserId(raw.userId) ||
    !isPreferenceArea(raw.area) ||
    !isPositiveInteger(raw.revision) ||
    typeof raw.updatedAt !== "number" ||
    !Number.isSafeInteger(raw.updatedAt) ||
    raw.updatedAt < 0 ||
    new TextEncoder().encode(JSON.stringify(raw)).byteLength >
      MAX_PREFERENCE_BYTES
  )
    return { ok: false, code: "preferences_invalid" };
  if (raw.schemaVersion !== 1)
    return { ok: false, code: "preferences_version_unsupported" };
  const envelope = {
    userId: raw.userId,
    schemaVersion: 1 as const,
    revision: raw.revision,
    updatedAt: raw.updatedAt,
  };
  switch (raw.area) {
    case "appearance": {
      const values = parseAppearance(raw.values);
      return values === null
        ? { ok: false, code: "preferences_invalid" }
        : { ok: true, value: { ...envelope, area: "appearance", values } };
    }
    case "chat": {
      const values = raw.values;
      if (
        !isRecord(values) ||
        !hasExactKeys(values, [
          "dockedPanelWidthPx",
          "fullscreenSidebarWidthPx",
        ]) ||
        !isDockedChatWidth(values.dockedPanelWidthPx) ||
        !isFullscreenSidebarWidth(values.fullscreenSidebarWidthPx)
      )
        return { ok: false, code: "preferences_invalid" };
      return {
        ok: true,
        value: {
          ...envelope,
          area: "chat",
          values: {
            dockedPanelWidthPx: values.dockedPanelWidthPx,
            fullscreenSidebarWidthPx: values.fullscreenSidebarWidthPx,
          },
        },
      };
    }
    case "bakeryos": {
      const values = raw.values;
      if (
        !isRecord(values) ||
        !hasExactKeys(values, ["appearance", "scene"]) ||
        !isRecord(values.scene) ||
        !hasExactKeys(values.scene, ["labels", "minimap"]) ||
        !isSceneLabels(values.scene.labels) ||
        typeof values.scene.minimap !== "boolean"
      )
        return { ok: false, code: "preferences_invalid" };
      const appearance = parseAppearanceOverride(values.appearance);
      if (appearance === null)
        return { ok: false, code: "preferences_invalid" };
      return {
        ok: true,
        value: {
          ...envelope,
          area: "bakeryos",
          values: {
            appearance,
            scene: {
              labels: values.scene.labels,
              minimap: values.scene.minimap,
            },
          },
        },
      };
    }
    default:
      return assertNever(raw.area);
  }
}
export function defaultPreferenceDocument(
  userId: UserId,
  area: PreferenceArea,
  now: number,
): UserPreferenceDocument {
  switch (area) {
    case "appearance":
      return {
        userId,
        area,
        schemaVersion: 1,
        revision: 1,
        updatedAt: now,
        values: DEFAULT_APPEARANCE,
      };
    case "chat":
      return {
        userId,
        area,
        schemaVersion: 1,
        revision: 1,
        updatedAt: now,
        values: DEFAULT_CHAT_PREFERENCES,
      };
    case "bakeryos":
      return {
        userId,
        area,
        schemaVersion: 1,
        revision: 1,
        updatedAt: now,
        values: DEFAULT_BAKERY_PREFERENCES,
      };
    default:
      return assertNever(area);
  }
}
export function parsePreferenceEdit(
  area: PreferenceArea,
  raw: unknown,
): UserPreferenceEdit | null {
  if (!isRecord(raw)) return null;
  if (raw.kind === "reset" && hasExactKeys(raw, ["kind"]))
    return { area, command: { kind: "reset" } };
  switch (area) {
    case "appearance": {
      if (
        raw.kind !== "set_appearance" ||
        !hasExactKeys(raw, ["kind", "value"])
      )
        return null;
      const value = parseAppearance(raw.value);
      return value === null
        ? null
        : { area, command: { kind: "set_appearance", value } };
    }
    case "chat":
      if (
        (raw.kind === "set_docked_chat_width" &&
          isDockedChatWidth(raw.widthPx)) ||
        (raw.kind === "set_fullscreen_chat_sidebar_width" &&
          isFullscreenSidebarWidth(raw.widthPx))
      ) {
        if (!hasExactKeys(raw, ["kind", "widthPx"])) return null;
        return { area, command: { kind: raw.kind, widthPx: raw.widthPx } };
      }
      return null;
    case "bakeryos":
      if (
        raw.kind === "set_scene_labels" &&
        hasExactKeys(raw, ["kind", "labels"]) &&
        isSceneLabels(raw.labels)
      )
        return { area, command: { kind: raw.kind, labels: raw.labels } };
      if (
        raw.kind === "set_minimap" &&
        hasExactKeys(raw, ["kind", "visible"]) &&
        typeof raw.visible === "boolean"
      )
        return { area, command: { kind: raw.kind, visible: raw.visible } };
      if (
        raw.kind === "set_surface_appearance" &&
        hasExactKeys(raw, ["kind", "value"])
      ) {
        const value = parseAppearanceOverride(raw.value);
        return value === null
          ? null
          : { area, command: { kind: raw.kind, value } };
      }
      return null;
    default:
      return assertNever(area);
  }
}
export function applyPreferenceEdit(
  document: UserPreferenceDocument,
  edit: UserPreferenceEdit,
): UserPreferenceDocument {
  switch (edit.area) {
    case "appearance": {
      if (document.area !== "appearance")
        throw new Error("preferences_area_mismatch");
      const values =
        edit.command.kind === "reset" ? DEFAULT_APPEARANCE : edit.command.value;
      return { ...document, values };
    }
    case "chat": {
      if (document.area !== "chat")
        throw new Error("preferences_area_mismatch");
      switch (edit.command.kind) {
        case "reset":
          return { ...document, values: DEFAULT_CHAT_PREFERENCES };
        case "set_docked_chat_width":
          return {
            ...document,
            values: {
              dockedPanelWidthPx: edit.command.widthPx,
              fullscreenSidebarWidthPx:
                document.values.fullscreenSidebarWidthPx,
            },
          };
        case "set_fullscreen_chat_sidebar_width":
          return {
            ...document,
            values: {
              dockedPanelWidthPx: document.values.dockedPanelWidthPx,
              fullscreenSidebarWidthPx: edit.command.widthPx,
            },
          };
        default:
          return assertNever(edit.command);
      }
    }
    case "bakeryos": {
      if (document.area !== "bakeryos")
        throw new Error("preferences_area_mismatch");
      switch (edit.command.kind) {
        case "reset":
          return { ...document, values: DEFAULT_BAKERY_PREFERENCES };
        case "set_scene_labels":
          return {
            ...document,
            values: {
              appearance: document.values.appearance,
              scene: {
                labels: edit.command.labels,
                minimap: document.values.scene.minimap,
              },
            },
          };
        case "set_minimap":
          return {
            ...document,
            values: {
              appearance: document.values.appearance,
              scene: {
                labels: document.values.scene.labels,
                minimap: edit.command.visible,
              },
            },
          };
        case "set_surface_appearance":
          return {
            ...document,
            values: {
              appearance: edit.command.value,
              scene: document.values.scene,
            },
          };
        default:
          return assertNever(edit.command);
      }
    }
    default:
      return assertNever(edit);
  }
}
