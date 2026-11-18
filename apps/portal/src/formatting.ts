/**
 * Presentation formatters with no JSX, so logic that only decides wording can
 * be imported and tested without pulling a component tree along with it.
 */

export function formatAbsoluteTime(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function formatLifecycle(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    draft: "Draft",
    configuring: "Configuring",
    connecting: "Connecting",
    activating: "Activating",
    active: "Active",
    suspended: "Suspended",
    archived: "Archived",
    ready: "Ready",
    blocked: "Blocked",
    degraded: "Needs attention",
    reauth_required: "Reconnect required",
    activation_failed: "Activation failed",
    pending: "Pending",
    invited: "Invited",
    revoked: "Revoked",
    disabled: "Disabled",
    installed: "Installed",
    validating: "Validating",
    assigning_runtime: "Assigning runtime",
    publishing_policy: "Publishing policy",
    publishing_cues: "Publishing cues",
    enabling_connections: "Enabling connections",
    finalizing: "Finalizing",
  };
  return labels[value] ?? "Unknown status";
}

/**
 * Renders a commerce minor-unit amount in the viewer's locale, deriving the
 * currency's minor-unit digits from Intl so ¥ and $ amounts both read right.
 */
export function formatMoneyMinor(
  amountMinor: number | bigint,
  currency: string,
): string {
  const minor = Number(amountMinor);
  try {
    const formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(minor / 10 ** digits);
  } catch {
    return `${minor.toLocaleString()} ${currency}`;
  }
}

/**
 * A minor-unit amount in English, whatever the viewer's locale: the menu
 * boards, the menu price card and the refund card show money so.
 */
export function formatMoneyMinorEnglish(
  amountMinor: number,
  currency: string,
): string {
  const format = new Intl.NumberFormat("en", { style: "currency", currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(amountMinor / 10 ** digits);
}

/** A signed amount, rounded to a whole minor unit, with a minus sign (U+2212). */
export function formatSignedMoneyRounded(
  amountMinor: number,
  currency: string,
): string {
  if (amountMinor < 0) {
    return `−${formatMoneyMinor(Math.abs(Math.round(amountMinor)), currency)}`;
  }
  return formatMoneyMinor(Math.round(amountMinor), currency);
}

export function formatRelativeTime(
  at: number,
  now: number = Date.now(),
): string {
  const elapsed = now - at;
  if (elapsed < 0) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return `on ${new Date(at).toLocaleDateString()}`;
}

/**
 * Last-resort label for an identifier the caller could not resolve to a
 * published label: `expected_delivery_at` reads as "Expected delivery at".
 * Prefer the definition's own label whenever one is available.
 */
export function humanizeIdentifier(value: string): string {
  const words = value.replace(/[._-]+/gu, " ").trim();
  if (words.length === 0) return "this resource";
  return words.replace(/\b\p{L}/gu, uppercaseLetter);
}

function uppercaseLetter(letter: string): string {
  return letter.toUpperCase();
}

export function formatFutureRelativeTime(
  at: number,
  now: number = Date.now(),
): string {
  const remaining = at - now;
  if (remaining <= 0) return "now";
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return "in under a minute";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `in ${days} day${days === 1 ? "" : "s"}`;
  return `on ${new Date(at).toLocaleDateString()}`;
}
