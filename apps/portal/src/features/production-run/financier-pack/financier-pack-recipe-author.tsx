import { Select } from "../../../ui/select";
import React from "react";
import {
  DEFAULT_FINANCIER_PACK_RECIPE,
  type FinancierBoxStyle,
  type FinancierPackCheck,
  type FinancierPackLoadPreset,
  type FinancierPackRecipeConfig,
} from "@seams/production-simulation/recipes/financier-pack/model";

type Props = Readonly<{
  prepared(recipe: FinancierPackRecipeConfig): void;
}>;

type State = Readonly<{
  loadPreset: FinancierPackLoadPreset;
  boxStyle: FinancierBoxStyle;
  coolingMinutes: string;
  crumbSamplePieces: 0 | 1;
  check: FinancierPackCheck;
  notice: string;
}>;

const LOAD_PRESET_ITEMS = [
  {
    value: "two-accepted-16",
    label:
      "Plan 61A 3-load campaign (24 baked − 8 rejected = 16 accepted · 376.0 g)",
  },
  {
    value: "single-load-8",
    label: "Single Matsunaga 8P mould load (8 accepted · 188.0 g)",
  },
];

const BOX_STYLE_ITEMS = [
  {
    value: "atelier-15",
    label: "15-Piece Atelier Coffret (352.5 g net · gold satin ribbon)",
  },
  {
    value: "patisserie-8",
    label:
      "7/8-Piece Boutique Ballotin (164.5–188.0 g net · gold satin ribbon)",
  },
];

const CRUMB_SAMPLE_PIECES_ITEMS = [
  {
    value: "1",
    label: "Sample 1 × 23.5 g piece for honeycombed crumb inspection",
  },
  {
    value: "0",
    label: "Skip destructive crumb sample (pack all accepted pieces)",
  },
];

const CHECK_ITEMS = [
  {
    value: "none",
    label: "Normal demould, 23.5 g crumb sample & verified gift-box release",
  },
  {
    value: "warm-demould",
    label: "Premature warm demoulding (> 55 °C core tears fragile bosse crown)",
  },
  {
    value: "underweight-box",
    label: "Ohaus net check-weight shortfall (−23.5 g missing piece hold)",
  },
];

export class FinancierPackRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    loadPreset: DEFAULT_FINANCIER_PACK_RECIPE.loadPreset,
    boxStyle: DEFAULT_FINANCIER_PACK_RECIPE.boxStyle,
    coolingMinutes: String(DEFAULT_FINANCIER_PACK_RECIPE.coolingMinutes),
    crumbSamplePieces: DEFAULT_FINANCIER_PACK_RECIPE.crumbSamplePieces,
    check: DEFAULT_FINANCIER_PACK_RECIPE.check,
    notice: "",
  };

  private submit(event: React.FormEvent): void {
    event.preventDefault();
    const coolingMinutes = Number(this.state.coolingMinutes);
    if (
      !Number.isFinite(coolingMinutes) ||
      coolingMinutes < 2 ||
      coolingMinutes > 20
    ) {
      this.setState({
        notice:
          "Choose a 2–20 minute wire-grid cooling window before packaging release.",
      });
      return;
    }
    this.props.prepared({
      loadPreset: this.state.loadPreset,
      boxStyle: this.state.boxStyle,
      coolingMinutes,
      crumbSamplePieces: this.state.crumbSamplePieces,
      check: this.state.check,
    });
  }

  render(): React.ReactNode {
    const isTwoLoad = this.state.loadPreset === "two-accepted-16";
    const demoulded = isTwoLoad ? 16 : 8;
    const packed = demoulded - this.state.crumbSamplePieces;
    const netG = (packed * 23.5).toFixed(1);
    return (
      <form
        onSubmit={this.submit.bind(this)}
        aria-label="Financier pack Cobot recipe"
      >
        <h3>
          Financier Pack · Wire-Grid Demoulding, Crumb Check &amp; Gift Box
        </h3>
        <p>
          FAIRINO FR10 Cobot cools baked financiers in the Matsunaga 8P
          silicone-coated mould for 2–3 minutes, inverts and releases{" "}
          {demoulded} golden-amber <em>bosse</em> financiers (23.5 g/piece) onto
          the wire cooling grid, stages the mould in the manual-care wash basin,
          performs the 10-minute crumb check on the Ohaus Ranger 3000 scale, and
          packs {packed} financiers ({netG} g net) into a gold-ribbon patisserie
          gift box.
        </p>
        <label>
          Accepted baked financier load (Plan 61A mass balance)
          <Select.Root
            items={LOAD_PRESET_ITEMS}
            value={this.state.loadPreset}
            onValueChange={(value) => {
              if (value === null) return;
              const loadPreset =
                value === "single-load-8" ? "single-load-8" : "two-accepted-16";
              this.setState({
                loadPreset,
                boxStyle:
                  loadPreset === "two-accepted-16"
                    ? "atelier-15"
                    : "patisserie-8",
              });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{LOAD_PRESET_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Patisserie gift-box format
          <Select.Root
            items={BOX_STYLE_ITEMS}
            value={this.state.boxStyle}
            onValueChange={(value) => {
              if (value === null) return;
              const boxStyle =
                value === "patisserie-8" ? "patisserie-8" : "atelier-15";
              this.setState({ boxStyle });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{BOX_STYLE_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          10-minute internal crumb check sample (23.5 g piece)
          <Select.Root
            items={CRUMB_SAMPLE_PIECES_ITEMS}
            value={String(this.state.crumbSamplePieces)}
            onValueChange={(value) => {
              if (value === null) return;
              this.setState({
                crumbSamplePieces: value === "0" ? 0 : 1,
              });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {CRUMB_SAMPLE_PIECES_ITEMS.map(renderItem)}
            </Select.Popup>
          </Select.Root>
        </label>
        <label>
          Wire-grid cooling duration before packaging (minutes)
          <input
            type="number"
            min={2}
            max={20}
            step={1}
            value={this.state.coolingMinutes}
            onChange={(e) =>
              this.setState({ coolingMinutes: e.currentTarget.value })
            }
          />
        </label>
        <label>
          Process check
          <Select.Root
            items={CHECK_ITEMS}
            value={this.state.check}
            onValueChange={(v) => {
              if (v === null) return;
              this.setState({
                check:
                  v === "warm-demould" || v === "underweight-box" ? v : "none",
              });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{CHECK_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <button type="submit">Prepare Financier pack station</button>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}

function renderItem(
  item: Readonly<{ value: string; label: string }>,
): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}
