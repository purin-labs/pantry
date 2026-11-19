import { hasExactKeys, isRecord } from "@purin-labs/std";
import {
  parseApplianceRequestEnvelope,
  parseApplianceResult,
  type ApplianceRequest,
  type ApplianceResult,
} from "./bakery-appliance-protocol.ts";

export const MAX_ESPRESSO_FILE_BYTES = 34 * 1024 * 1024;
export type SavedEspressoRun = Readonly<{
  request: ApplianceRequest;
  result: ApplianceResult;
  telemetry: readonly EspressoTelemetry[];
}>;

export function saveEspressoRun(run: SavedEspressoRun): string {
  assertEspressoRequest(run.request);
  return JSON.stringify({
    kind:
      run.request.appliance === "la-marzocco-linea-classic-s-2g"
        ? "linea-rehearsal"
        : "eagle-rehearsal",
    schemaVersion: 1,
    request: run.request,
    recording: run.result.file,
  });
}

export function readEspressoRun(file: string): SavedEspressoRun {
  if (new TextEncoder().encode(file).length > MAX_ESPRESSO_FILE_BYTES)
    throw new Error("The espresso file exceeds 34 MiB.");
  const raw: unknown = JSON.parse(file);
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["kind", "schemaVersion", "request", "recording"]) ||
    (raw.kind !== "linea-rehearsal" && raw.kind !== "eagle-rehearsal") ||
    raw.schemaVersion !== 1 ||
    typeof raw.recording !== "string"
  )
    throw new Error("Choose a saved espresso rehearsal file.");
  const request = parseApplianceRequestEnvelope(raw.request);
  const expected =
    raw.kind === "linea-rehearsal"
      ? "la-marzocco-linea-classic-s-2g"
      : "victoria-arduino-eagle-one-2g";
  if (request.appliance !== expected)
    throw new Error("The saved run belongs to another appliance.");
  const body: unknown = JSON.parse(request.file);
  if (
    !isRecord(body) ||
    body.run_id !== request.runId ||
    body.attempt_id !== request.attemptId
  )
    throw new Error("The saved request identity differs from its envelope.");
  const result = parseApplianceResult(raw.recording, request);
  return prepareEspressoRun(request, result);
}

export type EspressoTelemetry = Readonly<{
  cups: readonly Readonly<{
    mass_g: number;
    temperature_c: number;
    position: "placed" | "removed";
  }>[];
  hotWaterDose: number;
  shotDoses: readonly [readonly [number, number], readonly [number, number]];
}>;

function bounded(raw: unknown, minimum: number, maximum: number): number {
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw < minimum ||
    raw > maximum
  )
    throw new Error("Invalid saved espresso value.");
  return raw;
}
function readDosePair(raw: unknown): readonly [number, number] {
  if (!Array.isArray(raw) || raw.length !== 2)
    throw new Error("Invalid saved dose pair.");
  return [bounded(raw[0], 1, 60), bounded(raw[1], 1, 60)];
}
function readCup(raw: unknown): EspressoTelemetry["cups"][number] {
  if (
    !isRecord(raw) ||
    (raw.position !== "placed" && raw.position !== "removed")
  )
    throw new Error("Invalid saved cup.");
  return {
    mass_g: bounded(raw.mass_g, 0, 250),
    temperature_c: bounded(raw.temperature_c, 0, 130),
    position: raw.position,
  };
}
function readTelemetry(text: string): EspressoTelemetry {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw) || !isRecord(raw.espresso))
    throw new Error("Missing espresso state.");
  const espresso = raw.espresso;
  if (
    !Array.isArray(espresso.cups) ||
    espresso.cups.length !== 3 ||
    !Array.isArray(espresso.shot_doses_s) ||
    espresso.shot_doses_s.length !== 2
  )
    throw new Error("Invalid saved cups or presets.");
  return {
    cups: espresso.cups.map(readCup),
    hotWaterDose: bounded(espresso.hot_water_dose_s, 1, 60),
    shotDoses: [
      readDosePair(espresso.shot_doses_s[0]),
      readDosePair(espresso.shot_doses_s[1]),
    ],
  };
}
export function prepareEspressoRun(
  request: ApplianceRequest,
  result: ApplianceResult,
): SavedEspressoRun {
  assertEspressoRequest(request);
  return {
    request,
    result,
    telemetry: result.samples.map(readSampleTelemetry),
  };
}
function readSampleTelemetry(
  sample: ApplianceResult["samples"][number],
): EspressoTelemetry {
  return readTelemetry(sample.telemetryText);
}

function assertEspressoRequest(request: ApplianceRequest): void {
  if (
    request.appliance !== "la-marzocco-linea-classic-s-2g" &&
    request.appliance !== "victoria-arduino-eagle-one-2g"
  )
    throw new Error("Choose an espresso appliance.");
}
