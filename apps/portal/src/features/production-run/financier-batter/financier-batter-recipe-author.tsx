import { Select } from "../../../ui/select";
import React from "react";
import {
  DEFAULT_FINANCIER_BATTER_RECIPE,
  type FinancierBatterCheck,
  type FinancierBatterRecipeConfig,
  type FinancierHobModel,
  type FinancierMixerTool,
} from "@seams/production-simulation/recipes/financier-batter/model";

type Props = Readonly<{
  prepared(recipe: FinancierBatterRecipeConfig): void;
}>;

type State = Readonly<{
  hob: FinancierHobModel;
  tool: FinancierMixerTool;
  butterG: string;
  targetButterC: string;
  check: FinancierBatterCheck;
  notice: string;
}>;

const HOB_ITEMS = [
  { value: "maruzen", label: "Maruzen MIH-02C (2.0 kW ceramic plate)" },
  {
    value: "vollrath",
    label: "Vollrath Mirage Pro 59500P (1.8 kW countertop)",
  },
  {
    value: "panasonic-kz-ck1402",
    label: "Panasonic KZ-CK1402 (1.4 kW / 100 V starter hob)",
  },
  { value: "rinnai-rsb-150pj", label: "Rinnai RSB-150PJ (5.23 kW gas stove)" },
];

const TOOL_ITEMS = [
  { value: "beater", label: "Hobart BBEATER-HL20 Cast Aluminium Flat Beater" },
  { value: "whip", label: "Hobart DWHIP-HL20 Stainless Wire Whip" },
];

const CHECK_ITEMS = [
  {
    value: "none",
    label: "Normal run (152 °C hazelnut beurre noisette + 726 g batter)",
  },
  {
    value: "burnt-butter",
    label: "Burnt butter fault (> 170 °C scorched milk solids)",
  },
  {
    value: "guard-interlock",
    label: "Hobart HL200 wire guard interlock trip during Speed 2 agitation",
  },
];

export class FinancierBatterRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    hob: DEFAULT_FINANCIER_BATTER_RECIPE.hob,
    tool: DEFAULT_FINANCIER_BATTER_RECIPE.tool,
    butterG: String(DEFAULT_FINANCIER_BATTER_RECIPE.butterG),
    targetButterC: String(DEFAULT_FINANCIER_BATTER_RECIPE.targetButterC),
    check: DEFAULT_FINANCIER_BATTER_RECIPE.check,
    notice: "",
  };

  private submit(event: React.FormEvent): void {
    event.preventDefault();
    const butterG = Number(this.state.butterG);
    const targetButterC = Number(this.state.targetButterC);
    if (
      !Number.isFinite(butterG) ||
      butterG < 140 ||
      butterG > 220 ||
      !Number.isFinite(targetButterC) ||
      targetButterC < 142 ||
      targetButterC > 160
    ) {
      this.setState({
        notice:
          "Choose 140–220 g dairy butter and a 142–160 °C beurre noisette Maillard target.",
      });
      return;
    }
    this.props.prepared({
      hob: this.state.hob,
      tool: this.state.tool,
      butterG,
      dryMixG: 395,
      eggWhitesG: 181,
      targetButterC,
      check: this.state.check,
    });
  }

  render(): React.ReactNode {
    return (
      <form
        onSubmit={this.submit.bind(this)}
        aria-label="Financier batter Cobot recipe"
      >
        <h3>Financier Batter · Beurre Noisette &amp; Hobart HL200 Mix</h3>
        <p>
          FAIRINO FR10 Cobot tares the Ohaus Ranger 3000 bench scale, browns{" "}
          {this.state.butterG} g of Normandy butter on the induction hob to{" "}
          {this.state.targetButterC} °C hazelnut beurre noisette, charges 395 g
          sifted almond-sugar tant-pour-tant and 181 g egg whites into the
          Hobart HL200 20 qt planetary mixer, and folds a 726 g golden batter.
        </p>
        <label>
          Induction hob model
          <Select.Root
            items={HOB_ITEMS}
            value={this.state.hob}
            onValueChange={(v) => {
              if (v === null) return;
              this.setState({
                hob:
                  v === "vollrath" ||
                  v === "panasonic-kz-ck1402" ||
                  v === "rinnai-rsb-150pj"
                    ? v
                    : "maruzen",
              });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{HOB_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Hobart HL200 20 qt agitator
          <Select.Root
            items={TOOL_ITEMS}
            value={this.state.tool}
            onValueChange={(value) => {
              if (value === null) return;
              this.setState({
                tool: value === "whip" ? "whip" : "beater",
              });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{TOOL_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Raw dairy butter charge (g)
          <input
            type="number"
            min={140}
            max={220}
            step={5}
            value={this.state.butterG}
            onChange={(e) => this.setState({ butterG: e.currentTarget.value })}
          />
        </label>
        <label>
          Target beurre noisette Maillard peak (°C)
          <input
            type="number"
            min={142}
            max={160}
            step={1}
            value={this.state.targetButterC}
            onChange={(e) =>
              this.setState({ targetButterC: e.currentTarget.value })
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
                  v === "burnt-butter" || v === "guard-interlock" ? v : "none",
              });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{CHECK_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <button type="submit">Prepare Financier batter station</button>
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
