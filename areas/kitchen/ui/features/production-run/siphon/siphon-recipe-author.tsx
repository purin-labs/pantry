import React from "react";
import type {
  SiphonProcessCheck,
  SiphonRecipeConfig,
} from "@purin-labs/production-simulation/recipes/siphon/model";
import { RecipeChoice } from "../shared/recipe-form";

type Props = Readonly<{ prepared(recipe: SiphonRecipeConfig): void }>;
const CHECKS = [
  { value: "none", label: "Nominal vacuum brew" },
  { value: "unsealed-gasket", label: "Unsealed neck gasket (steam leak)" },
  {
    value: "clogged-filter",
    label: "Blinded F-103S cloth filter (slow drawdown)",
  },
  { value: "lost-grip", label: "Lose BA-15 paddle grip in whirlpool stir" },
];

type State = Readonly<{
  waterG: string;
  coffeeG: string;
  steepSeconds: string;
  check: SiphonProcessCheck;
  notice: string;
}>;

/** Hario ECA-3-B Electric Coffee Syphon recipe author on a prepared FR10 station. */
export class SiphonRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    waterG: "350",
    coffeeG: "24",
    steepSeconds: "70",
    check: "none",
    notice: "",
  };

  private changeWater(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ waterG: event.currentTarget.value });
  }
  private changeCoffee(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ coffeeG: event.currentTarget.value });
  }
  private changeSteep(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ steepSeconds: event.currentTarget.value });
  }
  private changeCheck(value: string | null): void {
    if (
      value === "none" ||
      value === "unsealed-gasket" ||
      value === "clogged-filter" ||
      value === "lost-grip"
    ) {
      this.setState({ check: value });
    }
  }

  private prepare(event: React.FormEvent): void {
    event.preventDefault();
    const waterG = Number(this.state.waterG);
    const coffeeG = Number(this.state.coffeeG);
    const steepSeconds = Number(this.state.steepSeconds);
    if (
      !Number.isFinite(waterG) ||
      waterG < 280 ||
      waterG > 400 ||
      !Number.isFinite(coffeeG) ||
      coffeeG < 18 ||
      coffeeG > 32 ||
      !Number.isFinite(steepSeconds) ||
      steepSeconds < 45 ||
      steepSeconds > 90
    ) {
      this.setState({
        notice:
          "Enter 280–400 g water, 18–32 g coffee and a 45–90 s steep duration.",
      });
      return;
    }
    this.props.prepared({
      revision: 1,
      waterG,
      coffeeG,
      steepSeconds,
      check: this.state.check,
    });
  }

  render(): React.ReactNode {
    return (
      <form
        aria-label="Siphon coffee recipe"
        onSubmit={this.prepare.bind(this)}
      >
        <p>Makes one siphon coffee from 24 g coffee and 350 g water.</p>
        <p>
          The FR10 seats the upper bowl silicone gasket at 94 °C, folds the
          grounds in with 3 circular revolutions of the BA-15 bamboo paddle,
          steeps for 70 s, performs 3 whirlpool stirs at heater cut-off, and
          monitors vacuum drawdown into the lower bulb.
        </p>
        <fieldset>
          <label>
            Lower bulb water (g){" "}
            <input
              type="number"
              min="280"
              max="400"
              step="5"
              value={this.state.waterG}
              onChange={this.changeWater.bind(this)}
            />
          </label>
          <label>
            Coffee dose (g){" "}
            <input
              type="number"
              min="18"
              max="32"
              step="1"
              value={this.state.coffeeG}
              onChange={this.changeCoffee.bind(this)}
            />
          </label>
          <label>
            Steep time (s){" "}
            <input
              type="number"
              min="45"
              max="90"
              step="5"
              value={this.state.steepSeconds}
              onChange={this.changeSteep.bind(this)}
            />
          </label>
          <RecipeChoice
            label="Process check "
            items={CHECKS}
            value={this.state.check}
            choose={this.changeCheck.bind(this)}
          />
          <button type="submit">Prepare siphon coffee</button>
        </fieldset>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}
