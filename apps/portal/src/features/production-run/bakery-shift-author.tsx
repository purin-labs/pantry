import React from "react";
import { Select } from "../../ui/select";
import type { GrinderModel } from "@purin-labs/production-simulation/native/cell-adapter";
import {
  morningShiftRecipeInput,
  sixHourShiftRecipeInput,
  type BakeryShiftOptions,
  type BakeryServiceShiftInput,
} from "@purin-labs/production-simulation/recipes/bakery/bakery-shift";
import { prepareNativeRecipe } from "./oven-recipe-file";
import type { OvenRunSource } from "@purin-labs/production-simulation/runs/oven-run-file";
import { buildShiftFloorPlanTravel } from "./floor-plan-shift-travel";
import { floorPlanWorkspace } from "../workflow-simulator/floor-plan-workspace";

type Props = Readonly<{ prepared(source: OvenRunSource): void }>;
type ShiftScope = "bounded" | "morning-shift" | "six-hour-shift";
type WalkRouteSource = "auto" | "floor-plan" | "preset";
type State = Readonly<{
  scope: ShiftScope;
  loads: string;
  financierWaves: string;
  waveIntervalMinutes: string;
  reorderThresholdUnits: string;
  mouldCount: string;
  coolingGridSlots: string;
  demandPreset: "steady" | "rush" | "gift-box-surge";
  shiftBreakPolicy: "staggered-relief" | "fixed-window" | "continuous-no-break";
  walkSpeedPreset: "standard" | "brisk" | "congested-aisle";
  walkRouteSource: WalkRouteSource;
  tea: string;
  blackTea: string;
  sesameBatches: string;
  sesameRoast: "skip" | "refresh";
  sesamePreparation: "baseline" | "early";
  espressoOrders: string;
  espressoAppliance: "linea" | "eagle-one";
  pourOverOrders: string;
  coffeeGrinder: GrinderModel;
  workers: string;
  hobZones: string;
  panCount: string;
  activity: "editing" | "preparing";
  notice: string;
}>;

function shiftFields(
  input: BakeryServiceShiftInput,
): Omit<State, "scope" | "walkRouteSource" | "activity" | "notice"> {
  return {
    loads: String(input.financierLoads),
    financierWaves: String(input.financierWaves),
    waveIntervalMinutes: String(input.waveIntervalMinutes),
    reorderThresholdUnits: String(input.reorderThresholdUnits ?? 4),
    mouldCount: String(input.mouldCount),
    coolingGridSlots: String(input.coolingGridSlots),
    tea: String(input.milkTeaBatches),
    blackTea: String(input.blackTeaBatches),
    sesameBatches: String(input.sesameBatches),
    espressoOrders: String(input.espressoOrders),
    pourOverOrders: String(input.pourOverOrders),
    workers: String(input.workers),
    hobZones: String(input.hobZones),
    panCount: String(input.panCount),
    demandPreset: input.demandPreset,
    shiftBreakPolicy: input.shiftBreakPolicy,
    walkSpeedPreset: input.walkSpeedPreset,
    sesameRoast: input.sesameRoast,
    sesamePreparation: input.sesamePreparation,
    espressoAppliance: input.espressoAppliance,
    coffeeGrinder: input.coffeeGrinder,
  };
}

const SHIFT_SCOPE_ITEMS = [
  { value: "bounded", label: "Financiers and milk tea (MVP)" },
  {
    value: "morning-shift",
    label:
      "Full morning shift: four financiers, two pies and drinks (Plan 61E)",
  },
  {
    value: "six-hour-shift",
    label:
      "6-hour shift: multi-wave financiers, two pies, three tea waves and relief breaks (Plan 61E)",
  },
];

const DEMAND_PRESET_ITEMS = [
  { value: "steady", label: "Steady service" },
  { value: "rush", label: "Early rush" },
  { value: "gift-box-surge", label: "Midday gift orders" },
];

const SHIFT_BREAK_POLICY_ITEMS = [
  {
    value: "staggered-relief",
    label: "Staggered 15-min relief breaks + cross-station handoff (baseline)",
  },
  { value: "fixed-window", label: "Shared break at 170–185 minutes" },
  { value: "continuous-no-break", label: "Continuous shift (no relief break)" },
];

