import type React from "react";
import type {
  CompiledScenario,
  LogisticsView,
} from "@seams/production-simulation";
import {
  carrierNoun,
  financierStation,
  placeLabel,
  taskLabel,
} from "./factory-places";
import { explainWait, storeHolders, type WaitLink } from "./wait-explanation";
import {
  computeFacilityUtilityTelemetry,
  summarizeAisleWalkCongestionTelemetry,
  summarizeContinuousWaveCarrierReturnTelemetry,
  summarizeMorningShiftFaultCascade,
  summarizeMorningShiftMassAccounting,
  summarizeShiftBreakAndHandoffTelemetry,
  type ApplianceFaultRecord,
  type MorningShiftApplianceCode,
  type MorningShiftFaultCascadeSummary,
  type SynchronizedApplianceState,
  type SynchronizedCobotTransferState,
} from "./morning-shift-appliances";
import type { Variant } from "@seams/type-utils";

type Logistics = Variant<LogisticsView, "available">;

function linkItem(
  select: (task: string) => void,
  link: WaitLink,
  index: number,
): React.ReactNode {
  return (
    <li key={index} data-wait-role={link.role}>
      {link.task === null ? (
        link.text
      ) : (
        <button onClick={select.bind(null, link.task)}>{link.text}</button>
      )}
    </li>
  );
}

/** What the task lacks, who holds it, and the constraint behind them. */
export function WaitExplanationView(
  props: Readonly<{
    scenario: CompiledScenario;
    view: Logistics;
    task: string;
    select(task: string): void;
  }>,
): React.ReactNode {
  const links = explainWait(props.scenario, props.view, props.task);
  const first = links[0];
  if (first === undefined) return null;
  let holder: string | null = null;
  for (const link of links.slice(1))
    if (link.task !== null) {
      holder = link.task;
      break;
    }
  let constraint: string | null = null;
  for (const link of links) if (link.place !== null) constraint = link.place;
  return (
    <section aria-label="Why this waits">
      <h4>Why this waits</h4>
      <dl className="wait-summary">
        <dt>Missing</dt>
        <dd data-wait-missing={first.place ?? ""}>
          {first.place === null ? first.text : placeLabel(first.place)}
        </dd>
        <dt>Its current task</dt>
        <dd>{holder === null ? "None" : taskLabel(holder)}</dd>
        <dt>Downstream constraint</dt>
        <dd data-wait-constraint={constraint ?? ""}>
          {constraint === null ? "None" : placeLabel(constraint)}
        </dd>
      </dl>
      <ol className="wait-chain">
        {links.map(linkItem.bind(null, props.select))}
      </ol>
    </section>
  );
}

function waitingButton(
  select: (task: string) => void,
  task: string,
): React.ReactNode {
  return (
    <li key={task}>
      <button onClick={select.bind(null, task)}>{taskLabel(task)}</button>
    </li>
  );
}

function storeLine(
  props: Readonly<{ scenario: CompiledScenario; view: Logistics }>,
  store: Logistics["carrierStores"][number],
): React.ReactNode {
  const holders = storeHolders(props.scenario, props.view, store.id);
  return (
    <li key={store.id} data-station-store={store.id}>
      {placeLabel(store.id)}: {store.occupants.length} of {store.capacity}{" "}
      {carrierNoun(store.id, store.capacity)}
      {holders.length > 0 ? ` (${holders.join("; ")})` : ""}.
    </li>
  );
}

