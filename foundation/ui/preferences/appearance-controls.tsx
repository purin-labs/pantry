import "./appearance-controls.css";
import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Moon, Sun, Palette } from "lucide-react";
import {
  DEFAULT_APPEARANCE,
  type AppearancePreferences,
  type PortalPalette,
} from "@purin-labs/control-api";
import { useUserPreferences } from "./context";
import type { UserPreferenceOwner } from "./owner";
import { usePortalTheme } from "../use-portal-theme";

type ModeChoice = Readonly<{
  value: AppearancePreferences["mode"];
  label: string;
}>;
const MODES: readonly ModeChoice[] = [
  { value: "system", label: "Use device appearance" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];
type PaletteChoice = Readonly<{ value: PortalPalette; label: string }>;
const PALETTES: readonly PaletteChoice[] = [
  { value: "slate-coral", label: "Slate" },
  { value: "espresso", label: "Espresso" },
  { value: "paper", label: "Paper" },
];
/**
 * The appearance button and its menu. `side` says where the menu opens: under
 * the button in a top bar, over it at the foot of the sidebar, and beside it
 * on the collapsed rail.
 */
export function AccountAppearanceControl(
  props: Readonly<{ side?: "bottom" | "top" | "right" }>,
): React.ReactNode {
  const appearance = usePortalTheme("appearance", false);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="portal-theme-toggle"
          aria-label="Account appearance"
        >
          {appearance.theme === "dark" ? (
            <Sun size={18} aria-hidden="true" />
          ) : (
            <Moon size={18} aria-hidden="true" />
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="preference-appearance-menu"
          side={props.side ?? "bottom"}
          sideOffset={8}
          align="end"
          collisionPadding={12}
          aria-label="Account appearance"
        >
          <DropdownMenu.Label className="preference-appearance-label">
            Mode
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={appearance.mode}>
            {MODES.map(renderMode.bind(null, appearance.setMode))}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator />
          <DropdownMenu.Label className="preference-appearance-label">
            Theme
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={appearance.palette}>
            {PALETTES.map(renderPalette.bind(null, appearance.setPalette))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
function renderMode(
  select: (mode: AppearancePreferences["mode"]) => void,
  choice: ModeChoice,
): React.ReactNode {
  return (
    <DropdownMenu.RadioItem
      key={choice.value}
      value={choice.value}
      onSelect={select.bind(null, choice.value)}
    >
      <span className="preference-appearance-check">
        <DropdownMenu.ItemIndicator>
          <Check size={16} aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      {choice.label}
    </DropdownMenu.RadioItem>
  );
}
function renderPalette(
  select: (palette: PortalPalette) => void,
  choice: PaletteChoice,
): React.ReactNode {
  return (
    <DropdownMenu.RadioItem
      key={choice.value}
      value={choice.value}
      onSelect={select.bind(null, choice.value)}
    >
      <span className="preference-appearance-check">
        <DropdownMenu.ItemIndicator>
          <Check size={16} aria-hidden="true" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span
        className="preference-palette-swatch"
        data-palette={choice.value}
        aria-hidden="true"
      />
      {choice.label}
    </DropdownMenu.RadioItem>
  );
}
export function BakeryAppearanceControl(): React.ReactNode {
  const owner = useUserPreferences("kitchen");
  if (owner === null) return null;
  const document = owner.document("kitchen");
  if (document.area !== "kitchen") return null;
  const override = document.values.appearance;
  const mode = override.kind === "inherit" ? "inherit" : override.value.mode;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Kitchen appearance"
          data-tooltip="Theme & appearance"
        >
          <Palette aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="preference-appearance-menu"
          side="top"
          sideOffset={8}
          align="end"
          collisionPadding={12}
          aria-label="Kitchen appearance"
        >
          <DropdownMenu.RadioGroup value={mode}>
            <DropdownMenu.RadioItem
              value="inherit"
              onSelect={inheritAppearance.bind(null, owner)}
            >
              <span className="preference-appearance-check">
                <DropdownMenu.ItemIndicator>
                  <Check size={16} aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </span>
              Use account appearance
            </DropdownMenu.RadioItem>
            <DropdownMenu.Separator />
            {MODES.map(
              renderMode.bind(null, customizeAppearance.bind(null, owner)),
            )}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
function inheritAppearance(owner: UserPreferenceOwner): void {
  owner.edit({
    area: "kitchen",
    command: { kind: "set_surface_appearance", value: { kind: "inherit" } },
  });
}
function customizeAppearance(
  owner: UserPreferenceOwner,
  mode: AppearancePreferences["mode"],
): void {
  owner.edit({
    area: "kitchen",
    command: {
      kind: "set_surface_appearance",
      // The surface keeps only the mode; the account theme always applies.
      value: {
        kind: "custom",
        value: { mode, palette: DEFAULT_APPEARANCE.palette },
      },
    },
  });
}
