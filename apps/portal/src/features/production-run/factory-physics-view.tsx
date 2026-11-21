import { floorPlanWorkspace } from "../workflow-simulator/floor-plan-workspace";
import {
  isApplianceId,
  type ApplianceId,
} from "@purin-labs/production-simulation/floor/appliance-catalogue";
import React from "react";
import { BakeryAppearanceControl } from "../../preferences/appearance-controls";
import { SegmentedControl } from "../workflow-simulator/docks/shared";
import type { LogisticsView } from "@purin-labs/production-simulation";
import type { PersistentPhysicsScene } from "@purin-labs/bakery-model/bakery-physics";
import { PhysicsSceneHost } from "../workflow-simulator/spatial/physics-scene-host";
import type { FactorySceneSource } from "../workflow-simulator/spatial/physics-factory-scene";
import { ovenFrameMotion, type OvenLiveFrame } from "@purin-labs/production-simulation/runs/oven-live-physics";
import type { FactoryStationSource } from "../workflow-simulator/spatial/factory-stations";
import {
  computeFacilityUtilityTelemetry,
  summarizeMorningShiftMassAccounting,
  type SynchronizedApplianceState,
  type SynchronizedCobotTransferState,
} from "./morning-shift-appliances";
import {
  BAKERY_FLOOR_PLANS,
  type BakeryFloorPlanId,
} from "@purin-labs/production-simulation/floor/bakery-room";
import { rotateApplianceWithCollisions } from "../workflow-simulator/bakery-appliance-layout";
import { SimulatorHistoryControls } from "../workflow-simulator/docks/history-controls";
import { StoreInteriorDesignControl } from "../workflow-simulator/docks/store-interior-control";

type Cell = Readonly<{
  scene: PersistentPhysicsScene;
  frame: OvenLiveFrame | null;
}>;
type Props = Readonly<{
  cells: readonly Cell[];
  /** Equipment stations of a factory without robot cells, or alongside cobot cells. */
  stations: readonly FactoryStationSource[] | null;
  appliances?: readonly SynchronizedApplianceState[] | null;
  cobotTransfers?: readonly SynchronizedCobotTransferState[] | null;
  logistics: LogisticsView;
  time: number;
  selected: string | null;
  selectedCell: string | null;
  select(cell: string, task: string | null): void;
}>;
type Camera = "floor" | "perspective";
type Layout = Camera | "split";
type PaneProps = Readonly<{
  source: FactorySceneSource;
  camera: Camera;
  ariaLabel?: string;
  select(cell: string): void;
}>;
type Status = "empty" | "loading" | "ready" | "unavailable";

/** Each pane renders the same accepted state. Neither pane advances physics. */
class FactoryPane extends React.Component<
  PaneProps,
  Readonly<{ status: Status }>
> {
  state: Readonly<{ status: Status }> = { status: "loading" };
  private readonly element = React.createRef<HTMLDivElement>();
  private readonly host = new PhysicsSceneHost({
    fallback: "message",
    camera: "cell",
    select: ignoreSingleCellSelection,
    changed: this.sceneChanged.bind(this),
    inspectEvent: null,
    pause: null,
  });
  private mounted = false;
  componentDidMount(): void {
    this.mounted = true;
    if (this.element.current !== null) void this.load(this.element.current);
  }
  private async load(element: HTMLElement): Promise<void> {
    await this.host.loadFactory(
      element,
      this.props.source,
      this.props.select,
      this.props.camera,
    );
    this.host.factory?.update(this.props.source);
  }
  componentDidUpdate(): void {
    this.host.factory?.update(this.props.source);
  }
  componentWillUnmount(): void {
    this.mounted = false;
    this.host.dispose();
  }
  private sceneChanged(status: Status): void {
    if (this.mounted) this.setState({ status });
  }
  render(): React.ReactNode {
    return (
      <div
        className="factory-pane"
        aria-label={this.props.ariaLabel}
        data-scene={this.state.status}
        data-camera={this.props.camera}
      >
        <div className="factory-physics-canvas" ref={this.element} />
        <span className="factory-pane-label">
          {this.props.camera === "floor" ? "Floor plan" : "3D factory"}
        </span>
        {this.state.status === "unavailable" && (
          <p role="status" className="factory-canvas-message">
            This canvas is unavailable. Open Logistics to inspect the run.
          </p>
        )}
      </div>
    );
  }
}

