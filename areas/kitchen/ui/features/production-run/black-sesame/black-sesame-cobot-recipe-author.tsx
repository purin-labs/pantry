import React from "react";
import {
  DEFAULT_BLACK_SESAME_COBOT_RECIPE,
  type BlackSesameCheck,
  type BlackSesameCobotRecipeConfig,
  type BlackSesameHobModel,
  type BlackSesameRoastMode,
} from "@purin-labs/production-simulation/recipes/black-sesame/model";
import { RecipeChoice } from "../shared/recipe-form";

type Props = Readonly<{
  prepared(recipe: BlackSesameCobotRecipeConfig): void;
}>;

type State = Readonly<{
  hob: BlackSesameHobModel;
  roast: BlackSesameRoastMode;
  sesameG: string;
  concentratePerDrinkG: string;
  milkPerDrinkG: string;
  check: BlackSesameCheck;
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

const ROAST_ITEMS = [
  {
    value: "skip",
    label: "Pre-roasted seeds (direct Waring WSG60 4 × 55 g grind)",
  },
  {
    value: "refresh",
    label: "160 °C Maruzen oven aroma refresh before grinding",
  },
];

const CHECK_ITEMS = [
  {
    value: "none",
    label:
      "Normal run (760 g concentrate + Hoshizaki cold carrier + 286 g drink)",
  },
  {
    value: "overweight-unreconciled",
    label: "Unreconciled overweight concentrate (762 g > 760 g limit)",
  },
  {
    value: "enclosure-interlock",
    label: "Vitamix The Quiet One acoustic enclosure door interlock trip",
  },
];

export class BlackSesameCobotRecipeAuthor extends React.Component<
  Props,
  State
> {
  state: State = {
    hob: DEFAULT_BLACK_SESAME_COBOT_RECIPE.hob,
    roast: DEFAULT_BLACK_SESAME_COBOT_RECIPE.roast,
    sesameG: String(DEFAULT_BLACK_SESAME_COBOT_RECIPE.sesameG),
    concentratePerDrinkG: String(
      DEFAULT_BLACK_SESAME_COBOT_RECIPE.concentratePerDrinkG,
    ),
    milkPerDrinkG: String(DEFAULT_BLACK_SESAME_COBOT_RECIPE.milkPerDrinkG),
    check: DEFAULT_BLACK_SESAME_COBOT_RECIPE.check,
    notice: "",
  };

  private submit(event: React.FormEvent): void {
    event.preventDefault();
    const sesameG = Number(this.state.sesameG);
    const concentratePerDrinkG = Number(this.state.concentratePerDrinkG);
    const milkPerDrinkG = Number(this.state.milkPerDrinkG);
    if (
      !Number.isFinite(sesameG) ||
      sesameG < 180 ||
      sesameG > 260 ||
      !Number.isFinite(concentratePerDrinkG) ||
      concentratePerDrinkG < 50 ||
      concentratePerDrinkG > 110 ||
      !Number.isFinite(milkPerDrinkG) ||
      milkPerDrinkG < 160 ||
      milkPerDrinkG > 260
    ) {
      this.setState({
        notice:
          "Choose 180–260 g black sesame seeds, 50–110 g concentrate per drink, and 160–260 g milk per drink.",
      });
      return;
    }
    this.props.prepared({
      hob: this.state.hob,
      roast: this.state.roast,
      sesameG,
      waterG: 400,
      riceFlourG: 20,
      sugarG: 120,
      saltG: 2,
      concentratePerDrinkG,
      milkPerDrinkG,
      check: this.state.check,
    });
  }

  render(): React.ReactNode {
    return (
      <form
        onSubmit={this.submit.bind(this)}
        aria-label="Black sesame milk Cobot recipe"
      >
        <h3>
          Black Sesame Milk · WSG60 Grind, Vitamix Quiet One &amp; Severin SM
          3587
        </h3>
        <p>
          FAIRINO FR10 Cobot mills {this.state.sesameG} g black sesame in 4
          pulse loads on the Waring WSG60 spice grinder, cooks 542 g sweet
          rice-flour slurry on the induction hob, blends and standardizes 760 g
          concentrate on the Vitamix The Quiet One and Ohaus Ranger 3000 scale,
          transfers the covered cold-container carrier (2 × 380 g bottles) into
          the Hoshizaki RT-120SNJ refrigerated worktop (3.0 °C), and serves a{" "}
          {Number(this.state.concentratePerDrinkG) +
            Number(this.state.milkPerDrinkG)}{" "}
          g heated drink in the Severin SM 3587 milk mixer.
        </p>
        <RecipeChoice
          label="Induction slurry hob model"
          items={HOB_ITEMS}
          value={this.state.hob}
          choose={(v) => {
            this.setState({
              hob:
                v === "vollrath" ||
                v === "panasonic-kz-ck1402" ||
                v === "rinnai-rsb-150pj"
                  ? v
                  : "maruzen",
            });
          }}
        />
        <RecipeChoice
          label="Sesame roast mode"
          items={ROAST_ITEMS}
          value={this.state.roast}
          choose={(value) => {
            this.setState({
              roast: value === "refresh" ? "refresh" : "skip",
            });
          }}
        />
        <label>
          Black sesame seed charge (g)
          <input
            type="number"
            min={180}
            max={260}
            step={5}
            value={this.state.sesameG}
            onChange={(e) => this.setState({ sesameG: e.currentTarget.value })}
          />
        </label>
        <label>
          Concentrate dose per drink (g)
          <input
            type="number"
            min={50}
            max={110}
            step={2}
            value={this.state.concentratePerDrinkG}
            onChange={(e) =>
              this.setState({ concentratePerDrinkG: e.currentTarget.value })
            }
          />
        </label>
        <label>
          Milk dose per drink (g)
          <input
            type="number"
            min={160}
            max={260}
            step={5}
            value={this.state.milkPerDrinkG}
            onChange={(e) =>
              this.setState({ milkPerDrinkG: e.currentTarget.value })
            }
          />
        </label>
        <RecipeChoice
          label="Process check"
          items={CHECK_ITEMS}
          value={this.state.check}
          choose={(v) => {
            this.setState({
              check:
                v === "overweight-unreconciled" || v === "enclosure-interlock"
                  ? v
                  : "none",
            });
          }}
        />
        <button type="submit">Prepare Black Sesame Milk 3D station</button>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}
