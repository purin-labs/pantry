import { Select } from "../../../ui/select";
import React from "react";
import {
  DEFAULT_FINANCIER_BAKE_RECIPE,
  type FinancierBakeCheck,
  type FinancierBakeMode,
  type FinancierBakeRecipeConfig,
  type FinancierMouldCount,
  type FinancierRackSlot,
} from "@seams/production-simulation/recipes/financier-bake/model";

type Props = Readonly<{
  prepared(recipe: FinancierBakeRecipeConfig): void;
}>;

type State = Readonly<{
  mode: FinancierBakeMode;
  mouldCount: FinancierMouldCount;
  rackSlot: FinancierRackSlot;
  targetOvenTempC: string;
  portionG: string;
  check: FinancierBakeCheck;
  notice: string;
}>;

const HANDOFF_PRESET_ITEMS = [
  {
    value: "nominal-handoff",
    label:
      "Nominal handoff (0 mm carrier alignment · direct Robot cell 1 transfer)",
  },
  {
    value: "carrier-slip-recovery",
    label:
      "Fault-recovery preset · 14 mm carrier rail slip & FR10 cell 1 re-seat (+45 s buffer)",
  },
  {
    value: "cell-2-restage-recovery",
    label:
      "Fault-recovery preset · 18 mm clamp hold & Cell 1 → Cell 2 failover restage (+120 s release)",
  },
];

const MODE_ITEMS = [
  {
    value: "convection",
    label: "170 °C Convection (1450 RPM circulation fan)",
  },
  {
    value: "conventional",
    label: "180 °C Conventional (natural thermal draft)",
  },
];

const MOULD_COUNT_ITEMS = [
  {
    value: "1",
    label: "1 × Matsunaga 8P (8 cavities · 200 g filled → 188 g baked)",
  },
  {
    value: "2",
    label: "2 × Matsunaga 8P (16 cavities · 400 g filled → 376 g baked)",
  },
  {
    value: "3",
    label: "3 × Matsunaga 8P (24 cavities · 600 g filled → 564 g baked)",
  },
];

const RACK_SLOT_ITEMS = [
  { value: "2", label: "mbco_slot_2 (Z = 269 mm lower-middle rail)" },
  { value: "3", label: "mbco_slot_3 (Z = 357 mm centre rail)" },
  { value: "4", label: "mbco_slot_4 (Z = 445 mm upper-middle rail)" },
];

const CHECK_ITEMS = [
  {
    value: "none",
    label:
      "Normal run (central bosse rise, golden Maillard crust & 6% steam loss)",
  },
  {
    value: "carrier-handoff-recovery",
    label:
      "Fault-recovery calibration · 14 mm carrier slip & FR10 cell 1 re-seat",
  },
  {
    value: "cell-2-restage-recovery",
    label:
      "Fault-recovery calibration · 18 mm clamp hold & Cell 1 → Cell 2 failover",
  },
  {
    value: "under-preheated",
    label: "Delayed oven readiness (< 155 °C preheat check blocks loading)",
  },
  {
    value: "over-baked",
    label: "Over-baked inspection rejection (> 200 °C scorched rims)",
  },
];

