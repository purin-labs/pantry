// The socket sweep of an Actor with collaboration rooms (the Organisation):
// one sweep that fails leaves the other sweeps to run, and the time until
// the next sweep follows the rooms that the open sockets share.
import {
  SOCKET_SILENCE_LIMIT_MS,
  SOCKET_SWEEP_INTERVAL_MS,
  openSockets,
} from "@purin-labs/actor-runtime/actors/hibernatable-sockets";
import { newRequestId } from "@purin-labs/kernel/ids";
import { traceWarn } from "@purin-labs/kernel/observability";
import { errorMessage } from "@purin-labs/std";
import { collaborationSocketRoute } from "./collaboration-room";

/** Runs one socket sweep; its failure leaves the other sweeps to run. */
export async function sweepSafely(
  name: string,
  sweep: () => Promise<void>,
): Promise<void> {
  try {
    await sweep();
  } catch (error) {
    traceWarn("organisation.socket_sweep_failed", {
      requestId: newRequestId(),
      sweep: name,
      detail: errorMessage(error),
    });
  }
}

/**
 * The time until the next sweep: short while two sockets share a room, so a
 * dropped client leaves its presence soon; long otherwise; none without
 * sockets.
 */
export function socketSweepInterval(ctx: DurableObjectState): number | null {
  const sockets = openSockets(ctx);
  if (sockets.length === 0) return null;
  const rooms = new Set<string>();
  for (const socket of sockets) {
    const route = collaborationSocketRoute(socket.deserializeAttachment());
    if (route === null) continue;
    const key = JSON.stringify([route.kind, route.key]);
    if (rooms.has(key)) return SOCKET_SILENCE_LIMIT_MS;
    rooms.add(key);
  }
  return SOCKET_SWEEP_INTERVAL_MS;
}
