import { readProcedure } from "./procedure-api.ts";
import {
  bakeryFingerprint,
  fields,
  sampleSettings,
  type Settings,
} from "@purin-labs/bakery-model/bakery";
import type { CompiledProcedure } from "@purin-labs/bakery-model/bakery-procedure";
import {
  parseScenarioCopy,
  type ScenarioCopy,
} from "@purin-labs/bakery-model/bakery-scenario";

import { ControlApiError } from "@purin-labs/control/portal/control-client";
import type { CommerceMutationTransport } from "../commerce/entity-plane/api";
import type { ProcedureRun } from "@purin-labs/production-simulation/simulator/procedure";
import { readScenario, type ScenarioRead } from "./scenario-api";
import type { Variant } from "@purin-labs/type-utils";

type WorkspaceCommandConnection = Readonly<{
  organisationId: string;
  mutate: CommerceMutationTransport;
}>;

type ScenarioSaveResult =
  | Readonly<{
      kind: "verified";
      scenario: Variant<ScenarioRead, "ready">;
      notice: string;
    }>
  | Readonly<{
      kind: "saved-readback-failed";
      id: string;
      message: string;
    }>
  | Readonly<{
      kind: "outcome-unknown";
      id: string;
      message: string;
    }>
  | Readonly<{ kind: "failed-before-save"; message: string }>;

type ProcedureReadResult =
  | Readonly<{ kind: "ready"; procedure: CompiledProcedure }>
  | Readonly<{ kind: "failed"; message: string }>;

type WorkspaceCommandDependencies = Readonly<{
  fingerprint(revisionKey: string): Promise<string>;
  readProcedure(
    organisationId: string,
    procedureId: string,
    assumptions: Settings,
  ): Promise<
    | Readonly<{ kind: "ready"; procedure: CompiledProcedure }>
    | Readonly<{ kind: "invalid"; message: string }>
  >;
  readScenario(
    organisationId: string,
    scenarioId: string,
  ): Promise<ScenarioRead>;
}>;

const defaultDependencies: WorkspaceCommandDependencies = {
  fingerprint: bakeryFingerprint,
  readProcedure: readProcedureDefault,
  readScenario: readScenarioDefault,
};

export async function saveScenarioCopy(
  connection: WorkspaceCommandConnection,
  input: Readonly<{
    id: string;
    name: string;
    note: string;
    procedureRun: ProcedureRun;
  }>,
  dependencies: WorkspaceCommandDependencies = defaultDependencies,
): Promise<ScenarioSaveResult> {
  let copy: ScenarioCopy;
  try {
    const fingerprint = await dependencies.fingerprint(
      input.procedureRun.source.revisionKey,
    );
    const body = {
      id: input.id,
      name: input.name,
      note: input.note,
      procedureId: input.procedureRun.source.reference.entityId,
      fingerprint,
      settings: input.procedureRun.schedule.settings,
    };
    const parsed = parseScenarioCopy(body);
    if (parsed === null) {
      throw new Error("Invalid scenario inputs");
    }
    copy = parsed;
  } catch {
    return {
      kind: "failed-before-save",
      message:
        "Unable to prepare this scenario copy. Review its inputs before saving.",
    };
  }
  return savePreparedScenarioCopy(
    connection,
    copy,
    { kind: "manual" },
    dependencies,
  );
}

type ScenarioSaveOrigin =
  | Readonly<{ kind: "manual" }>
  | Readonly<{ kind: "agent_effect"; effectId: string }>;

export async function savePreparedScenarioCopy(
  connection: WorkspaceCommandConnection,
  copy: ScenarioCopy,
  origin: ScenarioSaveOrigin,
  dependencies: WorkspaceCommandDependencies = defaultDependencies,
): Promise<ScenarioSaveResult> {
  let response: unknown;
  try {
    response = await connection.mutate(
      `/v1/control/organisations/${encodeURIComponent(connection.organisationId)}/commerce/bakery/scenario`,
      {
        id: copy.id,
        name: copy.name,
        note: copy.note,
        procedureId: copy.procedureId,
        fingerprint: copy.fingerprint,
        settings: copy.settings,
        ...(origin.kind === "agent_effect"
          ? { agentEffectId: origin.effectId }
          : {}),
      },
      "Save scenario copy",
    );
  } catch (error) {
    const rejection = scenarioSaveRejection(error);
    if (rejection !== null) return rejection;
    return reconcileUnconfirmedScenario(
      connection.organisationId,
      copy,
      origin,
      dependencies,
    );
  }
  if (!matchesScenarioResponse(response, copy.id))
    return reconcileUnconfirmedScenario(
      connection.organisationId,
      copy,
      origin,
      dependencies,
    );
  try {
    const scenario = await dependencies.readScenario(
      connection.organisationId,
      copy.id,
    );
    if (scenario.kind !== "ready" || !sameScenarioCopy(scenario.copy, copy)) {
      return {
        kind: "saved-readback-failed",
        id: copy.id,
        message: `Saved scenario ${copy.id}, but readback could not verify the submitted copy. Open that ID to check it.`,
      };
    }
    return {
      kind: "verified",
      scenario,
      notice: `Saved “${copy.name}”. Scenario entity ID: ${copy.id}. Timing note: ${copy.note}`,
    };
  } catch {
    return {
      kind: "saved-readback-failed",
      id: copy.id,
      message: `Saved scenario ${copy.id}, but readback failed. Open that ID to check it.`,
    };
  }
}

