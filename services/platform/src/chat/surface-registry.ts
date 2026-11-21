import type { SurfaceObservationV2 } from "@purin-labs/control-api";
import type { PageBrowserContext } from "@purin-labs/contracts";
import { definePort } from "../port";

/**
 * The typed state of a page that a message carried (Plan 87). The area of
 * the page owns its form and its check. The chat record keeps the state and
 * reads only its digest, which names it.
 */
export type ChatSurfaceState = Readonly<{ digest: string }>;

/**
 * The surface registry of the chat record (Plan 87, section 5): the check
 * of the typed page state that an observation carries, and the old forms of
 * that state. Only the Kitchen page has a typed state now. The Worker
 * registers it (`worker-ports.ts`). The record reads it only for an
 * observation with a state or for an old form, so a message without a page
 * state does not need it.
 */
export type ChatSurfaces<State extends ChatSurfaceState = ChatSurfaceState> =
  Readonly<{
  /**
   * The observation with its state checked and the view that the server
   * makes from the state. Null when the state breaks its contract, names
   * another surface instance or browser than the message, or belongs to a
   * surface with no typed state.
   */
  admitState(
    observation: SurfaceObservationV2,
    browser: PageBrowserContext,
  ): SurfaceObservationV2 | null;
  /** The state of an observation with a state, for the code of its area. */
  stateOf(observation: SurfaceObservationV2): State | null;
  /**
   * The state in its form before Plan 87 phase 2: a stored `surface` part,
   * or the `surfaceContext` key of a tab that loaded the Portal before then.
   * Null when the value is not that form.
   */
  parseOldState(raw: unknown): State | null;
  /** Whether an old tab's state still has the digest of its view. */
  oldStateIsIntact(state: State): boolean;
  /** The one observation of a message that also holds an old state. */
  withOldState(
    observation: SurfaceObservationV2 | undefined,
    state: State,
    browser: PageBrowserContext,
  ): SurfaceObservationV2 | undefined;
  /**
   * The read-only text of a stored `surface` part that is no longer a valid
   * state, or null when the part is not an old snapshot.
   */
  historicalText(raw: unknown): string | null;
}>;

export const chatSurfaces = definePort<ChatSurfaces>("chat_surfaces");

/** The state that an observation carries, or null. */
export function surfaceStateOf(
  observation: SurfaceObservationV2 | undefined,
): ChatSurfaceState | null {
  if (observation === undefined || observation.state === null) return null;
  return chatSurfaces.use().stateOf(observation);
}

/** The observation of a message, with its state checked. */
export function admitSurfaceState(
  observation: SurfaceObservationV2,
  browser: PageBrowserContext,
): SurfaceObservationV2 | null {
  if (observation.state === null) return observation;
  return chatSurfaces.use().admitState(observation, browser);
}
