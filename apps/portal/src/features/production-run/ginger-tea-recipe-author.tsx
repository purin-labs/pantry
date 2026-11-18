import { Select } from "../../ui/select";
import React from "react";
import { gingerBlackTeaRecipeInput } from "@seams/production-simulation/recipes/bakery/ginger-black-tea";
import { prepareNativeRecipe } from "./oven-recipe-file";
import {
  prepareGingerBlackTeaRecipe,
  type OvenRunSource,
} from "@seams/production-simulation/runs/oven-run-file";

type PanStaging = "manual" | "fairino-fr10";
type Props = Readonly<{ prepared(source: OvenRunSource): void }>;
const TEAS = [
  { value: "assam", label: "Assam leaf" },
  { value: "ctc", label: "Fine CTC tea" },
];
const PAN_STAGINGS = [
  { value: "manual", label: "Manual pan staging" },
  { value: "fairino-fr10", label: "FAIRINO FR10 pan-staging cell" },
];
type State = Readonly<{
  tea: "assam" | "ctc";
  steepSeconds: string;
  panStaging: PanStaging;
  activity: "editing" | "preparing";
  notice: string;
}>;

export class GingerTeaRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    tea: "assam",
    steepSeconds: "180",
    panStaging: "manual",
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
  private tea(tea: string | null): void {
    if (tea === "assam" || tea === "ctc")
      this.setState({ tea, steepSeconds: tea === "assam" ? "180" : "120" });
  }
  private steep(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ steepSeconds: event.currentTarget.value });
  }
  private changePanStaging(staging: string | null): void {
    if (staging === null) return;
    const value = staging === "fairino-fr10" ? "fairino-fr10" : "manual";
    this.setState({ panStaging: value });
  }
  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (this.state.activity === "preparing") return;
    this.setState({
      activity: "preparing",
      notice: "Preparing ginger black tea…",
    });
    const input = gingerBlackTeaRecipeInput();
    input.tea = this.state.tea;
    input.steepSeconds = Number(this.state.steepSeconds);
    try {
      const result =
        this.state.panStaging === "fairino-fr10"
          ? await prepareNativeRecipe({ kind: "ginger-black-tea", input })
          : await prepareGingerBlackTeaRecipe(input);
      if (!this.mounted) return;
      if (result.ok) this.props.prepared(result.value);
      else this.setState({ activity: "editing", notice: result.error });
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
        aria-label="Ginger black tea recipe"
        onSubmit={this.prepare.bind(this)}
      >
        <h3>Ginger black tea: extraction to service</h3>
        <p>
          Two batches share one hob, two pans, one heatproof rest position, one
          strainer and one worker. Each batch supplies two servings. The pan
          occupies the hob until the worker moves it.
        </p>
        <p>
          Straining is due immediately after the selected steep time. Every
          batch requires a recorded release or discard decision. Review shows
          any delay. This rehearsal assumes handling times, a seven-minute
          ginger simmer, and 58 g loss per 493 g batch. It does not simulate
          liquid or certify tea quality.
        </p>
        <fieldset disabled={this.state.activity === "preparing"}>
          <legend>Extraction settings</legend>
          <label>
            Black tea type
            <Select.Root
              items={TEAS}
              value={this.state.tea}
              onValueChange={this.tea.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {TEAS.map((item) => (
                  <Select.Item key={item.value} value={item.value}>
                    {item.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
          <label>
            Tea steep seconds
            <input
              type="number"
              min={this.state.tea === "assam" ? 180 : 120}
              max={this.state.tea === "assam" ? 240 : 180}
              step={1}
              value={this.state.steepSeconds}
              onChange={this.steep.bind(this)}
            />
          </label>
          <label>
            Clean pan staging
            <Select.Root
              items={PAN_STAGINGS}
              value={this.state.panStaging}
              onValueChange={this.changePanStaging.bind(this)}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                {PAN_STAGINGS.map((item) => (
                  <Select.Item key={item.value} value={item.value}>
                    {item.label}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
          <button>Prepare ginger black tea</button>
        </fieldset>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}
