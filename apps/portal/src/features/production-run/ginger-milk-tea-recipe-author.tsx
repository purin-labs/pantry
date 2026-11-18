import React from "react";
import { gingerMilkTeaRecipeInput } from "@seams/production-simulation/recipes/bakery/ginger-milk-tea";
import { mixedTeaRecipeInput } from "@seams/production-simulation/recipes/bakery/mixed-tea";
import { prepareNativeRecipe } from "./oven-recipe-file";
import type { OvenRunSource } from "@seams/production-simulation/runs/oven-run-file";
import { prepareRecipe, RecipeChoice } from "./shared/recipe-form";

type Props = Readonly<{ prepared(source: OvenRunSource): void }>;
const RECIPES = [
  { value: "ginger-milk-tea", label: "Two milk tea batches" },
  { value: "mixed-tea", label: "One black tea and two milk tea batches" },
];
type State = Readonly<{
  simmerSeconds: string;
  recipe: "ginger-milk-tea" | "mixed-tea";
  activity: "editing" | "preparing";
  notice: string;
}>;

export class GingerMilkTeaRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    simmerSeconds: "420",
    recipe: "ginger-milk-tea",
    activity: "editing",
    notice: "",
  };
  private mounted = false;
  componentDidMount(): void {
    this.mounted = true;
  }
  componentWillUnmount(): void {
    this.mounted = false;
  }
  private simmer(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ simmerSeconds: event.currentTarget.value });
  }
  private recipe(recipe: string | null): void {
    if (recipe === "ginger-milk-tea" || recipe === "mixed-tea")
      this.setState({ recipe });
  }
  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (this.state.activity === "preparing") return;
    this.setState({
      activity: "preparing",
      notice: "Preparing tea…",
    });
    const input = gingerMilkTeaRecipeInput();
    input.simmerSeconds = Number(this.state.simmerSeconds);
    const mixed = mixedTeaRecipeInput();
    mixed.milkTea.simmerSeconds = input.simmerSeconds;
    await prepareRecipe<OvenRunSource>(
      {
        mounted: () => this.mounted,
        prepared: (source) => this.props.prepared(source),
        failed: (notice) => this.setState({ activity: "editing", notice }),
      },
      () =>
        prepareNativeRecipe({
          kind: this.state.recipe,
          input: this.state.recipe === "mixed-tea" ? mixed : input,
        }),
    );
  }
  render(): React.ReactNode {
    return (
      <form
        aria-label="Ginger milk tea recipe"
        onSubmit={this.prepare.bind(this)}
      >
        <h3>Ginger milk tea: two-pan preparation to service</h3>
        <p>
          Two batches share two pans, one hob, one strainer and one worker. One
          pan starts dirty. Both pans must be clean and staged before
          extraction. The FR10 stages the empty receiving pan in a fixed tray
          insert. A worker removes it from the insert at the receiving station.
          Tea simmers for three minutes, then passes into the receiving pan.
        </p>
        <p>
          Review each extract before adding milk. Rejection skips milk, sugar
          and heating. Accepted batches warm cups with 300 ml water in the
          cleaned first pan. Milk finishing assumes 55°C after mixing, 68°C
          after one minute and 78°C after two minutes. The finishing range is
          75–80°C. Temperatures, pan mass and insert behavior are assumed.
          Native staging does not qualify bare-pan gripping or liquid transport.
        </p>
        <p>
          Each batch uses 400 ml water, 180 ml milk, 15 g ginger, 9 g Assam and
          25 g sugar. The rehearsal assumes 1 g/ml for both liquids and 59 g
          extraction loss. Cup temperature and cooling during delays are outside
          this rehearsal.
        </p>
        <fieldset disabled={this.state.activity === "preparing"}>
          <legend>Milk tea settings</legend>
          <RecipeChoice
            label="Tea orders"
            items={RECIPES}
            value={this.state.recipe}
            choose={this.recipe.bind(this)}
          />
          <p>
            Mixed orders share the same two pans, hob, strainer, scale and
            worker. Black tea also uses a serving receiver.
          </p>
          <label>
            Milk tea ginger simmer seconds
            <input
              type="number"
              min={360}
              max={480}
              step={1}
              value={this.state.simmerSeconds}
              onChange={this.simmer.bind(this)}
            />
          </label>
          <button>
            {this.state.recipe === "mixed-tea"
              ? "Prepare mixed tea"
              : "Prepare ginger milk tea"}
          </button>
        </fieldset>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}
