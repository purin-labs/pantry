/**
 * The `surface_effect` signals of the chat signal socket (Plan 87 phase 3).
 * The agent published a browser command for this user, so the Kitchen
 * bridge reads its pending commands at once. While a socket is live, the
 * bridge can poll slowly; without one, it keeps its fast poll.
 */
const listeners = new Set<() => void>();
const liveSockets = new Set<object>();

export function announceSurfaceEffect(): void {
  for (const listener of listeners) listener();
}

export function subscribeSurfaceEffects(listener: () => void): () => void {
  listeners.add(listener);
  return unsubscribeSurfaceEffects.bind(null, listener);
}

function unsubscribeSurfaceEffects(listener: () => void): void {
  listeners.delete(listener);
}

export function setSurfaceSignalsLive(socket: object, live: boolean): void {
  if (live) liveSockets.add(socket);
  else liveSockets.delete(socket);
}

/** Whether a live socket will announce the next command. */
export function surfaceSignalsLive(): boolean {
  return liveSockets.size > 0;
}
