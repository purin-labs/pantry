import type { DeviceReadiness } from "@purin-labs/control-api";
import type { BakeRunInput } from "@purin-labs/production-simulation/physical";
import type { OrganisationDatabase } from "../../database-handles";
import type { OrganisationId } from "../../ids";
import type { Result } from "../../result";
import { readBakeAuthority } from "./authority";
import type { BakeProposal } from "./records";
import type { BakeRunError, BakeRunStart } from "./run";
import {
  bakeRunIdOf,
  readBakeRun,
  writeBakeRunNotStarted,
  type BakeRunSummary,
} from "./run-records";
import type { BakeRunDevice } from "./run-store";

/**
 * The start of an approved proposal's bake run (Plan 24 S4, D1: one approval
 * covers the run, its load and its unload). The run compiles from the
 * proposal: its mould groups, its recipe revision, the oven program of the
 * recipe, and the active enrolled devices at the kitchen: two cobots that
 * move mould groups and one oven that bakes. If a device is missing or not
 * ready, the run does not start, and the proposal shows the reason. A person
 * starts it again when the devices are ready; the approval stands.
 *
 * S5: the run takes the authority of its kitchen location when it starts. A
 * shadow run compiles the same plan and only watches; it reserves and sends
 * nothing.
 */

/** A device at the kitchen as the Devices page has it now. */
type BakeKitchenDevice = Readonly<{
  deviceId: string;
  gatewayId: string;
  locationId: string;
  sourceKey: string;
  name: string;
  capabilities: readonly string[];
  readiness: DeviceReadiness;
}>;

export type BakeRunLaunchPorts = Readonly<{
  kitchenDevices(location: string): Promise<readonly BakeKitchenDevice[]>;
  /**
   * The bake time of the proposal's recipe revision, and the time of its
   * step between the bake and the unload, in seconds; null without a bake.
   */
  recipeTimes(proposal: BakeProposal): Promise<Readonly<{
    bakeSeconds: number;
    unloadGraceSeconds: number | null;
  }> | null>;
  /** Starts the run's Durable Object, which sends the first task. */
  launch(start: BakeRunStart): Promise<Result<null, BakeRunError>>;
}>;

export type BakeRunStartError = Readonly<{ code: string; message: string }>;

const MOVE_CAPABILITY = "move_mould_group";
const BAKE_CAPABILITY = "bake";
/** The oven of the simulation phase has four shelves. */
const OVEN_SHELVES = 4;
/**
 * The nominal seconds of a load and an unload, from the FR10 table-to-oven
 * and oven-to-table physics cases (Plan 24 S2). The plan uses them; the
 * receipts give the observed times.
 */
const MOVE_SECONDS = { load: 38.5, unload: 40 } as const;
/** The recipe revision holds no oven temperature yet; Kitchen's default. */
const OVEN_TEMPERATURE_C = 180;
/**
 * S6: the over-bake grace of a recipe with no step between its bake and its
 * unload. The financier recipe's `examine-bake` step gives 30 s.
 */
const UNLOAD_GRACE_SECONDS = 60;

function problem(
  code: string,
  message: string,
): Result<never, BakeRunStartError> {
  return { ok: false, error: { code, message } };
}

function describe(readiness: DeviceReadiness): string {
  switch (readiness.kind) {
    case "blocked":
      return readiness.reason.replaceAll("_", " ");
    case "busy":
      return "busy with another task";
    default:
      return readiness.kind.replaceAll("_", " ");
  }
}

/** Chooses the run's devices and builds its engine input from the proposal. */
async function planRun(
  proposal: BakeProposal,
  ports: BakeRunLaunchPorts,
): Promise<
  Result<
    Readonly<{
      input: BakeRunInput;
      devices: readonly BakeRunDevice[];
      unloadGraceSeconds: number;
    }>,
    BakeRunStartError
  >
