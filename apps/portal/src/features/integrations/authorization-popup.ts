/**
 * The window that a provider sign-in opens in: a small window centred over
 * the Portal, so the operator signs in and comes back to the same page.
 * Provider sign-in pages refuse to load in a frame, so a window is the only
 * in-context surface.
 *
 * Call it from the click that asks for it, before the first await, or the
 * browser blocks it as a popup that the user did not ask for. It answers
 * null when the browser blocks it anyway. One window serves every sign-in:
 * a second open replaces the page in the first.
 */
export function openAuthorizationPopup(url = "about:blank"): Window | null {
  const left = Math.max(
    0,
    Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2),
  );
  const top = Math.max(
    0,
    Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2),
  );
  const features = [
    "popup=yes",
    `width=${POPUP_WIDTH}`,
    `height=${POPUP_HEIGHT}`,
    `left=${left}`,
    `top=${top}`,
    "resizable=yes",
    "scrollbars=yes",
  ].join(",");
  return window.open(url, "satyr-provider-authorization", features);
}

const POPUP_WIDTH = 560;
const POPUP_HEIGHT = 720;