function stationApplianceRow(
  props: Readonly<{
    select(task: string): void;
    injectFault?(appliance: MorningShiftApplianceCode): void;
    restoreCheckpoint?(appliance: MorningShiftApplianceCode): void;
    proposeChatRecovery?(appliance: MorningShiftApplianceCode): void;
  }>,
  state: SynchronizedApplianceState,
): React.ReactNode {
  const inspectTask = state.activeTaskId ?? state.lastTaskId;
  return (
    <tr
      key={state.appliance}
      data-station-appliance={state.appliance}
      data-appliance-status={state.status}
      data-appliance-power-watts={state.powerWatts}
      data-appliance-pressure-bar={state.pressureBar}
      data-appliance-torque-nm={state.torqueNm}
      data-appliance-viscosity-pas={state.viscosityPas}
      data-appliance-noise-dba={state.acousticNoiseDba}
      data-appliance-vibration-mms={state.vibrationMmPerSecRms}
      data-appliance-peak-noise-dba={state.peakAcousticNoiseDba}
      data-appliance-peak-vibration-mms={state.peakVibrationMmPerSecRms}
      data-appliance-door-open={state.doorOpenRatio}
    >
      <td>
        {inspectTask === null ? (
          state.displayName
        ) : (
          <button onClick={props.select.bind(null, inspectTask)}>
            {state.displayName}
          </button>
        )}
      </td>
      <td>{state.status}</td>
      <td>{state.programSummary}</td>
      <td>
        {state.temperatureC.toFixed(1)} °C · {state.powerWatts} W
      </td>
      <td
        data-cell-noise-dba={state.acousticNoiseDba}
        data-cell-vibration-mms={state.vibrationMmPerSecRms}
      >
        {state.acousticNoiseDba.toFixed(1)} dBA ·{" "}
        {state.vibrationMmPerSecRms.toFixed(2)} mm/s RMS
        {state.isRotary && state.peakAcousticNoiseDba > state.acousticNoiseDba ? (
          <>
            {" "}
            <small>
              (peak {state.peakAcousticNoiseDba.toFixed(1)} dBA ·{" "}
              {state.peakVibrationMmPerSecRms.toFixed(2)} mm/s)
            </small>
          </>
        ) : null}
      </td>
      <td>
        {state.completedCount}/{state.totalCount}
      </td>
      <td>
        {state.status === "fault" && state.fault !== null ? (
          <div>
            <small data-checkpoint-digest={state.fault.checkpointDigest}>
              {state.fault.code} · {state.fault.checkpointDigest.slice(0, 8)}
            </small>{" "}
            {props.proposeChatRecovery !== undefined && (
              <button
                type="button"
                data-appliance-fault-action="propose-chat"
                data-fault-appliance={state.appliance}
                onClick={props.proposeChatRecovery.bind(null, state.appliance)}
              >
                Propose chat recovery
              </button>
            )}{" "}
            {props.restoreCheckpoint !== undefined && (
              <button
                type="button"
                data-appliance-fault-action="restore"
                data-fault-appliance={state.appliance}
                onClick={props.restoreCheckpoint.bind(null, state.appliance)}
              >
                Restore from checkpoint
              </button>
            )}
          </div>
        ) : (
          <div>
            {state.fault?.restored && (
              <small
                data-checkpoint-restored={state.fault.checkpointDigest}
              >
                Restored {state.fault.checkpointDigest.slice(0, 8)}{" "}
              </small>
            )}
            {props.injectFault !== undefined && (
              <button
                type="button"
                data-appliance-fault-action="inject"
                data-fault-appliance={state.appliance}
                onClick={props.injectFault.bind(null, state.appliance)}
              >
                Simulate mid-cycle fault
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

const PRIMARY_ROTARY_APPLIANCES: readonly MorningShiftApplianceCode[] = [
  "hobart-hl200",
  "waring-wsg60",
  "vitamix-quiet-one",
  "la-marzocco-linea-classic-s-2g",
  "severin-sm-3587",
];

function rotaryAcousticsSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const rotaryItems = appliances.filter((a) =>
    PRIMARY_ROTARY_APPLIANCES.includes(a.appliance),
  );
  if (rotaryItems.length === 0) return null;
  const utilities = computeFacilityUtilityTelemetry(appliances);
  const av = utilities.acousticsAndVibration;
  return (
    <section
      aria-label="Rotary acoustic and vibration telemetry"
      data-rotary-acoustics-status={av.isoVibrationClass}
      data-room-composite-dba={av.roomCompositeNoiseDba}
      data-peak-rotary-vibration-mms={av.peakVibrationMmPerSecRms}
    >
      <h4>Rotary acoustic & vibration telemetry</h4>
      <p>
        Room composite L<sub>eq</sub>: {av.roomCompositeNoiseDba} dBA · Peak
        rotary: {av.peakApplianceNoiseDba} dBA / {av.peakVibrationMmPerSecRms}{" "}
        mm/s RMS ({av.isoVibrationClass}).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Rotary appliance</th>
            <th>RPM</th>
            <th>Live dBA / Vib</th>
            <th>Cycle peak</th>
            <th>ISO 10816</th>
          </tr>
        </thead>
        <tbody>
          {rotaryItems.map((item) => {
            const inspectTask = item.activeTaskId ?? item.lastTaskId;
            const isoClass =
              item.peakVibrationMmPerSecRms >= 4.5
                ? "Class III (Alert)"
                : item.peakVibrationMmPerSecRms >= 2.3
                  ? "Class II (Satisfactory)"
                  : "Class I (Good)";
            return (
              <tr
                key={item.appliance}
                data-rotary-appliance={item.appliance}
                data-rotary-rpm={item.rpm}
                data-rotary-live-dba={item.acousticNoiseDba}
                data-rotary-live-vib-mms={item.vibrationMmPerSecRms}
                data-rotary-peak-dba={item.peakAcousticNoiseDba}
                data-rotary-peak-vib-mms={item.peakVibrationMmPerSecRms}
              >
                <td>
                  {inspectTask === null ? (
                    item.displayName
                  ) : (
                    <button onClick={select.bind(null, inspectTask)}>
                      {item.displayName}
                    </button>
                  )}
                </td>
                <td>{item.rpm} RPM</td>
                <td>
                  {item.acousticNoiseDba.toFixed(1)} dBA ·{" "}
                  {item.vibrationMmPerSecRms.toFixed(2)} mm/s
                </td>
                <td>
                  {item.peakAcousticNoiseDba.toFixed(1)} dBA ·{" "}
                  {item.peakVibrationMmPerSecRms.toFixed(2)} mm/s RMS
                </td>
                <td>{isoClass}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function batchMassAccountingSection(
  view: Logistics,
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const mass = summarizeMorningShiftMassAccounting(view);
  return (
    <section
      aria-label="Batch rework and scrap mass accounting"
      data-mass-accepted-g={mass.totalAcceptedGrams}
      data-mass-rejected-scrap-g={mass.totalRejectedScrapGrams}
      data-mass-qc-sample-g={mass.totalQcSampleGrams}
      data-mass-byproduct-loss-g={mass.totalByproductOrLossGrams}
      data-mass-first-pass-yield-pct={mass.firstPassYieldPercent}
      data-mass-rework-loops={mass.reworkLoopCount}
    >
      <h4>Batch rework & scrap mass accounting</h4>
      <p>
        Accepted yield: {mass.totalAcceptedGrams} g ({mass.acceptedLots} lots) ·
        Rejected scrap: {mass.totalRejectedScrapGrams} g ({mass.rejectedLots}{" "}
        rework loops) · QC sample: {mass.totalQcSampleGrams} g · Byproduct/loss:{" "}
        {mass.totalByproductOrLossGrams} g · First-pass yield:{" "}
        {mass.firstPassYieldPercent}%.
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Batch</th>
            <th>Gate & metric</th>
            <th>Outcome</th>
            <th>Accepted (g)</th>
            <th>Rejected scrap (g)</th>
            <th>Loss / sample (g)</th>
            <th>Rework / disposition</th>
          </tr>
        </thead>
        <tbody>
          {mass.lots.map((lot) => (
            <tr
              key={lot.batchId}
              data-mass-lot={lot.batchId}
              data-mass-lot-gate={lot.gateKind}
              data-mass-lot-outcome={lot.outcome}
              data-mass-lot-accepted-g={lot.acceptedYieldGrams}
              data-mass-lot-rejected-g={lot.rejectedScrapGrams}
            >
              <td>
                <button onClick={select.bind(null, lot.gateTaskId)}>
                  {lot.batchId}
                </button>
              </td>
              <td>
                {lot.gateKind} · {lot.measuredMetric}
              </td>
              <td>{lot.outcome}</td>
              <td>{lot.acceptedYieldGrams.toFixed(1)} g</td>
              <td>{lot.rejectedScrapGrams.toFixed(1)} g</td>
              <td>
                {(lot.byproductOrLossGrams + lot.qcSampleGrams).toFixed(1)} g
              </td>
              <td>{lot.reworkAction}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function chillerColdCellSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const utilities = computeFacilityUtilityTelemetry(appliances);
  const cc = utilities.chillerColdCell;
  return (
    <section
      aria-label="Hoshizaki cold-cell defrost and door infiltration telemetry"
      data-chiller-phase={cc.phase}
      data-chiller-cabinet-c={cc.cabinetAirC}
      data-chiller-peak-spike-c={cc.cabinetInfiltrationPeakC}
      data-chiller-coil-c={cc.evaporatorCoilC}
      data-chiller-frost-g={cc.evaporatorFrostGrams}
      data-chiller-defrost-cycles={cc.defrostCycleCount}
      data-chiller-condensate-ml={cc.totalCondensateDrainedMl}
      data-chiller-infiltration-kj={cc.totalInfiltrationHeatKj}
      data-chiller-door-openings={cc.doorOpeningsCount}
    >
      <h4>Hoshizaki RT-120SNJ cold-cell defrost & door infiltration</h4>
      <p>
        Phase: {cc.phase} · Cabinet air: {cc.cabinetAirC.toFixed(1)} °C (door
        spike peak {cc.cabinetInfiltrationPeakC.toFixed(1)} °C) · Evaporator
        coil: {cc.evaporatorCoilC.toFixed(1)} °C · Frost:{" "}
        {cc.evaporatorFrostGrams.toFixed(2)} g (peak{" "}
        {cc.peakFrostGrams.toFixed(2)} g) · Defrost cycles:{" "}
        {cc.defrostCycleCount} ({cc.totalCondensateDrainedMl.toFixed(2)} mL
        condensate) · Door infiltration: {cc.totalInfiltrationHeatKj.toFixed(2)}{" "}
        kJ across {cc.doorOpeningsCount} openings · Compressor:{" "}
        {cc.compressorRpm} RPM ({cc.compressorDutyPercent}% duty · COP{" "}
        {cc.copEfficiency}).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Cold-cell task</th>
            <th>Phase</th>
            <th>Door open</th>
            <th>Infiltration spike</th>
            <th>Cabinet peak → exit</th>
            <th>Coil & frost</th>
            <th>Defrost condensate</th>
          </tr>
        </thead>
        <tbody>
          {cc.events.map((ev) => (
            <tr
              key={ev.taskId}
              data-chiller-event={ev.taskId}
              data-chiller-event-phase={ev.phase}
              data-chiller-event-infiltration-kj={ev.infiltrationHeatKj}
              data-chiller-event-peak-c={ev.cabinetPeakC}
              data-chiller-event-defrost={ev.defrostTriggered}
              data-chiller-event-condensate-ml={ev.condensateDrainedMl}
            >
              <td>
                <button onClick={propsSelect(select, ev.taskId)}>
                  {ev.batchLabel}
                </button>
              </td>
              <td>{ev.phase}</td>
              <td>{ev.doorOpenSeconds.toFixed(1)} s</td>
              <td>
                {ev.infiltrationHeatKj.toFixed(2)} kJ ·{" "}
                {ev.moistureIngressGrams.toFixed(2)} g H<sub>2</sub>O
              </td>
              <td>
                {ev.cabinetPeakC.toFixed(1)} °C → {ev.cabinetExitC.toFixed(1)}{" "}
                °C
              </td>
              <td>
                {ev.evaporatorCoilC.toFixed(1)} °C ·{" "}
                {ev.frostAccumulatedGrams.toFixed(2)} g
              </td>
              <td>
                {ev.defrostTriggered
                  ? `Defrost (${ev.condensateDrainedMl.toFixed(2)} mL)`
                  : "Hold"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function propsSelect(
  select: (task: string) => void,
  taskId: string,
): () => void {
  return select.bind(null, taskId);
}

function dishwasherWarewashSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const utilities = computeFacilityUtilityTelemetry(appliances);
  const dw = utilities.dishwasherWarewash;
  return (
    <section
      aria-label="Winterhalter dishwasher dosing and greywater heat recovery telemetry"
      data-dishwasher-status={dw.status}
      data-dishwasher-sanitizer-ppm={dw.sanitizerPpm}
      data-dishwasher-detergent-ml={dw.totalDetergentDosedMl}
      data-dishwasher-rinse-aid-ml={dw.totalRinseAidDosedMl}
      data-dishwasher-ph={dw.washBathPh}
      data-dishwasher-hue={dw.thermalHue}
      data-dishwasher-heat-recovered-kj={dw.totalGreywaterRecoveredKj}
      data-dishwasher-recovery-efficiency-pct={dw.heatRecoveryEfficiencyPercent}
    >
      <h4>Winterhalter UC-L chemical dosing, sanitizer & greywater heat recovery</h4>
      <p>
        Wash tank: {dw.washTankC.toFixed(1)} °C · Final rinse boiler:{" "}
        {dw.rinseBoilerC.toFixed(1)} °C ({dw.thermalHue} HUE) · Sanitizer:{" "}
        {dw.sanitizerPpm.toFixed(1)} ppm (pH {dw.washBathPh.toFixed(2)}) ·
        Dosing: {dw.totalDetergentDosedMl.toFixed(2)} mL detergent /{" "}
        {dw.totalRinseAidDosedMl.toFixed(2)} mL rinse aid · Greywater heat
        recovery: {dw.incomingMakeupWaterC.toFixed(1)} °C →{" "}
        {dw.preheatedWaterC.toFixed(1)} °C makeup ({dw.greywaterDrainC.toFixed(1)}{" "}
        °C drain · {dw.totalGreywaterRecoveredKj.toFixed(1)} kJ /{" "}
        {dw.totalRecoveredWh.toFixed(1)} Wh ·{" "}
        {dw.heatRecoveryEfficiencyPercent.toFixed(1)}% eff).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Warewash cycle</th>
            <th>Soil load</th>
            <th>Wash / Rinse</th>
            <th>Dosing (det / aid)</th>
            <th>Sanitizer & pH</th>
            <th>Makeup preheat</th>
            <th>Recovered heat</th>
          </tr>
        </thead>
        <tbody>
          {dw.cycles.map((c) => (
            <tr
              key={c.taskId}
              data-dishwasher-cycle={c.taskId}
              data-dishwasher-soil={c.soilLoadCategory}
              data-dishwasher-cycle-ppm={c.sanitizerPpm}
              data-dishwasher-cycle-recovered-kj={c.heatRecoveredKj}
            >
              <td>
                <button onClick={propsSelect(select, c.taskId)}>
                  {c.vesselLabel}
                </button>
              </td>
              <td>{c.soilLoadCategory}</td>
              <td>
                {c.washTankC.toFixed(1)} °C / {c.rinseBoilerC.toFixed(1)} °C (
                {c.thermalHue} HUE)
              </td>
              <td>
                {c.detergentDosedMl.toFixed(2)} mL /{" "}
                {c.rinseAidDosedMl.toFixed(2)} mL
              </td>
              <td>
                {c.sanitizerPpm.toFixed(1)} ppm · pH {c.washBathPh.toFixed(2)}
              </td>
              <td>
                {c.incomingWaterC.toFixed(1)} °C →{" "}
                {c.preheatedWaterC.toFixed(1)} °C (drain{" "}
                {c.greywaterDrainC.toFixed(1)} °C)
              </td>
              <td>
                {c.heatRecoveredKj.toFixed(1)} kJ (
                {c.recoveryEfficiencyPercent.toFixed(1)}%)
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function espressoBoilerSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const u = computeFacilityUtilityTelemetry(appliances);
  const eb = u.espressoBoiler;
  return (
    <section
      aria-label="La Marzocco espresso boiler and grouphead thermal stability telemetry"
      data-espresso-status={eb.status}
      data-espresso-min-grouphead-c={eb.minGroupheadTempC}
      data-espresso-thermal-dip-c={eb.maxGroupheadThermalDipC}
      data-espresso-steam-pressure-bar={eb.steamBoilerPressureBar}
      data-espresso-steam-drop-bar={eb.maxSteamDropBar}
    >
      <h4>
        La Marzocco Linea Classic S · Dual-boiler PID & grouphead stability
      </h4>
      <p>
        Status: <strong>{eb.status}</strong> · Brew boiler:{" "}
        {eb.brewBoilerTempC.toFixed(2)} °C (setpoint{" "}
        {eb.brewBoilerSetpointC.toFixed(1)} °C · min grouphead{" "}
        {eb.minGroupheadTempC.toFixed(2)} °C · max thermal dip −
        {eb.maxGroupheadThermalDipC.toFixed(2)} °C · PID recovery{" "}
        {eb.meanPidRecoverySeconds.toFixed(1)} s) · Steam boiler:{" "}
        {eb.steamBoilerPressureBar.toFixed(2)} bar ({eb.steamBoilerSetpointC} °C
        · max steam drop −{eb.maxSteamDropBar.toFixed(2)} bar · recovery{" "}
        {eb.meanSteamRecoverySeconds.toFixed(1)} s).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Order</th>
            <th>Grouphead</th>
            <th>Brew boiler</th>
            <th>Grouphead entry / min</th>
            <th>PID recovery</th>
            <th>Steam boiler & drop</th>
          </tr>
        </thead>
        <tbody>
          {eb.shots.map((s) => (
            <tr
              key={s.taskId}
              data-espresso-shot={s.taskId}
              data-espresso-grouphead={s.grouphead}
              data-espresso-grouphead-min-c={s.groupheadMinC}
              data-espresso-shot-dip-c={s.thermalDipC}
              data-espresso-shot-steam-bar={s.steamBoilerPressureBar}
            >
              <td>
                <button onClick={propsSelect(select, s.taskId)}>
                  {s.orderLabel}
                </button>
              </td>
              <td>{s.grouphead}</td>
              <td>{s.brewBoilerC.toFixed(2)} °C</td>
              <td>
                {s.groupheadEntryC.toFixed(2)} °C → {s.groupheadMinC.toFixed(2)}{" "}
                °C (−{s.thermalDipC.toFixed(2)} °C)
              </td>
              <td>
                {s.pidRecoverySeconds.toFixed(1)} s ({s.pidDutyPercent}%)
              </td>
              <td>
                {s.steamBoilerPressureBar.toFixed(2)} bar (−
                {s.steamDropBar.toFixed(2)} bar ·{" "}
                {s.steamRecoverySeconds.toFixed(1)} s)
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ovenVentingRadiantSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const u = computeFacilityUtilityTelemetry(appliances);
  const ov = u.ovenVentingRadiant;
  return (
    <section
      aria-label="Maruzen convection oven venting and deck radiant heat flux telemetry"
      data-oven-venting-status={ov.status}
      data-oven-nominal-flux-kw-m2={ov.nominalDeckFluxKwPerSqM}
      data-oven-hotspot-flux-kw-m2={ov.hotspotDeckFluxKwPerSqM}
      data-oven-peak-venting-gps={ov.peakSteamVentingGps}
      data-oven-min-aw={ov.minSurfaceWaterActivityAw}
    >
      <h4>
        Maruzen MBCO-5E · Steam-damper venting, deck radiant flux & crust
        diffusivity
      </h4>
      <p>
        Status: <strong>{ov.status}</strong> · Nominal deck flux:{" "}
        {ov.nominalDeckFluxKwPerSqM.toFixed(2)} kW/m² · Middle-rear hotspot
        flux: {ov.hotspotDeckFluxKwPerSqM.toFixed(2)} kW/m² · Steam injected:{" "}
        {ov.totalSteamInjectedMl.toFixed(1)} mL · Peak damper exhaust:{" "}
        {ov.peakSteamVentingGps.toFixed(2)} g/s · Peak crust diffusivity:{" "}
        {ov.peakMoistureDiffusivitySqMPerSec.toExponential(2)} m²/s (min a_w{" "}
        {ov.minSurfaceWaterActivityAw.toFixed(3)}).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Batch</th>
            <th>Deck zone</th>
            <th>Chamber & damper</th>
            <th>Steam pulse / vent</th>
            <th>Radiant / convective / total flux</th>
            <th>Crust diffusivity & a_w</th>
          </tr>
        </thead>
        <tbody>
          {ov.decks.map((d) => (
            <tr
              key={d.taskId}
              data-oven-deck={d.taskId}
              data-oven-deck-zone={d.deckZone}
              data-oven-deck-flux-kw-m2={d.totalFluxKwPerSqM}
              data-oven-deck-vent-gps={d.steamVentingGps}
              data-oven-deck-aw={d.surfaceWaterActivityAw}
            >
              <td>
                <button onClick={propsSelect(select, d.taskId)}>
                  {d.batchLabel}
                </button>
              </td>
              <td>{d.deckZone}</td>
              <td>
                {d.chamberC.toFixed(1)} °C · {d.chamberRhPercent.toFixed(1)}% RH
                · damper {Math.round(d.damperOpenRatio * 100)}%
              </td>
              <td>
                {d.steamInjectionMl.toFixed(1)} mL /{" "}
                {d.steamVentingGps.toFixed(2)} g/s
              </td>
              <td>
                {d.radiantFluxKwPerSqM.toFixed(2)} +{" "}
                {d.convectiveFluxKwPerSqM.toFixed(2)} ={" "}
                {d.totalFluxKwPerSqM.toFixed(2)} kW/m²
              </td>
              <td>
                {d.moistureDiffusivitySqMPerSec.toExponential(2)} m²/s · a_w{" "}
                {d.surfaceWaterActivityAw.toFixed(3)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function hobCoilThermalSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const u = computeFacilityUtilityTelemetry(appliances);
  const hb = u.hobCoilThermal;
  return (
    <section
      aria-label="Induction hob coil coupling and pan thermal gradient telemetry"
      data-hob-status={hb.status}
      data-hob-coupling-pct={hb.meanCouplingEfficiencyPercent}
      data-hob-max-gradient-c={hb.maxRadialGradientC}
      data-hob-peak-boil-off-gps={hb.peakBoilOffGps}
    >
      <h4>
        Maruzen MIH-02C & Vollrath 59500P · Coil coupling, pan radial ΔT &
        boil-off vapor
      </h4>
      <p>
        Status: <strong>{hb.status}</strong> · Mean IGBT coil coupling:{" "}
        {hb.meanCouplingEfficiencyPercent.toFixed(1)}% · Peak pan center:{" "}
        {hb.peakPanCenterC.toFixed(1)} °C (max center-to-rim ΔT{" "}
        {hb.maxRadialGradientC.toFixed(1)} °C) · Peak boil-off vapor:{" "}
        {hb.peakBoilOffGps.toFixed(2)} g/s ({hb.totalEvaporatedGrams.toFixed(1)}{" "}
        g total evaporated).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Pan / Kettle</th>
            <th>Hob & coil freq</th>
            <th>Coupling</th>
            <th>Pan center → rim (ΔT)</th>
            <th>Boil-off vapor & loss</th>
          </tr>
        </thead>
        <tbody>
          {hb.cycles.map((c) => (
            <tr
              key={c.taskId}
              data-hob-cycle={c.taskId}
              data-hob-appliance={c.appliance}
              data-hob-coupling-efficiency={c.couplingEfficiencyPercent}
              data-hob-radial-gradient-c={c.radialGradientC}
              data-hob-boil-off-gps={c.boilOffGps}
            >
              <td>
                <button onClick={propsSelect(select, c.taskId)}>
                  {c.vesselLabel}
                </button>
              </td>
              <td>
                {c.appliance} ({c.coilFrequencyKhz.toFixed(1)} kHz)
              </td>
              <td>{c.couplingEfficiencyPercent.toFixed(1)}%</td>
              <td>
                {c.panCenterC.toFixed(1)} °C → {c.panRimC.toFixed(1)} °C (Δ
                {c.radialGradientC.toFixed(1)} °C)
              </td>
              <td>
                {c.boilOffGps.toFixed(2)} g/s ({c.evaporatedGrams.toFixed(1)} g)
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function precisionScaleSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const u = computeFacilityUtilityTelemetry(appliances);
  const sc = u.precisionScale;
  return (
    <section
      aria-label="Ohaus Ranger 3000 load-cell settling and air-draft telemetry"
      data-scale-status={sc.status}
      data-scale-mean-settling-s={sc.meanSettlingTimeSeconds}
      data-scale-max-tare-drift-mg={sc.maxZeroTareDriftMg}
      data-scale-mean-rejection-db={sc.meanFilterRejectionDb}
    >
      <h4>
        Ohaus Ranger 3000 · Load-cell settling, zero-tare drift & air-draft
        rejection
      </h4>
      <p>
        Status: <strong>{sc.status}</strong> · Mean settling time:{" "}
        {sc.meanSettlingTimeSeconds.toFixed(2)} s (max{" "}
        {sc.maxSettlingTimeSeconds.toFixed(2)} s) · Max zero-tare drift: +
        {sc.maxZeroTareDriftMg.toFixed(1)} mg · Peak hood air-draft disturbance:{" "}
        {sc.peakAirDraftDisturbanceMg.toFixed(1)} mg · Digital filter rejection:{" "}
        {sc.meanFilterRejectionDb.toFixed(1)} dB ({sc.totalWeighings}{" "}
        weighings).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Ingredient</th>
            <th>Target / settled</th>
            <th>Settling time</th>
            <th>Zero-tare drift</th>
            <th>Air-draft peak & filter</th>
            <th>Stability</th>
          </tr>
        </thead>
        <tbody>
          {sc.weighings.map((w) => (
            <tr
              key={w.taskId}
              data-scale-weigh={w.taskId}
              data-scale-settling-s={w.settlingTimeSeconds}
              data-scale-tare-drift-mg={w.zeroTareDriftMg}
              data-scale-draft-rejection-db={w.filterRejectionDb}
              data-scale-stability={w.stabilityStatus}
            >
              <td>
                <button onClick={propsSelect(select, w.taskId)}>
                  {w.ingredientLabel}
                </button>
              </td>
              <td>
                {w.targetGrams.toFixed(1)} g → {w.settledGrams.toFixed(2)} g
              </td>
              <td>{w.settlingTimeSeconds.toFixed(2)} s</td>
              <td>+{w.zeroTareDriftMg.toFixed(1)} mg</td>
              <td>
                {w.airDraftPeakMg.toFixed(1)} mg ({w.filterRejectionDb.toFixed(1)}{" "}
                dB)
              </td>
              <td>{w.stabilityStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function planetaryMixerSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const u = computeFacilityUtilityTelemetry(appliances);
  const mx = u.planetaryMixer;
  return (
    <section
      aria-label="Hobart HL200 planetary mixer rheology and torque ripple telemetry"
      data-mixer-status={mx.status}
      data-mixer-work-wh-kg={mx.totalSpecificWorkWhPerKg}
      data-mixer-torque-ripple-nm={mx.maxTorqueRippleNmPeakToPeak}
      data-mixer-emulsion-index={mx.meanEmulsionIndex}
    >
      <h4>
        Hobart HL200 · Viscoelastic work input, B-beater torque ripple & bowl
        heat transfer
      </h4>
      <p>
        Status: <strong>{mx.status}</strong> · Specific work input:{" "}
        {mx.totalSpecificWorkWhPerKg.toFixed(2)} Wh/kg · Peak shaft torque:{" "}
        {mx.peakShaftTorqueNm.toFixed(2)} N·m (max p-p ripple{" "}
        {mx.maxTorqueRippleNmPeakToPeak.toFixed(2)} N·m) · Peak viscous shear
        heating: {mx.peakViscousHeatingWatts.toFixed(1)} W · Mean emulsion
        index: {mx.meanEmulsionIndex.toFixed(2)}.
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Batch stage</th>
            <th>Agitator speed</th>
            <th>Specific work</th>
            <th>Shaft torque & p-p ripple</th>
            <th>Viscous / bowl wall heat</th>
            <th>Emulsion index</th>
          </tr>
        </thead>
        <tbody>
          {mx.cycles.map((c) => (
            <tr
              key={c.taskId}
              data-mixer-cycle={c.taskId}
              data-mixer-stage={c.mixStage}
              data-mixer-cycle-work-wh-kg={c.specificWorkWhPerKg}
              data-mixer-cycle-ripple-nm={c.torqueRippleNmPeakToPeak}
              data-mixer-cycle-emulsion={c.emulsionIndex}
            >
              <td>
                <button onClick={propsSelect(select, c.taskId)}>
                  {c.batchLabel}
                </button>
              </td>
              <td>
                {c.mixStage} ({c.agitatorRpm} RPM)
              </td>
              <td>{c.specificWorkWhPerKg.toFixed(2)} Wh/kg</td>
              <td>
                {c.meanShaftTorqueNm.toFixed(2)} N·m (±
                {c.torqueRippleNmPeakToPeak.toFixed(2)} N·m p-p)
              </td>
              <td>
                {c.viscousHeatingWatts.toFixed(1)} W /{" "}
                {c.bowlWallHeatWatts >= 0 ? "+" : ""}
                {c.bowlWallHeatWatts.toFixed(1)} W
              </td>
              <td>{c.emulsionIndex.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function milkFrotherSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const u = computeFacilityUtilityTelemetry(appliances);
  const mf = u.milkFrother;
  return (
    <section
      aria-label="Severin SM 3587 microfoam overrun and whey protein telemetry"
      data-frother-status={mf.status}
      data-frother-overrun-pct={mf.meanMicrofoamOverrunPercent}
      data-frother-shear-inv-s={mf.peakVortexShearRateInverseSec}
      data-frother-whey-pct={mf.meanWheyDenaturationPercent}
    >
      <h4>
        Severin SM 3587 · Induction microfoam overrun, vortex shear & whey
        denaturation
      </h4>
      <p>
        Status: <strong>{mf.status}</strong> · Mean microfoam overrun:{" "}
        {mf.meanMicrofoamOverrunPercent.toFixed(1)}% (d₃₂{" "}
        {mf.meanBubbleDiameterMicrons.toFixed(1)} µm) · Peak vortex shear rate:{" "}
        {mf.peakVortexShearRateInverseSec} s⁻¹ · Mean β-lactoglobulin
        unfolding: {mf.meanWheyDenaturationPercent.toFixed(1)}% (max pitcher{" "}
        {mf.maxPitcherExitTempC.toFixed(1)} °C).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Drink order</th>
            <th>Whisk & vortex shear</th>
            <th>Microfoam overrun & d₃₂</th>
            <th>Pitcher exit & β-LG unfolding</th>
            <th>Window</th>
          </tr>
        </thead>
        <tbody>
          {mf.cycles.map((c) => (
            <tr
              key={c.taskId}
              data-frother-cycle={c.taskId}
              data-frother-overrun-pct={c.microfoamOverrunPercent}
              data-frother-shear-inv-s={c.vortexShearRateInverseSec}
              data-frother-whey-pct={c.wheyDenaturationPercent}
              data-frother-window={c.windowStatus}
            >
              <td>
                <button onClick={propsSelect(select, c.taskId)}>
                  {c.drinkLabel}
                </button>
              </td>
              <td>
                {c.whiskRpm} RPM ({c.vortexShearRateInverseSec} s⁻¹)
              </td>
              <td>
                {c.microfoamOverrunPercent.toFixed(1)}% (
                {c.bubbleDiameterMicrons.toFixed(1)} µm)
              </td>
              <td>
                {c.pitcherExitC.toFixed(1)} °C (
                {c.wheyDenaturationPercent.toFixed(1)}% β-LG)
              </td>
              <td>{c.windowStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function continuousWavesCarrierReturnSection(
  view: Logistics,
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const cw = summarizeContinuousWaveCarrierReturnTelemetry(appliances, view);
  return (
    <section
      aria-label="Continuous production waves and carrier return telemetry"
      data-wave-status={cw.status}
      data-wave-active={cw.activeWaveIndex}
      data-wave-total={cw.waveCount}
      data-carrier-turnarounds={cw.totalCarrierReturns}
      data-carrier-wash-cycles={cw.totalWashCycles}
      data-carrier-reuse-ratio={cw.overallReuseRatio}
    >
      <h4>Continuous production waves & closed-loop carrier return</h4>
      <p>
        Wave {cw.activeWaveIndex} of {cw.waveCount} ({cw.waveCadenceMinutes} min
        cadence) · {cw.totalCarrierAcquisitions} acquisitions ·{" "}
        {cw.totalWashCycles} UC-L sanitization cycles ·{" "}
        {cw.totalCarrierReturns} closed-loop returns ({cw.overallReuseRatio}×
        reuse · {cw.meanTurnaroundSeconds} s mean turnaround).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Carrier pool</th>
            <th>Carriers (clean / busy / wash)</th>
            <th>Acquisitions & returns</th>
            <th>Reuse ratio</th>
            <th>Mean turnaround</th>
          </tr>
        </thead>
        <tbody>
          {cw.pools.map((p) => (
            <tr
              key={p.poolId}
              data-carrier-pool={p.poolId}
              data-carrier-count={p.carrierCount}
              data-carrier-acquisitions={p.acquisitions}
              data-carrier-wash-cycles={p.washCycles}
              data-carrier-returns={p.returns}
              data-carrier-reuse-ratio={p.reuseRatio}
              data-carrier-turnaround-s={p.meanTurnaroundSeconds}
            >
              <td>{p.label}</td>
              <td>
                {p.carrierCount} total ({p.cleanAvailableCount} clean /{" "}
                {p.inUseCount} active / {p.washingCount} wash)
              </td>
              <td>
                {p.acquisitions} acquired → {p.washCycles} washed → {p.returns}{" "}
                returned
              </td>
              <td>{p.reuseRatio.toFixed(2)}×</td>
              <td>{p.meanTurnaroundSeconds.toFixed(1)} s</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function shiftBreakAndHandoffSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
  select: (task: string) => void,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const bh = summarizeShiftBreakAndHandoffTelemetry(appliances);
  return (
    <section
      aria-label="Shift break relief and station handoff telemetry"
      data-break-status={bh.status}
      data-break-policy={bh.breakPolicy}
      data-break-windows={bh.scheduledBreakWindows}
      data-break-coverage-pct={bh.reliefCoveragePercent}
      data-handoff-count={bh.totalStationHandoffs}
      data-handoff-mean-s={bh.meanHandoffDurationSeconds}
      data-unattended-thermal-violations={bh.unattendedThermalViolations}
    >
      <h4>Shift break relief &amp; cross-station handoff schedule</h4>
      <p>
        Policy: <strong>{bh.breakPolicy}</strong> ({bh.status}) ·{" "}
        {bh.scheduledBreakWindows} staggered 15-min break windows (
        {bh.completedBreakMinutes} min total relief) ·{" "}
        {bh.reliefCoveragePercent.toFixed(1)}% station coverage ·{" "}
        {bh.totalStationHandoffs} custody handoffs (mean{" "}
        {bh.meanHandoffDurationSeconds.toFixed(1)} s) ·{" "}
        {bh.unattendedThermalViolations} unattended thermal violations.
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Station</th>
            <th>Outgoing → incoming operator</th>
            <th>Window &amp; handoff duration</th>
            <th>Active task &amp; custody checklist</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {bh.handoffs.map((h) => (
            <tr
              key={h.handoffId}
              data-shift-handoff={h.handoffId}
              data-handoff-station={h.stationId}
              data-handoff-duration-s={h.handoffDurationSeconds}
              data-handoff-status={h.status}
            >
              <td>{h.stationLabel}</td>
              <td>
                {h.outgoingOperator} → {h.incomingOperator}
              </td>
              <td>
                {Math.round(h.windowStartSeconds / 60)}m (+
                {h.handoffDurationSeconds} s handoff)
              </td>
              <td>
                <button onClick={propsSelect(select, h.activeBatchId)}>
                  {h.activeBatchId}
                </button>{" "}
                · {h.checklistNote}
              </td>
              <td>{h.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function aisleWalkCongestionSection(
  appliances: readonly SynchronizedApplianceState[] | null | undefined,
): React.ReactNode {
  if (!appliances || appliances.length === 0) return null;
  const wc = summarizeAisleWalkCongestionTelemetry(appliances);
  return (
    <section
      aria-label="Operator walk speed and aisle congestion telemetry"
      data-walk-status={wc.status}
      data-walk-preset={wc.walkSpeedPreset}
      data-walk-nominal-mps={wc.nominalWalkSpeedMps}
      data-walk-effective-mps={wc.effectiveWalkSpeedMps}
      data-aisle-width-m={wc.aisleClearWidthMeters}
      data-aisle-transits={wc.totalCrossAisleTransits}
      data-aisle-distance-m={wc.totalDistanceWalkedMeters}
      data-aisle-yield-events={wc.aisleYieldEvents}
      data-aisle-congestion-wait-s={wc.totalCongestionWaitSeconds}
    >
      <h4>Operator walk speed &amp; aisle pass-through congestion</h4>
      <p>
        Preset: <strong>{wc.walkSpeedPreset}</strong> ({wc.status}) · Speed:{" "}
        {wc.effectiveWalkSpeedMps.toFixed(2)} m/s effective (
        {wc.nominalWalkSpeedMps.toFixed(2)} m/s nominal ·{" "}
        {wc.aisleClearWidthMeters.toFixed(2)} m clear aisle) ·{" "}
        {wc.totalCrossAisleTransits} cross-aisle transits (
        {wc.totalDistanceWalkedMeters.toFixed(1)} m walked) ·{" "}
        {wc.aisleYieldEvents} bidirectional yield events (+
        {wc.totalCongestionWaitSeconds.toFixed(1)} s congestion wait ·{" "}
        {wc.transitOverheadPercent.toFixed(1)}% transit overhead).
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Corridor</th>
            <th>Route &amp; operator</th>
            <th>Distance &amp; walk time</th>
            <th>Yield wait &amp; effective speed</th>
            <th>Pass-through observation</th>
          </tr>
        </thead>
        <tbody>
          {wc.transits.map((t) => (
            <tr
              key={t.transitId}
              data-aisle-transit={t.transitId}
              data-transit-distance-m={t.distanceMeters}
              data-transit-walk-s={t.nominalWalkSeconds}
              data-transit-yield-s={t.congestionYieldSeconds}
              data-transit-speed-mps={t.effectiveSpeedMps}
            >
              <td>{t.corridorLabel}</td>
              <td>
                {t.operatorLabel}: {t.fromStation} → {t.toStation}
              </td>
              <td>
                {t.distanceMeters.toFixed(1)} m ·{" "}
                {t.nominalWalkSeconds.toFixed(1)} s
              </td>
              <td>
                +{t.congestionYieldSeconds.toFixed(1)} s ·{" "}
                {t.effectiveSpeedMps.toFixed(2)} m/s
              </td>
              <td>{t.yieldReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function faultCascadeSection(
  cascade: MorningShiftFaultCascadeSummary,
): React.ReactNode {
  if (cascade.status === "nominal") return null;
  const linkedCells =
    cascade.status === "held" ? cascade.heldCells : cascade.recoveredCells;
  return (
    <section
      aria-label="Multi-batch fault-cascade recovery"
      data-cascade-summary={cascade.status}
      data-cascade-status={cascade.status}
      data-cascade-delay-seconds={cascade.totalRecoveryDelaySeconds}
    >
      <h4>Multi-batch fault-cascade recovery</h4>
      <p>
        {cascade.status === "held"
          ? `Cascade hold active (+${cascade.totalRecoveryDelaySeconds} s) across ${linkedCells.join(", ")}.`
          : `Cascade recovered from checkpoint (+${cascade.totalRecoveryDelaySeconds} s) across ${linkedCells.join(", ")}.`}
      </p>
      <table className="oven-workspace-cells">
        <thead>
          <tr>
            <th>Batch</th>
            <th>Workflow</th>
            <th>Linked cell</th>
            <th>Shift</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {cascade.affectedBatches.map((item) => (
            <tr
              key={item.batchId}
              data-cascade-batch={item.batchId}
              data-cascade-batch-cell={item.cellId}
              data-cascade-batch-status={item.status}
            >
              <td>{item.batchId}</td>
              <td>{item.workflowLabel}</td>
              <td>{item.cellId}</td>
              <td>+{item.delaySeconds} s</td>
              <td>{item.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** A selected station or cobot cell: its stores, who holds them, and the work waiting here. */
export function StationDetails(
  props: Readonly<{
    id: string;
    scenario: CompiledScenario;
    view: Logistics;
    appliances?: readonly SynchronizedApplianceState[] | null;
    cobotTransfers?: readonly SynchronizedCobotTransferState[] | null;
    select(task: string): void;
    injectFault?(appliance: MorningShiftApplianceCode): void;
    restoreCheckpoint?(appliance: MorningShiftApplianceCode): void;
    proposeChatRecovery?(appliance: MorningShiftApplianceCode): void;
  }>,
): React.ReactNode {
  const faultRecordMap: Record<string, ApplianceFaultRecord> = {};
  for (const app of props.appliances ?? []) {
    if (app.fault !== null) {
      faultRecordMap[app.appliance] = app.fault;
    }
  }
  const cascade = summarizeMorningShiftFaultCascade(faultRecordMap);
  const utilities =
    props.appliances && props.appliances.length > 0
      ? computeFacilityUtilityTelemetry(props.appliances)
      : null;
  const cobot = (props.cobotTransfers ?? []).find((t) => t.cellId === props.id);
  if (cobot !== undefined) {
    return (
      <section aria-label="Selected cobot cell" data-selected-cobot={cobot.cellId}>
        <dl className="wait-summary">
          <dt>Robot</dt>
          <dd>{cobot.robot}</dd>
          <dt>State</dt>
          <dd data-cobot-status={cobot.status}>{cobot.status}</dd>
          <dt>Phase</dt>
          <dd>{cobot.label}</dd>
          <dt>Transfers</dt>
          <dd>
            {cobot.completedTransfers}/{cobot.totalTransfers} · step{" "}
            {cobot.step} ({Math.round(cobot.progress * 100)}%)
          </dd>
          <dt>6-DOF IK joints (rad)</dt>
          <dd data-cobot-joints={cobot.jointAnglesRad.join(",")}>
            [{cobot.jointAnglesRad.map((j) => j.toFixed(2)).join(", ")}]
          </dd>
          <dt>TCP pose (m)</dt>
          <dd>
            [{cobot.endEffectorPoseMeters.map((v) => v.toFixed(3)).join(", ")}]
          </dd>
          <dt>Gripper & payload</dt>
          <dd>
            {cobot.gripperWidthMm} mm · {cobot.gripperForceNewtons} N ·{" "}
            {cobot.payloadMassKg} kg · {cobot.shoulderTorqueNm} N·m
          </dd>
          {cobot.taskId !== null && (
            <>
              <dt>Task</dt>
              <dd>
                <button onClick={props.select.bind(null, cobot.taskId)}>
                  {taskLabel(cobot.taskId)}
                </button>
              </dd>
            </>
          )}
        </dl>
        {faultCascadeSection(cascade)}
      </section>
    );
  }
  const station = financierStation(props.id, props.scenario);
  if (station === null) return null;
  const stores: Logistics["carrierStores"][number][] = [];
  for (const id of station.stores)
    for (const store of props.view.carrierStores)
      if (store.id === id) stores.push(store);
  const stationAppliances = (props.appliances ?? []).filter(
    (a) => a.stationId === station.id,
  );
  const waiting: string[] = [];
  for (const queue of props.view.queues)
    if (
      (queue.kind === "storage" && station.stores.includes(queue.id)) ||
      (queue.kind === "resource" && station.resources.includes(queue.id))
    )
      for (const task of queue.tasks)
        if (!waiting.includes(task)) waiting.push(task);
  return (
    <section aria-label="Selected station" data-selected-station={station.id}>
      <h3>{station.label}</h3>
      {utilities !== null && (
        <p
          className="station-utility-summary"
          data-facility-utility-status={utilities.status}
          data-hvac-psychrometric-status={utilities.hvacPsychrometrics.status}
          data-acoustics-room-dba={
            utilities.acousticsAndVibration.roomCompositeNoiseDba
          }
          data-vibration-peak-mms={
            utilities.acousticsAndVibration.peakVibrationMmPerSecRms
          }
        >
          Facility bus: {(utilities.totalPowerWatts / 1000).toFixed(2)} kW (L1{" "}
          {utilities.phaseLoadsWatts.l1} W · L2 {utilities.phaseLoadsWatts.l2} W
          · L3 {utilities.phaseLoadsWatts.l3} W · {utilities.lineVoltageVolts}{" "}
          V) · Water manifold: {utilities.waterManifoldPressureBar} bar (
          {utilities.waterFlowLpm} L/min) · Room HVAC:{" "}
          {utilities.hvacPsychrometrics.roomDryBulbC} °C /{" "}
          {utilities.hvacPsychrometrics.relativeHumidityPercent}% RH (WB{" "}
          {utilities.hvacPsychrometrics.wetBulbC} °C · DP{" "}
          {utilities.hvacPsychrometrics.dewPointC} °C ·{" "}
          {utilities.hvacPsychrometrics.specificEnthalpyKjPerKg} kJ/kg · Hood{" "}
          {utilities.hvacPsychrometrics.canopyHoodExhaustCfm} CFM ·{" "}
          {utilities.hvacPsychrometrics.airChangesPerHour} ACH) · Acoustics:{" "}
          {utilities.acousticsAndVibration.roomCompositeNoiseDba} dBA /{" "}
          {utilities.acousticsAndVibration.peakVibrationMmPerSecRms} mm/s RMS.
        </p>
      )}
      {stationAppliances.length > 0 && (
        <section aria-label="Synchronized station appliances">
          <h4>Synchronized appliances</h4>
          <table className="oven-workspace-cells">
            <thead>
              <tr>
                <th>Appliance</th>
                <th>State</th>
                <th>Program</th>
                <th>Temp</th>
                <th>Acoustics & Vib</th>
                <th>Tasks</th>
                <th>Checkpoint</th>
              </tr>
            </thead>
            <tbody>
              {stationAppliances.map(
                stationApplianceRow.bind(null, props),
              )}
            </tbody>
          </table>
        </section>
      )}
      {rotaryAcousticsSection(props.appliances, props.select)}
      {batchMassAccountingSection(props.view, props.appliances, props.select)}
      {chillerColdCellSection(props.appliances, props.select)}
      {dishwasherWarewashSection(props.appliances, props.select)}
      {espressoBoilerSection(props.appliances, props.select)}
      {ovenVentingRadiantSection(props.appliances, props.select)}
      {hobCoilThermalSection(props.appliances, props.select)}
      {precisionScaleSection(props.appliances, props.select)}
      {planetaryMixerSection(props.appliances, props.select)}
      {milkFrotherSection(props.appliances, props.select)}
      {continuousWavesCarrierReturnSection(props.view, props.appliances)}
      {shiftBreakAndHandoffSection(props.appliances, props.select)}
      {aisleWalkCongestionSection(props.appliances)}
      {faultCascadeSection(cascade)}
      <ul>{stores.map(storeLine.bind(null, props))}</ul>
      <h4>Waiting here</h4>
      {waiting.length === 0 ? (
        <p>No work waits for this station.</p>
      ) : (
        <ul aria-label="Work waiting at this station">
          {waiting.map(waitingButton.bind(null, props.select))}
        </ul>
      )}
    </section>
  );
}
