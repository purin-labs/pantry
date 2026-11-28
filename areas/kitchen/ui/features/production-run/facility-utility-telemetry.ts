import type {
  FacilityAcousticVibrationTelemetry,
  FacilityUtilityTelemetry,
  HvacPsychrometricTelemetry,
  MorningShiftApplianceCode,
  MorningShiftChillerColdCellTelemetry,
  MorningShiftChillerDoorInfiltrationEvent,
  MorningShiftDishwasherCycleEvent,
  MorningShiftDishwasherTelemetry,
  MorningShiftEspressoBoilerTelemetry,
  MorningShiftEspressoShotEvent,
  MorningShiftFrotherCycleEvent,
  MorningShiftHobCoilThermalTelemetry,
  MorningShiftHobCycleEvent,
  MorningShiftMilkFrotherTelemetry,
  MorningShiftMixerCycleEvent,
  MorningShiftOvenDeckEvent,
  MorningShiftOvenVentingRadiantTelemetry,
  MorningShiftPlanetaryMixerTelemetry,
  MorningShiftPrecisionScaleTelemetry,
  MorningShiftScaleWeighEvent,
  SynchronizedApplianceState,
} from "./morning-shift-telemetry-types";
import {
  summarizeAisleWalkCongestionTelemetry,
  summarizeContinuousWaveCarrierReturnTelemetry,
  summarizeShiftBreakAndHandoffTelemetry,
} from "./shift-flow-telemetry";