const WALK_SPEED_PRESET_ITEMS = [
  {
    value: "standard",
    label: "Standard walk speed (1.25 m/s · 1.2 m clear aisle · 5 s / 15 s)",
  },
  {
    value: "brisk",
    label: "Brisk floor pace (1.50 m/s · priority pass · 4 s / 11 s)",
  },
  {
    value: "congested-aisle",
    label: "Narrow aisle congestion (0.95 m/s · two-way yield · 7 s / 21 s)",
  },
];

const WALK_ROUTE_SOURCE_ITEMS = [
  { value: "auto", label: "Auto (3D floor plan when customised)" },
  { value: "floor-plan", label: "Live 3D floor-plan obstacle routing" },
  { value: "preset", label: "Fixed cluster preset (5 s / 15 s)" },
];

const FINANCIER_WAVES_ITEMS = [
  { value: "1", label: "1 wave (single batch)" },
  { value: "2", label: "2 recurring waves (closed-loop return)" },
  { value: "3", label: "3 recurring waves (continuous shift)" },
];

const WAVE_INTERVAL_MINUTES_ITEMS = [
  { value: "30", label: "Every 30 min" },
  { value: "45", label: "Every 45 min (baseline)" },
  { value: "60", label: "Every 60 min" },
  { value: "75", label: "Every 75 min (6-hour shift)" },
];

const MOULD_COUNT_ITEMS = [
  { value: "2", label: "2 silicone moulds (baseline)" },
  { value: "3", label: "3 silicone moulds (+1 clean mould)" },
];

const COOLING_GRID_SLOTS_ITEMS = [
  { value: "2", label: "2 cooling grids (baseline)" },
  { value: "3", label: "3 cooling grids" },
  { value: "4", label: "4 cooling grids" },
];

const SESAME_PREPARATION_ITEMS = [
  { value: "baseline", label: "Start with morning rush (600 s)" },
  { value: "early", label: "Start 10 min earlier (0 s)" },
];

const SESAME_ROAST_ITEMS = [
  { value: "refresh", label: "Refresh roast (oven changeover)" },
  { value: "skip", label: "Skip roast" },
];

const ESPRESSO_APPLIANCE_ITEMS = [
  { value: "linea", label: "La Marzocco Linea Classic S 2G" },
  { value: "eagle-one", label: "Victoria Arduino Eagle One 2G" },
];

const COFFEE_GRINDER_ITEMS = [
  { value: "option-o-lagom-casa", label: "Option-O Lagom Casa" },
  { value: "timemore-bricks-01s", label: "Timemore Bricks 01S" },
  { value: "fellow-opus-2", label: "Fellow Opus 2" },
  { value: "miicoffee-df64-gen2", label: "MiiCoffee DF64 II (Gen 2)" },
];

const WORKER_ITEMS = [
  { value: "1", label: "1 worker (baseline)" },
  { value: "2", label: "2 workers" },
];

const HOB_ZONE_ITEMS = [
  { value: "1", label: "1 cooking zone (baseline)" },
  { value: "2", label: "2 cooking zones" },
];

const PAN_COUNT_ITEMS = [
  { value: "2", label: "2 shared pans, 1 initially dirty (baseline)" },
  { value: "3", label: "3 shared pans (+1 clean pan)" },
  { value: "4", label: "4 shared pans (optimised shift)" },
];