async function reconcileUnconfirmedScenario(
  organisationId: string,
  copy: ScenarioCopy,
  origin: ScenarioSaveOrigin,
  dependencies: WorkspaceCommandDependencies,
): Promise<ScenarioSaveResult> {
  try {
    const scenario = await dependencies.readScenario(organisationId, copy.id);
    if (
      scenario.kind === "ready" &&
      sameScenarioCopy(scenario.copy, copy) &&
      origin.kind === "manual"
    )
      return {
        kind: "verified",
        scenario,
        notice: `Saved and verified “${copy.name}”. Scenario entity ID: ${copy.id}.`,
      };
  } catch {
    return unknownScenarioOutcome(copy.id);
  }
  return unknownScenarioOutcome(copy.id);
}

function unknownScenarioOutcome(scenarioId: string): ScenarioSaveResult {
  return {
    kind: "outcome-unknown",
    id: scenarioId,
    message: `The save outcome for scenario ${scenarioId} is uncertain. Open that ID to check it before another save.`,
  };
}

export function sameScenarioCopy(
  left: ScenarioCopy,
  right: ScenarioCopy,
): boolean {
  if (
    left.id !== right.id ||
    left.name !== right.name ||
    left.note !== right.note ||
    left.procedureId !== right.procedureId ||
    left.fingerprint !== right.fingerprint
  )
    return false;
  for (const field of fields)
    if (left.settings[field.key] !== right.settings[field.key]) return false;
  return true;
}

export async function loadScenarioCopy(
  organisationId: string,
  scenarioId: string,
  dependencies: WorkspaceCommandDependencies = defaultDependencies,
): Promise<ScenarioRead | Readonly<{ kind: "failed"; message: string }>> {
  try {
    return await dependencies.readScenario(organisationId, scenarioId);
  } catch {
    return {
      kind: "failed",
      message:
        "Unable to load this scenario. Check its entity ID and your workspace access, then retry. Your current replay is unchanged.",
    };
  }
}

export async function createWorkspaceSample(
  connection: WorkspaceCommandConnection,
  dependencies: WorkspaceCommandDependencies = defaultDependencies,
): Promise<ProcedureReadResult> {
  try {
    const response = await connection.mutate(
      `/v1/control/organisations/${encodeURIComponent(connection.organisationId)}/commerce/bakery/sample`,
      {},
      "Create financier sample",
    );
    const procedureId = readProcedureId(response);
    if (procedureId === null) {
      return sampleCreationFailure();
    }
    const result = await dependencies.readProcedure(
      connection.organisationId,
      procedureId,
      sampleSettings(),
    );
    if (result.kind === "invalid") {
      return { kind: "failed", message: result.message };
    }
    return { kind: "ready", procedure: result.procedure };
  } catch {
    return sampleCreationFailure();
  }
}

export async function loadWorkspaceProcedure(
  organisationId: string,
  procedureId: string,
  assumptions: Settings,
  dependencies: WorkspaceCommandDependencies = defaultDependencies,
): Promise<ProcedureReadResult> {
  try {
    const result = await dependencies.readProcedure(
      organisationId,
      procedureId,
      assumptions,
    );
    if (result.kind === "invalid") {
      return { kind: "failed", message: result.message };
    }
    return { kind: "ready", procedure: result.procedure };
  } catch {
    return {
      kind: "failed",
      message:
        "Unable to load this procedure. Check its entity ID and your workspace access, then retry. Your current simulation is unchanged.",
    };
  }
}

function matchesScenarioResponse(raw: unknown, scenarioId: string): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    "scenarioId" in raw &&
    raw.scenarioId === scenarioId
  );
}

function readProcedureId(raw: unknown): string | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("procedureId" in raw) ||
    typeof raw.procedureId !== "string"
  ) {
    return null;
  }
  return raw.procedureId;
}

export function scenarioSaveRejection(
  error: unknown,
): Readonly<{ kind: "failed-before-save"; message: string }> | null {
  if (!(error instanceof ControlApiError)) return null;
  switch (error.kind) {
    case "bakery_scenario_stale":
    case "bakery_scenario_invalid":
    case "bakery_agent_save_approval_invalid":
      return { kind: "failed-before-save", message: error.message };
    default:
      return null;
  }
}

async function readProcedureDefault(
  organisationId: string,
  procedureId: string,
  assumptions: Settings,
): ReturnType<WorkspaceCommandDependencies["readProcedure"]> {
  return readProcedure(organisationId, procedureId, assumptions);
}

async function readScenarioDefault(
  organisationId: string,
  scenarioId: string,
): ReturnType<WorkspaceCommandDependencies["readScenario"]> {
  return readScenario(organisationId, scenarioId);
}

function sampleCreationFailure(): ProcedureReadResult {
  return {
    kind: "failed",
    message:
      "Unable to create or load the workspace sample. Retry to resume setup. Existing records and your current simulation are preserved.",
  };
}