export class FactoryPhysicsView extends React.Component<
  Props,
  Readonly<{
    layout: Layout;
    floorPlan: BakeryFloorPlanId;
    floorPercent: number;
    compact: boolean;
  }>
> {
  state: Readonly<{
    layout: Layout;
    floorPlan: BakeryFloorPlanId;
    floorPercent: number;
    compact: boolean;
  }> = {
    layout: "perspective",
    floorPlan: floorPlanWorkspace.getActivePlan(),
    floorPercent: 34,
    compact: false,
  };
  private readonly panes = React.createRef<HTMLDivElement>();
  private readonly narrow = window.matchMedia("(max-width: 800px)");
  private unsubscribeFloorPlan: (() => void) | null = null;
  componentDidMount(): void {
    this.resize();
    this.narrow.addEventListener("change", this.resize);
    this.unsubscribeFloorPlan = floorPlanWorkspace.subscribePlan(
      (floorPlan) => {
        this.setState({ floorPlan });
      },
    );
  }
  componentWillUnmount(): void {
    this.narrow.removeEventListener("change", this.resize);
    this.unsubscribeFloorPlan?.();
  }
  private resize = (): void => {
    this.setState({ compact: this.narrow.matches });
  };
  private chooseLayout(layout: Layout): void {
    this.setState({ layout });
  }
  private chooseFloorPlan(floorPlan: BakeryFloorPlanId): void {
    floorPlanWorkspace.setActivePlan(floorPlan);
    this.setState({ floorPlan });
  }
  private selectCell(id: string): void {
    for (const station of this.props.stations ?? [])
      if (station.id === id) {
        const active = (this.props.appliances ?? []).find(
          (a) => a.stationId === id && a.activeTaskId !== null,
        );
        this.props.select(id, active?.activeTaskId ?? null);
        return;
      }
    for (const cell of this.props.cells) {
      if (cell.scene.cell.cellId !== id) continue;
      const frame = cell.frame;
      const task =
        frame !== null &&
        (frame.purpose === "operation" || frame.purpose === "recovery")
          ? frame.task
          : null;
      this.props.select(id, task);
      return;
    }
    for (const transfer of this.props.cobotTransfers ?? []) {
      if (transfer.cellId !== id) continue;
      this.props.select(id, transfer.taskId);
      return;
    }
  }
  private selectAppliance(state: SynchronizedApplianceState): void {
    this.props.select(state.stationId, state.activeTaskId ?? state.lastTaskId);
  }
  private activePeerIds(): readonly ApplianceId[] {
    const ids = new Set<string>();
    for (const station of this.props.stations ?? []) ids.add(station.id);
    for (const cell of this.props.cells) ids.add(cell.scene.cell.cellId);
    for (const transfer of this.props.cobotTransfers ?? [])
      ids.add(transfer.cellId);
    return [...ids].filter(isApplianceId);
  }
  private rotateSelectedAppliance = (): void => {
    if (
      this.props.selectedCell === null ||
      !isApplianceId(this.props.selectedCell)
    )
      return;
    rotateApplianceWithCollisions(
      this.state.floorPlan,
      this.props.selectedCell,
      this.activePeerIds(),
    );
  };
  private resetApplianceLayout = (): void => {
    floorPlanWorkspace.resetPlacements(this.state.floorPlan);
  };
  private moveDivider(event: React.PointerEvent<HTMLButtonElement>): void {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = this.panes.current?.getBoundingClientRect();
    if (bounds === undefined || bounds.width === 0) return;
    this.setState({
      floorPercent: Math.max(
        25,
        Math.min(60, ((event.clientX - bounds.left) / bounds.width) * 100),
      ),
    });
  }
  private startDivider(event: React.PointerEvent<HTMLButtonElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  private endDivider(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  private keyDivider(event: React.KeyboardEvent<HTMLButtonElement>): void {
    let value = this.state.floorPercent;
    switch (event.key) {
      case "ArrowLeft":
        value -= 5;
        break;
      case "ArrowRight":
        value += 5;
        break;
      case "Home":
        value = 25;
        break;
      case "End":
        value = 60;
        break;
      default:
        return;
    }
    event.preventDefault();
    this.setState({ floorPercent: Math.max(25, Math.min(60, value)) });
  }
  private cellButton(cell: Cell): React.ReactNode {
    const frame = cell.frame;
    const selectable =
      frame !== null &&
      (frame.purpose === "operation" || frame.purpose === "recovery");
    return (
      <button
        key={cell.scene.cell.cellId}
        aria-pressed={
          this.props.selectedCell === cell.scene.cell.cellId ||
          (selectable && this.props.selected === frame.task)
        }
        onClick={this.selectCell.bind(this, cell.scene.cell.cellId)}
      >
        {cell.scene.cell.cellId}
      </button>
    );
  }
  private stationButton(station: FactoryStationSource): React.ReactNode {
    return (
      <button
        key={station.id}
        aria-pressed={this.props.selectedCell === station.id}
        onClick={this.selectCell.bind(this, station.id)}
      >
        {station.label}
      </button>
    );
  }
  private cobotCellButton(
    transfer: SynchronizedCobotTransferState,
  ): React.ReactNode {
    return (
      <button
        key={transfer.cellId}
        aria-pressed={
          this.props.selectedCell === transfer.cellId ||
          (transfer.taskId !== null && this.props.selected === transfer.taskId)
        }
        onClick={this.selectCell.bind(this, transfer.cellId)}
      >
        {transfer.cellId}
      </button>
    );
  }
  private cobotPill(transfer: SynchronizedCobotTransferState): React.ReactNode {
    const cascadeStatus =
      transfer.cascadeHold === null
        ? undefined
        : transfer.cascadeHold.restored
          ? "recovered"
          : "held";
    return (
      <button
        key={`cobot:${transfer.cellId}`}
        type="button"
        className="factory-sync-pill"
        data-sync-kind="cobot"
        data-cobot-cell={transfer.cellId}
        data-sync-status={transfer.status}
        data-cobot-gripper-force-n={transfer.gripperForceNewtons}
        data-cobot-shoulder-torque-nm={transfer.shoulderTorqueNm}
        data-cobot-payload-kg={transfer.payloadMassKg}
        data-cobot-joints-rad={transfer.jointAnglesRad.join(",")}
        data-cascade-status={cascadeStatus}
        data-cascade-checkpoint={transfer.cascadeHold?.checkpointDigest.slice(
          0,
          8,
        )}
        aria-pressed={this.props.selectedCell === transfer.cellId}
        onClick={this.selectCell.bind(this, transfer.cellId)}
      >
        <div className="factory-sync-pill-header">
          <strong>
            {transfer.cellId === "tea-pan-cell" ? "Baker" : "Barista"} ·{" "}
            {transfer.cellId}
          </strong>
          <span className="factory-sync-badge" data-status={transfer.status}>
            {transfer.status}
          </span>
        </div>
        <small>
          {transfer.label} · {transfer.gripperForceNewtons} N ·{" "}
          {transfer.shoulderTorqueNm} N·m · step {transfer.step} ·{" "}
          {transfer.completedTransfers}/{transfer.totalTransfers} transfers
        </small>
      </button>
    );
  }
  private facilityUtilityPill(
    appliances: readonly SynchronizedApplianceState[],
  ): React.ReactNode {
    const u = computeFacilityUtilityTelemetry(appliances);
    const hvac = u.hvacPsychrometrics;
    const av = u.acousticsAndVibration;
    const cc = u.chillerColdCell;
    const dw = u.dishwasherWarewash;
    const eb = u.espressoBoiler;
    const ov = u.ovenVentingRadiant;
    const hb = u.hobCoilThermal;
    const sc = u.precisionScale;
    const mx = u.planetaryMixer;
    const mf = u.milkFrother;
    const cw = u.continuousWaveCarrierReturn;
    const bh = u.shiftBreakAndHandoff;
    const wc = u.aisleLocomotionAndCongestion;
    const mass = summarizeMorningShiftMassAccounting(this.props.logistics);
    return (
      <div
        key="facility-utilities"
        className="factory-sync-pill"
        data-sync-kind="facility-utility"
        data-utility-status={u.status}
        data-utility-power-watts={u.totalPowerWatts}
        data-utility-voltage-volts={u.lineVoltageVolts}
        data-utility-water-pressure-bar={u.waterManifoldPressureBar}
        data-utility-water-flow-lpm={u.waterFlowLpm}
        data-hvac-status={hvac.status}
        data-hvac-dry-bulb-c={hvac.roomDryBulbC}
        data-hvac-rh-pct={hvac.relativeHumidityPercent}
        data-hvac-wet-bulb-c={hvac.wetBulbC}
        data-hvac-dew-point-c={hvac.dewPointC}
        data-hvac-enthalpy-kj-kg={hvac.specificEnthalpyKjPerKg}
        data-hvac-hood-cfm={hvac.canopyHoodExhaustCfm}
        data-acoustics-room-dba={av.roomCompositeNoiseDba}
        data-vibration-peak-mms={av.peakVibrationMmPerSecRms}
        data-vibration-iso-class={av.isoVibrationClass}
        data-chiller-phase={cc.phase}
        data-chiller-infiltration-kj={cc.totalInfiltrationHeatKj}
        data-chiller-frost-g={cc.evaporatorFrostGrams}
        data-chiller-defrost-cycles={cc.defrostCycleCount}
        data-chiller-condensate-ml={cc.totalCondensateDrainedMl}
        data-dishwasher-sanitizer-ppm={dw.sanitizerPpm}
        data-dishwasher-detergent-ml={dw.totalDetergentDosedMl}
        data-dishwasher-heat-recovered-kj={dw.totalGreywaterRecoveredKj}
        data-dishwasher-recovery-efficiency-pct={
          dw.heatRecoveryEfficiencyPercent
        }
        data-espresso-min-grouphead-c={eb.minGroupheadTempC}
        data-espresso-thermal-dip-c={eb.maxGroupheadThermalDipC}
        data-espresso-steam-pressure-bar={eb.steamBoilerPressureBar}
        data-oven-nominal-flux-kw-m2={ov.nominalDeckFluxKwPerSqM}
        data-oven-hotspot-flux-kw-m2={ov.hotspotDeckFluxKwPerSqM}
        data-oven-venting-gps={ov.peakSteamVentingGps}
        data-hob-coupling-efficiency-pct={hb.meanCouplingEfficiencyPercent}
        data-hob-radial-gradient-c={hb.maxRadialGradientC}
        data-hob-boil-off-gps={hb.peakBoilOffGps}
        data-scale-settling-s={sc.meanSettlingTimeSeconds}
        data-scale-tare-drift-mg={sc.maxZeroTareDriftMg}
        data-scale-draft-rejection-db={sc.meanFilterRejectionDb}
        data-mixer-work-wh-kg={mx.totalSpecificWorkWhPerKg}
        data-mixer-torque-ripple-nm={mx.maxTorqueRippleNmPeakToPeak}
        data-mixer-emulsion-index={mx.meanEmulsionIndex}
        data-frother-overrun-pct={mf.meanMicrofoamOverrunPercent}
        data-frother-shear-inv-s={mf.peakVortexShearRateInverseSec}
        data-frother-whey-denaturation-pct={mf.meanWheyDenaturationPercent}
        data-wave-active={cw.activeWaveIndex}
        data-wave-total={cw.waveCount}
        data-carrier-turnarounds={cw.totalCarrierReturns}
        data-carrier-wash-cycles={cw.totalWashCycles}
        data-carrier-reuse-ratio={cw.overallReuseRatio}
        data-handoff-count={bh.totalStationHandoffs}
        data-break-coverage-pct={bh.reliefCoveragePercent}
        data-handoff-mean-s={bh.meanHandoffDurationSeconds}
        data-walk-speed-mps={wc.effectiveWalkSpeedMps}
        data-aisle-transits={wc.totalCrossAisleTransits}
        data-aisle-distance-m={wc.totalDistanceWalkedMeters}
        data-aisle-congestion-wait-s={wc.totalCongestionWaitSeconds}
        data-mass-accepted-g={mass.totalAcceptedGrams}
        data-mass-rejected-scrap-g={mass.totalRejectedScrapGrams}
        data-mass-yield-pct={mass.firstPassYieldPercent}
      >
        <div className="factory-sync-pill-header">
          <strong>Facility 3Φ · Water · HVAC · Acoustics · Yield</strong>
          <span className="factory-sync-badge" data-status={u.status}>
            {u.status}
          </span>
        </div>
        <small>
          {(u.totalPowerWatts / 1000).toFixed(2)} kW ({u.lineVoltageVolts} V) ·{" "}
          {u.waterManifoldPressureBar} bar · {hvac.roomDryBulbC} °C /{" "}
          {hvac.relativeHumidityPercent}% RH ({hvac.canopyHoodExhaustCfm} CFM) ·{" "}
          {av.roomCompositeNoiseDba} dBA / {av.peakVibrationMmPerSecRms} mm/s ·{" "}
          {mass.totalAcceptedGrams} g ok / {mass.totalRejectedScrapGrams} g
          scrap
        </small>
      </div>
    );
  }
  private appliancePill(state: SynchronizedApplianceState): React.ReactNode {
    return (
      <button
        key={state.appliance}
        type="button"
        className="factory-sync-pill"
        data-sync-kind="appliance"
        data-appliance={state.appliance}
        data-sync-status={state.status}
        data-appliance-power-watts={state.powerWatts}
        data-appliance-pressure-bar={state.pressureBar}
        data-appliance-torque-nm={state.torqueNm}
        data-appliance-viscosity-pas={state.viscosityPas}
        data-appliance-noise-dba={state.acousticNoiseDba}
        data-appliance-vibration-mms={state.vibrationMmPerSecRms}
        data-appliance-peak-noise-dba={state.peakAcousticNoiseDba}
        data-appliance-peak-vibration-mms={state.peakVibrationMmPerSecRms}
        data-appliance-door-open={state.doorOpenRatio}
        aria-pressed={this.props.selectedCell === state.stationId}
        onClick={this.selectAppliance.bind(this, state)}
      >
        <div className="factory-sync-pill-header">
          <strong>{state.displayName}</strong>
          <span className="factory-sync-badge" data-status={state.status}>
            {state.status}
          </span>
        </div>
        <small>
          {state.programSummary} · {state.temperatureC.toFixed(0)} °C ·{" "}
          {state.powerWatts} W · {state.acousticNoiseDba.toFixed(1)} dBA ·{" "}
          {state.vibrationMmPerSecRms.toFixed(2)} mm/s · {state.completedCount}/
          {state.totalCount}
        </small>
      </button>
    );
  }
  render(): React.ReactNode {
    const layout =
      this.state.compact && this.state.layout === "split"
        ? "perspective"
        : this.state.layout;
    const source: FactorySceneSource = {
      ...factorySource(this.props),
      floorPlan: this.state.floorPlan,
    };
    const activePlan = BAKERY_FLOOR_PLANS[this.state.floorPlan];
    const singleCobotWithStations =
      this.props.cells.length === 1 && this.props.stations !== null;
    const appliances = this.props.appliances ?? null;
    const cobotTransfers = this.props.cobotTransfers ?? null;
    return (
      <section
        className="factory-canvas-workspace"
        aria-label="Shared recorded factory"
        data-time={this.props.time}
        data-floor-plan={this.state.floorPlan}
        data-floor-plan-area-sqm={activePlan.areaSqm}
      >
        <nav className="factory-canvas-switch" aria-label="Factory canvas view">
          <SegmentedControl
            ariaLabel="Canvas layout"
            value={layout}
            options={
              this.state.compact
                ? [
                    {
                      value: "floor" as const,
                      label: "Floor plan",
                      onSelect: this.chooseLayout.bind(this, "floor"),
                    },
                    {
                      value: "perspective" as const,
                      label: "3D view",
                      onSelect: this.chooseLayout.bind(this, "perspective"),
                    },
                  ]
                : [
                    {
                      value: "floor" as const,
                      label: "Floor plan",
                      onSelect: this.chooseLayout.bind(this, "floor"),
                    },
                    {
                      value: "perspective" as const,
                      label: "3D view",
                      onSelect: this.chooseLayout.bind(this, "perspective"),
                    },
                    {
                      value: "split" as const,
                      label: "Split",
                      onSelect: this.chooseLayout.bind(this, "split"),
                    },
                  ]
            }
          />
          <SegmentedControl
            ariaLabel="Floor plan model"
            value={this.state.floorPlan}
            options={(
              [
                "reference",
                "kinshicho-6992842011",
                "asakusabashi-t101940",
                "machiya-sun-reve",
                "hongo-8257562",
              ] as const
            ).map((id) => ({
              value: id,
              label: BAKERY_FLOOR_PLANS[id].shortLabel,
              onSelect: this.chooseFloorPlan.bind(this, id),
            }))}
          />
          <StoreInteriorDesignControl />
          <BakeryAppearanceControl />
          <SimulatorHistoryControls />
        </nav>
        {appliances !== null && appliances.length > 0 && (
          <section
            className="factory-appliance-strip"
            aria-label="Synchronized appliance and cobot states"
          >
            {this.facilityUtilityPill(appliances)}
            {(cobotTransfers ?? []).map(this.cobotPill.bind(this))}
            {appliances.map(this.appliancePill.bind(this))}
          </section>
        )}
        <div
          className="factory-panes"
          ref={this.panes}
          data-layout={layout}
          style={
            layout === "split"
              ? {
                  gridTemplateColumns: `${this.state.floorPercent}% 8px minmax(0, 1fr)`,
                }
              : undefined
          }
        >
          {layout !== "perspective" && (
            <FactoryPane
              key="floor"
              camera="floor"
              ariaLabel={
                singleCobotWithStations && layout === "floor"
                  ? "Live accepted physics"
                  : undefined
              }
              source={source}
              select={this.selectCell.bind(this)}
            />
          )}
          {layout === "split" && (
            <button
              className="factory-pane-divider"
              role="separator"
              aria-label="Resize floor plan"
              aria-orientation="vertical"
              aria-valuemin={25}
              aria-valuemax={60}
              aria-valuenow={Math.round(this.state.floorPercent)}
              onPointerDown={this.startDivider.bind(this)}
              onPointerMove={this.moveDivider.bind(this)}
              onPointerUp={this.endDivider.bind(this)}
              onPointerCancel={this.endDivider.bind(this)}
              onKeyDown={this.keyDivider.bind(this)}
            />
          )}
          {layout !== "floor" && (
            <FactoryPane
              key="perspective"
              camera="perspective"
              ariaLabel={
                singleCobotWithStations ? "Live accepted physics" : undefined
              }
              source={source}
              select={this.selectCell.bind(this)}
            />
          )}
        </div>
        {this.props.stations === null ? (
          <div
            className="factory-cell-selection"
            aria-label="Select factory cell"
          >
            {this.props.cells.map(this.cellButton.bind(this))}
            {this.props.selectedCell !== null && (
              <button
                type="button"
                onClick={this.rotateSelectedAppliance}
                title="Rotate selected workcell 90°"
              >
                Rotate 90°
              </button>
            )}
            <button
              type="button"
              onClick={this.resetApplianceLayout}
              title="Reset room appliance layout"
            >
              Reset layout
            </button>
          </div>
        ) : (
          <div
            className="factory-cell-selection"
            aria-label="Select factory station"
          >
            {this.props.cells.map(this.cellButton.bind(this))}
            {(cobotTransfers ?? [])
              .filter(
                (t) =>
                  !this.props.cells.some(
                    (c) => c.scene.cell.cellId === t.cellId,
                  ),
              )
              .map(this.cobotCellButton.bind(this))}
            {this.props.stations.map(this.stationButton.bind(this))}
            {this.props.selectedCell !== null && (
              <button
                type="button"
                onClick={this.rotateSelectedAppliance}
                title="Rotate selected appliance or workcell 90°"
              >
                Rotate 90°
              </button>
            )}
            <button
              type="button"
              onClick={this.resetApplianceLayout}
              title="Reset room appliance layout"
            >
              Reset layout
            </button>
          </div>
        )}
      </section>
    );
  }
}

function ignoreSingleCellSelection(): void {}
function factorySource(props: Props): FactorySceneSource {
  const cells = [];
  let selectedCell: string | null = props.selectedCell;
  for (const cell of props.cells) {
    const frame = cell.frame;
    cells.push({
      id: cell.scene.cell.cellId,
      motion: frame === null ? null : ovenFrameMotion(frame, "after"),
    });
    if (
      frame !== null &&
      (frame.purpose === "operation" || frame.purpose === "recovery") &&
      frame.task === props.selected
    )
      selectedCell = cell.scene.cell.cellId;
  }
  for (const transfer of props.cobotTransfers ?? []) {
    if (transfer.taskId !== null && transfer.taskId === props.selected)
      selectedCell = transfer.cellId;
  }
  const workers = [];
  if (props.logistics.kind === "available") {
    const taskById = new Map(props.logistics.tasks.map((t) => [t.id, t]));
    for (const resource of props.logistics.resources) {
      if (resource.kind !== "worker") continue;
      const parsed = parseWorkerRoute(resource.position);
      const activeAlloc = resource.allocations[0];
      const activeTask =
        activeAlloc !== undefined ? taskById.get(activeAlloc.task) : undefined;
      let progress = 0;
      if (activeTask !== undefined && activeTask.kind === "executing") {
        const start = activeTask.startedAt;
        const end = activeTask.completesAt ?? start + 20_000_000;
        progress = Math.max(
          0,
          Math.min(1, (props.time - start) / Math.max(1, end - start)),
        );
      }
      workers.push({
        id: resource.id,
        location: parsed.from,
        destination: parsed.to,
        progress,
        carrying: activeTask !== undefined,
        taskId: activeTask?.id ?? null,
      });
    }
  }
  return {
    cells,
    selectedCell,
    stores:
      props.logistics.kind === "available"
        ? props.logistics.carrierStores
        : null,
    stations: props.stations,
    workers,
    appliances: props.appliances ?? null,
    cobotTransfers: props.cobotTransfers ?? null,
  };
}
/** An assigned worker stands at its station or walks between stations along the aisle. */
function parseWorkerRoute(position: string): Readonly<{
  from: string | null;
  to: string | null;
}> {
  if (position === "Fixed") return { from: null, to: null };
  const cleaned = position.replace(/^Moving:\s*/i, "").trim();
  const route = cleaned.split(" → ").map((part) => part.trim());
  if (route.length >= 3) {
    return { from: route[0] ?? null, to: route[1] ?? null };
  }
  if (route.length === 2) {
    return { from: route[0] ?? null, to: route[1] ?? null };
  }
  return { from: cleaned, to: null };
}
