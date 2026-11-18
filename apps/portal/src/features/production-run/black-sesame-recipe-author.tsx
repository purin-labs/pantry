import { Select } from "../../ui/select";
import React from "react";
import { blackSesameRecipeInput } from "@seams/production-simulation/recipes/bakery/black-sesame";
import { prepareNativeRecipe } from "./oven-recipe-file";
import { prepareBlackSesameRecipe, type OvenRunSource } from "@seams/production-simulation/runs/oven-run-file";

type ColdHandling = "manual" | "fairino-fr10";
type Props = Readonly<{ prepared(source: OvenRunSource): void }>;
type State = Readonly<{
  coolingMinutes: string;
  secondBatchMinutes: string;
  roast: "skip" | "refresh";
  coldHandling: ColdHandling;
  activity: "editing" | "preparing";
  notice: string;
}>;

const COLD_HANDLING_ITEMS = [
  { value: "manual", label: "Manual container transfer" },
  { value: "fairino-fr10", label: "FAIRINO FR10 cold rack cell" },
];

export class BlackSesameRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    coolingMinutes: "20",
    secondBatchMinutes: "120",
    roast: "skip",
    coldHandling: "manual",
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
  private cooling(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ coolingMinutes: event.currentTarget.value });
  }
  private arrival(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ secondBatchMinutes: event.currentTarget.value });
  }
  private roast(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ roast: event.currentTarget.checked ? "refresh" : "skip" });
  }
  private changeHandling(raw: string | null): void {
    if (raw === null) return;
    const value = raw === "fairino-fr10" ? "fairino-fr10" : "manual";
    this.setState({ coldHandling: value });
  }
  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (this.state.activity === "preparing") return;
    this.setState({
      activity: "preparing",
      notice: "Preparing black sesame milk…",
    });
    const input = blackSesameRecipeInput();
    input.roast = this.state.roast;
    input.durationsSeconds.cool = Number(this.state.coolingMinutes) * 60;
    input.batchArrivalsSeconds = [
      0,
      Number(this.state.secondBatchMinutes) * 60,
    ];
    try {
      const prepared =
        this.state.coldHandling === "fairino-fr10"
          ? await prepareNativeRecipe({ kind: "black-sesame", input })
          : await prepareBlackSesameRecipe(input);
      if (!this.mounted) return;
      if (prepared.ok) this.props.prepared(prepared.value);
      else this.setState({ activity: "editing", notice: prepared.error });
    } catch (error) {
      if (this.mounted)
        this.setState({
          activity: "editing",
          notice:
            error instanceof Error
              ? error.message
              : "The recipe could not be prepared.",
        });
    }
  }
  render(): React.ReactNode {
    return (
      <form
        aria-label="Black sesame milk recipe"
        onSubmit={this.prepare.bind(this)}
      >
        <h3>Black sesame milk: concentrate to service</h3>
        <p>
          Twelve orders share one heated mixer, one reusable jug, two 380 g
          bottles and one worker. Each batch supplies ten 76 g portions. Each
          drink adds 210 g milk.
        </p>
        <p>
          This rehearsal assumes 12 g evaporation, 8 g residue, 2 g spills and
          20 g added water per 762 g batch. Cooling releases on its declared
          duration. Equipment limits and cooling temperatures still need
          qualification.
        </p>
        <fieldset disabled={this.state.activity === "preparing"}>
          <legend>Batch assumptions</legend>
          <label>
            Cooling minutes per sesame batch
            <input
              type="number"
              min={1}
              max={120}
              step={1}
              value={this.state.coolingMinutes}
              onChange={this.cooling.bind(this)}
            />
          </label>
          <label>
            Second sesame batch starts after minutes
            <input
              type="number"
              min={0}
              max={300}
              step={1}
              value={this.state.secondBatchMinutes}
              onChange={this.arrival.bind(this)}
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={this.state.roast === "refresh"}
              onChange={this.roast.bind(this)}
            />
            Refresh the sesame roast
          </label>
          <label>
            Cold container carrier handling
            <Select.Root
              items={COLD_HANDLING_ITEMS}
              value={this.state.coldHandling}
              onValueChange={this.changeHandling.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {COLD_HANDLING_ITEMS.map(renderItem)}
              </Select.Popup>
            </Select.Root>
          </label>
          <button>Prepare black sesame milk</button>
        </fieldset>
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