export function computeFacilityUtilityTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): FacilityUtilityTelemetry {
  const ratedBusCapacityWatts = 20780;
  const waterStaticSupplyBar = 3.5;
  let l1 = 0;
  let l2 = 0;
  let l3 = 0;
  let waterFlowLpm = 0.2;
  let sensibleHeatRejectionWatts = 420; // operator + lighting + electronics baseline
  let latentVaporGps = 0.14; // operator respiration + ambient baseline (g/s)

  for (const app of appliances) {
    const w = app.powerWatts;
    const plume = app.thermalPlumeIntensity;
    const doorOpen = app.doorOpenRatio;
    switch (app.appliance) {
      case "maruzen-mbco-5e":
        l1 += w / 3;
        l2 += w / 3;
        l3 += w / 3;
        if (app.status === "active") waterFlowLpm += 0.55;
        sensibleHeatRejectionWatts +=
          w * (0.28 + doorOpen * 0.45) +
          Math.max(0, app.temperatureC - 21) * 1.4;
        latentVaporGps += plume * 0.38 + doorOpen * 0.42;
        break;
      case "winterhalter-uc-l":
        l1 += w / 3;
        l2 += w / 3;
        l3 += w / 3;
        if (app.status === "active") waterFlowLpm += 3.6;
        sensibleHeatRejectionWatts +=
          w * (0.25 + doorOpen * 0.38) +
          Math.max(0, app.temperatureC - 21) * 1.6;
        latentVaporGps += plume * 0.52 + doorOpen * 0.65;
        break;
      case "maruzen-mih-02c":
      case "ohaus-ranger-3000":
      case "waring-wsg60":
        l1 += w;
        sensibleHeatRejectionWatts +=
          w * 0.32 + Math.max(0, app.temperatureC - 21) * 1.1;
        latentVaporGps += plume * 0.44;
        break;
      case "vollrath-59500p":
      case "hobart-hl200":
      case "vitamix-quiet-one":
        l2 += w;
        sensibleHeatRejectionWatts +=
          w * 0.32 + Math.max(0, app.temperatureC - 21) * 1.1;
        latentVaporGps += plume * 0.4;
        break;
      case "la-marzocco-linea-classic-s-2g":
        l3 += w;
        if (app.status === "active") waterFlowLpm += 1.8;
        sensibleHeatRejectionWatts +=
          w * 0.36 + Math.max(0, app.temperatureC - 21) * 1.3;
        latentVaporGps += plume * 0.34;
        break;
      case "hoshizaki-rt-120snj":
        l3 += w;
        // Refrigeration condenser rejects electrical input + extracted cabinet heat (COP ~ 2.2)
        sensibleHeatRejectionWatts += w * 2.15;
        break;
      case "severin-sm-3587":
        l3 += w;
        sensibleHeatRejectionWatts += w * 0.3;
        latentVaporGps += plume * 0.18;
        break;
      case "pastry-bench":
        l1 += w;
        sensibleHeatRejectionWatts += w * 0.25;
        break;
    }
  }

  const totalPowerWatts = Math.round(l1 + l2 + l3);
  const meanPhase = totalPowerWatts / 3;
  const maxDev = Math.max(
    Math.abs(l1 - meanPhase),
    Math.abs(l2 - meanPhase),
    Math.abs(l3 - meanPhase),
  );
  const phaseImbalancePercent = Number(
    (meanPhase > 0 ? (maxDev / meanPhase) * 100 : 0).toFixed(1),
  );
  const breakerUtilizationPercent = Number(
    ((totalPowerWatts / ratedBusCapacityWatts) * 100).toFixed(1),
  );
  const lineCurrentAmps = totalPowerWatts / (208.0 * Math.sqrt(3) * 0.94);
  const lineVoltageVolts = Number(
    Math.max(196.5, 208.0 - lineCurrentAmps * 0.115).toFixed(1),
  );
  const waterManifoldPressureBar = Number(
    Math.max(
      1.85,
      waterStaticSupplyBar - 0.042 * waterFlowLpm * waterFlowLpm,
    ).toFixed(2),
  );
  const status: FacilityUtilityTelemetry["status"] =
    lineVoltageVolts < 205.5
      ? "voltage-sag"
      : totalPowerWatts > 4500
        ? "high-draw"
        : "nominal";

  // Room HVAC & Canopy Hood Psychrometrics (room volume 268.8 m³ = 9492 ft³)
  const canopyHoodExhaustCfm = Math.min(
    1450,
    Math.round(450 + sensibleHeatRejectionWatts * 0.14 + latentVaporGps * 180),
  );
  const airChangesPerHour = Number(
    ((canopyHoodExhaustCfm * 60) / 9492).toFixed(1),
  );
  // Hood captures ~68% of sensible/latent plume; remaining load warms and humidifies the room air
  const uncapturedSensibleW = sensibleHeatRejectionWatts * 0.32;
  const roomDryBulbC = Number(
    Math.min(27.5, 21.0 + uncapturedSensibleW / 540).toFixed(1),
  );
  const relativeHumidityPercent = Number(
    Math.min(72.0, 48.0 + latentVaporGps * 7.8).toFixed(1),
  );
  // Magnus-Tetens saturation vapor pressure (kPa) & dew point (°C)
  const pSatKpa =
    0.61078 * Math.exp((17.27 * roomDryBulbC) / (roomDryBulbC + 237.3));
  const pVapKpa = (relativeHumidityPercent / 100) * pSatKpa;
  const gamma = Math.log(Math.max(1e-4, pVapKpa / 0.61078));
  const dewPointC = Number(((237.3 * gamma) / (17.27 - gamma)).toFixed(1));
  // Stull (2011) wet-bulb temperature (°C)
  const wetBulbC = Number(
    (
      roomDryBulbC *
        Math.atan(0.151977 * Math.sqrt(relativeHumidityPercent + 8.313659)) +
      Math.atan(roomDryBulbC + relativeHumidityPercent) -
      Math.atan(relativeHumidityPercent - 1.676331) +
      0.00391838 *
        Math.pow(relativeHumidityPercent, 1.5) *
        Math.atan(0.023101 * relativeHumidityPercent) -
      4.686035
    ).toFixed(1),
  );
  const omegaKgPerKg = (0.62198 * pVapKpa) / Math.max(10, 101.325 - pVapKpa);
  const humidityRatioGPerKg = Number((omegaKgPerKg * 1000).toFixed(2));
  const specificEnthalpyKjPerKg = Number(
    (
      1.006 * roomDryBulbC +
      omegaKgPerKg * (2501 + 1.86 * roomDryBulbC)
    ).toFixed(1),
  );
  const hvacCoolingLoadWatts = Math.round(
    sensibleHeatRejectionWatts * 0.85 + latentVaporGps * 2260 * 0.55,
  );
  const hvacStatus: HvacPsychrometricTelemetry["status"] =
    relativeHumidityPercent >= 56.0
      ? "humid-plume"
      : roomDryBulbC >= 23.2
        ? "high-sensible-load"
        : "nominal";

  // Room composite acoustic noise (dBA logarithmic sum) & ISO 10816 rotary vibration severity
  const hoodAeroNoiseDba =
    43.0 + 11.5 * Math.log10(Math.max(1, canopyHoodExhaustCfm / 450));
  let acousticPowerSum = Math.pow(10, hoodAeroNoiseDba / 10);
  let peakApplianceNoiseDba = 47.5;
  let peakVibrationMmPerSecRms = 0.62;
  let dominantRotaryAppliance: MorningShiftApplianceCode =
    "hoshizaki-rt-120snj";
  let activeRotaryCount = 0;

  for (const app of appliances) {
    acousticPowerSum += Math.pow(10, app.acousticNoiseDba / 10);
    if (app.isRotary && (app.rpm > 0 || app.status === "active")) {
      activeRotaryCount += 1;
    }
    const candidateDba = Math.max(
      app.acousticNoiseDba,
      app.peakAcousticNoiseDba,
    );
    const candidateVib = Math.max(
      app.vibrationMmPerSecRms,
      app.peakVibrationMmPerSecRms,
    );
    if (app.isRotary && candidateDba > peakApplianceNoiseDba) {
      peakApplianceNoiseDba = candidateDba;
      dominantRotaryAppliance = app.appliance;
    }
    if (app.isRotary && candidateVib > peakVibrationMmPerSecRms) {
      peakVibrationMmPerSecRms = candidateVib;
    }
  }
  const roomCompositeNoiseDba = Number(
    (10 * Math.log10(acousticPowerSum)).toFixed(1),
  );
  const isoVibrationClass: FacilityAcousticVibrationTelemetry["isoVibrationClass"] =
    peakVibrationMmPerSecRms >= 4.5
      ? "iso-alert"
      : peakVibrationMmPerSecRms >= 2.3
        ? "elevated-rotary"
        : "nominal";

  const chillerColdCell = summarizeChillerColdCellTelemetry(
    appliances,
    roomDryBulbC,
    relativeHumidityPercent,
  );
  const dishwasherWarewash = summarizeDishwasherWarewashTelemetry(appliances);
  const espressoBoiler = summarizeEspressoBoilerTelemetry(appliances);
  const ovenVentingRadiant = summarizeOvenVentingRadiantTelemetry(appliances);
  const hobCoilThermal = summarizeHobCoilThermalTelemetry(appliances);
  const precisionScale = summarizePrecisionScaleTelemetry(appliances);
  const planetaryMixer = summarizePlanetaryMixerTelemetry(appliances);
  const milkFrother = summarizeMilkFrotherTelemetry(appliances);
  const continuousWaveCarrierReturn =
    summarizeContinuousWaveCarrierReturnTelemetry(appliances);
  const shiftBreakAndHandoff =
    summarizeShiftBreakAndHandoffTelemetry(appliances);
  const aisleLocomotionAndCongestion =
    summarizeAisleWalkCongestionTelemetry(appliances);

  return {
    totalPowerWatts,
    ratedBusCapacityWatts,
    breakerUtilizationPercent,
    phaseLoadsWatts: {
      l1: Math.round(l1),
      l2: Math.round(l2),
      l3: Math.round(l3),
    },
    phaseImbalancePercent,
    lineVoltageVolts,
    waterStaticSupplyBar,
    waterFlowLpm: Number(waterFlowLpm.toFixed(2)),
    waterManifoldPressureBar,
    hvacPsychrometrics: {
      roomDryBulbC,
      relativeHumidityPercent,
      wetBulbC,
      dewPointC,
      humidityRatioGPerKg,
      specificEnthalpyKjPerKg,
      sensibleHeatRejectionWatts: Math.round(sensibleHeatRejectionWatts),
      latentMoistureGramsPerMin: Number((latentVaporGps * 60).toFixed(1)),
      canopyHoodExhaustCfm,
      hvacCoolingLoadWatts,
      airChangesPerHour,
      status: hvacStatus,
    },
    acousticsAndVibration: {
      roomCompositeNoiseDba,
      peakApplianceNoiseDba,
      peakVibrationMmPerSecRms,
      dominantRotaryAppliance,
      activeRotaryCount,
      isoVibrationClass,
    },
    chillerColdCell,
    dishwasherWarewash,
    espressoBoiler,
    ovenVentingRadiant,
    hobCoilThermal,
    precisionScale,
    planetaryMixer,
    milkFrother,
    continuousWaveCarrierReturn,
    shiftBreakAndHandoff,
    aisleLocomotionAndCongestion,
    status,
  };
}

function summarizePlanetaryMixerTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftPlanetaryMixerTelemetry {
  const mixer = appliances.find((a) => a.appliance === "hobart-hl200");
  const cycles: MorningShiftMixerCycleEvent[] = [
    {
      cycleIndex: 1,
      taskId: "hazelnut-preparation-batches#0/mix",
      batchLabel: "Hazelnut Financier Batter #1 (Speed 1)",
      mixStage: "dry-blend-speed1",
      agitatorRpm: 107,
      specificWorkWhPerKg: 0.42,
      meanShaftTorqueNm: 4.18,
      torqueRippleNmPeakToPeak: 0.67,
      viscousHeatingWatts: 46.8,
      bowlWallHeatWatts: -3.2,
      emulsionIndex: 0.78,
    },
    {
      cycleIndex: 2,
      taskId: "coffee-preparation-batches#0/mix",
      batchLabel: "Coffee Financier Batter #1 (Speed 2)",
      mixStage: "batter-emulsify-speed2",
      agitatorRpm: 198,
      specificWorkWhPerKg: 1.06,
      meanShaftTorqueNm: 6.84,
      torqueRippleNmPeakToPeak: 1.44,
      viscousHeatingWatts: 141.8,
      bowlWallHeatWatts: 18.4,
      emulsionIndex: 0.94,
    },
  ];
  const status: MorningShiftPlanetaryMixerTelemetry["status"] =
    mixer?.status === "fault"
      ? "guard-interlock-open"
      : mixer?.status === "active"
        ? "emulsifying"
        : "homogenized-ready";
  return {
    status,
    totalSpecificWorkWhPerKg: 1.48,
    peakShaftTorqueNm: 6.84,
    maxTorqueRippleNmPeakToPeak: 1.44,
    peakViscousHeatingWatts: 141.8,
    meanEmulsionIndex: 0.86,
    cycles,
  };
}

function summarizeMilkFrotherTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftMilkFrotherTelemetry {
  const frother = appliances.find((a) => a.appliance === "severin-sm-3587");
  const cycles: MorningShiftFrotherCycleEvent[] = [
    {
      cycleIndex: 1,
      taskId: "sesame-orders#0/heat-and-mix",
      drinkLabel: "Black Sesame Latte Microfoam #1 (Severin SM 3587)",
      whiskRpm: 2420,
      vortexShearRateInverseSec: 1604,
      microfoamOverrunPercent: 41.2,
      bubbleDiameterMicrons: 45.6,
      pitcherExitC: 63.6,
      wheyDenaturationPercent: 61.5,
      windowStatus: "optimal-microfoam-window",
    },
    {
      cycleIndex: 2,
      taskId: "sesame-orders#1/heat-and-mix",
      drinkLabel: "Black Sesame Latte Microfoam #2 (Severin SM 3587)",
      whiskRpm: 2390,
      vortexShearRateInverseSec: 1508,
      microfoamOverrunPercent: 42.6,
      bubbleDiameterMicrons: 44.4,
      pitcherExitC: 64.2,
      wheyDenaturationPercent: 63.2,
      windowStatus: "optimal-microfoam-window",
    },
  ];
  const status: MorningShiftMilkFrotherTelemetry["status"] =
    frother?.status === "active"
      ? "vortex-aerating"
      : "optimal-microfoam-window";
  return {
    status,
    meanMicrofoamOverrunPercent: 41.9,
    peakVortexShearRateInverseSec: 1604,
    meanBubbleDiameterMicrons: 45.0,
    meanWheyDenaturationPercent: 62.4,
    maxPitcherExitTempC: 64.2,
    cycles,
  };
}

function summarizeHobCoilThermalTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftHobCoilThermalTelemetry {
  const mih = appliances.find((a) => a.appliance === "maruzen-mih-02c");
  const vollrath = appliances.find((a) => a.appliance === "vollrath-59500p");
  const cycles: MorningShiftHobCycleEvent[] = [
    {
      cycleIndex: 1,
      taskId: "hazelnut-preparation-batches#0/brown-butter",
      appliance: "maruzen-mih-02c",
      vesselLabel: "Beurre Noisette Pan #1 (Maruzen MIH-02C)",
      coilFrequencyKhz: 24.8,
      couplingEfficiencyPercent: 88.4,
      panCenterC: 148.5,
      panRimC: 140.1,
      radialGradientC: 8.4,
      boilOffGps: 0.62,
      evaporatedGrams: 11.2,
    },
    {
      cycleIndex: 2,
      taskId: "tea-batches#0/heat-to-simmer",
      appliance: "maruzen-mih-02c",
      vesselLabel: "Ginger Decoction Reheat Pan #1 (Maruzen MIH-02C)",
      coilFrequencyKhz: 24.8,
      couplingEfficiencyPercent: 88.4,
      panCenterC: 102.6,
      panRimC: 95.8,
      radialGradientC: 6.8,
      boilOffGps: 0.88,
      evaporatedGrams: 14.1,
    },
    {
      cycleIndex: 3,
      taskId: "tea-batches#0/steep",
      appliance: "vollrath-59500p",
      vesselLabel: "Assam Black Tea Infusion Pan #1 (Vollrath 59500P)",
      coilFrequencyKhz: 28.5,
      couplingEfficiencyPercent: 86.2,
      panCenterC: 96.4,
      panRimC: 91.2,
      radialGradientC: 5.2,
      boilOffGps: 0.46,
      evaporatedGrams: 7.4,
    },
    {
      cycleIndex: 4,
      taskId: "milk-tea-batches#0/heat-and-stir-to-78c",
      appliance: "vollrath-59500p",
      vesselLabel: "Ginger Milk Tea Finishing Pan #1 (Vollrath 59500P)",
      coilFrequencyKhz: 28.5,
      couplingEfficiencyPercent: 86.2,
      panCenterC: 92.8,
      panRimC: 87.6,
      radialGradientC: 5.2,
      boilOffGps: 0.46,
      evaporatedGrams: 6.4,
    },
  ];
  const status: MorningShiftHobCoilThermalTelemetry["status"] =
    mih?.status === "active"
      ? "browning-high-gradient"
      : vollrath?.status === "active"
        ? "simmer-duty-modulated"
        : "igbt-coupled";
  return {
    status,
    meanCouplingEfficiencyPercent: 87.3,
    maxRadialGradientC: 8.4,
    peakPanCenterC: 148.5,
    peakBoilOffGps: 0.88,
    totalEvaporatedGrams: 39.1,
    cycles,
  };
}

function summarizePrecisionScaleTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftPrecisionScaleTelemetry {
  const scale = appliances.find((a) => a.appliance === "ohaus-ranger-3000");
  const weighings: MorningShiftScaleWeighEvent[] = [
    {
      weighIndex: 1,
      taskId: "hazelnut-preparation-batches#0/weigh-butter",
      ingredientLabel: "Unsalted Cultured Butter (Financier #1)",
      targetGrams: 150.0,
      settledGrams: 150.02,
      settlingTimeSeconds: 0.89,
      zeroTareDriftMg: 6.6,
      airDraftPeakMg: 56.5,
      filterRejectionDb: 39.8,
      stabilityStatus: "locked-stable",
    },
    {
      weighIndex: 2,
      taskId: "sesame-orders#0/dose",
      ingredientLabel: "Black Sesame Latte Dose #1 (concentrate + milk)",
      targetGrams: 286.0,
      settledGrams: 286.05,
      settlingTimeSeconds: 0.96,
      zeroTareDriftMg: 8.7,
      airDraftPeakMg: 71.0,
      filterRejectionDb: 41.4,
      stabilityStatus: "draft-filtered",
    },
    {
      weighIndex: 3,
      taskId: "espresso-orders#0/weigh-espresso-beans",
      ingredientLabel: "Espresso Single-Origin Dose #1",
      targetGrams: 18.0,
      settledGrams: 18.01,
      settlingTimeSeconds: 0.84,
      zeroTareDriftMg: 4.5,
      airDraftPeakMg: 42.0,
      filterRejectionDb: 38.2,
      stabilityStatus: "locked-stable",
    },
    {
      weighIndex: 4,
      taskId: "pour-over-order#0/weigh-pour-over-beans",
      ingredientLabel: "V60 Pour-Over Filter Dose #1",
      targetGrams: 22.0,
      settledGrams: 22.02,
      settlingTimeSeconds: 0.91,
      zeroTareDriftMg: 10.8,
      airDraftPeakMg: 85.5,
      filterRejectionDb: 41.4,
      stabilityStatus: "draft-filtered",
    },
  ];
  const status: MorningShiftPrecisionScaleTelemetry["status"] =
    scale?.status === "active" ? "draft-filtered" : "locked-stable";
  return {
    status,
    totalWeighings: Math.max(4, scale?.completedCount ?? 4),
    meanSettlingTimeSeconds: 0.9,
    maxSettlingTimeSeconds: 0.96,
    maxZeroTareDriftMg: 10.8,
    peakAirDraftDisturbanceMg: 85.5,
    meanFilterRejectionDb: 40.2,
    weighings,
  };
}

function summarizeEspressoBoilerTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftEspressoBoilerTelemetry {
  const linea = appliances.find(
    (a) => a.appliance === "la-marzocco-linea-classic-s-2g",
  );
  const shots: MorningShiftEspressoShotEvent[] = [
    {
      shotIndex: 1,
      taskId: "espresso-orders#0/extract-espresso",
      orderLabel: "Double Shot #1 (18 g dose → 36 g yield)",
      grouphead: "left",
      brewBoilerC: 93.2,
      groupheadEntryC: 93.2,
      groupheadMinC: 92.82,
      thermalDipC: 0.38,
      pidRecoverySeconds: 10.6,
      pidDutyPercent: 82.5,
      steamBoilerPressureBar: 1.16,
      steamDropBar: 0.16,
      steamRecoverySeconds: 13.3,
    },
    {
      shotIndex: 2,
      taskId: "espresso-orders#1/extract-espresso",
      orderLabel: "Double Shot #2 Back-to-Back (18 g → 36 g)",
      grouphead: "right",
      brewBoilerC: 93.07,
      groupheadEntryC: 93.11,
      groupheadMinC: 92.61,
      thermalDipC: 0.5,
      pidRecoverySeconds: 11.7,
      pidDutyPercent: 89.0,
      steamBoilerPressureBar: 1.1,
      steamDropBar: 0.22,
      steamRecoverySeconds: 14.6,
    },
  ];
  const status: MorningShiftEspressoBoilerTelemetry["status"] =
    linea?.status === "active" ? "back-to-back-recovery" : "pid-locked";
  return {
    status,
    brewBoilerSetpointC: 93.2,
    brewBoilerTempC: linea?.temperatureC ?? 93.1,
    minGroupheadTempC: 92.61,
    maxGroupheadThermalDipC: 0.5,
    meanPidRecoverySeconds: 11.2,
    steamBoilerSetpointC: 124.5,
    steamBoilerPressureBar: 1.16,
    maxSteamDropBar: 0.22,
    meanSteamRecoverySeconds: 14.0,
    shots,
  };
}

function summarizeOvenVentingRadiantTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftOvenVentingRadiantTelemetry {
  const oven = appliances.find((a) => a.appliance === "maruzen-mbco-5e");
  const decks: MorningShiftOvenDeckEvent[] = [
    {
      cycleIndex: 1,
      taskId: "steak-and-pepper-pie-batches#0/bake-pies",
      batchLabel: "Steak and pepper pie tray (Upper Deck)",
      deckZone: "upper-deck",
      chamberC: 200.0,
      chamberRhPercent: 9.5,
      damperOpenRatio: 0.62,
      steamInjectionMl: 0,
      steamVentingGps: 0.88,
      radiantFluxKwPerSqM: 3.42,
      convectiveFluxKwPerSqM: 2.46,
      totalFluxKwPerSqM: 5.88,
      moistureDiffusivitySqMPerSec: 4.2e-9,
      surfaceWaterActivityAw: 0.4,
    },
    {
      cycleIndex: 2,
      taskId: "load-hazelnut-a#0/bake",
      batchLabel: "Hazelnut financier tray (Front-Lower Nominal Deck)",
      deckZone: "front-lower-nominal",
      chamberC: 170.0,
      chamberRhPercent: 18.6,
      damperOpenRatio: 0.78,
      steamInjectionMl: 35.0,
      steamVentingGps: 0.74,
      radiantFluxKwPerSqM: 2.42,
      convectiveFluxKwPerSqM: 1.96,
      totalFluxKwPerSqM: 4.38,
      moistureDiffusivitySqMPerSec: 3.58e-9,
      surfaceWaterActivityAw: 0.48,
    },
    {
      cycleIndex: 3,
      taskId: "load-coffee-a#0/bake",
      batchLabel: "Coffee financier tray (Middle-Rear Hotspot Deck)",
      deckZone: "middle-rear-hotspot",
      chamberC: 184.0,
      chamberRhPercent: 14.2,
      damperOpenRatio: 0.78,
      steamInjectionMl: 35.0,
      steamVentingGps: 0.82,
      radiantFluxKwPerSqM: 3.88,
      convectiveFluxKwPerSqM: 2.54,
      totalFluxKwPerSqM: 6.42,
      moistureDiffusivitySqMPerSec: 5.21e-9,
      surfaceWaterActivityAw: 0.36,
    },
    {
      cycleIndex: 4,
      taskId: "load-matcha-a#0/bake",
      batchLabel: "Matcha financier tray (Front-Lower Nominal Deck)",
      deckZone: "front-lower-nominal",
      chamberC: 170.0,
      chamberRhPercent: 18.6,
      damperOpenRatio: 0.78,
      steamInjectionMl: 35.0,
      steamVentingGps: 0.74,
      radiantFluxKwPerSqM: 2.42,
      convectiveFluxKwPerSqM: 1.96,
      totalFluxKwPerSqM: 4.38,
      moistureDiffusivitySqMPerSec: 3.58e-9,
      surfaceWaterActivityAw: 0.48,
    },
  ];
  const status: MorningShiftOvenVentingRadiantTelemetry["status"] =
    oven?.status === "active" ? "damper-venting" : "hotspot-scorching-alert";
  return {
    status,
    nominalDeckFluxKwPerSqM: 4.38,
    hotspotDeckFluxKwPerSqM: 6.42,
    peakSteamVentingGps: 0.82,
    totalSteamInjectedMl: 105.0,
    peakMoistureDiffusivitySqMPerSec: 5.21e-9,
    minSurfaceWaterActivityAw: 0.32,
    decks,
  };
}

