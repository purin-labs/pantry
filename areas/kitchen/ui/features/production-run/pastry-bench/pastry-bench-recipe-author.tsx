import React from "react";
import type { PieType } from "@purin-labs/production-simulation/recipes/bakery/pie";
import {
  CRIMP_FORCE_ITEMS,
  DEFAULT_PASTRY_BENCH_RECIPE,
  FAULT_CHECK_ITEMS,
  PIE_TYPE_ITEMS,
  THICKNESS_ITEMS,
  type PastryBenchFaultCheck,
  type PastryBenchRecipeConfig,
} from "./pastry-bench-model";
import { RecipeChoice } from "../shared/recipe-form";

type Props = Readonly<{
  prepared(recipe: PastryBenchRecipeConfig): void;
}>;

type State = Readonly<{
  pieType: PieType;
  targetThicknessMm: 2.5 | 3.0 | 3.5;
  crimpForceN: 36 | 42 | 52;
  faultCheck: PastryBenchFaultCheck;
}>;

export class PastryBenchRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    pieType: DEFAULT_PASTRY_BENCH_RECIPE.pieType,
    targetThicknessMm: DEFAULT_PASTRY_BENCH_RECIPE.targetThicknessMm,
    crimpForceN: DEFAULT_PASTRY_BENCH_RECIPE.crimpForceN,
    faultCheck: DEFAULT_PASTRY_BENCH_RECIPE.faultCheck,
  };

  private submit(event: React.FormEvent): void {
    event.preventDefault();
    this.props.prepared({
      pieType: this.state.pieType,
      targetThicknessMm: this.state.targetThicknessMm,
      crimpForceN: this.state.crimpForceN,
      faultCheck: this.state.faultCheck,
    });
  }

  render(): React.ReactNode {
    return (
      <form
        onSubmit={this.submit.bind(this)}
        aria-label="Pie pastry bench deformable recipe"
      >
        <h3>
          Pie Pastry Bench · Deformable Shortcrust &amp; Puff Lid (MuJoCo 4.0.0)
        </h3>
        <p>
          Sheets 330 g of rested 8 °C butter shortcrust to{" "}
          {this.state.targetThicknessMm.toFixed(1)} mm on a floured 16 °C marble
          slab, drapes the 81-vertex / 128-triangle{" "}
          <code>flexcomp elastic2d</code> shell into 12 cm fluted aluminium pie
          tins (28 mm cavity depth), and crimps 240 g of 6 °C laminated puff
          pastry at {this.state.crimpForceN} N.
        </p>
        <RecipeChoice
          label="Savoury pie variety"
          items={PIE_TYPE_ITEMS}
          value={this.state.pieType}
          choose={(v) => {
            if (v === "steak-and-pepper" || v === "beef-bourguignon") {
              this.setState({ pieType: v });
            }
          }}
        />
        <RecipeChoice
          label="Target shortcrust sheet thickness"
          items={THICKNESS_ITEMS}
          value={this.state.targetThicknessMm.toFixed(1)}
          choose={(v) => {
            if (v === "2.5") this.setState({ targetThicknessMm: 2.5 });
            else if (v === "3.5") this.setState({ targetThicknessMm: 3.5 });
            else if (v === "3.0") this.setState({ targetThicknessMm: 3.0 });
          }}
        />
        <RecipeChoice
          label="Fluted rim crimp force"
          items={CRIMP_FORCE_ITEMS}
          value={String(this.state.crimpForceN)}
          choose={(v) => {
            if (v === "36") this.setState({ crimpForceN: 36 });
            else if (v === "52") this.setState({ crimpForceN: 52 });
            else if (v === "42") this.setState({ crimpForceN: 42 });
          }}
        />
        <RecipeChoice
          label="Process check"
          items={FAULT_CHECK_ITEMS}
          value={this.state.faultCheck}
          choose={(v) => {
            if (v === "none" || v === "unfloured-bench") {
              this.setState({ faultCheck: v });
            }
          }}
        />
        <button type="submit">Prepare pastry bench</button>
      </form>
    );
  }
}
