import React from "react";
import { preloadRobotVisual } from "../../workflow-simulator/spatial/physics-robot-visual";
import { preparePourOverRecipe } from "../oven-recipe-file";
import type { OvenRunSource } from "@seams/production-simulation/runs/oven-run-file";
import { RecipeChoice } from "../shared/recipe-form";

type Props = Readonly<{ prepared(source: OvenRunSource): void }>;
type Check = "none" | "reduced-drainage" | "lost-grip";
const CHECKS = [
  { value: "none", label: "Nominal brew" },
  { value: "reduced-drainage", label: "Reduced bed drainage" },
  { value: "lost-grip", label: "Lose the kettle grip in pour 2" },
];
type State = Readonly<{
  kettleWaterG: string;
  check: Check;
  notice: string;
}> &
  (Readonly<{ kind: "editing" }> | Readonly<{ kind: "preparing" }>);

/** One Blue Bottle brew on a prepared FR10 station, with optional process checks. */
export class PourOverRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    kind: "editing",
    kettleWaterG: "500",
    check: "none",
    notice: "",
  };
  private mounted = false;
  componentDidMount(): void {
    this.mounted = true;
    preloadRobotVisual("fairino-fr10");
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }
  private water(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ kettleWaterG: event.currentTarget.value });
  }
  private check(value: string | null): void {
    if (
      value === "none" ||
      value === "reduced-drainage" ||
      value === "lost-grip"
    )
      this.setState({ check: value });
  }
  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (this.state.kind !== "editing") return;
    this.setState({
      kind: "preparing",
      notice: "Preparing the pour-over station…",
    });
    const result = await preparePourOverRecipe({
      revision: 1,
      kettleWaterG: Number(this.state.kettleWaterG),
      drainage: this.state.check === "reduced-drainage" ? "reduced" : "nominal",
      fault: this.state.check === "lost-grip" ? "lost-grip" : "none",
    });
    if (!this.mounted) return;
    if (result.ok) this.props.prepared(result.value);
    else this.setState({ kind: "editing", notice: result.error });
  }
  render(): React.ReactNode {
    return (
      <form aria-label="Pour-over recipe" onSubmit={this.prepare.bind(this)}>
        <h3>Pour-over · FR10 and gooseneck kettle</h3>
        <p>
          The Blue Bottle method: 27 g blend coffee and four spiral pours to 50,
          150, 250 and 350 g, starting at 0:00, 0:40, 1:10 and 1:40. The scale
          is tared before the first pour and controls each pour.
        </p>
        <p>
          A person prepares the filter, the ground bed, the server and the hot
          kettle at 93 °C. The robot pours and returns the kettle. The beverage
          stays in the server, ready for service. The water model does not
          predict flavour or extraction.
        </p>
        <fieldset disabled={this.state.kind === "preparing"}>
          <label>
            Kettle water (g){" "}
            <input
              type="number"
              min="420"
              max="700"
              step="1"
              value={this.state.kettleWaterG}
              onChange={this.water.bind(this)}
            />
          </label>
          <RecipeChoice
            label="Process check "
            items={CHECKS}
            value={this.state.check}
            choose={this.check.bind(this)}
          />
          <button type="submit">Prepare pour-over</button>
        </fieldset>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}
