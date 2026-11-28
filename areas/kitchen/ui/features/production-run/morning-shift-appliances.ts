import type {
  CompiledScenario,
  LogisticsView,
  TaskView,
} from "@purin-labs/production-simulation";
import { recipeApplianceTask } from "@purin-labs/production-simulation/recipes/bakery/appliance-task-table";
import type { RecipeApplianceTaskBinding } from "@purin-labs/production-simulation/recipes/bakery/appliance-execution";
import {
  buildScenarioTaskLookup,
  taskDescriptorFromView,
} from "./recipe-appliance-report";
import type { OvenLiveFrame } from "@purin-labs/production-simulation/runs/oven-live-physics";
import {
  appendBeverageCobotCells,
  computeCobotKinematicsAndDynamics,
  type BaseCobotTransferEntry,
} from "./morning-shift-cobot-kinematics";
import { MORNING_SHIFT_APPLIANCE_SPECS } from "./morning-shift-stations";
import type { ApplianceSpec } from "./morning-shift-stations";
import type {
  ApplianceFaultRecord,
  MorningShiftApplianceCode,
  SynchronizedApplianceState,
  SynchronizedCobotTransferState,
} from "./morning-shift-telemetry-types";
import {
  computeApplianceAcousticsAndVibration,
  computeFacilityUtilityTelemetry,
} from "./facility-utility-telemetry";
import { recoveryDelayForAppliance } from "./morning-shift-cascade";
export type {
  ApplianceFaultRecord,
  MorningShiftApplianceCode,
  MorningShiftFaultCascadeSummary,
  SynchronizedApplianceState,
  SynchronizedCobotTransferState,
} from "./morning-shift-telemetry-types";
export { MORNING_SHIFT_STATIONS } from "./morning-shift-stations";
export { computeFacilityUtilityTelemetry } from "./facility-utility-telemetry";
export {
  summarizeAisleWalkCongestionTelemetry,
  summarizeContinuousWaveCarrierReturnTelemetry,
  summarizeShiftBreakAndHandoffTelemetry,
} from "./shift-flow-telemetry";
export {
  summarizeMorningShiftFaultCascade,
  summarizeMorningShiftMassAccounting,
} from "./morning-shift-cascade";

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function newtonCooling(
  peakC: number,
  equilibriumC: number,
  elapsedSeconds: number,
  tauSeconds: number,
): number {
  if (elapsedSeconds <= 0 || tauSeconds <= 0) return peakC;
  return (
    equilibriumC +
    (peakC - equilibriumC) * Math.exp(-elapsedSeconds / tauSeconds)
  );
}