function summarizeDishwasherWarewashTelemetry(
  appliances: readonly SynchronizedApplianceState[],
): MorningShiftDishwasherTelemetry {
  const dishwasher = appliances.find(
    (a) => a.appliance === "winterhalter-uc-l",
  );
  const completedCycles = dishwasher?.completedCount ?? 4;
  const totalCycles = Math.max(completedCycles, dishwasher?.totalCount ?? 12);
  const cycles: MorningShiftDishwasherCycleEvent[] = [
    {
      cycleIndex: 1,
      taskId: "hazelnut-preparation-batches#0/clean",
      vesselLabel: "Beurre Noisette Induction Pan #1",
      soilLoadCategory: "brown-butter-mould",
      washTankC: 62.4,
      rinseBoilerC: 85.2,
      detergentDosedMl: 8.4,
      rinseAidDosedMl: 0.84,
      washBathPh: 11.15,
      sanitizerPpm: 74.2,
      thermalHue: 4120,
      incomingWaterC: 15.5,
      preheatedWaterC: 41.8,
      greywaterDrainC: 34.2,
      heatRecoveredKj: 264.1,
      recoveryEfficiencyPercent: 56.6,
    },
    {
      cycleIndex: 2,
      taskId: "load-hazelnut-a#0/clean-mould",
      vesselLabel: "Financier 8-Cavity Silicone/Steel Mould A",
      soilLoadCategory: "brown-butter-mould",
      washTankC: 62.6,
      rinseBoilerC: 85.3,
      detergentDosedMl: 8.4,
      rinseAidDosedMl: 0.84,
      washBathPh: 11.12,
      sanitizerPpm: 72.8,
      thermalHue: 4180,
      incomingWaterC: 15.5,
      preheatedWaterC: 42.1,
      greywaterDrainC: 34.0,
      heatRecoveredKj: 267.1,
      recoveryEfficiencyPercent: 57.0,
    },
    {
      cycleIndex: 3,
      taskId: "sesame-orders#0/wash-jug",
      vesselLabel: "Black Sesame Latte Jug",
      soilLoadCategory: "sesame-oil-vessel",
      washTankC: 62.5,
      rinseBoilerC: 85.1,
      detergentDosedMl: 8.4,
      rinseAidDosedMl: 0.84,
      washBathPh: 11.18,
      sanitizerPpm: 71.5,
      thermalHue: 4090,
      incomingWaterC: 15.5,
      preheatedWaterC: 41.9,
      greywaterDrainC: 34.1,
      heatRecoveredKj: 265.1,
      recoveryEfficiencyPercent: 56.7,
    },
    {
      cycleIndex: 4,
      taskId: "tea-batches#0/wash-equipment",
      vesselLabel: "Ginger Black Tea Simmer Pan & Strainer",
      soilLoadCategory: "tannin-tea-pan",
      washTankC: 62.1,
      rinseBoilerC: 85.2,
      detergentDosedMl: 7.2,
      rinseAidDosedMl: 0.84,
      washBathPh: 10.94,
      sanitizerPpm: 75.6,
      thermalHue: 4150,
      incomingWaterC: 15.5,
      preheatedWaterC: 41.6,
      greywaterDrainC: 33.9,
      heatRecoveredKj: 262.1,
      recoveryEfficiencyPercent: 56.5,
    },
  ];

  const totalDetergentDosedMl = Number(
    cycles.reduce((sum, c) => sum + c.detergentDosedMl, 0).toFixed(2),
  );
  const totalRinseAidDosedMl = Number(
    cycles.reduce((sum, c) => sum + c.rinseAidDosedMl, 0).toFixed(2),
  );
  const totalGreywaterRecoveredKj = Number(
    cycles.reduce((sum, c) => sum + c.heatRecoveredKj, 0).toFixed(1),
  );
  const totalRecoveredWh = Number((totalGreywaterRecoveredKj / 3.6).toFixed(1));
  const heatRecoveryEfficiencyPercent = Number(
    (
      cycles.reduce((sum, c) => sum + c.recoveryEfficiencyPercent, 0) /
      cycles.length
    ).toFixed(1),
  );
  const status: MorningShiftDishwasherTelemetry["status"] =
    dishwasher?.status === "active"
      ? "heat-recovery-active"
      : "sanitizing-nominal";

  return {
    status,
    completedCycles,
    totalCycles,
    washTankC: 62.4,
    rinseBoilerC: 85.2,
    detergentConcentrationGPerL: 3.35,
    totalDetergentDosedMl,
    totalRinseAidDosedMl,
    sanitizerPpm: 73.5,
    washBathPh: 11.1,
    thermalHue: 4135,
    incomingMakeupWaterC: 15.5,
    preheatedWaterC: 41.9,
    greywaterDrainC: 34.1,
    totalGreywaterRecoveredKj,
    totalRecoveredWh,
    heatRecoveryEfficiencyPercent,
    cycles,
  };
}

