import React from "react";
import {
  DEFAULT_CAFE_SHIFT_RECIPE,
  type CafeShiftAppliance,
  type CafeShiftCheck,
  type CafeShiftGrinder,
  type CafeShiftRecipeConfig,
  type CafeShiftStaffing,
} from "@purin-labs/production-simulation/recipes/cafe-shift/model";
import { RecipeChoice } from "../shared/recipe-form";

type Props = Readonly<{
  prepared(recipe: CafeShiftRecipeConfig): void;
}>;

type State = Readonly<{
  appliance: CafeShiftAppliance;
  grinder: CafeShiftGrinder;
  financierLoads: 1 | 2 | 3;
  espressoOrders: 2 | 4;
  staffing: CafeShiftStaffing;
  check: CafeShiftCheck;
}>;

const APPLIANCE_ITEMS = [
  { value: "linea", label: "La Marzocco Linea Classic S (2-group)" },
  { value: "eagle-one", label: "Victoria Arduino Eagle One (2-group)" },
];

const GRINDER_ITEMS = [
  {
    value: "miicoffee-df64-gen2",
    label: "MiiCoffee DF64 II (Gen 2 · 64 mm flat burr)",
  },
  { value: "option-o-lagom-casa", label: "Option-O Lagom Casa (conical burr)" },
  { value: "timemore-bricks-01s", label: "Timemore Bricks 01S (40 mm S2C)" },
  { value: "fellow-opus-2", label: "Fellow Opus 2 (conical burr)" },
];

const FINANCIER_LOAD_ITEMS = [
  {
    value: "1",
    label:
      "1 load · 8 cavities (7 packed financiers + 1 sample · 526.0 g retained batter)",
  },
  {
    value: "2",
    label:
      "2 loads · 16 cavities (15 packed financiers + 1 sample · 326.0 g retained batter)",
  },
  {
    value: "3",
    label:
      "3 loads · 24 cavities (23 packed financiers + 1 sample · 126.0 g retained batter)",
  },
];

const ESPRESSO_ORDERS_ITEMS = [
  { value: "2", label: "2 espresso orders (72.0 g served)" },
  { value: "4", label: "4 espresso orders (144.0 g served)" },
];

const STAFFING_ITEMS = [
  {
    value: "two-workers",
    label: "Two workers · Baker #1 + Dedicated Barista #2 (parallel)",
  },
  {
    value: "single-worker",
    label:
      "Single shared worker · Patisserie & Espresso contention (+wait time)",
  },
];

const CHECK_ITEMS = [
  {
    value: "none",
    label: "Uninterrupted shift · accept all loads & complete espresso service",
  },
  {
    value: "reject-second-load",
    label:
      "Fault journey · 2 loads, reject Load 2 (7 packed, 8 rejected, 72.0 g espresso)",
  },
  {
    value: "interrupted-extraction",
    label:
      "Interrupted extraction on Order 2 (18.0 g discarded & recovered to 72.0 g served)",
  },
];

export class CafeShiftRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    appliance: DEFAULT_CAFE_SHIFT_RECIPE.appliance,
    grinder: DEFAULT_CAFE_SHIFT_RECIPE.grinder ?? "miicoffee-df64-gen2",
    financierLoads: DEFAULT_CAFE_SHIFT_RECIPE.financierLoads,
    espressoOrders: DEFAULT_CAFE_SHIFT_RECIPE.espressoOrders,
    staffing: DEFAULT_CAFE_SHIFT_RECIPE.staffing,
    check: DEFAULT_CAFE_SHIFT_RECIPE.check,
  };

  private submit(event: React.FormEvent): void {
    event.preventDefault();
    this.props.prepared({
      appliance: this.state.appliance,
      grinder: this.state.grinder,
      financierLoads:
        this.state.check === "reject-second-load" &&
        this.state.financierLoads < 2
          ? 2
          : this.state.financierLoads,
      espressoOrders: this.state.espressoOrders,
      staffing: this.state.staffing,
      check: this.state.check,
    });
  }

  render(): React.ReactNode {
    const effectiveLoads =
      this.state.check === "reject-second-load" && this.state.financierLoads < 2
        ? 2
        : this.state.financierLoads;
    const rejectedLoads = this.state.check === "reject-second-load" ? 1 : 0;
    const acceptedPieces = (effectiveLoads - rejectedLoads) * 8;
    const packedPieces = Math.max(0, acceptedPieces - 1);
    const servedEspressoG = (this.state.espressoOrders * 36.0).toFixed(1);

    return (
      <form
        onSubmit={this.submit.bind(this)}
        aria-label="Combined café shift recipe"
      >
        <h3>
          Combined Café Shift · Financier Patisserie &amp; Espresso Service
        </h3>
        <p>
          Bakes financiers and serves {servedEspressoG} g espresso across{" "}
          {this.state.espressoOrders} orders.
        </p>
        <p>
          Expected saleable output: <strong>{packedPieces}</strong> packed
          financiers ({(packedPieces * 23.5).toFixed(1)} g net) +{" "}
          <strong>1</strong> crumb sample (23.5 g)
          {rejectedLoads > 0
            ? " + 8 rejected financiers (188.0 g)"
            : ""} and <strong>{servedEspressoG} g</strong> served espresso.
        </p>
        <RecipeChoice
          label="Espresso machine"
          triggerLabel="Espresso machine"
          items={APPLIANCE_ITEMS}
          value={this.state.appliance}
          choose={(value) => {
            this.setState({
              appliance: value === "eagle-one" ? "eagle-one" : "linea",
            });
          }}
        />
        <RecipeChoice
          label="Single-dose coffee grinder"
          triggerLabel="Single-dose coffee grinder"
          items={GRINDER_ITEMS}
          value={this.state.grinder}
          choose={(v) => {
            this.setState({
              grinder:
                v === "option-o-lagom-casa" ||
                v === "timemore-bricks-01s" ||
                v === "fellow-opus-2"
                  ? v
                  : "miicoffee-df64-gen2",
            });
          }}
        />
        <RecipeChoice
          label="Financier baking loads (Matsunaga 8P · 8 cavities/load)"
          items={FINANCIER_LOAD_ITEMS}
          value={String(effectiveLoads)}
          choose={(value) => {
            const v = Number(value);
            this.setState({
              financierLoads: v === 3 ? 3 : v === 2 ? 2 : 1,
            });
          }}
        />
        <RecipeChoice
          label="Espresso orders (18.0 g dose → 36.0 g served shot)"
          items={ESPRESSO_ORDERS_ITEMS}
          value={String(this.state.espressoOrders)}
          choose={(value) => {
            this.setState({
              espressoOrders: value === "4" ? 4 : 2,
            });
          }}
        />
        <RecipeChoice
          label="Shift staffing (controlled comparison)"
          items={STAFFING_ITEMS}
          value={this.state.staffing}
          choose={(value) => {
            this.setState({
              staffing:
                value === "single-worker" ? "single-worker" : "two-workers",
            });
          }}
        />
        <RecipeChoice
          label="Quality & recovery check"
          items={CHECK_ITEMS}
          value={this.state.check}
          choose={(v) => {
            const check: CafeShiftCheck =
              v === "reject-second-load" || v === "interrupted-extraction"
                ? v
                : "none";
            this.setState({
              check,
              financierLoads:
                check === "reject-second-load" && this.state.financierLoads < 2
                  ? 2
                  : this.state.financierLoads,
            });
          }}
        />
        <button type="submit">Prepare combined café shift</button>
      </form>
    );
  }
}
