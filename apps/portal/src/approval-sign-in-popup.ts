/**
 * The step-up sign-in of an approval in a small window (the owner,
 * 2026-11-07: "Can it be a popup? not a page change"). Google returns the
 * window to `approval-signed-in.html`, which reports on this origin and
 * closes. The session and approval cookies that the callback sets reach
 * this page too, so the approval goes on here.
 */
type ApprovalSignIn = "signed_in" | "closed" | "blocked";

const CHANNEL = "pantry-approval-sign-in";
const RETURN_PAGE = "/approval-signed-in.html";
/** A sign-in that takes longer than this ends as closed. */
const MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * An approval that waits for a sign-in on the page (a browser that blocks
 * the window) is stored for the page that comes back. An older stored
 * approval is ignored, so a later page load does not approve or apply it.
 */
export const PENDING_APPROVAL_MAX_AGE_MS = MAX_WAIT_MS;

export function signInForApproval(
  organisationId: string,
  actionNonce: string,
): Promise<ApprovalSignIn> {
  const returnTo = `${RETURN_PAGE}?${new URLSearchParams({ action: actionNonce })}`;
  const query = new URLSearchParams({
    purpose: "approval",
    organisation: organisationId,
    action: actionNonce,
    returnTo,
  });
  const width = 520;
  const height = 680;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 3));
  const popup = window.open(
    `/v1/control/auth/google/start?${query.toString()}`,
    "pantry-approval-sign-in",
    `popup,width=${width},height=${height},left=${left},top=${top}`,
  );
  if (popup === null) return Promise.resolve("blocked");
  return new Promise((resolve) => {
    let done = false;
    const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(CHANNEL) : null;
    const finish = (result: ApprovalSignIn): void => {
      if (done) return;
      done = true;
      channel?.close();
      window.removeEventListener("message", onMessage);
      window.clearInterval(poll);
      window.clearTimeout(limit);
      resolve(result);
    };
    const signedIn = (data: unknown): boolean =>
      typeof data === "object" && data !== null &&
      (data as { kind?: unknown }).kind === "pantry:approval-signed-in" &&
      (data as { action?: unknown }).action === actionNonce;
    const onMessage = (event: MessageEvent): void => {
      if (event.origin === window.location.origin && signedIn(event.data)) finish("signed_in");
    };
    if (channel !== null)
      channel.onmessage = (event: MessageEvent) => {
        if (signedIn(event.data)) finish("signed_in");
      };
    window.addEventListener("message", onMessage);
    // A window that Google cut from this page still closes; then the
    // approval is tried, and the Worker says whether the sign-in counted.
    const poll = window.setInterval(() => {
      if (popup.closed) finish("closed");
    }, 500);
    const limit = window.setTimeout(() => finish("closed"), MAX_WAIT_MS);
  });
}
