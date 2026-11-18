import { Select } from "../../../ui/select";
import React from "react";
import type { EspressoMachine } from "@seams/bakery-model/bakery-physics";
import { prepareNativeRecipe } from "../oven-recipe-file";
import type { OvenRunSource } from "@seams/production-simulation/runs/oven-run-file";
import { preloadEspressoVisual } from "./espresso-scene";

type Props = Readonly<{ prepared(source: OvenRunSource): void }>;
const MACHINES = [
  { value: "linea", label: "La Marzocco Linea Classic S" },
  { value: "eagle-one", label: "Victoria Arduino Eagle One" },
];
type State = Readonly<{
  orders: string;
  notice: string;
  appliance: EspressoMachine;
}> &
  (Readonly<{ kind: "editing" }> | Readonly<{ kind: "preparing" }>);
export class EspressoRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    kind: "editing",
    orders: "2",
    notice: "",
    appliance: "linea",
  };
  private mounted = false;
  componentDidMount(): void {
    this.mounted = true;
    preloadEspressoVisual(this.state.appliance);
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }
  private machine(value: string | null): void {
    if (value === "linea" || value === "eagle-one") {
      preloadEspressoVisual(value);
      this.setState({ appliance: value });
    }
  }
  private orders(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ orders: event.currentTarget.value });
  }
  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (this.state.kind !== "editing") return;
    this.setState({
      kind: "preparing",
      notice: "Preparing the espresso station…",
    });
    try {
      const espresso = {
        revision: 1,
        orders: Number(this.state.orders),
        appliance: this.state.appliance,
      };
      const result = await prepareNativeRecipe({
        kind: "espresso" as const,
        input: espresso,
      });
      if (!this.mounted) return;
      if (result.ok) this.props.prepared(result.value);
      else this.setState({ kind: "editing", notice: result.error });
    } catch (error) {
      if (this.mounted)
        this.setState({
          kind: "editing",
          notice:
            error instanceof Error
              ? error.message
              : "The espresso station could not open.",
        });
    }
  }
  render(): React.ReactNode {
    return (
      <form
        aria-label="Espresso service recipe"
        onSubmit={this.prepare.bind(this)}
      >
        <h3>Espresso service · FAIRINO FR10 Cobot</h3>
        <p>
          Orders share one preheated dual-group espresso machine and one FAIRINO
          FR10 Cobot arm at the barista station. Each cycle places a porcelain
          demitasse cup on the drip grate, triggers an 18-second 9-bar
          extraction, and transfers the served shot onto the brass service
          coasters.
        </p>
        <p>
          The recipe doses 18 g coffee and yields 36 g espresso per order.
          Completed cups stay on the front service mat and spent pucks collect
          in the knock-box across multi-cup runs.
        </p>
        <fieldset disabled={this.state.kind === "preparing"}>
          <label>
            Espresso machine{" "}
            <Select.Root
              items={MACHINES}
              value={this.state.appliance}
              onValueChange={this.machine.bind(this)}
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
            Espresso orders{" "}
            <input
              type="number"
              min="1"
              max="4"
              value={this.state.orders}
              onChange={this.orders.bind(this)}
            />
          </label>
          <button type="submit">Prepare espresso service</button>
        </fieldset>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}
