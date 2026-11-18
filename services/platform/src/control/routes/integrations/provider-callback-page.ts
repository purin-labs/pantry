import type { ProviderCompletionTerminal } from "./provider-callback";

export function providerCompletionPage(
  provider: string,
  attemptId: string,
  terminal: ProviderCompletionTerminal,
  portalOrigin: string,
  returnPath: string,
): Response {
  const message = JSON.stringify({
    type: "satyr.provider-attempt.completed",
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
  <title>${connected ? "Connected" : failed ? "Connection not finished" : "Authorization received"} · Seams Pantry</title>
  <style>${PROVIDER_CALLBACK_PAGE_STYLES}</style>
</head>
<body>
  <main class="callback-shell">
    <section class="callback-panel" aria-labelledby="callback-title">
      <p class="callback-brand">SEAMS PANTRY</p>
      <span class="callback-mark ${connected ? "is-ok" : "is-neutral"}" aria-hidden="true">${connected ? CALLBACK_CHECK_ICON : CALLBACK_LINK_ICON}</span>
      <h1 id="callback-title">${connected ? "You&rsquo;re connected" : failed ? "Connection not finished" : "Authorization received"}</h1>
      <p class="callback-copy" id="status">${
        connected
          ? "Taking you back to Pantry&hellip;"
          : failed
            ? "Head back to Pantry for the next step."
            : "Head back to Pantry to see where this connection landed."
      }</p>
      <a class="callback-action" id="return-link" href=${returnUrl}>Back to Pantry</a>
      <p class="callback-footnote">If nothing happens, use the button above.</p>
    </section>
  </main>
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
      ? new BroadcastChannel("satyr-provider-attempt")
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
      return data.type === "satyr.provider-attempt.ack" && data.attempt_id === attemptId;
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
  <title>Connection not finished · Seams Pantry</title>
  <style>${PROVIDER_CALLBACK_PAGE_STYLES}</style>
</head>
<body>
  <main class="callback-shell">
    <section class="callback-panel" aria-labelledby="callback-title">
      <p class="callback-brand">SEAMS PANTRY</p>
      <span class="callback-mark is-warn" aria-hidden="true">${CALLBACK_ALERT_ICON}</span>
      <h1 id="callback-title">We couldn&rsquo;t finish that connection</h1>
      <p class="callback-copy">${detail}</p>
      <a class="callback-action" href=${returnUrl}>Back to Pantry</a>
      <p class="callback-footnote">Nothing was changed in your workspace.</p>
    </section>
  </main>
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

export const CALLBACK_CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4.8 12.6 4.8 4.8L19.2 6.6"/></svg>`;

export const CALLBACK_LINK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 14.4 14.4 9.6"/><path d="M11.2 6.6 13 4.8a4.4 4.4 0 0 1 6.2 6.2l-1.8 1.8"/><path d="M12.8 17.4 11 19.2A4.4 4.4 0 0 1 4.8 13l1.8-1.8"/></svg>`;

export const CALLBACK_ALERT_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v5"/><path d="M12 16.3h.01"/></svg>`;

/* One small card, centred. The heading stays at reading size: this page is a
   two-second waypoint, not a destination that needs display type. */

export const PROVIDER_CALLBACK_PAGE_STYLES = `
  :root {
    color-scheme: light;
    --cb-ground: #fdfcfc;
    --cb-paper: #ffffff;
    --cb-surface: #f5f3f1;
    --cb-ink: #000000;
    --cb-ink-2: #777169;
    --cb-ink-3: #a59f97;
    --cb-ok-text: #2e6b47;
    --cb-ok-bg: #eaf0eb;
    --cb-warn-text: #7c5220;
    --cb-warn-bg: #f5eee2;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color: var(--cb-ink);
    background: var(--cb-ground);
    font-synthesis: none;
    text-rendering: optimizeLegibility;
  }
  * { box-sizing: border-box; }
  body {
    min-width: 320px;
    min-height: 100vh;
    min-height: 100dvh;
    margin: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: var(--cb-ground);
    letter-spacing: 0.005em;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  .callback-shell {
    width: 100%;
    display: grid;
    place-items: center;
  }
  .callback-panel {
    width: min(100%, 380px);
    display: grid;
    justify-items: center;
    padding: 30px 28px 26px;
    border-radius: 18px;
    background: var(--cb-paper);
    box-shadow: 0 0 1px rgb(0 0 0 / 40%), 0 2px 4px rgb(0 0 0 / 4%), 0 6px 16px rgb(0 0 0 / 4%);
    text-align: center;
  }
  .callback-brand {
    margin: 0 0 22px;
    color: var(--cb-ink-3);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.16em;
  }
  .callback-mark {
    display: grid;
    place-items: center;
    width: 46px;
    height: 46px;
    border-radius: 9999px;
    animation: callback-mark-in 260ms cubic-bezier(0.2, 0.7, 0.3, 1) both;
  }
  .callback-mark svg {
    width: 22px;
    height: 22px;
  }
  .callback-mark.is-ok { color: var(--cb-ok-text); background: var(--cb-ok-bg); }
  .callback-mark.is-neutral { color: var(--cb-ink-2); background: var(--cb-surface); }
  .callback-mark.is-warn { color: var(--cb-warn-text); background: var(--cb-warn-bg); }
  h1 {
    margin: 18px 0 0;
    font-size: 21px;
    font-weight: 500;
    line-height: 1.28;
    letter-spacing: -0.015em;
    text-wrap: balance;
  }
  .callback-copy {
    max-width: 32ch;
    margin: 8px 0 0;
    color: var(--cb-ink-2);
    font-size: 14px;
    line-height: 1.5;
    text-wrap: pretty;
  }
  .callback-action {
    min-height: 42px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-top: 22px;
    padding-inline: 24px;
    border-radius: 9999px;
    background: var(--cb-ink);
    color: #ffffff;
    font-size: 14px;
    font-weight: 500;
    text-decoration: none;
    transition: background-color 0.15s ease;
  }
  .callback-action:hover { background: #262626; }
  .callback-action:focus-visible {
    outline: 2px solid var(--cb-ink);
    outline-offset: 3px;
  }
  .callback-footnote {
    max-width: 32ch;
    margin: 14px 0 0;
    color: var(--cb-ink-3);
    font-size: 12px;
    line-height: 1.45;
  }
  @keyframes callback-mark-in {
    from { opacity: 0; transform: scale(0.82); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .callback-mark { animation: none; }
  }
  @media (max-width: 24rem) {
    .callback-panel { padding: 26px 20px 22px; border-radius: 16px; }
  }
`;

export function providerCallbackFailureDetail(reasonCode: string): string {
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
