import React from "react";
import { Select } from "../../ui/select";
import {
  MENU_BOARD_ITEM_ROWS,
  MENU_BOARD_STYLE_PRESETS,
  MENU_BOARD_STYLE_TOKENS,
  MENU_BOARD_TYPE_BASE_LIMITS,
  MENU_BOARD_TYPE_RATIOS,
  contrastRatio,
  type MenuBoardColorToken,
  type MenuBoardFontFamily,
  type MenuBoardItemRow,
  type MenuBoardStyle,
  type MenuBoardTypeRatio,
} from "@purin-labs/menu-board-crdt/board";
import type { MenuBoardClient } from "./board-client";
import { boardColors } from "./board-view";
import "./board-style-panel.css";

/**
 * A board's style tokens (Plan 40B phase 5): a preset, four colours, the
 * fonts of headings and text, and the type scale. Every board, screen and
 * preview reads the same tokens. A token that is not set keeps the default.
 */

const COLOR_NAMES: Readonly<Record<MenuBoardColorToken, string>> = {
  background: "Background",
  surface: "Cards",
  ink: "Text",
  accent: "Accent",
};

/** The names of the item-row variants, for the board and each section. */
export const ITEM_ROW_NAMES: Readonly<Record<MenuBoardItemRow, string>> = {
  line: "Name and price",
  leader: "Dot leaders to the price",
  stacked: "Description under the name",
  price_first: "Price first",
  tiles: "Tiles",
};

const FONT_NAMES: Readonly<Record<MenuBoardFontFamily, string>> = {
  serif: "Serif",
  sans: "Sans serif",
  rounded: "Rounded",
  mono: "Monospace",
};

const RATIO_NAMES: Readonly<Record<MenuBoardTypeRatio, string>> = {
  "1.125": "1.125 · gentle",
  "1.2": "1.2 · calm",
  "1.25": "1.25 · balanced",
  "1.333": "1.333 · clear",
  "1.414": "1.414 · strong",
  "1.5": "1.5 · bold",
};

/** WCAG AA for normal text; a menu read from across a shop needs at least this. */
const READABLE_CONTRAST = 4.5;

const DEFAULTS = MENU_BOARD_STYLE_PRESETS.espresso.style;