export class FinancierBakeRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    mode: DEFAULT_FINANCIER_BAKE_RECIPE.mode,
    mouldCount: DEFAULT_FINANCIER_BAKE_RECIPE.mouldCount,
    rackSlot: DEFAULT_FINANCIER_BAKE_RECIPE.rackSlot,
    targetOvenTempC: String(DEFAULT_FINANCIER_BAKE_RECIPE.targetOvenTempC),
    portionG: String(DEFAULT_FINANCIER_BAKE_RECIPE.portionG),
    check: DEFAULT_FINANCIER_BAKE_RECIPE.check,
    notice: "",
  };

  private submit(event: React.FormEvent): void {
    event.preventDefault();
    const targetOvenTempC = Number(this.state.targetOvenTempC);
    const portionG = Number(this.state.portionG);
    if (
      !Number.isFinite(targetOvenTempC) ||
      targetOvenTempC < 160 ||
      targetOvenTempC > 195 ||
      !Number.isFinite(portionG) ||
      portionG < 20 ||
      portionG > 30
    ) {
      this.setState({
        notice:
          "Choose a 160–195 °C Maruzen MBCO-5E setpoint and a 20–30 g Matsunaga cavity portion.",
      });
      return;
    }
    this.props.prepared({
      mode: this.state.mode,
      mouldCount: this.state.mouldCount,
      rackSlot: this.state.rackSlot,
      targetOvenTempC,
      portionG,
      check: this.state.check,
    });
  }

  render(): React.ReactNode {
    const cavities = this.state.mouldCount * 8;
    const totalFillG = cavities * (Number(this.state.portionG) || 25);
    return (
      <form
        onSubmit={this.submit.bind(this)}
        aria-label="Financier bake Cobot recipe"
      >
        <h3>Financier Bake · Mould Depositing &amp; Maruzen MBCO-5E Oven</h3>
        <p>
          FAIRINO FR10 Cobot tares the Ohaus Ranger 3000 bench scale, doses{" "}
          {this.state.portionG} g of golden financier batter per cavity (75–80%
          fill depth, {totalFillG} g total) into the Matsunaga 220 × 300 mm
          8-cavity silicone-coated silver mould, slides the 600 × 400 mm carrier
          into Maruzen MBCO-5E Slot {this.state.rackSlot}, and bakes at{" "}
          {this.state.targetOvenTempC} °C before unloading onto the cooling wire
          grid.
        </p>
        <label>
          Tier 2 → Tier 3 handoff calibration preset
          <Select.Root
            items={HANDOFF_PRESET_ITEMS}
            value={
              this.state.check === "carrier-handoff-recovery"
                ? "carrier-slip-recovery"
                : this.state.check === "cell-2-restage-recovery"
                  ? "cell-2-restage-recovery"
                  : "nominal-handoff"
            }
            onValueChange={(preset) => {
              if (preset === null) return;
              if (preset === "carrier-slip-recovery") {
                this.setState({
                  mode: "convection",
                  mouldCount: 2,
                  rackSlot: 3,
                  targetOvenTempC: "170",
                  portionG: "25",
                  check: "carrier-handoff-recovery",
                  notice:
                    "Loaded fault-recovery calibration preset: 14 mm carrier rail slip + FR10 datum re-seat (+45 s Tier 3 cell handoff buffer).",
                });
              } else if (preset === "cell-2-restage-recovery") {
                this.setState({
                  mode: "convection",
                  mouldCount: 2,
                  rackSlot: 3,
                  targetOvenTempC: "170",
                  portionG: "25",
                  check: "cell-2-restage-recovery",
                  notice:
                    "Loaded fault-recovery calibration preset: 18 mm clamp hold + Cell 1 → Cell 2 failover restage (+60 s re-registration · 120 s hold release).",
                });
              } else {
                this.setState({
                  check: "none",
                  notice:
                    "Loaded nominal Tier 2 → Tier 3 handoff preset (0 mm carrier offset · direct cold-cell-1 transfer).",
                });
              }
            }}
          >
            <Select.Trigger aria-label="Tier 2 to Tier 3 handoff calibration preset">
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {HANDOFF_PRESET_ITEMS.map(renderItem)}
            </Select.Popup>
          </Select.Root>
        </label>
        <label>
          Maruzen MBCO-5E bake mode
          <Select.Root
            items={MODE_ITEMS}
            value={this.state.mode}
            onValueChange={(value) => {
              if (value === null) return;
              const mode =
                value === "conventional" ? "conventional" : "convection";
              this.setState({
                mode,
                targetOvenTempC: mode === "convection" ? "170" : "180",
              });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{MODE_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Matsunaga 8-cavity mould load (220 × 300 mm · 35 cc/cavity)
          <Select.Root
            items={MOULD_COUNT_ITEMS}
            value={String(this.state.mouldCount)}
            onValueChange={(value) => {
              if (value === null) return;
              const v = Number(value);
              this.setState({ mouldCount: v === 2 ? 2 : v === 3 ? 3 : 1 });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{MOULD_COUNT_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Maruzen MBCO-5E rack rail slot (88 mm pitch)
          <Select.Root
            items={RACK_SLOT_ITEMS}
            value={String(this.state.rackSlot)}
            onValueChange={(value) => {
              if (value === null) return;
              const v = Number(value);
              this.setState({ rackSlot: v === 2 ? 2 : v === 4 ? 4 : 3 });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{RACK_SLOT_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <label>
          Oven chamber setpoint (°C)
          <input
            type="number"
            min={160}
            max={195}
            step={1}
            value={this.state.targetOvenTempC}
            onChange={(e) =>
              this.setState({ targetOvenTempC: e.currentTarget.value })
            }
          />
        </label>
        <label>
          Cavity portion mass (g · 75–80% depth)
          <input
            type="number"
            min={20}
            max={30}
            step={1}
            value={this.state.portionG}
            onChange={(e) => this.setState({ portionG: e.currentTarget.value })}
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
                  v === "carrier-handoff-recovery" ||
                  v === "cell-2-restage-recovery" ||
                  v === "under-preheated" ||
                  v === "over-baked"
                    ? v
                    : "none",
              });
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>{CHECK_ITEMS.map(renderItem)}</Select.Popup>
          </Select.Root>
        </label>
        <button type="submit">Prepare Financier bake station</button>
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