function summarizeChillerColdCellTelemetry(
  appliances: readonly SynchronizedApplianceState[],
  roomDryBulbC = 22.1,
  relativeHumidityPercent = 52.0,
): MorningShiftChillerColdCellTelemetry {
  const chiller = appliances.find((a) => a.appliance === "hoshizaki-rt-120snj");
  const summary = chiller?.programSummary ?? "";
  const phase: MorningShiftChillerColdCellTelemetry["phase"] = summary.includes(
    "Defrost Heater",
  )
    ? "defrost-active"
    : summary.includes("Post-Defrost")
      ? "post-defrost-recovery"
      : summary.includes("Door Infiltration") ||
          (chiller?.doorOpenRatio ?? 0) > 0
        ? "door-infiltration-pulldown"
        : "refrigerating";

  const roomHumidityFactor = Number(
    (1 + Math.max(0, relativeHumidityPercent - 48) * 0.015).toFixed(3),
  );
  const roomDeltaFactor = Number(
    (1 + Math.max(0, roomDryBulbC - 21) * 0.025).toFixed(3),
  );

  const events: MorningShiftChillerDoorInfiltrationEvent[] = [
    {
      cycleIndex: 1,
      taskId: "hazelnut-preparation-batches#0/store-batter",
      batchLabel: "Financier Batter Cold Rest #1 (600 g)",
      phase: "door-infiltration-pulldown",
      doorOpenSeconds: 8.4,
      infiltrationHeatKj: Number((4.85 * roomDeltaFactor).toFixed(2)),
      moistureIngressGrams: Number((1.42 * roomHumidityFactor).toFixed(2)),
      cabinetPeakC: 7.4,
      cabinetExitC: 3.4,
      evaporatorCoilC: -6.2,
      frostAccumulatedGrams: 1.7,
      defrostTriggered: false,
      condensateDrainedMl: 0,
    },
    {
      cycleIndex: 2,
      taskId: "sesame-orders#0/dose",
      batchLabel: "Day-Before Sesame Concentrate Pick #1 (door only)",
      phase: "defrost-active",
      doorOpenSeconds: 4.2,
      infiltrationHeatKj: Number((2.57 * roomDeltaFactor).toFixed(2)),
      moistureIngressGrams: Number((0.77 * roomHumidityFactor).toFixed(2)),
      cabinetPeakC: 6.3,
      cabinetExitC: 4.2,
      evaporatorCoilC: 6.4,
      frostAccumulatedGrams: 0.26,
      defrostTriggered: true,
      condensateDrainedMl: 2.92,
    },
    {
      cycleIndex: 3,
      taskId: "load-hazelnut-a#0/transfer-cold-carrier",
      batchLabel: "Financier Tray Cold-Cell Stabilization (188 g)",
      phase: "post-defrost-recovery",
      doorOpenSeconds: 7.6,
      infiltrationHeatKj: Number((4.38 * roomDeltaFactor).toFixed(2)),
      moistureIngressGrams: Number((1.28 * roomHumidityFactor).toFixed(2)),
      cabinetPeakC: 6.9,
      cabinetExitC: 3.3,
      evaporatorCoilC: -6.5,
      frostAccumulatedGrams: 1.39,
      defrostTriggered: false,
      condensateDrainedMl: 0,
    },
    {
      cycleIndex: 4,
      taskId: "sesame-orders#1/dose",
      batchLabel: "Day-Before Sesame Concentrate Pick #2 (door only)",
      phase: "defrost-active",
      doorOpenSeconds: 4.0,
      infiltrationHeatKj: Number((2.45 * roomDeltaFactor).toFixed(2)),
      moistureIngressGrams: Number((0.73 * roomHumidityFactor).toFixed(2)),
      cabinetPeakC: 6.2,
      cabinetExitC: 4.1,
      evaporatorCoilC: 6.4,
      frostAccumulatedGrams: 0.24,
      defrostTriggered: true,
      condensateDrainedMl: 2.77,
    },
  ];

  const totalInfiltrationHeatKj = Number(
    events.reduce((sum, e) => sum + e.infiltrationHeatKj, 0).toFixed(2),
  );
  const totalCondensateDrainedMl = Number(
    events.reduce((sum, e) => sum + e.condensateDrainedMl, 0).toFixed(2),
  );
  const defrostCycleCount = events.filter((e) => e.defrostTriggered).length;
  const doorOpeningsCount = events.length * 2;
  const cabinetAirC = chiller?.temperatureC ?? 3.4;
  const cabinetInfiltrationPeakC = Math.max(
    cabinetAirC,
    ...events.map((e) => e.cabinetPeakC),
  );
  const evaporatorFrostGrams =
    phase === "defrost-active"
      ? 0.28
      : phase === "post-defrost-recovery"
        ? 0.64
        : 1.72;
  const peakFrostGrams = 3.18;
  const evaporatorCoilC =
    phase === "defrost-active"
      ? 6.4
      : phase === "door-infiltration-pulldown"
        ? -5.4
        : -6.5;
  const compressorRpm = chiller?.rpm ?? 900;
  const defrostHeaterWatts = phase === "defrost-active" ? 360 : 0;
  const compressorDutyPercent =
    phase === "defrost-active"
      ? 94.0
      : phase === "door-infiltration-pulldown" || chiller?.status === "active"
        ? 88.5
        : 64.0;
  const copEfficiency = Number(
    Math.max(
      1.68,
      2.28 - (roomDryBulbC - 21) * 0.045 - evaporatorFrostGrams * 0.08,
    ).toFixed(2),
  );

  return {
    phase,
    cabinetAirC,
    cabinetInfiltrationPeakC,
    evaporatorCoilC,
    evaporatorFrostGrams,
    peakFrostGrams,
    defrostCycleCount,
    totalCondensateDrainedMl,
    doorOpeningsCount,
    totalInfiltrationHeatKj,
    compressorRpm,
    compressorDutyPercent,
    defrostHeaterWatts,
    copEfficiency,
    events,
  };
}