function deriveApplianceTelemetry(
  spec: ApplianceSpec,
  binding: RecipeApplianceTaskBinding | null,
  status: "idle" | "active" | "completed",
  progress: number,
  completedCount: number,
  idleElapsedSeconds = 0,
  faultElapsedSeconds: number | null = null,
): Readonly<{
  programSummary: string;
  temperatureC: number;
  rpm: number;
  massG: number;
  powerWatts: number;
  pressureBar: number;
  torqueNm: number;
  viscosityPas: number;
  doorOpenRatio: number;
  thermalPlumeIntensity: number;
  liquidColorHex: number;
}> {
  const massG =
    binding?.batch !== null && binding?.batch !== undefined
      ? Math.round(binding.batch.mass_kg * 1000)
      : 0;
  const key = binding?.taskKey ?? "";
  const wf = binding?.workflowId ?? "";
  const isFaulted = faultElapsedSeconds !== null;

  switch (spec.appliance) {
    case "ohaus-ranger-3000": {
      const batchTemp =
        key === "standardize-yield"
          ? 76
          : (binding?.batch?.temperature_c ?? spec.idleTemperatureC);
      const temp =
        status === "active"
          ? batchTemp
          : completedCount > 0
            ? newtonCooling(
                batchTemp,
                spec.idleTemperatureC,
                idleElapsedSeconds,
                140,
              )
            : spec.idleTemperatureC;
      const activeMass = status === "active" || completedCount > 0 ? massG : 0;
      return {
        programSummary:
          status === "active"
            ? `Weigh · ${massG} g`
            : completedCount > 0
              ? `Stable · ${massG} g`
              : "Tare 0 g",
        temperatureC: Number(temp.toFixed(1)),
        rpm: 0,
        massG: activeMass,
        powerWatts: status === "active" ? 9 : 4,
        pressureBar: 1.01,
        torqueNm: 0,
        viscosityPas: 0,
        doorOpenRatio: 0,
        thermalPlumeIntensity: temp > 60 ? clamp01((temp - 60) / 40) * 0.45 : 0,
        liquidColorHex: wf.includes("sesame")
          ? 0x2d2c32
          : wf.includes("tea")
            ? 0xc87f28
            : 0xe7d3a2,
      };
    }
    case "hobart-hl200": {
      const viscosityPas =
        status === "active"
          ? Number((1.8 + 2.8 * smoothProgress(progress)).toFixed(2))
          : completedCount > 0
            ? 4.6
            : 0;
      const torqueNm =
        status === "active" && !isFaulted
          ? Number((4.2 + 1.35 * viscosityPas).toFixed(2))
          : 0;
      const omega =
        ((status === "active" && !isFaulted ? 185 : 0) * 2 * Math.PI) / 60;
      const mechWatts = torqueNm * omega;
      const temp =
        status === "active"
          ? 21.5 + 4.8 * progress
          : completedCount > 0
            ? newtonCooling(
                26.3,
                spec.idleTemperatureC,
                idleElapsedSeconds,
                240,
              )
            : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? `Planetary #2 · 185 RPM · ${torqueNm.toFixed(1)} N·m`
            : completedCount > 0
              ? "Stopped · Bowl clean"
              : "Standby · 20 qt",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 185 : 0,
        massG: status === "active" ? Math.max(375, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? Math.round(95 + mechWatts * 1.18)
            : 12,
        pressureBar: 1.01,
        torqueNm,
        viscosityPas,
        doorOpenRatio: isFaulted ? 1 : 0,
        thermalPlumeIntensity: 0,
        liquidColorHex: 0xe7d3a2,
      };
    }
    case "waring-wsg60": {
      const peakC = 41.5;
      const temp =
        status === "active"
          ? 24 + (peakC - 24) * progress
          : completedCount > 0
            ? newtonCooling(peakC, spec.warmStandbyC, idleElapsedSeconds, 125)
            : spec.idleTemperatureC;
      const viscosityPas =
        status === "active"
          ? Number((3.4 + 9.0 * progress).toFixed(2))
          : completedCount > 0
            ? 12.4
            : 0;
      const torqueNm =
        status === "active" && !isFaulted
          ? Number((0.28 + 0.025 * viscosityPas).toFixed(2))
          : 0;
      return {
        programSummary:
          status === "active"
            ? "Pulse Grind · 18,000 RPM"
            : completedCount > 0
              ? "Paste ground · 220 g"
              : "Standby",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 18000 : 0,
        massG: status === "active" ? Math.max(220, massG) : 0,
        powerWatts: status === "active" && !isFaulted ? 980 : 6,
        pressureBar: 1.01,
        torqueNm,
        viscosityPas,
        doorOpenRatio: isFaulted ? 0.85 : 0,
        thermalPlumeIntensity: 0,
        liquidColorHex: 0x242329,
      };
    }
    case "vitamix-quiet-one": {
      const peakC = 74.0;
      const baseTemp =
        status === "active"
          ? 64 + (peakC - 64) * progress
          : completedCount > 0
            ? newtonCooling(peakC, spec.warmStandbyC, idleElapsedSeconds, 110)
            : spec.idleTemperatureC;
      const temp =
        isFaulted && faultElapsedSeconds !== null
          ? newtonCooling(baseTemp, 24, faultElapsedSeconds, 60)
          : baseTemp;
      const viscosityPas =
        status === "active"
          ? Number((5.2 - 3.1 * progress).toFixed(2))
          : completedCount > 0
            ? 2.1
            : 0;
      const torqueNm =
        status === "active" && !isFaulted
          ? Number((0.62 + 0.08 * viscosityPas).toFixed(2))
          : 0;
      return {
        programSummary:
          status === "active"
            ? "Quiet Blend 45% · 9,500 RPM"
            : completedCount > 0
              ? "Homogenized · 760 g"
              : "Enclosure closed",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 9500 : 0,
        massG: status === "active" ? Math.max(760, massG) : 0,
        powerWatts: status === "active" && !isFaulted ? 1340 : 11,
        pressureBar: 1.01,
        torqueNm,
        viscosityPas,
        doorOpenRatio: isFaulted ? 1 : 0,
        thermalPlumeIntensity:
          temp > 62 ? clamp01((temp - 62) / 30) * (isFaulted ? 0.85 : 0.35) : 0,
        liquidColorHex: 0x28272d,
      };
    }
    case "maruzen-mih-02c": {
      let targetC = 96;
      let color = 0xc67d28;
      let mode = "Induction";
      let dutyWatts = 2400;
      if (key === "brown-butter") {
        targetC = 152;
        color = 0xd4892a;
        mode = "80% · 152 °C Beurre Noisette";
        dutyWatts = 2400;
      } else if (key === "cook-slurry") {
        targetC = 88;
        color = 0x28272d;
        mode = "68% · 88 °C Sesame Slurry";
        dutyWatts = 2040;
      } else if (key === "simmer-ginger" || key === "simmer-tea") {
        targetC = 98;
        color = 0xc67d28;
        mode = "65% · 98 °C Tea Simmer";
        dutyWatts = 1950;
      } else if (key === "heat-water") {
        targetC = 96;
        color = 0x60a5fa;
        mode = "85% · 96 °C Water Boil";
        dutyWatts = 2550;
      }
      const startC = completedCount > 0 ? spec.warmStandbyC : 24;
      const temp =
        status === "active"
          ? startC + (targetC - startC) * Math.max(0.25, progress)
          : completedCount > 0
            ? newtonCooling(targetC, spec.warmStandbyC, idleElapsedSeconds, 175)
            : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? mode
            : completedCount > 0
              ? `Warm plate · ${Math.round(temp)} °C`
              : "Standby · 2.0 kW",
        temperatureC: Number(temp.toFixed(1)),
        rpm: 0,
        massG: status === "active" ? Math.max(110, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? dutyWatts
            : completedCount > 0
              ? 85
              : 18,
        pressureBar: 1.01,
        torqueNm: 0,
        viscosityPas: key === "cook-slurry" ? 3.8 : 0.4,
        doorOpenRatio: 0,
        thermalPlumeIntensity:
          status === "active" && temp > 75
            ? clamp01((temp - 72) / 80)
            : temp > 82
              ? 0.25
              : 0,
        liquidColorHex: color,
      };
    }
    case "vollrath-59500p": {
      let targetC = 78;
      let color = 0xdab88b;
      let mode = "78 °C Milk Tea Finish";
      let dutyWatts = 1350;
      if (key === "prepare-warm-cups") {
        targetC = 65;
        color = 0x60a5fa;
        mode = "65 °C Cup Preheat";
        dutyWatts = 1100;
      } else if (key === "simmer-ginger" || key === "simmer-tea") {
        targetC = 98;
        color = 0xc67d28;
        mode = "98 °C Extraction Simmer";
        dutyWatts = 1680;
      } else if (key === "heat-water") {
        targetC = 96;
        color = 0x60a5fa;
        mode = "96 °C Water Bring-Up";
        dutyWatts = 1800;
      }
      const startC = completedCount > 0 ? 54 : 26;
      const temp =
        status === "active"
          ? startC + (targetC - startC) * Math.max(0.3, progress)
          : completedCount > 0
            ? newtonCooling(targetC, spec.warmStandbyC, idleElapsedSeconds, 165)
            : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? mode
            : completedCount > 0
              ? `Hold · ${Math.round(temp)} °C`
              : "Standby · 1.8 kW",
        temperatureC: Number(temp.toFixed(1)),
        rpm: 0,
        massG: status === "active" ? Math.max(400, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? dutyWatts
            : completedCount > 0
              ? 120
              : 15,
        pressureBar: 1.01,
        torqueNm: 0,
        viscosityPas: 0.25,
        doorOpenRatio: 0,
        thermalPlumeIntensity:
          status === "active" && temp > 74 ? clamp01((temp - 70) / 35) : 0,
        liquidColorHex: color,
      };
    }
    case "maruzen-mbco-5e": {
      const isRoast = key === "roast-sesame";
      const targetC = isRoast ? 160 : 170;
      const nominalTemp =
        status === "active"
          ? key === "preheat"
            ? 35 + (170 - 35) * Math.max(0.35, progress)
            : targetC
          : completedCount > 0
            ? newtonCooling(targetC, spec.warmStandbyC, idleElapsedSeconds, 420)
            : spec.idleTemperatureC;
      const temp =
        isFaulted && faultElapsedSeconds !== null
          ? newtonCooling(
              nominalTemp,
              55,
              Math.max(12, faultElapsedSeconds),
              45,
            )
          : nominalTemp;
      const doorOpenRatio = isFaulted
        ? 0.92
        : status === "active" && (progress < 0.06 || progress > 0.94)
          ? 0.55
          : 0;
      return {
        programSummary:
          status === "active"
            ? isRoast
              ? "160 °C Sesame Roast"
              : key === "preheat"
                ? "Preheat → 170 °C"
                : "170 °C Financier Bake"
            : completedCount > 0
              ? `Ready · ${Math.round(temp)} °C`
              : "Cold · 24 °C",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 1450 : 0,
        massG: status === "active" ? Math.max(188, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? key === "preheat"
              ? 5600
              : 3850
            : completedCount > 0 && !isFaulted
              ? 640
              : 35,
        pressureBar: 1.01,
        torqueNm: 0,
        viscosityPas: 0,
        doorOpenRatio,
        thermalPlumeIntensity:
          doorOpenRatio > 0.1 && temp > 65
            ? clamp01((temp - 55) / 115) * 0.95
            : status === "active"
              ? 0.28
              : 0,
        liquidColorHex: isRoast ? 0x2b2930 : 0xc28a45,
      };
    }
    case "hoshizaki-rt-120snj": {
      const doorInfiltrationWindow =
        status === "active" && (progress < 0.08 || progress > 0.92);
      const inDefrostWindow =
        status !== "active" &&
        completedCount >= 1 &&
        idleElapsedSeconds >= 10 &&
        idleElapsedSeconds <= 55;
      const postDefrostPullDown =
        status !== "active" &&
        completedCount >= 1 &&
        idleElapsedSeconds > 55 &&
        idleElapsedSeconds <= 95;
      const pullDownC =
        status === "active"
          ? doorInfiltrationWindow
            ? 7.2
            : Number((5.8 - 2.2 * progress).toFixed(1))
          : inDefrostWindow
            ? 5.1
            : postDefrostPullDown
              ? 3.8
              : 3.4;
      const modeLabel =
        status === "active"
          ? doorInfiltrationWindow
            ? `Door Infiltration Spike · ${pullDownC.toFixed(1)} °C (${massG} g)`
            : `Pull-Down Refrigerate · ${pullDownC.toFixed(1)} °C (${massG} g)`
          : inDefrostWindow
            ? `Defrost Heater Active · ${pullDownC.toFixed(1)} °C (Coil +6.4 °C)`
            : postDefrostPullDown
              ? `Post-Defrost Recovery · ${pullDownC.toFixed(1)} °C`
              : `Cold-Cell Hold · ${pullDownC.toFixed(1)} °C`;
      return {
        programSummary: modeLabel,
        temperatureC: pullDownC,
        rpm:
          status === "active" || postDefrostPullDown
            ? 2100
            : inDefrostWindow
              ? 0
              : 900,
        massG: status === "active" ? Math.max(220, massG) : 0,
        powerWatts:
          status === "active"
            ? doorInfiltrationWindow
              ? 310
              : 265
            : inDefrostWindow
              ? 385
              : postDefrostPullDown
                ? 295
                : 145,
        pressureBar:
          status === "active" || postDefrostPullDown
            ? 2.55
            : inDefrostWindow
              ? 1.45
              : 1.85,
        torqueNm: 0,
        viscosityPas: 0,
        doorOpenRatio: doorInfiltrationWindow ? 0.65 : 0,
        thermalPlumeIntensity: inDefrostWindow ? 0.16 : 0,
        liquidColorHex: 0x38bdf8,
      };
    }
    case "severin-sm-3587": {
      const peakC = 65;
      const temp =
        status === "active"
          ? 38 + (peakC - 38) * Math.max(0.3, progress)
          : completedCount > 0
            ? newtonCooling(peakC, spec.warmStandbyC, idleElapsedSeconds, 95)
            : spec.idleTemperatureC;
      const viscosityPas =
        status === "active"
          ? Number((0.04 + 0.14 * progress).toFixed(2))
          : 0.18;
      return {
        programSummary:
          status === "active"
            ? "Heated Froth · 65 °C · 2,400 RPM"
            : completedCount > 0
              ? `Served · ${completedCount} drinks`
              : "Standby",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 2400 : 0,
        massG: status === "active" ? Math.max(205, massG) : 0,
        powerWatts: status === "active" && !isFaulted ? 500 : 4,
        pressureBar: 1.01,
        torqueNm: status === "active" && !isFaulted ? 0.08 : 0,
        viscosityPas,
        doorOpenRatio: 0,
        thermalPlumeIntensity: status === "active" && temp > 55 ? 0.35 : 0,
        liquidColorHex: 0x4b4952,
      };
    }
    case "winterhalter-uc-l": {
      const peakC = 85;
      const nominalTemp =
        status === "active"
          ? 62 + (peakC - 62) * progress
          : completedCount > 0
            ? newtonCooling(peakC, spec.warmStandbyC, idleElapsedSeconds, 210)
            : spec.idleTemperatureC;
      const temp =
        isFaulted && faultElapsedSeconds !== null
          ? newtonCooling(
              nominalTemp,
              38,
              Math.max(10, faultElapsedSeconds),
              50,
            )
          : nominalTemp;
      const doorOpenRatio = isFaulted
        ? 0.9
        : status === "active" && (progress < 0.08 || progress > 0.92)
          ? 0.7
          : 0;
      return {
        programSummary:
          status === "active"
            ? "Wash 62 °C / Rinse 85 °C"
            : completedCount > 0
              ? `Sanitized · ${completedCount} cycles`
              : "Tank ready · 60 °C",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 2800 : 0,
        massG: status === "active" ? Math.max(320, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? 7900
            : completedCount > 0 && !isFaulted
              ? 420
              : 45,
        pressureBar: status === "active" && !isFaulted ? 0.45 : 1.01,
        torqueNm: 0,
        viscosityPas: 0,
        doorOpenRatio,
        thermalPlumeIntensity:
          doorOpenRatio > 0.1 && temp > 55
            ? 0.9
            : status === "active" && progress > 0.6
              ? 0.45
              : 0,
        liquidColorHex: 0x38bdf8,
      };
    }
    case "la-marzocco-linea-classic-s-2g": {
      const temp =
        status === "active"
          ? 91.8 + 1.4 * progress
          : completedCount > 0
            ? spec.warmStandbyC
            : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? "93 °C · 9.0 bar Double Shot (36 g)"
            : completedCount > 0
              ? `Served · ${completedCount} shots (93 °C)`
              : "Boiler standby · 93 °C",
        temperatureC: Number(temp.toFixed(1)),
        rpm: status === "active" && !isFaulted ? 1725 : 0,
        massG: status === "active" ? Math.max(36, massG) : 0,
        powerWatts:
          status === "active" && !isFaulted
            ? 3600
            : completedCount > 0
              ? 480
              : 220,
        pressureBar: status === "active" && !isFaulted ? 9.0 : 1.3,
        torqueNm: 0,
        viscosityPas: status === "active" ? 0.09 : 0,
        doorOpenRatio: 0,
        thermalPlumeIntensity: status === "active" ? 0.65 : 0.18,
        liquidColorHex: 0x5c341d,
      };
    }
    case "pastry-bench": {
      const isLid = key.startsWith("lid-pies");
      const temp =
        status === "active"
          ? isLid
            ? 6.4 + 1.8 * progress
            : 8.2 + 2.1 * progress
          : spec.idleTemperatureC;
      return {
        programSummary:
          status === "active"
            ? isLid
              ? "Drape puff lid · 42 N fluted crimp"
              : "Sheet 3.0 mm shortcrust · 22.5 mm drape"
            : completedCount > 0
              ? `Sheeted · ${completedCount} pie trays`
              : "Chilled marble slab · 16 °C",
        temperatureC: Number(temp.toFixed(1)),
        rpm: 0,
        massG: status === "active" ? Math.max(isLid ? 240 : 330, massG) : 0,
        powerWatts: status === "active" && !isFaulted ? 140 : 18,
        pressureBar: 1.01,
        torqueNm: status === "active" && !isFaulted ? 4.2 : 0,
        viscosityPas: status === "active" ? 18.5 : 0,
        doorOpenRatio: 0,
        thermalPlumeIntensity: 0,
        liquidColorHex: 0xead49c,
      };
    }
  }
}

function smoothProgress(u: number): number {
  const c = clamp01(u);
  return c * c * (3 - 2 * c);
}

export function createApplianceFaultRecord(
  appliance: MorningShiftApplianceCode,
  timeUs: number,
): ApplianceFaultRecord {
  const faultedAtSeconds = Number((timeUs / 1_000_000).toFixed(1));
  switch (appliance) {
    case "hobart-hl200":
      return {
        appliance,
        code: "GUARD_OPEN",
        reason: "Planetary safety guard opened mid-mix (remaining 2.0 s)",
        remediation: "Close guard and restore from mixer checkpoint",
        faultedAtSeconds,
        checkpointDigest: "c4b9e1f0a28d7356e1049c7a88b312f6e90d4512a7c83e19",
        restored: false,
        restoredAtSeconds: null,
      };
    case "vitamix-quiet-one":
      return {
        appliance,
        code: "SIM_LID_OPEN",
        reason: "Sound enclosure and jar lid unseated mid-blend",
        remediation: "Seat lid, reset motor fault, and restore from checkpoint",
        faultedAtSeconds,
        checkpointDigest: "8f31d4c90e27b6154a90c82e1745f039d2817e64b5091c2a",
        restored: false,
        restoredAtSeconds: null,
      };
    case "maruzen-mbco-5e":
      return {
        appliance,
        code: "DOOR_PAUSED",
        reason: "Convection door opened mid-bake (remaining 7.0 s at 55 °C)",
        remediation: "Close door, recover chamber heat, and resume checkpoint",
        faultedAtSeconds,
        checkpointDigest: "3e72a81c59f40d62b1837e904a52c618f903e271d485a90b",
        restored: false,
        restoredAtSeconds: null,
      };
    case "winterhalter-uc-l":
      return {
        appliance,
        code: "DOOR_FAULT",
        reason: "Undercounter door opened during wash fill cycle",
        remediation: "Close door, re-prepare wash, and restore checkpoint",
        faultedAtSeconds,
        checkpointDigest: "7a19e5d30b48c2716f094a83e215c709b842d163f590e84c",
        restored: false,
        restoredAtSeconds: null,
      };
    case "pastry-bench":
      return {
        appliance,
        code: "UNFLOURED_SLAB",
        reason:
          "Shortcrust sheet stuck to unfloured marble slab (< 14 mm cavity drape)",
        remediation: "Dust 14 g T55 bench flour and re-sheet from checkpoint",
        faultedAtSeconds,
        checkpointDigest: "c859f3334736f440ed67da969b9240f9de34e182a773862a",
        restored: false,
        restoredAtSeconds: null,
      };
    default:
      return {
        appliance,
        code: "INTERLOCK_PAUSE",
        reason: "Mid-cycle safety interlock paused appliance operation",
        remediation: "Clear interlock and restore from appliance checkpoint",
        faultedAtSeconds,
        checkpointDigest: "5d83b209e417c652a903f814e726b038c491d275e608a13f",
        restored: false,
        restoredAtSeconds: null,
      };
  }
}

export function synchronizeMorningShiftAppliances(
  scenario: CompiledScenario,
  logistics: LogisticsView,
  timeUs: number,
  faults: Readonly<Record<string, ApplianceFaultRecord>> | null = null,
): readonly SynchronizedApplianceState[] {
  if (logistics.kind !== "available") return [];
  const lookup = buildScenarioTaskLookup(scenario);
  const byAppliance = new Map<
    string,
    {
      active: { task: TaskView; binding: RecipeApplianceTaskBinding } | null;
      lastCompleted: {
        task: TaskView;
        binding: RecipeApplianceTaskBinding;
        completedAt: number;
      } | null;
      completedCount: number;
      totalCount: number;
    }
  >();
  for (const spec of MORNING_SHIFT_APPLIANCE_SPECS) {
    byAppliance.set(spec.appliance, {
      active: null,
      lastCompleted: null,
      completedCount: 0,
      totalCount: 0,
    });
  }

  for (const task of logistics.tasks) {
    const descriptor = taskDescriptorFromView(task, lookup);
    const binding =
      descriptor === null ? null : recipeApplianceTask(descriptor);
    if (binding === null) continue;
    const key =
      binding.appliance === "victoria-arduino-eagle-one-2g"
        ? "la-marzocco-linea-classic-s-2g"
        : binding.appliance;
    const bucket = byAppliance.get(key);
    if (bucket === undefined) continue;
    bucket.totalCount += 1;
    if (task.kind === "executing") {
      bucket.active = { task, binding };
    } else if (task.kind === "completed" && task.completedAt <= timeUs) {
      bucket.completedCount += 1;
      if (
        bucket.lastCompleted === null ||
        task.completedAt >= bucket.lastCompleted.completedAt
      ) {
        bucket.lastCompleted = {
          task,
          binding,
          completedAt: task.completedAt,
        };
      }
    }
  }

  const states: SynchronizedApplianceState[] = [];
  for (const spec of MORNING_SHIFT_APPLIANCE_SPECS) {
    const bucket = byAppliance.get(spec.appliance)!;
    const active = bucket.active;
    const lastCompleted = bucket.lastCompleted;
    const faultRecord = faults?.[spec.appliance] ?? null;
    const isFaulted = faultRecord !== null && !faultRecord.restored;
    const baseStatus: "idle" | "active" | "completed" =
      active !== null
        ? "active"
        : bucket.totalCount > 0 && bucket.completedCount === bucket.totalCount
          ? "completed"
          : "idle";
    const status: SynchronizedApplianceState["status"] = isFaulted
      ? "fault"
      : baseStatus;
    let progress = 0;
    if (active !== null && active.task.kind === "executing") {
      const start = active.task.startedAt;
      const end = active.task.completesAt ?? start + 30_000_000;
      progress = end > start ? clamp01((timeUs - start) / (end - start)) : 0.5;
    } else if (baseStatus === "completed") {
      progress = 1;
    }
    const chosenBinding = active?.binding ?? lastCompleted?.binding ?? null;
    const idleElapsedSeconds =
      active === null && lastCompleted !== null
        ? Math.max(0, (timeUs - lastCompleted.completedAt) / 1_000_000)
        : 0;
    const faultElapsedSeconds = isFaulted
      ? Math.max(15, timeUs / 1_000_000 - faultRecord.faultedAtSeconds)
      : null;
    const telemetry = deriveApplianceTelemetry(
      spec,
      chosenBinding,
      baseStatus,
      progress,
      bucket.completedCount,
      idleElapsedSeconds,
      faultElapsedSeconds,
    );
    const programSummary = isFaulted
      ? `FAULT ${faultRecord.code} · ${faultRecord.reason}`
      : faultRecord?.restored
        ? `Restored (${faultRecord.checkpointDigest.slice(0, 8)}) · ${telemetry.programSummary}`
        : telemetry.programSummary;
    const acoustics = computeApplianceAcousticsAndVibration(
      spec.appliance,
      status,
      bucket.completedCount,
      telemetry.torqueNm,
      telemetry.viscosityPas,
      telemetry.pressureBar,
    );
    states.push({
      appliance: spec.appliance,
      displayName: spec.displayName,
      category: spec.category,
      stationId: spec.stationId,
      status,
      activeTaskId: active?.task.id ?? null,
      lastTaskId: lastCompleted?.task.id ?? null,
      label:
        active?.binding.label ??
        lastCompleted?.binding.label ??
        `${spec.displayName} standby`,
      programSummary,
      temperatureC: telemetry.temperatureC,
      rpm: isFaulted ? 0 : telemetry.rpm,
      massG: telemetry.massG,
      powerWatts: telemetry.powerWatts,
      pressureBar: telemetry.pressureBar,
      torqueNm: telemetry.torqueNm,
      viscosityPas: telemetry.viscosityPas,
      acousticNoiseDba: acoustics.acousticNoiseDba,
      vibrationMmPerSecRms: acoustics.vibrationMmPerSecRms,
      peakAcousticNoiseDba: acoustics.peakAcousticNoiseDba,
      peakVibrationMmPerSecRms: acoustics.peakVibrationMmPerSecRms,
      isRotary: acoustics.isRotary,
      doorOpenRatio: telemetry.doorOpenRatio,
      thermalPlumeIntensity: telemetry.thermalPlumeIntensity,
      liquidColorHex: telemetry.liquidColorHex,
      progress,
      completedCount: bucket.completedCount,
      totalCount: bucket.totalCount,
      fault: faultRecord,
    });
  }
  const utilities = computeFacilityUtilityTelemetry(states);
  const voltageScale = Math.pow(utilities.lineVoltageVolts / 208.0, 2);
  const manifoldDeltaBar = 3.5 - utilities.waterManifoldPressureBar;
  const ambientRoomDriftC = Math.max(
    0,
    utilities.hvacPsychrometrics.roomDryBulbC - 21.0,
  );
  return states.map((s) => {
    const isResistiveOrInduction =
      s.category === "oven" ||
      s.category === "hob" ||
      s.category === "dishwasher" ||
      s.category === "espresso";
    const isChiller = s.appliance === "hoshizaki-rt-120snj";
    const chillerCondenserFactor = 1 + ambientRoomDriftC * 0.026;
    const coupledPowerWatts =
      s.status === "active" && isResistiveOrInduction
        ? Math.round(s.powerWatts * voltageScale)
        : isChiller
          ? Math.round(s.powerWatts * chillerCondenserFactor)
          : s.powerWatts;
    const coupledPressureBar =
      s.appliance === "la-marzocco-linea-classic-s-2g" ||
      s.appliance === "winterhalter-uc-l"
        ? Number(
            Math.max(1.01, s.pressureBar - manifoldDeltaBar * 0.45).toFixed(2),
          )
        : isChiller
          ? Number((s.pressureBar + ambientRoomDriftC * 0.04).toFixed(2))
          : s.pressureBar;
    return {
      ...s,
      powerWatts: coupledPowerWatts,
      pressureBar: coupledPressureBar,
    };
  });
}

export function synchronizeCobotTransfers(
  cells: readonly Readonly<{
    scene: Readonly<{ cell: Readonly<{ cellId: string; robot: string }> }>;
    frame: OvenLiveFrame | null;
  }>[],
  logistics: LogisticsView,
  scenario?: CompiledScenario,
  timeUs = 0,
  faults: Readonly<Record<string, ApplianceFaultRecord>> | null = null,
): readonly SynchronizedCobotTransferState[] {
  let completedTransfers = 0;
  let totalTransfers = 0;
  let executingTransferTask: TaskView | null = null;
  if (logistics.kind === "available") {
    for (const task of logistics.tasks) {
      if (task.subject.kind !== "workflow") continue;
      const key = task.subject.key;
      if (
        key === "stage-pan" ||
        key === "stage-pan-b" ||
        key === "transfer-cold-carrier" ||
        key.includes("oven") ||
        key.includes("rack")
      ) {
        totalTransfers += 1;
        if (task.kind === "completed") completedTransfers += 1;
        else if (task.kind === "executing") executingTransferTask = task;
      }
    }
  }
  const frameByCell = new Map<string, OvenLiveFrame | null>();
  for (const c of cells) {
    frameByCell.set(c.scene.cell.cellId, c.frame);
  }
  const results: BaseCobotTransferEntry[] = cells.map(({ scene, frame }) => {
    if (frame === null) {
      return {
        cellId: scene.cell.cellId,
        robot: scene.cell.robot,
        status: executingTransferTask !== null ? "executing" : "idle",
        taskId: executingTransferTask?.id ?? null,
        label:
          executingTransferTask?.id ?? "Baker pan & cold-carrier station ready",
        step: 0,
        committedSeconds: Number((timeUs / 1_000_000).toFixed(1)),
        completedTransfers,
        totalTransfers,
        progress: executingTransferTask !== null ? 0.5 : 0,
        phase: executingTransferTask !== null ? "transfer" : "idle",
        cascadeHold: null,
      };
    }
    const status: SynchronizedCobotTransferState["status"] =
      frame.purpose === "operation"
        ? "executing"
        : frame.purpose === "recovery"
          ? "recovery"
          : frame.purpose === "admission" || frame.purpose === "removal"
            ? "handoff"
            : "idle";
    const taskId =
      frame.purpose === "operation" || frame.purpose === "recovery"
        ? frame.task
        : (executingTransferTask?.id ?? null);
    const motion =
      frame.purpose === "admission" || frame.purpose === "removal"
        ? frame.after.motion
        : frame.motion;
    const lastSample =
      motion !== undefined
        ? motion.samples[motion.samples.length - 1]
        : undefined;
    return {
      cellId: scene.cell.cellId,
      robot: scene.cell.robot,
      status,
      taskId,
      label:
        frame.purpose === "operation" || frame.purpose === "recovery"
          ? frame.task
          : frame.purpose === "admission" || frame.purpose === "removal"
            ? `${frame.purpose}: ${frame.boundary}`
            : (executingTransferTask?.id ?? "Idle between carrier transfers"),
      step: lastSample?.step ?? 0,
      committedSeconds: Number((frame.committedAt / 1_000_000).toFixed(1)),
      completedTransfers,
      totalTransfers,
      progress: status === "executing" ? 0.5 : completedTransfers > 0 ? 1 : 0,
      phase: frame.purpose,
      cascadeHold: null,
    };
  });

  appendBeverageCobotCells(results, logistics, scenario, timeUs);

  const faultValues = Object.values(faults ?? {});
  const activeFault = faultValues.find((f) => !f.restored) ?? null;
  const restoredFault = faultValues.find((f) => f.restored) ?? null;
  if (activeFault !== null) {
    const delaySeconds = faultValues
      .filter((f) => !f.restored)
      .reduce((sum, f) => sum + recoveryDelayForAppliance(f.appliance), 0);
    return results.map((entry) => {
      const affectedBatches =
        entry.cellId === "espresso-cell"
          ? ["espresso-orders#0", "espresso-orders#1", "sesame-orders#0"]
          : entry.cellId === "pour-over-cell"
            ? ["pour-over-order#0", "pour-over-order#1"]
            : [
                "load-hazelnut-a#0",
                "load-coffee-a#0",
                "load-matcha-a#0",
                "tea-batches#0",
                "milk-tea-batches#0",
              ];
      const phase = `cascade-held:${activeFault.appliance}`;
      return {
        ...entry,
        status: "cascade-held",
        label: `HELD (${activeFault.code}) · ${entry.label}`,
        phase,
        ...computeCobotKinematicsAndDynamics(
          entry.cellId,
          "cascade-held",
          phase,
          entry.progress,
          frameByCell.get(entry.cellId) ?? null,
        ),
        cascadeHold: {
          heldByAppliance: activeFault.appliance,
          heldByFaultCode: activeFault.code,
          affectedBatches,
          delaySeconds,
          restored: false,
          checkpointDigest: activeFault.checkpointDigest,
        },
      };
    });
  }
  if (restoredFault !== null) {
    const delaySeconds = faultValues.reduce(
      (sum, f) => sum + recoveryDelayForAppliance(f.appliance),
      0,
    );
    return results.map((entry) => {
      const affectedBatches =
        entry.cellId === "espresso-cell"
          ? ["espresso-orders#0", "espresso-orders#1", "sesame-orders#0"]
          : entry.cellId === "pour-over-cell"
            ? ["pour-over-order#0", "pour-over-order#1"]
            : [
                "load-hazelnut-a#0",
                "load-coffee-a#0",
                "load-matcha-a#0",
                "tea-batches#0",
                "milk-tea-batches#0",
              ];
      return {
        ...entry,
        label: `Recovered (+${delaySeconds}s) · ${entry.label}`,
        ...computeCobotKinematicsAndDynamics(
          entry.cellId,
          entry.status,
          entry.phase,
          entry.progress,
          frameByCell.get(entry.cellId) ?? null,
        ),
        cascadeHold: {
          heldByAppliance: restoredFault.appliance,
          heldByFaultCode: restoredFault.code,
          affectedBatches,
          delaySeconds,
          restored: true,
          checkpointDigest: restoredFault.checkpointDigest,
        },
      };
    });
  }

  return results.map((entry) => ({
    ...entry,
    ...computeCobotKinematicsAndDynamics(
      entry.cellId,
      entry.status,
      entry.phase,
      entry.progress,
      frameByCell.get(entry.cellId) ?? null,
    ),
  }));
}