export function BoardStylePanel(props: Readonly<{
  style: MenuBoardStyle;
  editable: boolean;
  client: React.RefObject<MenuBoardClient | null>;
}>): React.ReactNode {
  const { style } = props;
  const set = (changes: Partial<Record<keyof MenuBoardStyle, string | number | null>>): void => {
    props.client.current?.setStyle(changes);
  };
  const resolved = { ...DEFAULTS, ...style, ...boardColors(style) };
  const textContrast = contrastRatio(resolved.ink, resolved.background);
  const accentContrast = contrastRatio(resolved.accent, resolved.background);
  const cardContrast = contrastRatio(resolved.ink, resolved.surface);
  const base = resolved.typeBase;
  const ratio = Number(resolved.typeRatio);
  const preset = presetOf(style);
  return <aside className="menu-boards-drawer menu-board-style" aria-label="Board style">
    <header>
      <div>
        <span>Board</span>
        <h3>Style</h3>
      </div>
      <button
        type="button"
        className="secondary"
        disabled={!props.editable || Object.keys(style).length === 0}
        onClick={() => set(Object.fromEntries(MENU_BOARD_STYLE_TOKENS.map((token) => [token, null])))}
      >
        Use the default
      </button>
    </header>
    <div className="menu-board-style-presets" role="group" aria-label="Presets">
      {(Object.keys(MENU_BOARD_STYLE_PRESETS) as (keyof typeof MENU_BOARD_STYLE_PRESETS)[]).map((key) => {
        const candidate = MENU_BOARD_STYLE_PRESETS[key];
        return <button
          key={key}
          type="button"
          aria-pressed={preset === key}
          disabled={!props.editable}
          onClick={() => set(candidate.style)}
        >
          <span className="menu-board-style-swatch" aria-hidden="true" style={{ background: candidate.style.background }}>
            <span style={{ background: candidate.style.surface }} />
            <span style={{ background: candidate.style.ink }} />
            <span style={{ background: candidate.style.accent }} />
          </span>
          {candidate.name}
        </button>;
      })}
    </div>
    <fieldset className="menu-board-style-colors">
      <legend>Colours</legend>
      {(Object.keys(COLOR_NAMES) as MenuBoardColorToken[]).map((token) => <label key={token}>
        <input
          type="color"
          value={resolved[token]}
          disabled={!props.editable}
          onChange={(event) => set({ [token]: event.target.value.toLowerCase() })}
        />
        <span>{COLOR_NAMES[token]}</span>
        <code>{resolved[token]}</code>
      </label>)}
    </fieldset>
    <ContrastLine label="Text on the background" ratio={textContrast} />
    <ContrastLine label="Text on cards" ratio={cardContrast} />
    <ContrastLine label="Accent on the background" ratio={accentContrast} />
    <label>
      <span>Headings</span>
      <Select.Root items={FONT_NAMES} value={resolved.fontDisplay} disabled={!props.editable} onValueChange={(value) => { if (value !== null) set({ fontDisplay: value }); }}>
        <Select.Trigger><Select.Value /></Select.Trigger>
        <Select.Popup>{(Object.keys(FONT_NAMES) as MenuBoardFontFamily[]).map((family) => <Select.Item key={family} value={family}>{FONT_NAMES[family]}</Select.Item>)}</Select.Popup>
      </Select.Root>
    </label>
    <label>
      <span>Text</span>
      <Select.Root items={FONT_NAMES} value={resolved.fontBody} disabled={!props.editable} onValueChange={(value) => { if (value !== null) set({ fontBody: value }); }}>
        <Select.Trigger><Select.Value /></Select.Trigger>
        <Select.Popup>{(Object.keys(FONT_NAMES) as MenuBoardFontFamily[]).map((family) => <Select.Item key={family} value={family}>{FONT_NAMES[family]}</Select.Item>)}</Select.Popup>
      </Select.Root>
    </label>
    <div className="menu-board-style-type">
      <label>
        <span>Text size</span>
        <input
          type="number"
          min={MENU_BOARD_TYPE_BASE_LIMITS.min}
          max={MENU_BOARD_TYPE_BASE_LIMITS.max}
          value={base}
          disabled={!props.editable}
          onChange={(event) => {
            const value = Math.round(Number(event.target.value));
            if (value >= MENU_BOARD_TYPE_BASE_LIMITS.min && value <= MENU_BOARD_TYPE_BASE_LIMITS.max) set({ typeBase: value });
          }}
        />
      </label>
      <label>
        <span>Scale</span>
        <Select.Root items={RATIO_NAMES} value={resolved.typeRatio} disabled={!props.editable} onValueChange={(value) => { if (value !== null) set({ typeRatio: value }); }}>
          <Select.Trigger><Select.Value /></Select.Trigger>
          <Select.Popup>{MENU_BOARD_TYPE_RATIOS.map((value) => <Select.Item key={value} value={value}>{RATIO_NAMES[value]}</Select.Item>)}</Select.Popup>
        </Select.Root>
      </label>
    </div>
    <ol className="menu-board-style-scale" aria-label="Type scale">
      {[7, 6, 3, 1, 0, -1].map((step) => {
        const size = Math.round(base * ratio ** step);
        return <li key={step}>
          <span className="menu-board-style-scale-name">{STEP_NAMES[step] ?? `Step ${step}`}</span>
          <span>{size}</span>
        </li>;
      })}
    </ol>
    <label>
      <span>Item rows</span>
      <Select.Root
        items={ITEM_ROW_NAMES}
        value={style.itemRow ?? "line"}
        disabled={!props.editable}
        onValueChange={(value) => {
          if (value !== null) set({ itemRow: value === "line" ? null : value });
        }}
      >
        <Select.Trigger><Select.Value /></Select.Trigger>
        <Select.Popup>{MENU_BOARD_ITEM_ROWS.map((row) => <Select.Item key={row} value={row}>{ITEM_ROW_NAMES[row]}</Select.Item>)}</Select.Popup>
      </Select.Root>
    </label>
    <p className="menu-boards-drawer-note">Every item of a section repeats this row. A section can choose another row.</p>
    <p className="menu-boards-drawer-note">Sizes are board units: a landscape board is 1600 wide. Screens change only when you publish.</p>
  </aside>;
}

const STEP_NAMES: Readonly<Record<number, string>> = {
  7: "Large display",
  6: "Board title",
  3: "Featured item",
  1: "Item name",
  0: "Text",
  [-1]: "Small text",
};

function ContrastLine(props: Readonly<{ label: string; ratio: number }>): React.ReactNode {
  const readable = props.ratio >= READABLE_CONTRAST;
  return <p className="menu-board-style-contrast" data-readable={readable ? "true" : "false"} role={readable ? undefined : "status"}>
    <span>{props.label}</span>
    <strong>{props.ratio.toFixed(1)} : 1</strong>
    {readable ? null : <span>Hard to read from across the shop. Use at least {READABLE_CONTRAST} : 1.</span>}
  </p>;
}

function presetOf(style: MenuBoardStyle): string | null {
  for (const [key, preset] of Object.entries(MENU_BOARD_STYLE_PRESETS))
    if ((Object.keys(preset.style) as (keyof typeof preset.style)[]).every((token) => style[token] === preset.style[token])) return key;
  return null;
}
