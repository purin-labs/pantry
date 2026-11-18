import { Select } from "../../../ui/select";
import React from "react";
import type { EspressoMachine } from "@seams/bakery-model/bakery-physics";
import { preloadEspressoVisual } from "../linea/espresso-scene";
import type { LatteProcessCheck, LatteRecipeConfig } from "@seams/production-simulation/recipes/latte/model";

type Props = Readonly<{ prepared(recipe: LatteRecipeConfig): void }>;
const MACHINES = [
  { value: "linea", label: "La Marzocco Linea Classic S" },
  { value: "eagle-one", label: "Victoria Arduino Eagle One" },
];
const CHECKS = [
  { value: "none", label: "Nominal 63 °C silky microfoam" },
  {
    value: "overheated-milk",
    label: "Overheated milk (74.5 °C scalded lactose)",
  },
  {
    value: "low-steam-pressure",
    label: "Low steam boiler pressure (0.38 bar stall)",
  },
];

type State = Readonly<{
  appliance: EspressoMachine;
  milkG: string;
  targetMilkC: string;
  check: LatteProcessCheck;
  notice: string;
}>;

/** FAIRINO FR10 Caffe Latte & Rosetta milk-steaming recipe author. */
export class LatteRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    appliance: "linea",
    milkG: "180",
    targetMilkC: "63",
    check: "none",
    notice: "",
  };

  componentDidMount(): void {
    preloadEspressoVisual(this.state.appliance);
  }

  private changeMachine(value: string | null): void {
    if (value === "linea" || value === "eagle-one") {
      preloadEspressoVisual(value);
      this.setState({ appliance: value });
    }
  }

  private changeMilk(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ milkG: event.currentTarget.value });
  }

  private changeTemp(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ targetMilkC: event.currentTarget.value });
  }

  private changeCheck(value: string | null): void {
    if (
      value === "none" ||
      value === "overheated-milk" ||
      value === "low-steam-pressure"
    ) {
      this.setState({ check: value });
    }
  }

  private prepare(event: React.FormEvent): void {
    event.preventDefault();
    const milkG = Number(this.state.milkG);
    const targetMilkC = Number(this.state.targetMilkC);
    if (
      !Number.isFinite(milkG) ||
      milkG < 120 ||
      milkG > 240 ||
      !Number.isFinite(targetMilkC) ||
      targetMilkC < 56 ||
      targetMilkC > 70
    ) {
      this.setState({
        notice:
          "Enter 120–240 g chilled milk and a 56–70 °C target steaming temperature.",
      });
      return;
    }
    this.props.prepared({
      revision: 1,
      appliance: this.state.appliance,
      milkG,
      targetMilkC,
      check: this.state.check,
    });
  }

  render(): React.ReactNode {
    return (
      <form aria-label="Caffe latte recipe" onSubmit={this.prepare.bind(this)}>
        <h3>Caffe Latte · Milk steaming &amp; Rosetta pour</h3>
        <p>
          Composes espresso extraction, pressurized steam aeration, whirlpool
          microfoam texturing, and free-pour Rosetta latte art on one FAIRINO
          FR10 Cobot station.
        </p>
        <p>
          The FR10 extracts a 36 g 9-bar double espresso into a 240 mL porcelain
          latte bowl, grasps the 600 mL stainless pitcher (4 °C milk), stretches
          microfoam at the right steam wand to 37 °C, spins a whirlpool roll to{" "}
          {this.state.targetMilkC} °C, and pours a Rosetta &amp; Heart pattern.
        </p>
        <fieldset>
          <label>
            Espresso machine{" "}
            <Select.Root
              items={MACHINES}
              value={this.state.appliance}
              onValueChange={this.changeMachine.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {MACHINES.map((item) => (
                  <Select.Item key={item.value} value={item.value}>
                    {item.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
          <label>
            Chilled milk mass (g){" "}
            <input
              type="number"
              min="120"
              max="240"
              step="5"
              value={this.state.milkG}
              onChange={this.changeMilk.bind(this)}
            />
          </label>
          <label>
            Target milk temperature (°C){" "}
            <input
              type="number"
              min="56"
              max="70"
              step="1"
              value={this.state.targetMilkC}
              onChange={this.changeTemp.bind(this)}
            />
          </label>
          <label>
            Process check{" "}
            <Select.Root
              items={CHECKS}
              value={this.state.check}
              onValueChange={this.changeCheck.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {CHECKS.map((item) => (
                  <Select.Item key={item.value} value={item.value}>
                    {item.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
          <button type="submit">Prepare caffe latte</button>
        </fieldset>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}
