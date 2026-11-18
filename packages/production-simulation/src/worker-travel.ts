import type { Variant } from "@seams/type-utils";
import type { ControlCommand } from "./commands.ts";
import type { AcceptedEvent } from "./events.ts";
import type { CommandId, LocationId, ResourceId } from "./identity.ts";
import type { ResourceDefinition, TravelRoute } from "./scenario.ts";
import type { RunState } from "./state.ts";
import { tickDuration, ZERO_DURATION, type TickDuration } from "./time.ts";

type UpdateWorkerTravelCommand = Extract<
  ControlCommand,
  { kind: "update-worker-travel" }
>;

export function routePairKey(from: LocationId, to: LocationId): string {
  return `${from}\0${to}`;
}

export function travelDurationFromRoutes(
  routes: readonly TravelRoute[],
  from: LocationId,
  to: LocationId,
): TickDuration | null {
  if (from === to) return ZERO_DURATION;
  for (const route of routes)
    if (route.from === from && route.to === to) return route.duration;
  return null;
}

export function validTravelRouteReplacement(
  baseTravel: readonly TravelRoute[],
  travel: readonly TravelRoute[],
): boolean {
  if (travel.length !== baseTravel.length) return false;
  const expected = new Set<string>();
  for (const route of baseTravel)
    expected.add(routePairKey(route.from, route.to));
  const seen = new Set<string>();
  for (const route of travel) {
    if (route.from === route.to || !tickDuration(route.duration).ok)
      return false;
    const key = routePairKey(route.from, route.to);
    if (seen.has(key) || !expected.has(key)) return false;
    seen.add(key);
  }
  return seen.size === expected.size;
}

export function validWorkerTravelReplacement(
  worker: Variant<ResourceDefinition, "worker">,
  travel: readonly TravelRoute[],
): boolean {
  return validTravelRouteReplacement(worker.travel, travel);
}

export function acceptedCommandsById(
  run: RunState,
): ReadonlyMap<CommandId, ControlCommand> {
  const accepted = new Map<CommandId, ControlCommand>();
  for (const entry of run.commands)
    if (entry.receipt.status === "accepted")
      accepted.set(entry.command.commandId, entry.command);
  return accepted;
}

export function admittedWorkerTravelCommand(
  acceptedCommands: ReadonlyMap<CommandId, ControlCommand>,
  event: AcceptedEvent,
): UpdateWorkerTravelCommand | null {
  if (event.kind !== "command-admitted") return null;
  const command = acceptedCommands.get(event.command);
  return command?.kind === "update-worker-travel" ? command : null;
}

export function activeWorkerTravelByResource(
  run: RunState,
): Map<ResourceId, readonly TravelRoute[]> {
  const acceptedCommands = acceptedCommandsById(run);
  const workerTravel = new Map<ResourceId, readonly TravelRoute[]>();
  let updates = false;
  for (const command of acceptedCommands.values())
    if (command.kind === "update-worker-travel") updates = true;
  // Most runs change no travel; they need no pass over the history.
  if (!updates) return workerTravel;
  for (const event of run.events) {
    const command = admittedWorkerTravelCommand(acceptedCommands, event);
    if (command !== null) workerTravel.set(command.resource, command.travel);
  }
  return workerTravel;
}

export function activeWorkerRoutes(
  run: RunState,
  worker: Variant<ResourceDefinition, "worker">,
): readonly TravelRoute[] {
  return activeWorkerTravelByResource(run).get(worker.id) ?? worker.travel;
}
