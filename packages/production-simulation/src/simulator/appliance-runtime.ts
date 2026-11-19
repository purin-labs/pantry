import { isRecord } from "@seams/std";
import { checkpointBody } from "@seams/bakery-model/bakery-checkpoint";
import type {
  ApplianceRequest,
  ApplianceResult,
} from "@seams/bakery-model/bakery-appliance-protocol";
import {
  BAKERY_APPLIANCE_BUILDS,
  BAKERY_BROWSER_BUNDLE,
} from "./browser-physics-asset.ts";

export type RuntimeFile = Readonly<{
  file: string;
  sha256: string;
  byteLength: number;
}>;
/**
 * A runtime bundle's descriptor. Schema 1 has one data file; schema 2
 * (Refactor 16, step 11) has the model index and one entry for each pack,
 * keyed `pack:<name>`.
 */
export type ApplianceRuntimeBundle = Readonly<{
  id: string;
  schemaVersion: number;
  files: Readonly<
    { module: RuntimeFile; wasm: RuntimeFile; data?: RuntimeFile } & Record<
      string,
      RuntimeFile
    >
  >;
}>;
export type ApplianceVisual = Readonly<{ url: string; sha256: string }>;
type Build = (typeof BAKERY_APPLIANCE_BUILDS)[number];

function matchesExecution(build: Build, execution: unknown): boolean {
  return (
    isRecord(execution) &&
    build.execution.backend === execution.backend &&
    build.execution.controllerSourceHash === execution.controllerSourceHash &&
    build.execution.controllerHash === execution.controllerHash &&
    build.execution.runtimeHash === execution.runtimeHash
  );
}

function retainedBuild(raw: unknown): Build {
  const checkpoint = checkpointBody(raw);
  if (checkpoint === null || !isRecord(checkpoint.execution))
    throw new Error("Invalid appliance checkpoint identity.");
  const execution = checkpoint.execution;
  for (const build of BAKERY_APPLIANCE_BUILDS) {
    if (
      build.appliance === checkpoint.appliance &&
      build.modelHash === checkpoint.model_hash &&
      matchesExecution(build, execution)
    )
      return build;
  }
  throw new Error(
    "The exact runtime or visual for this saved appliance is unavailable. The saved state was not changed.",
  );
}
export function applianceRuntime(
  request: ApplianceRequest,
): ApplianceRuntimeBundle {
  const raw: unknown = JSON.parse(request.file);
  if (!isRecord(raw) || !isRecord(raw.initial))
    throw new Error("Invalid appliance request.");
  if (raw.initial.kind === "fresh") return BAKERY_BROWSER_BUNDLE;
  if (raw.initial.kind !== "continue")
    throw new Error("Invalid appliance opening.");
  const checkpoint = checkpointBody(raw.initial.checkpoint);
  if (checkpoint === null) throw new Error("Invalid appliance checkpoint.");
  // Runtime identity is shared by all appliances. Rust still checks the selected model.
  for (const build of BAKERY_APPLIANCE_BUILDS) {
    if (matchesExecution(build, checkpoint.execution)) return build.bundle;
  }
  throw new Error(
    "The exact saved appliance runtime is unavailable. The current run is unchanged.",
  );
}
export function applianceVisual(result: ApplianceResult): ApplianceVisual {
  const raw: unknown = JSON.parse(result.file);
  if (!isRecord(raw)) throw new Error("Invalid appliance recording.");
  const build = retainedBuild(raw.continuation);
  return {
    url: `/bakery-physics/visuals/${build.visual.file}`,
    sha256: build.visual.sha256,
  };
}
