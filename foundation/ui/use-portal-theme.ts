import React from "react";
import {
  DEFAULT_APPEARANCE,
  isPortalPalette,
  resolveSurfaceAppearance,
  type AppearancePreferences,
  type PortalPalette,
} from "@purin-labs/control-api";
import { useUserPreferences } from "./preferences/context";
import type { UserPreferenceOwner } from "./preferences/owner";

type PortalTheme = "light" | "dark";
function systemTheme(): PortalTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}
function observeSystem(
  setSystem: React.Dispatch<React.SetStateAction<PortalTheme>>,
): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = updateSystem.bind(null, setSystem);
  query.addEventListener("change", listener);
  return query.removeEventListener.bind(query, "change", listener);
}
function updateSystem(
  setSystem: React.Dispatch<React.SetStateAction<PortalTheme>>,
  event: Event,
): void {
  if (event instanceof MediaQueryListEvent)
    setSystem(event.matches ? "dark" : "light");
}
function applyTheme(
  theme: PortalTheme,
  enabled: boolean,
  mode: AppearancePreferences["mode"],
  palette: PortalPalette,
): void {
  if (!enabled) return;
  document.documentElement.dataset.portalTheme = theme;
  document.documentElement.dataset.portalMode = mode;
  document.documentElement.dataset.pantryTheme = palette;
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem("pantry:portal-appearance", mode);
    localStorage.setItem("pantry:portal-palette", palette);
  } catch {
    // Account preferences still apply when the startup paint hint cannot be saved.
  }
}
function initialAppearance(): AppearancePreferences {
  const mode = document.documentElement.dataset.portalMode;
  const palette = document.documentElement.dataset.pantryTheme;
  return {
    mode: mode === "light" || mode === "dark" ? mode : "system",
    palette: isPortalPalette(palette) ? palette : DEFAULT_APPEARANCE.palette,
  };
}
function accountAppearance(
  owner: UserPreferenceOwner | null,
): AppearancePreferences {
  const document = owner?.document("appearance");
  return document?.area === "appearance" ? document.values : DEFAULT_APPEARANCE;
}
export function usePortalTheme(
  area: "appearance" | "kitchen" = "appearance",
  apply: boolean = true,
) {
  const owner = useUserPreferences(area);
  const [system, setSystem] = React.useState(systemTheme);
  const [unsigned, setUnsigned] =
    React.useState<AppearancePreferences>(initialAppearance);
  React.useEffect(observeSystem.bind(null, setSystem), []);
  const account = owner === null ? unsigned : accountAppearance(owner);
  let appearance = account;
  const surface = area === "kitchen" ? owner?.document("kitchen") : null;
  if (surface?.area === "kitchen")
    appearance = resolveSurfaceAppearance(
      appearance,
      surface.values.appearance,
    );
  const theme = appearance.mode === "system" ? system : appearance.mode;
  React.useLayoutEffect(
    applyTheme.bind(null, theme, apply, appearance.mode, appearance.palette),
    [theme, apply, appearance.mode, appearance.palette],
  );
  return {
    theme,
    mode: appearance.mode,
    palette: appearance.palette,
    toggleTheme: toggleTheme.bind(null, owner, setUnsigned, account, theme),
    setMode: setMode.bind(null, owner, setUnsigned, account),
    setPalette: setPalette.bind(null, owner, setUnsigned, account),
  };
}
function toggleTheme(
  owner: UserPreferenceOwner | null,
  setUnsigned: React.Dispatch<React.SetStateAction<AppearancePreferences>>,
  account: AppearancePreferences,
  theme: PortalTheme,
): void {
  setMode(owner, setUnsigned, account, theme === "dark" ? "light" : "dark");
}
function setMode(
  owner: UserPreferenceOwner | null,
  setUnsigned: React.Dispatch<React.SetStateAction<AppearancePreferences>>,
  account: AppearancePreferences,
  mode: AppearancePreferences["mode"],
): void {
  saveAppearance(owner, setUnsigned, { mode, palette: account.palette });
}
function setPalette(
  owner: UserPreferenceOwner | null,
  setUnsigned: React.Dispatch<React.SetStateAction<AppearancePreferences>>,
  account: AppearancePreferences,
  palette: PortalPalette,
): void {
  saveAppearance(owner, setUnsigned, { mode: account.mode, palette });
}
function saveAppearance(
  owner: UserPreferenceOwner | null,
  setUnsigned: React.Dispatch<React.SetStateAction<AppearancePreferences>>,
  value: AppearancePreferences,
): void {
  if (owner === null) setUnsigned(value);
  else
    owner.edit({
      area: "appearance",
      command: { kind: "set_appearance", value },
    });
}