> {
  if (proposal.mouldGroups > OVEN_SHELVES)
    return problem(
      "bake_run_too_large",
      `The oven holds ${OVEN_SHELVES} mould groups, and this proposal has ${proposal.mouldGroups}.`,
    );
  const found = await ports.kitchenDevices(proposal.kitchenLocation);
  // The first two by name: a load prefers the first, an unload the second.
  const cobots = found
    .filter((device) => device.capabilities.includes(MOVE_CAPABILITY))
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.sourceKey.localeCompare(right.sourceKey),
    )
    .slice(0, 2);
  const oven =
    found.find(
      (device) =>
        device.deviceId === proposal.oven?.deviceId &&
        device.capabilities.includes(BAKE_CAPABILITY),
    ) ?? found.find((device) => device.capabilities.includes(BAKE_CAPABILITY));
  const [first, second] = cobots;
  if (first === undefined || second === undefined)
    return problem(
      "bake_run_cobot_missing",
      `The run needs two active cobots with the ${MOVE_CAPABILITY} capability at ${proposal.kitchenLocation}, and ${cobots.length} are enrolled. Confirm them on the Devices page.`,
    );
  if (oven === undefined)
    return problem(
      "bake_run_oven_missing",
      `No active oven with the bake capability is enrolled at ${proposal.kitchenLocation}.`,
    );
  for (const device of [first, second, oven])
    if (device.readiness.kind !== "ready")
      return problem(
        "bake_run_device_not_ready",
        `${device.name} is not ready: ${describe(device.readiness)}. Check it on the Devices page, then start the run.`,
      );
  const times = await ports.recipeTimes(proposal);
  if (times === null)
    return problem(
      "bake_run_program_missing",
      `Recipe revision ${proposal.workflowRevision} has no bake step with a time.`,
    );
  const devices: BakeRunDevice[] = [
    ...[first, second].map((device) => ({
      ...plain(device),
      role: "cobot" as const,
    })),
    { ...plain(oven), role: "oven" as const },
  ];
  const input: BakeRunInput = {
    runId: bakeRunIdOf(proposal.proposalId),
    recipeRevision: proposal.workflowDigest,
    mouldGroups: Array.from({ length: proposal.mouldGroups }, (_, index) => ({
      mouldGroup: index + 1,
      coldRackShelf: index + 1,
      ovenShelf: index + 1,
      coolingRackShelf: index + 1,
    })),
    oven: {
      programSeconds: times.bakeSeconds,
      temperatureC: OVEN_TEMPERATURE_C,
    },
    cobots: [first.sourceKey, second.sourceKey],
    ovenSource: oven.sourceKey,
    moveSeconds: MOVE_SECONDS,
  };
  return {
    ok: true,
    value: {
      input,
      devices,
      unloadGraceSeconds: times.unloadGraceSeconds ?? UNLOAD_GRACE_SECONDS,
    },
  };
}

function plain(device: BakeKitchenDevice): Omit<BakeRunDevice, "role"> {
  return {
    deviceId: device.deviceId,
    gatewayId: device.gatewayId,
    locationId: device.locationId,
    sourceKey: device.sourceKey,
    name: device.name,
  };
}

/**
 * Starts the run of an approved proposal, once. A run that did not start
 * keeps its reason on the proposal; a second call tries again.
 */
export async function startProposalRun(
  db: OrganisationDatabase,
  organisationId: OrganisationId,
  proposal: BakeProposal,
  ports: BakeRunLaunchPorts,
  now: number,
): Promise<Result<BakeRunSummary | null, BakeRunStartError>> {
  const runId = bakeRunIdOf(proposal.proposalId);
  const existing = await readBakeRun(db, organisationId, runId);
  if (existing !== null && existing.state !== "not_started")
    return { ok: true, value: existing };
  const decision = proposal.decision;
  if (proposal.state !== "approved" || decision === null)
    return problem(
      "bake_proposal_not_approved",
      "Only an approved proposal starts a bake run.",
    );
  const mode = await readBakeAuthority(
    db,
    organisationId,
    proposal.kitchenLocation,
  );
  const planned = await planRun(proposal, ports);
  const launched = planned.ok
    ? await ports.launch({
        runId,
        proposalId: proposal.proposalId,
        productName: proposal.productName,
        mode,
        input: planned.value.input,
        devices: planned.value.devices,
        unloadGraceSeconds: planned.value.unloadGraceSeconds,
        approval: {
          by: decision.by,
          role: decision.role,
          via: decision.via,
          at: decision.at,
        },
      })
    : planned;
  if (!launched.ok) {
    await writeBakeRunNotStarted(db, organisationId, {
      runId,
      proposalId: proposal.proposalId,
      mode,
      code: launched.error.code,
      message: launched.error.message,
      now,
    });
    return launched;
  }
  return { ok: true, value: await readBakeRun(db, organisationId, runId) };
}