export function computeApplianceAcousticsAndVibration(
  appliance: MorningShiftApplianceCode,
  status: SynchronizedApplianceState["status"],
  completedCount: number,
  torqueNm: number,
  viscosityPas: number,
  pressureBar: number,
): Readonly<{
  acousticNoiseDba: number;
  vibrationMmPerSecRms: number;
  peakAcousticNoiseDba: number;
  peakVibrationMmPerSecRms: number;
  isRotary: boolean;
}> {
  const hasCycleHistory =
    status === "active" || completedCount > 0 || status === "fault";
  switch (appliance) {
    case "waring-wsg60": {
      // 18,000 RPM commercial spice/paste grinder
      const activeDba = Number(
        (83.6 + torqueNm * 1.8 + Math.min(12, viscosityPas) * 0.14).toFixed(1),
      );
      const activeVib = Number(
        (2.85 + Math.min(12, viscosityPas) * 0.22 + torqueNm * 1.35).toFixed(2),
      );
      const peakDba = hasCycleHistory ? Math.max(85.8, activeDba) : 38.0;
      const peakVib = hasCycleHistory ? Math.max(5.95, activeVib) : 0.08;
      if (status === "fault") {
        return {
          acousticNoiseDba: 72.4,
          vibrationMmPerSecRms: 3.15,
          peakAcousticNoiseDba: peakDba,
          peakVibrationMmPerSecRms: peakVib,
          isRotary: true,
        };
      }
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 44.2 : 38.0,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.34 : 0.08,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "vitamix-quiet-one": {
      // 9,500 RPM blender with magnetic sound enclosure (or +10 dBA / unseated jar vibration when lid-faulted)
      const activeDba = Number(
        (66.4 + torqueNm * 2.2 + Math.min(8, viscosityPas) * 0.32).toFixed(1),
      );
      const activeVib = Number(
        (1.75 + Math.min(8, viscosityPas) * 0.26 + torqueNm * 0.85).toFixed(2),
      );
      if (status === "fault") {
        return {
          acousticNoiseDba: 78.6,
          vibrationMmPerSecRms: 4.85,
          peakAcousticNoiseDba: 78.6,
          peakVibrationMmPerSecRms: 4.85,
          isRotary: true,
        };
      }
      const peakDba = hasCycleHistory ? Math.max(69.2, activeDba) : 38.5;
      const peakVib = hasCycleHistory ? Math.max(3.42, activeVib) : 0.09;
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 43.8 : 38.5,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.28 : 0.09,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "hobart-hl200": {
      // 185 RPM 20-qt planetary mixer gearhead
      const activeDba = Number(
        (64.5 + torqueNm * 0.65 + Math.min(6, viscosityPas) * 0.4).toFixed(1),
      );
      const activeVib = Number(
        (1.45 + torqueNm * 0.24 + Math.min(6, viscosityPas) * 0.18).toFixed(2),
      );
      if (status === "fault") {
        // Interlock brake trip & safety cage alarm
        return {
          acousticNoiseDba: 74.8,
          vibrationMmPerSecRms: 3.42,
          peakAcousticNoiseDba: 74.8,
          peakVibrationMmPerSecRms: 4.65,
          isRotary: true,
        };
      }
      const peakDba = hasCycleHistory ? Math.max(72.8, activeDba) : 39.0;
      const peakVib = hasCycleHistory ? Math.max(4.52, activeVib) : 0.1;
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 45.6 : 39.0,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.42 : 0.1,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "la-marzocco-linea-classic-s-2g": {
      // 1,725 RPM 9-bar brass rotary vane pump
      const activeDba = Number((63.8 + pressureBar * 0.62).toFixed(1));
      const activeVib = Number((1.25 + pressureBar * 0.16).toFixed(2));
      const peakDba = hasCycleHistory ? Math.max(69.4, activeDba) : 43.5;
      const peakVib = hasCycleHistory ? Math.max(2.69, activeVib) : 0.18;
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 46.8 : 43.5,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.36 : 0.18,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "severin-sm-3587": {
      // 2,400 RPM magnetic induction milk frother
      const activeDba = Number((56.4 + viscosityPas * 4.5).toFixed(1));
      const activeVib = Number((0.92 + viscosityPas * 0.8).toFixed(2));
      const peakDba = hasCycleHistory ? Math.max(57.2, activeDba) : 37.5;
      const peakVib = hasCycleHistory ? Math.max(1.06, activeVib) : 0.06;
      return {
        acousticNoiseDba:
          status === "active" ? activeDba : completedCount > 0 ? 40.2 : 37.5,
        vibrationMmPerSecRms:
          status === "active" ? activeVib : completedCount > 0 ? 0.14 : 0.06,
        peakAcousticNoiseDba: peakDba,
        peakVibrationMmPerSecRms: peakVib,
        isRotary: true,
      };
    }
    case "maruzen-mbco-5e": {
      // 1,450 RPM reversing convection blower
      const liveDba =
        status === "fault"
          ? 66.2
          : status === "active"
            ? 59.5
            : completedCount > 0
              ? 48.4
              : 41.0;
      const liveVib =
        status === "active" ? 1.18 : completedCount > 0 ? 0.45 : 0.14;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: hasCycleHistory ? Math.max(59.5, liveDba) : 41.0,
        peakVibrationMmPerSecRms: hasCycleHistory ? 1.18 : 0.14,
        isRotary: true,
      };
    }
    case "hoshizaki-rt-120snj": {
      // 2,100 / 900 RPM hermetic rotary refrigeration compressor
      const liveDba = Number(
        (status === "active"
          ? 54.2 + (pressureBar - 1.8) * 2.5
          : 47.5 + (pressureBar - 1.8) * 1.8
        ).toFixed(1),
      );
      const liveVib = status === "active" ? 1.38 : 0.62;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: Math.max(55.7, liveDba),
        peakVibrationMmPerSecRms: 1.38,
        isRotary: true,
      };
    }
    case "winterhalter-uc-l": {
      // 2,800 RPM undercounter wash circulation pump
      const liveDba =
        status === "fault"
          ? 64.5
          : status === "active"
            ? 63.4
            : completedCount > 0
              ? 44.5
              : 42.0;
      const liveVib =
        status === "active" ? 1.95 : completedCount > 0 ? 0.28 : 0.15;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: hasCycleHistory ? 63.4 : 42.0,
        peakVibrationMmPerSecRms: hasCycleHistory ? 1.95 : 0.15,
        isRotary: true,
      };
    }
    case "maruzen-mih-02c":
    case "vollrath-59500p": {
      const liveDba =
        status === "active" ? 54.8 : completedCount > 0 ? 42.5 : 39.5;
      const liveVib =
        status === "active" ? 0.56 : completedCount > 0 ? 0.12 : 0.08;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: hasCycleHistory ? 54.8 : 39.5,
        peakVibrationMmPerSecRms: hasCycleHistory ? 0.56 : 0.08,
        isRotary: false,
      };
    }
    case "ohaus-ranger-3000":
      return {
        acousticNoiseDba: 36.5,
        vibrationMmPerSecRms: 0.04,
        peakAcousticNoiseDba: 36.5,
        peakVibrationMmPerSecRms: 0.04,
        isRotary: false,
      };
    case "pastry-bench": {
      const liveDba =
        status === "active" ? 48.2 : completedCount > 0 ? 38.4 : 37.0;
      const liveVib =
        status === "active" ? 0.34 : completedCount > 0 ? 0.06 : 0.04;
      return {
        acousticNoiseDba: liveDba,
        vibrationMmPerSecRms: liveVib,
        peakAcousticNoiseDba: hasCycleHistory ? 48.2 : 37.0,
        peakVibrationMmPerSecRms: hasCycleHistory ? 0.34 : 0.04,
        isRotary: false,
      };
    }
  }
}
