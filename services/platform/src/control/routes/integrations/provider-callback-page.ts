import type { ProviderCompletionTerminal } from "./provider-callback";
import { PURIN_ICON } from "./purin-icon";

export function providerCompletionPage(
  provider: string,
  attemptId: string,
  terminal: ProviderCompletionTerminal,
  portalOrigin: string,
  returnPath: string,
): Response {
  const message = JSON.stringify({
    type: "pantry.provider-attempt.completed",
    attempt_id: attemptId,
    terminal_state: terminal.kind,
    failure_reason_code: terminal.failureReasonCode,
    provider,
  });
  const expectedOrigin = JSON.stringify(portalOrigin);
  const expectedAttemptId = JSON.stringify(attemptId);
  const returnUrl = JSON.stringify(
    new URL(returnPath, portalOrigin).toString(),
  );
  const connected = terminal.kind === "connected";
  const failed = terminal.kind === "failed";
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${connected ? "Connected" : failed ? "Connection not finished" : "Authorization received"} · Purin Pantry</title>
  <style>${PROVIDER_CALLBACK_PAGE_STYLES}</style>
</head>
<body>
  ${callbackCard({
    tone: connected ? "ok" : failed ? "warn" : "neutral",
    title: connected
      ? "You&rsquo;re connected"
      : failed
        ? "Connection not finished"
        : "Authorization received",
    detail: `<p class="callback-copy" id="status">${
      connected
        ? "Taking you back to Pantry&hellip;"
        : failed
          ? "Head back to Pantry for the next step."
          : "Head back to Pantry to see where this connection landed."
    }</p>`,
    action: `<a class="callback-action" id="return-link" href=${returnUrl}>Back to Pantry</a>`,
    footnote: "If nothing happens, use the button above.",
  })}
  <script>
    const portalOrigin = ${expectedOrigin};
    const attemptId = ${expectedAttemptId};
    const completion = ${message};
    const returnUrl = ${returnUrl};
    const status = document.getElementById("status");
    // Provider consent pages are adopting Cross-Origin-Opener-Policy (their
    // report-only headers already announce it), which severs window.opener
    // once enforced. BroadcastChannel reaches the same-origin portal tab
    // either way, so completion and acknowledgement travel both routes.
    const channel = "BroadcastChannel" in window
      ? new BroadcastChannel("pantry-provider-attempt")
      : null;
    let settled = false;
    function sendCompletion() {
      if (window.opener !== null) {
        window.opener.postMessage(completion, portalOrigin);
      }
      if (channel !== null) channel.postMessage(completion);
    }
    function isAcknowledgement(data) {
      if (typeof data !== "object" || data === null) return false;
      return data.type === "pantry.provider-attempt.ack" && data.attempt_id === attemptId;
    }
    function returnToPortal() {
      status.textContent = "Taking you back to Pantry…";
      window.location.replace(returnUrl);
    }
    function settle() {
      if (settled) return;
      settled = true;
      status.textContent = "All set. Closing this tab…";
      if (window.opener !== null) window.opener.focus();
      window.close();
      // A severed popup may refuse close(); the timer dies with the
      // document when close() succeeds.
      window.setTimeout(returnToPortal, 400);
    }
    function receiveWindowAcknowledgement(event) {
      if (event.origin !== portalOrigin || event.source !== window.opener) return;
      if (isAcknowledgement(event.data)) settle();
    }
    function receiveChannelAcknowledgement(event) {
      if (isAcknowledgement(event.data)) settle();
    }
    function returnUnlessSettled() {
      if (!settled) returnToPortal();
    }
    window.addEventListener("message", receiveWindowAcknowledgement);
    if (channel !== null) {
      channel.addEventListener("message", receiveChannelAcknowledgement);
    }
    if (window.opener === null && channel === null) {
      returnToPortal();
    } else {
      sendCompletion();
      window.setInterval(sendCompletion, 1000);
      if (window.opener === null) window.setTimeout(returnUnlessSettled, 4000);
    }
  </script>
</body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

export function providerCallbackFailurePage(
  reasonCode: string,
  status: number,
  portalOrigin: string,
  returnPath: string,
): Response {
  const detail = providerCallbackFailureDetail(reasonCode);
  const returnUrl = JSON.stringify(
    new URL(returnPath, portalOrigin).toString(),
  );
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connection not finished · Purin Pantry</title>
  <style>${PROVIDER_CALLBACK_PAGE_STYLES}</style>
</head>
<body>
  ${callbackCard({
    tone: "warn",
    title: "We couldn&rsquo;t finish that connection",
    detail: `<p class="callback-copy">${detail}</p>`,
    action: `<a class="callback-action" href=${returnUrl}>Back to Pantry</a>`,
    footnote: "Nothing was changed in your workspace.",
  })}
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

/** `ok` is a finished connection, `warn` one that stopped, `neutral` neither. */
type CallbackTone = "ok" | "warn" | "neutral";

/**
 * The card of every state, as the Portal's authorization screen shows a
 * result: the Purin Pantry brand, the status mark, the title, the detail, the
 * way back and a footnote. Every part is HTML that the caller has escaped.
 */
function callbackCard(
  card: Readonly<{
    tone: CallbackTone;
    title: string;
    detail: string;
    action: string;
    footnote: string;
  }>,
): string {
  return `<main class="callback-shell">
    <section class="callback-card" aria-labelledby="callback-title">
      <p class="callback-brand"><svg class="callback-brand-mark" viewBox="${PURIN_ICON.viewBox}" aria-hidden="true" focusable="false">${PURIN_ICON.body}</svg>Purin Pantry</p>
      <div class="callback-result">
        <span class="callback-mark" data-tone="${card.tone}" aria-hidden="true">${CALLBACK_TONE_ICONS[card.tone]}</span>
        <h1 class="callback-title" id="callback-title">${card.title}</h1>
        ${card.detail}
        ${card.action}
        <p class="callback-footnote">${card.footnote}</p>
      </div>
    </section>
  </main>`;
}

const CALLBACK_TONE_ICONS: Readonly<Record<CallbackTone, string>> = {
  ok: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.8 12.6 4.8 4.8L19.2 6.6"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v5"/><path d="M12 16.3h.01"/></svg>`,
  neutral: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 14.4 14.4 9.6"/><path d="M11.2 6.6 13 4.8a4.4 4.4 0 0 1 6.2 6.2l-1.8 1.8"/><path d="M12.8 17.4 11 19.2A4.4 4.4 0 0 1 4.8 13l1.8-1.8"/></svg>`,
};

/* The page looks like the result card of the Portal's authorization screen
   (apps/portal/src/ui/permission-request.css, the compact layout) on the
   default Portal theme (packages/frontend-themes/slate-coral.css). The Worker
   imports no Portal code, so the values are a copy: the slate and coral
   steps of that theme, in light and dark. The brand row is the one of the
   Portal header.

   Motion: the card is the one entrance, so its content moves with it. The
   status mark lands just after the card starts, with the glide spring of the
   Portal; reduced motion keeps only a short fade of the card. */

const PROVIDER_CALLBACK_PAGE_STYLES = `
  :root {
    color-scheme: light dark;
    --ground: oklch(0.95 0.007 248);
    --paper: oklch(0.978 0.004 248);
    --surface: oklch(0.922 0.009 248);
    --border: oklch(0.893 0.012 248);
    --ink: oklch(0.278 0.021 258);
    --ink-strong: oklch(0.278 0.021 258);
    --ink-2: oklch(0.445 0.028 255.2);
    --primary: oklch(0.387 0.025 257.5);
    --primary-hover: oklch(0.332 0.023 258);
    --on-primary: oklch(0.978 0.004 248);
    --focus: oklch(0.503 0.12 27.5);
    --ok-text: oklch(0.45 0.06 158);
    --ok-bg: oklch(0.95 0.02 160);
    --warn-text: oklch(0.44 0.075 75);
    --warn-bg: oklch(0.94 0.035 85);
    --shadow-color: oklch(0.278 0.021 258);
    --shadow-strength: 4%;
    --glide-duration: 390ms;
    --glide-ease: linear(
      0, 0.005 1.2%, 0.022 2.8%, 0.055 4.5%, 0.099 6.2%, 0.142 7.8%, 0.198 9.5%,
      0.429 16.2%, 0.534 19.5%, 0.63 22.8%, 0.676 24.5%, 0.713 26%, 0.779 29%,
      0.839 32.2%, 0.887 35.5%, 0.928 39%, 0.96 42.8%, 0.985 47%, 1.001 51.5%,
      1.011 56.8%, 1.015 61.5%, 1.015 67.2%, 1.002 99.8%, 1
    );
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--ink);
    background: var(--ground);
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: oklch(0.278 0.021 258);
      --paper: oklch(0.387 0.025 257.5);
      --surface: oklch(0.332 0.023 258);
      --border: oklch(0.445 0.028 255.2);
      --ink: oklch(0.978 0.004 248);
      --ink-strong: oklch(0.95 0.007 248);
      --ink-2: oklch(0.893 0.012 248);
      --primary: oklch(0.922 0.009 248);
      --primary-hover: oklch(0.95 0.007 248);
      --on-primary: oklch(0.278 0.021 258);
      --focus: oklch(0.717 0.106 31.5);
      --ok-text: oklch(0.84 0.06 158);
      --ok-bg: oklch(0.36 0.03 160);
      --warn-text: oklch(0.89 0.087 85);
      --warn-bg: oklch(0.4 0.045 75);
      --shadow-color: oklch(0.18 0.02 258);
      --shadow-strength: 24%;
    }
  }
  * { box-sizing: border-box; }
  body {
    min-width: 320px;
    min-height: 100vh;
    min-height: 100dvh;
    margin: 0;
    display: grid;
    place-items: center;
    padding: 16px;
    background: var(--ground);
    letter-spacing: 0.005em;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .callback-shell {
    width: 100%;
    display: grid;
    place-items: center;
  }
  .callback-card {
    width: min(100%, 400px);
    min-width: 0;
    border-radius: 24px;
    background: var(--paper);
    box-shadow:
      0 0 0 1px var(--border),
      0 2px 4px color-mix(in oklch, var(--shadow-color) var(--shadow-strength), transparent),
      0 6px 16px color-mix(in oklch, var(--shadow-color) var(--shadow-strength), transparent);
    color: var(--ink);
    font-size: 14px;
    line-height: 1.45;
  }
  .callback-card p { margin: 0; }
  .callback-brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 24px 24px 0;
    color: var(--ink);
    font-size: 15px;
    font-weight: 500;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
  .callback-brand-mark {
    width: 24px;
    height: 24px;
    flex: 0 0 24px;
  }
  .callback-result {
    display: grid;
    justify-items: center;
    gap: 10px;
    padding: 28px 28px 24px;
    text-align: center;
  }
  .callback-mark {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    margin-block-end: 8px;
    border-radius: 50%;
    background: var(--surface);
    color: var(--ink-2);
  }
  .callback-mark svg {
    width: 28px;
    height: 28px;
  }
  .callback-mark[data-tone="ok"] { background: var(--ok-bg); color: var(--ok-text); }
  .callback-mark[data-tone="warn"] { background: var(--warn-bg); color: var(--warn-text); }
  .callback-title {
    margin: 0;
    color: var(--ink-strong);
    font-size: 22px;
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.015em;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  .callback-copy {
    max-width: 36ch;
    color: var(--ink-2);
    font-size: 14px;
    text-wrap: pretty;
  }
  .callback-action {
    justify-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 46px;
    margin-block-start: 14px;
    padding: 0 18px;
    border-radius: 9999px;
    background: var(--primary);
    color: var(--on-primary);
    font-size: 15px;
    font-weight: 500;
    text-decoration: none;
    -webkit-tap-highlight-color: transparent;
  }
  .callback-action:hover { background: var(--primary-hover); }
  .callback-action:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .callback-footnote {
    max-width: 36ch;
    color: var(--ink-2);
    font-size: 13px;
    text-wrap: pretty;
  }
  @media (prefers-reduced-motion: no-preference) {
    .callback-card {
      animation: callback-card-enter var(--glide-duration) var(--glide-ease) both;
    }
    .callback-mark {
      animation: callback-mark-enter var(--glide-duration) var(--glide-ease) 80ms both;
    }
    .callback-action {
      transition: background-color 150ms ease, scale 150ms ease;
    }
    .callback-action:active { scale: 0.97; }
  }
  @media (prefers-reduced-motion: reduce) {
    .callback-card { animation: callback-card-fade 150ms ease-out both; }
  }
  @keyframes callback-card-enter {
    from { opacity: 0; translate: 0 6px; }
    to { opacity: 1; translate: 0 0; }
  }
  @keyframes callback-mark-enter {
    from { opacity: 0; scale: 0.5; }
    60% { opacity: 1; scale: 1.08; }
    to { opacity: 1; scale: 1; }
  }
  @keyframes callback-card-fade {
    from { opacity: 0; }
    to { opacity: 1; }
  }
  @media (forced-colors: active) {
    .callback-card { border: 1px solid CanvasText; }
    .callback-action { border: 1px solid ButtonText; }
  }
`;

function providerCallbackFailureDetail(reasonCode: string): string {
  switch (reasonCode) {
    case "provider_oauth_denied":
      return "Access was declined at the provider. You can try again whenever you are ready.";
    case "authorization_expired":
      return "This request sat idle too long and expired. Starting a fresh connection should sort it out.";
    case "provider_state_replayed":
    case "provider_state_invalid":
    case "provider_callback_signature_invalid":
      return "We could not verify this response, so we stopped here. Start a new connection to try again.";
    case "provider_asset_missing":
      return "The sign-in finished without sharing the business account that Pantry needs, so nothing was stored. The portal explains what to do next.";
    default:
      return "Something went wrong partway through. The portal has the details and a way to retry.";
  }
}
