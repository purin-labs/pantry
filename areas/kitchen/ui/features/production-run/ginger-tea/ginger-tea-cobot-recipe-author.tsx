import React from "react";
import {
  DEFAULT_GINGER_TEA_COBOT_RECIPE,
  type GingerTeaCheck,
  type GingerTeaCobotRecipeConfig,
  type GingerTeaHobModel,
  type GingerTeaLeaf,
  type GingerTeaWorkflowMode,
} from "@purin-labs/production-simulation/recipes/ginger-tea/model";
import { RecipeChoice } from "../shared/recipe-form";

type Props = Readonly<{
  prepared(recipe: GingerTeaCobotRecipeConfig): void;
}>;

const MODES = [
  {
    value: "two-pan-milk-tea",
    label: "Two-Pan Ginger Milk Tea (pan-a simmer → pan-b milk finish)",
  },
  {
    value: "black-tea",
    label: "Ginger Black Tea (heat-off steeping on heatproof rest)",
  },
];
const HOBS = [
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
const TEAS = [
  { value: "assam", label: "Assam leaf (180–240 s)" },
  { value: "ctc", label: "Fine CTC tea (120–180 s)" },
];
const CHECKS = [
  {
    value: "none",
    label:
      "Normal run (FR10 pan-b staging + on-time straining + 2 cups served)",
  },
  {
    value: "dropped-pan-recovery",
    label: "D5 Dropped/displaced pan recovery (wash & re-stage in insert)",
  },
  {
    value: "late-straining-hold",
    label: "90 s worker delay across extraction deadline (hold for review)",
  },
];

type State = Readonly<{
  mode: GingerTeaWorkflowMode;
  hob: GingerTeaHobModel;
  tea: GingerTeaLeaf;
  simmerSeconds: string;
  steepSeconds: string;
  initialDirtyPan: boolean;
  check: GingerTeaCheck;
  notice: string;
}>;

export class GingerTeaCobotRecipeAuthor extends React.Component<Props, State> {
  state: State = {
    mode: DEFAULT_GINGER_TEA_COBOT_RECIPE.mode,
    hob: DEFAULT_GINGER_TEA_COBOT_RECIPE.hob,
    tea: DEFAULT_GINGER_TEA_COBOT_RECIPE.tea,
    simmerSeconds: String(DEFAULT_GINGER_TEA_COBOT_RECIPE.simmerSeconds),
    steepSeconds: String(DEFAULT_GINGER_TEA_COBOT_RECIPE.steepSeconds),
    initialDirtyPan: DEFAULT_GINGER_TEA_COBOT_RECIPE.initialDirtyPan,
    check: DEFAULT_GINGER_TEA_COBOT_RECIPE.check,
    notice: "",
  };

  private submit(event: React.FormEvent): void {
    event.preventDefault();
    const simmerSeconds = Number(this.state.simmerSeconds);
    const steepSeconds = Number(this.state.steepSeconds);
    if (
      !Number.isFinite(simmerSeconds) ||
      simmerSeconds < 360 ||
      simmerSeconds > 480 ||
      !Number.isFinite(steepSeconds) ||
      steepSeconds < 120 ||
      steepSeconds > 240
    ) {
      this.setState({
        notice:
          "Choose 360–480 s ginger simmer and 120–240 s tea extraction duration.",
      });
      return;
    }
    this.props.prepared({
      mode: this.state.mode,
      hob: this.state.hob,
      tea: this.state.tea,
      simmerSeconds,
      steepSeconds,
      initialDirtyPan: this.state.initialDirtyPan,
      check: this.state.check,
    });
  }

  render(): React.ReactNode {
    return (
      <form
        onSubmit={this.submit.bind(this)}
        aria-label="Ginger tea 3D MuJoCo pan-staging recipe"
      >
        <h3>
          Ginger Tea &amp; Two-Pan Milk Tea · FR10 MuJoCo Pan Staging &amp;
          Service
        </h3>
        <p>
          FAIRINO FR10 Cobot stages the clean 200 mm receiving saucepan in its
          rigid 600 × 400 mm tray insert (`persistent-pan-staging/1`), weighs 15
          g sliced ginger on the Ohaus Ranger 3000 scale, simmers ginger on the
          Maruzen MIH-02C or Vollrath 59500P induction hob, executes either
          heat-off steeping on the heatproof rest or two-pan straining into
          `pan-b` with 180 g milk + 25 g sugar finishing to 78 °C (75–80 °C),
          and washes used utensils at the sink.
        </p>
        <RecipeChoice
          label="Workflow mode"
          items={MODES}
          value={this.state.mode}
          choose={(value) => {
            this.setState({
              mode: value === "black-tea" ? "black-tea" : "two-pan-milk-tea",
            });
          }}
        />
        <RecipeChoice
          label="Induction hob model"
          items={HOBS}
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
          label="Tea leaf selection"
          items={TEAS}
          value={this.state.tea}
          choose={(value) => {
            const tea = value === "ctc" ? "ctc" : "assam";
            this.setState({
              tea,
              steepSeconds: tea === "ctc" ? "120" : "180",
            });
          }}
        />
        <label>
          Ginger simmer duration (s)
          <input
            type="number"
            min={360}
            max={480}
            step={10}
            value={this.state.simmerSeconds}
            onChange={(e) =>
              this.setState({ simmerSeconds: e.currentTarget.value })
            }
          />
        </label>
        <label>
          Tea steep / simmer duration (s)
          <input
            type="number"
            min={120}
            max={240}
            step={10}
            value={this.state.steepSeconds}
            onChange={(e) =>
              this.setState({ steepSeconds: e.currentTarget.value })
            }
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={this.state.initialDirtyPan}
            onChange={(e) =>
              this.setState({ initialDirtyPan: e.currentTarget.checked })
            }
          />
          Start with one dirty pan requiring sink wash before extraction
        </label>
        <RecipeChoice
          label="Process & pan-staging check"
          items={CHECKS}
          value={this.state.check}
          choose={(v) => {
            this.setState({
              check:
                v === "late-straining-hold" || v === "dropped-pan-recovery"
                  ? v
                  : "none",
            });
          }}
        />
        <button type="submit">Prepare Ginger Tea 3D station</button>
        <p role="status">{this.state.notice}</p>
      </form>
    );
  }
}