export class BakeryShiftAuthor extends React.Component<Props, State> {
  state: State = {
    scope: "bounded",
    loads: "2",
    financierWaves: "1",
    waveIntervalMinutes: "45",
    reorderThresholdUnits: "4",
    mouldCount: "2",
    coolingGridSlots: "2",
    demandPreset: "rush",
    shiftBreakPolicy: "staggered-relief",
    walkSpeedPreset: "standard",
    walkRouteSource: "auto",
    tea: "2",
    blackTea: "2",
    sesameBatches: "2",
    sesameRoast: "refresh",
    sesamePreparation: "baseline",
    espressoOrders: "2",
    espressoAppliance: "linea",
    pourOverOrders: "2",
    coffeeGrinder: "option-o-lagom-casa",
    workers: "1",
    hobZones: "1",
    panCount: "2",
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
  private scope(raw: string | null): void {
    if (raw === null) return;
    const scope: ShiftScope =
      raw === "six-hour-shift"
        ? "six-hour-shift"
        : raw === "morning-shift"
          ? "morning-shift"
          : "bounded";
    if (scope === "bounded") {
      this.setState({ scope, loads: "2", tea: "2" });
      return;
    }
    const preset =
      scope === "six-hour-shift"
        ? sixHourShiftRecipeInput()
        : morningShiftRecipeInput();
    this.setState({ scope, ...shiftFields(preset) });
  }
  private loads(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ loads: event.currentTarget.value });
  }
  private tea(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ tea: event.currentTarget.value });
  }
  private blackTea(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ blackTea: event.currentTarget.value });
  }
  private sesameBatches(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ sesameBatches: event.currentTarget.value });
  }
  private sesameRoast(value: string | null): void {
    if (value === null) return;
    this.setState({
      sesameRoast: value === "skip" ? "skip" : "refresh",
    });
  }
  private sesamePreparation(value: string | null): void {
    if (value === null) return;
    this.setState({
      sesamePreparation: value === "early" ? "early" : "baseline",
    });
  }
  private espressoOrders(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ espressoOrders: event.currentTarget.value });
  }
  private espressoAppliance(value: string | null): void {
    if (value === null) return;
    this.setState({
      espressoAppliance: value === "eagle-one" ? "eagle-one" : "linea",
    });
  }
  private pourOverOrders(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ pourOverOrders: event.currentTarget.value });
  }
  private coffeeGrinder(raw: string | null): void {
    if (raw === null) return;
    this.setState({
      coffeeGrinder:
        raw === "timemore-bricks-01s" ||
        raw === "fellow-opus-2" ||
        raw === "miicoffee-df64-gen2"
          ? raw
          : "option-o-lagom-casa",
    });
  }
  private workers(value: string | null): void {
    if (value === null) return;
    this.setState({
      workers: value === "2" ? "2" : "1",
    });
  }
  private hobZones(value: string | null): void {
    if (value === null) return;
    this.setState({
      hobZones: value === "2" ? "2" : "1",
    });
  }
  private panCount(value: string | null): void {
    if (value === null) return;
    this.setState({
      panCount: value === "4" ? "4" : value === "3" ? "3" : "2",
    });
  }
  private financierWaves(raw: string | null): void {
    if (raw === null) return;
    this.setState({
      financierWaves: raw === "3" ? "3" : raw === "2" ? "2" : "1",
    });
  }
  private waveIntervalMinutes(raw: string | null): void {
    if (raw === null) return;
    this.setState({
      waveIntervalMinutes:
        raw === "75" ? "75" : raw === "60" ? "60" : raw === "30" ? "30" : "45",
    });
  }
  private reorderThresholdUnits(
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    this.setState({ reorderThresholdUnits: event.currentTarget.value });
  }
  private mouldCount(value: string | null): void {
    if (value === null) return;
    this.setState({
      mouldCount: value === "3" ? "3" : "2",
    });
  }
  private coolingGridSlots(raw: string | null): void {
    if (raw === null) return;
    this.setState({
      coolingGridSlots: raw === "4" ? "4" : raw === "3" ? "3" : "2",
    });
  }
  private demandPreset(raw: string | null): void {
    if (raw === null) return;
    this.setState({
      demandPreset:
        raw === "gift-box-surge"
          ? "gift-box-surge"
          : raw === "steady"
            ? "steady"
            : "rush",
    });
  }
  private shiftBreakPolicy(raw: string | null): void {
    if (raw === null) return;
    this.setState({
      shiftBreakPolicy:
        raw === "fixed-window"
          ? "fixed-window"
          : raw === "continuous-no-break"
            ? "continuous-no-break"
            : "staggered-relief",
    });
  }
  private walkSpeedPreset(raw: string | null): void {
    if (raw === null) return;
    this.setState({
      walkSpeedPreset:
        raw === "brisk"
          ? "brisk"
          : raw === "congested-aisle"
            ? "congested-aisle"
            : "standard",
    });
  }
  private walkRouteSource(raw: string | null): void {
    if (raw === null) return;
    this.setState({
      walkRouteSource:
        raw === "floor-plan"
          ? "floor-plan"
          : raw === "preset"
            ? "preset"
            : "auto",
    });
  }
  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (this.state.activity === "preparing") return;
    this.setState({
      activity: "preparing",
      notice: "Preparing the bakery shift…",
    });
    try {
      const useFloorPlanTravel =
        this.state.walkRouteSource === "floor-plan" ||
        (this.state.walkRouteSource === "auto" &&
          floorPlanWorkspace.hasCustomPlacements());
      const customTravel = useFloorPlanTravel
        ? buildShiftFloorPlanTravel(this.state.walkSpeedPreset)
        : undefined;
      const shiftOptions: Partial<BakeryShiftOptions> = {
        financierLoads: Number(this.state.loads),
        financierWaves:
          this.state.financierWaves === "3"
            ? 3
            : this.state.financierWaves === "2"
              ? 2
              : 1,
        waveIntervalMinutes: Number(this.state.waveIntervalMinutes),
        reorderThresholdUnits: Number(this.state.reorderThresholdUnits),
        mouldCount: this.state.mouldCount === "3" ? 3 : 2,
        coolingGridSlots:
          this.state.coolingGridSlots === "4"
            ? 4
            : this.state.coolingGridSlots === "3"
              ? 3
              : 2,
        demandPreset: this.state.demandPreset,
        shiftBreakPolicy: this.state.shiftBreakPolicy,
        walkSpeedPreset: this.state.walkSpeedPreset,
        ...(customTravel === undefined ? {} : { customTravel }),
        sesameBatches: Number(this.state.sesameBatches),
        sesameRoast: this.state.sesameRoast,
        sesamePreparation: this.state.sesamePreparation,
        blackTeaBatches: Number(this.state.blackTea),
        milkTeaBatches: Number(this.state.tea),
        espressoOrders: Number(this.state.espressoOrders),
        espressoAppliance: this.state.espressoAppliance,
        pourOverOrders: Number(this.state.pourOverOrders),
        coffeeGrinder: this.state.coffeeGrinder,
        workers: this.state.workers === "2" ? 2 : 1,
        hobZones: this.state.hobZones === "2" ? 2 : 1,
        panCount:
          this.state.panCount === "4" ? 4 : this.state.panCount === "3" ? 3 : 2,
      };
      const input =
        this.state.scope === "six-hour-shift"
          ? sixHourShiftRecipeInput(shiftOptions)
          : this.state.scope === "morning-shift"
            ? morningShiftRecipeInput(shiftOptions)
            : {
                financierLoads: Number(this.state.loads),
                milkTeaBatches: Number(this.state.tea),
                ...(customTravel === undefined ? {} : { customTravel }),
              };
      const prepared = await prepareNativeRecipe({
        kind: "bakery-shift",
        input,
      });
      if (!this.mounted) return;
      if (prepared.ok) {
        this.setState({ activity: "editing", notice: "" });
        this.props.prepared(prepared.value);
      } else {
        this.setState({ activity: "editing", notice: prepared.error });
      }
    } catch (error) {
      if (this.mounted)
        this.setState({
          activity: "editing",
          notice:
            error instanceof Error
              ? error.message
              : "The shift could not be prepared.",
        });
    }
  }
  render(): React.ReactNode {
    const isExtended = this.state.scope !== "bounded";
    const horizonLabel =
      this.state.scope === "six-hour-shift"
        ? "6 h horizon (21,600 s)"
        : this.state.scope === "morning-shift"
          ? "8 h horizon (28,800 s)"
          : "Bounded MVP";
    const financierPlanLabel = isExtended
      ? `${this.state.financierWaves} wave${this.state.financierWaves === "1" ? "" : "s"} · ${this.state.loads} tray${this.state.loads === "1" ? "" : "s"}/flavour · reorder < ${this.state.reorderThresholdUnits}`
      : `${this.state.loads} hazelnut tray${this.state.loads === "1" ? "" : "s"}`;
    const staffingLabel = isExtended
      ? `${this.state.workers} worker${this.state.workers === "1" ? "" : "s"} · ${this.state.panCount} pans · ${this.state.hobZones} hob${this.state.hobZones === "1" ? "" : "s"}`
      : `${this.state.tea} milk tea batch${this.state.tea === "1" ? "" : "es"}`;
    return (
      <form
        aria-label="Bakery shift"
        className="bakery-shift-author"
        onSubmit={this.prepare.bind(this)}
      >
        <div className="bakery-shift-header">
          <div>
            <h3>Run a bakery shift</h3>
            <p className="bakery-shift-lead">
              Prepare hazelnut, coffee, matcha and black sesame financiers,
              savory pies, black sesame milk, ginger teas, espresso and Blue
              Bottle pour-over on one shared logical clock.
            </p>
          </div>
          <div
            className="bakery-shift-summary-pills"
            aria-label="Selected shift summary"
          >
            <span className="bakery-shift-pill" data-tone="accent">
              {horizonLabel}
            </span>
            <span className="bakery-shift-pill">{financierPlanLabel}</span>
            <span className="bakery-shift-pill">{staffingLabel}</span>
          </div>
        </div>
        <fieldset
          className="bakery-shift-fieldset"
          disabled={this.state.activity === "preparing"}
        >
          <legend>Production quantities</legend>
          <div className="bakery-shift-section">
            <span className="bakery-shift-section-title">
              Shift preset &amp; service rhythm
            </span>
            <div className="bakery-shift-grid">
              <label className="bakery-shift-span-full">
                <span>Shift scope</span>
                <Select.Root
                  items={SHIFT_SCOPE_ITEMS}
                  value={this.state.scope}
                  onValueChange={this.scope.bind(this)}
                >
                  <Select.Trigger aria-label="Shift scope">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Popup>
                    {SHIFT_SCOPE_ITEMS.map(renderItem)}
                  </Select.Popup>
                </Select.Root>
              </label>
              {isExtended ? (
                <>
                  <label>
                    <span>Customer demand pattern</span>
                    <Select.Root
                      items={DEMAND_PRESET_ITEMS}
                      value={this.state.demandPreset}
                      onValueChange={this.demandPreset.bind(this)}
                    >
                      <Select.Trigger aria-label="Customer demand pattern">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {DEMAND_PRESET_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label className="bakery-shift-span-2">
                    <span>Worker break policy</span>
                    <Select.Root
                      items={SHIFT_BREAK_POLICY_ITEMS}
                      value={this.state.shiftBreakPolicy}
                      onValueChange={this.shiftBreakPolicy.bind(this)}
                    >
                      <Select.Trigger aria-label="Worker break policy">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {SHIFT_BREAK_POLICY_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label className="bakery-shift-span-2">
                    <span>Operator walk speed &amp; aisle congestion</span>
                    <Select.Root
                      items={WALK_SPEED_PRESET_ITEMS}
                      value={this.state.walkSpeedPreset}
                      onValueChange={this.walkSpeedPreset.bind(this)}
                    >
                      <Select.Trigger aria-label="Operator walk speed and aisle congestion">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {WALK_SPEED_PRESET_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                </>
              ) : null}
              <label
                className={isExtended ? undefined : "bakery-shift-span-full"}
              >
                <span>Station walk routing</span>
                <Select.Root
                  items={WALK_ROUTE_SOURCE_ITEMS}
                  value={this.state.walkRouteSource}
                  onValueChange={this.walkRouteSource.bind(this)}
                >
                  <Select.Trigger aria-label="Station walk routing">
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Popup>
                    {WALK_ROUTE_SOURCE_ITEMS.map(renderItem)}
                  </Select.Popup>
                </Select.Root>
              </label>
            </div>
          </div>

          <div className="bakery-shift-section">
            <span className="bakery-shift-section-title">
              Pâtisserie &amp; stock replenishment
            </span>
            <div className="bakery-shift-grid">
              <label>
                <span>
                  {isExtended
                    ? "Financier trays of each flavour"
                    : "Hazelnut financier trays"}
                </span>
                <input
                  aria-label="Financier trays"
                  type="number"
                  min={1}
                  max={3}
                  step={1}
                  value={this.state.loads}
                  onChange={this.loads.bind(this)}
                />
              </label>
              {isExtended ? (
                <>
                  <label>
                    <span>Financier production waves</span>
                    <Select.Root
                      items={FINANCIER_WAVES_ITEMS}
                      value={this.state.financierWaves}
                      onValueChange={this.financierWaves.bind(this)}
                    >
                      <Select.Trigger aria-label="Financier production waves">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {FINANCIER_WAVES_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label>
                    <span>Wave cadence (minutes)</span>
                    <Select.Root
                      items={WAVE_INTERVAL_MINUTES_ITEMS}
                      value={this.state.waveIntervalMinutes}
                      onValueChange={this.waveIntervalMinutes.bind(this)}
                    >
                      <Select.Trigger aria-label="Wave cadence (minutes)">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {WAVE_INTERVAL_MINUTES_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label>
                    <span>Financier reorder threshold (units per flavour)</span>
                    <input
                      aria-label="Financier reorder threshold (units per flavour)"
                      type="number"
                      min={0}
                      max={16}
                      step={1}
                      value={this.state.reorderThresholdUnits}
                      onChange={this.reorderThresholdUnits.bind(this)}
                    />
                  </label>
                  <label>
                    <span>Silicone mould count</span>
                    <Select.Root
                      items={MOULD_COUNT_ITEMS}
                      value={this.state.mouldCount}
                      onValueChange={this.mouldCount.bind(this)}
                    >
                      <Select.Trigger aria-label="Silicone mould count">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {MOULD_COUNT_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label>
                    <span>Cooling rack grids</span>
                    <Select.Root
                      items={COOLING_GRID_SLOTS_ITEMS}
                      value={this.state.coolingGridSlots}
                      onValueChange={this.coolingGridSlots.bind(this)}
                    >
                      <Select.Trigger aria-label="Cooling rack grids">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {COOLING_GRID_SLOTS_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                </>
              ) : null}
            </div>
          </div>

          <div className="bakery-shift-section">
            <span className="bakery-shift-section-title">
              Café beverage bar &amp; appliances
            </span>
            <div className="bakery-shift-grid">
              <label>
                <span>Milk tea batches</span>
                <input
                  aria-label="Milk tea batches"
                  type="number"
                  min={1}
                  max={this.state.scope === "six-hour-shift" ? 3 : 2}
                  step={1}
                  value={this.state.tea}
                  onChange={this.tea.bind(this)}
                />
              </label>
              {isExtended ? (
                <>
                  <label>
                    <span>Black tea batches</span>
                    <input
                      aria-label="Black tea batches"
                      type="number"
                      min={1}
                      max={this.state.scope === "six-hour-shift" ? 3 : 2}
                      step={1}
                      value={this.state.blackTea}
                      onChange={this.blackTea.bind(this)}
                    />
                  </label>
                  <label>
                    <span>Sesame concentrate batches</span>
                    <input
                      aria-label="Sesame concentrate batches"
                      type="number"
                      min={1}
                      max={2}
                      step={1}
                      value={this.state.sesameBatches}
                      onChange={this.sesameBatches.bind(this)}
                    />
                  </label>
                  <label>
                    <span>Sesame preparation timing</span>
                    <Select.Root
                      items={SESAME_PREPARATION_ITEMS}
                      value={this.state.sesamePreparation}
                      onValueChange={this.sesamePreparation.bind(this)}
                    >
                      <Select.Trigger aria-label="Sesame preparation timing">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {SESAME_PREPARATION_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label>
                    <span>Sesame oven roast</span>
                    <Select.Root
                      items={SESAME_ROAST_ITEMS}
                      value={this.state.sesameRoast}
                      onValueChange={this.sesameRoast.bind(this)}
                    >
                      <Select.Trigger aria-label="Sesame oven roast">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {SESAME_ROAST_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label>
                    <span>Espresso orders</span>
                    <input
                      aria-label="Espresso orders"
                      type="number"
                      min={0}
                      max={4}
                      step={1}
                      value={this.state.espressoOrders}
                      onChange={this.espressoOrders.bind(this)}
                    />
                  </label>
                  <label>
                    <span>Espresso machine</span>
                    <Select.Root
                      items={ESPRESSO_APPLIANCE_ITEMS}
                      value={this.state.espressoAppliance}
                      onValueChange={this.espressoAppliance.bind(this)}
                    >
                      <Select.Trigger aria-label="Espresso machine">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {ESPRESSO_APPLIANCE_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                  <label>
                    <span>Pour-over orders</span>
                    <input
                      aria-label="Pour-over orders"
                      type="number"
                      min={0}
                      max={2}
                      step={1}
                      value={this.state.pourOverOrders}
                      onChange={this.pourOverOrders.bind(this)}
                    />
                  </label>
                  <label>
                    <span>Coffee grinder</span>
                    <Select.Root
                      items={COFFEE_GRINDER_ITEMS}
                      value={this.state.coffeeGrinder}
                      onValueChange={this.coffeeGrinder.bind(this)}
                    >
                      <Select.Trigger aria-label="Coffee grinder">
                        <Select.Value />
                      </Select.Trigger>
                      <Select.Popup>
                        {COFFEE_GRINDER_ITEMS.map(renderItem)}
                      </Select.Popup>
                    </Select.Root>
                  </label>
                </>
              ) : null}
            </div>
          </div>

          {isExtended ? (
            <div className="bakery-shift-section">
              <span className="bakery-shift-section-title">
                Staffing &amp; shared kitchen capacity
              </span>
              <div className="bakery-shift-grid">
                <label>
                  <span>Staffing comparison</span>
                  <Select.Root
                    items={WORKER_ITEMS}
                    value={this.state.workers}
                    onValueChange={this.workers.bind(this)}
                  >
                    <Select.Trigger aria-label="Staffing comparison">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup>
                      {WORKER_ITEMS.map(renderItem)}
                    </Select.Popup>
                  </Select.Root>
                </label>
                <label>
                  <span>Hob capacity comparison</span>
                  <Select.Root
                    items={HOB_ZONE_ITEMS}
                    value={this.state.hobZones}
                    onValueChange={this.hobZones.bind(this)}
                  >
                    <Select.Trigger aria-label="Hob capacity comparison">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup>
                      {HOB_ZONE_ITEMS.map(renderItem)}
                    </Select.Popup>
                  </Select.Root>
                </label>
                <label>
                  <span>Pan availability comparison</span>
                  <Select.Root
                    items={PAN_COUNT_ITEMS}
                    value={this.state.panCount}
                    onValueChange={this.panCount.bind(this)}
                  >
                    <Select.Trigger aria-label="Pan availability comparison">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Popup>
                      {PAN_COUNT_ITEMS.map(renderItem)}
                    </Select.Popup>
                  </Select.Root>
                </label>
              </div>
            </div>
          ) : null}

          <button className="bakery-shift-submit">Prepare bakery shift</button>
        </fieldset>
        <p role="status" className="bakery-shift-status">
          {this.state.notice}
        </p>
        <div className="bakery-shift-notes">
          <p>
            Each tray holds eight financiers of one flavour; the full shift
            bakes the set number of trays of each flavour and a tray of six 12
            cm pies of each type. One piece from the first tray is sampled. Each
            tea batch serves two cups and each sesame batch yields ten drink
            portions. Review bakes, packing and tea extraction before release.
            Rejected products leave through the recorded disposal path.
          </p>
          <p>
            The robot stages tea pans and transfers cold carriers. Other
            handling, heating and cooling use declared assumptions. Save a
            shared copy before closing the browser.
          </p>
        </div>
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
