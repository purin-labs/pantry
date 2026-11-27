import { openAuthorizationPopup } from "./authorization-popup";
import type { FileContextProvider } from "@purin-labs/contracts";
import React from "react";
import { toast } from "sonner";
import { initialFileAccessPath } from "@purin-labs/ui/route";
import type { OrganisationMutation } from "@purin-labs/control/portal/mutation-state";
import { providerLabel } from "@purin-labs/area-integrations-contract/ui/integration-catalogue";
import type { VariantBy } from "@purin-labs/type-utils";
import {
  assertNever,
  isRecord,
} from "@purin-labs/std";
import { loadIntegrationsRoute } from "./route-loading";
import type {
  IntegrationsRouteData,
  IntegrationsRouteMutationContext,
  IntegrationsRouteProps,
  PendingProviderAuthorization,
  ProviderAuthorizationWatch,
  SettingsMutationFeedback,
  SettingsRouteContent,
} from "@purin-labs/area-integrations-contract/ui/features/integrations/settings-types";

type ProviderAuthorizationSurface =
  | { readonly kind: "popup"; readonly popup: Window }
  | { readonly kind: "current_window"; readonly popup?: never };

export function openProviderAuthorizationSurface(): ProviderAuthorizationSurface {
  const popup = openAuthorizationPopup();
  return popup === null ? { kind: "current_window" } : { kind: "popup", popup };
}

export function navigateProviderAuthorizationSurface(
  surface: ProviderAuthorizationSurface,
  authorizationUrl: string,
): void {
  switch (surface.kind) {
    case "popup":
      if (surface.popup.closed) {
        throw new Error(
          "The provider authorization popup was closed. Try again.",
        );
      }
      surface.popup.location.replace(authorizationUrl);
      return;
    case "current_window":
      window.location.assign(authorizationUrl);
      return;
    default:
      return assertNever(surface, "Unexpected settings state");
  }
}

export function closeProviderAuthorizationSurface(
  surface: ProviderAuthorizationSurface,
): void {
  if (surface.kind === "popup" && !surface.popup.closed) surface.popup.close();
}

/**
 * A popup that reached the provider is the route's only evidence that the
 * operator is mid-sign-in. The current-window fallback leaves this page, so
 * there is nothing to watch there.
 */
export function watchProviderAuthorizationSurface(
  context: IntegrationsRouteMutationContext,
  surface: ProviderAuthorizationSurface,
  pending: PendingProviderAuthorization,
): void {
  if (surface.kind !== "popup") return;
  context.setAuthorization({ pending, popup: surface.popup });
}

export function trackProviderAuthorization(
  ref: React.RefObject<ProviderAuthorizationWatch | null>,
  authorization: ProviderAuthorizationWatch | null,
): void {
  ref.current = authorization;
}

type ProviderAuthorizationOutcome = "waiting" | "closed" | "returned";

/**
 * Reads where a consent popup stands without the provider's help. A closed
 * window is unambiguous. A portal path on this origin means the operator came
 * back through a "Back to Pantry" link rather than the completion handshake:
 * the callback failure page carries no script, so that link is the only trace
 * it leaves. The provider's own pages throw on inspection and the same-origin
 * callback page is not a portal path, so both keep waiting.
 */
export function providerAuthorizationOutcome(
  popup: Pick<Window, "closed" | "location">,
  portalOrigin: string,
): ProviderAuthorizationOutcome {
  if (popup.closed) return "closed";
  let href: string;
  try {
    href = popup.location.href;
  } catch {
    return "waiting";
  }
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return "waiting";
  }
  return url.origin === portalOrigin && url.pathname.startsWith("/portal")
    ? "returned"
    : "waiting";
}

const PROVIDER_AUTHORIZATION_POLL_MS = 500;

// The completion handshake travels just before a popup closes itself; this
// pause keeps a successful sign-in from reading as an interruption.
const PROVIDER_AUTHORIZATION_SETTLE_MS = 750;

type ProviderAuthorizationTimers = { poll: number; settle: number | null };

export function beginProviderAuthorizationWatch(
  authorization: ProviderAuthorizationWatch | null,
  setAuthorization: React.Dispatch<
    React.SetStateAction<ProviderAuthorizationWatch | null>
  >,
  setFeedback: React.Dispatch<React.SetStateAction<SettingsMutationFeedback>>,
  props: IntegrationsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >,
): () => void {
  if (authorization === null) return emptySettingsCleanup;
  const timers: ProviderAuthorizationTimers = { poll: 0, settle: null };
  const settle = (
    outcome: Exclude<ProviderAuthorizationOutcome, "waiting">,
  ): void => {
    if (outcome === "returned" && !authorization.popup.closed)
      authorization.popup.close();
    setAuthorization(null);
    setFeedback({
      mutation: pendingAuthorizationMutation(authorization.pending),
      message: providerAuthorizationInterruptedMessage(
        authorization.pending,
        outcome,
      ),
    });
    void loadIntegrationsRoute(props, requestRevision, setContent);
  };
  timers.poll = window.setInterval(() => {
    if (timers.settle !== null) return;
    const outcome = providerAuthorizationOutcome(
      authorization.popup,
      window.location.origin,
    );
    if (outcome === "waiting") return;
    timers.settle = window.setTimeout(
      settle.bind(null, outcome),
      PROVIDER_AUTHORIZATION_SETTLE_MS,
    );
  }, PROVIDER_AUTHORIZATION_POLL_MS);
  return stopProviderAuthorizationWatch.bind(null, timers);
}

function stopProviderAuthorizationWatch(
  timers: ProviderAuthorizationTimers,
): void {
  window.clearInterval(timers.poll);
  if (timers.settle !== null) window.clearTimeout(timers.settle);
}

export function cancelProviderAuthorization(
  context: IntegrationsRouteMutationContext,
): void {
  const watch = context.authorization.current;
  if (watch === null) return;
  if (!watch.popup.closed) watch.popup.close();
  context.setAuthorization(null);
  context.setFeedback(null);
}

function pendingAuthorizationMutation(
  pending: PendingProviderAuthorization,
): OrganisationMutation {
  switch (pending.kind) {
    case "connect":
      return { kind: "connect_provider", provider: pending.provider };
    case "existing_account":
      return {
        kind: "integration_account",
        integrationAccountId: pending.integrationAccountId,
      };
    default:
      return assertNever(pending, "Unexpected settings state");
  }
}

/** The name on the sign-in window, which is not always the provider's own. */
export function authorizationServiceName(provider: string): string {
  switch (provider) {
    case "whatsapp":
      return "Meta";
    case "gmail":
    case "google_drive":
      return "Google";
    default:
      return providerLabel(provider);
  }
}

export function providerAuthorizationInterruptedMessage(
  pending: PendingProviderAuthorization,
  outcome: Exclude<ProviderAuthorizationOutcome, "waiting">,
): string {
  const service = authorizationServiceName(pending.provider);
  switch (outcome) {
    case "closed":
      return `The ${service} window closed before sign-in finished. Nothing was changed. Try again when you're ready.`;
    case "returned":
      return `${service} sent you back without finishing the connection. Nothing was changed. Try again, and contact support if it keeps happening.`;
    default:
      return assertNever(outcome, "Unexpected settings state");
  }
}

export function openCodexAttemptId(
  content: SettingsRouteContent<IntegrationsRouteData>,
): string | null {
  return content.kind === "ready" &&
    content.data.codexConnection.kind === "authorizing"
    ? content.data.codexConnection.attempt.attemptId
    : null;
}

export function beginCodexAuthorizationPolling(
  attemptId: string | null,
  props: IntegrationsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >,
): () => void {
  if (attemptId === null) return emptySettingsCleanup;
  const timer = window.setInterval(
    pollCodexAuthorization.bind(null, props, requestRevision, setContent),
    2_500,
  );
  return stopSettingsInterval.bind(null, timer);
}

type ProviderCompletionMessageBase = {
  readonly type: "pantry.provider-attempt.completed";
  readonly attempt_id: string;
  readonly provider: string | null;
};

type ProviderCompletionMessage =
  | (ProviderCompletionMessageBase & {
      readonly terminal_state: "connected" | "cancelled" | "expired";
      readonly failure_reason_code: null;
    })
  | (ProviderCompletionMessageBase & {
      readonly terminal_state: "failed";
      readonly failure_reason_code: string;
    });

// The popup broadcasts completions here as well as posting to its opener:
// provider consent pages are adopting Cross-Origin-Opener-Policy, which
// severs window.opener once enforced. Must match the channel name in
// areas/integrations/server/control/routes/integrations.ts.
const PROVIDER_ATTEMPT_CHANNEL = "pantry-provider-attempt";

type ProviderCompletionContext = {
  readonly props: IntegrationsRouteProps;
  readonly requestRevision: { current: number };
  readonly setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >;
  readonly setFeedback: React.Dispatch<
    React.SetStateAction<SettingsMutationFeedback>
  >;
  readonly authorization: React.RefObject<ProviderAuthorizationWatch | null>;
  readonly setAuthorization: React.Dispatch<
    React.SetStateAction<ProviderAuthorizationWatch | null>
  >;
  /** Shared across re-subscriptions so a re-sent completion never runs twice. */
  readonly handledAttemptIds: Set<string>;
  readonly channel: BroadcastChannel | null;
};

export function beginProviderCompletionListener(
  props: IntegrationsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >,
  setFeedback: React.Dispatch<React.SetStateAction<SettingsMutationFeedback>>,
  authorization: React.RefObject<ProviderAuthorizationWatch | null>,
  setAuthorization: React.Dispatch<
    React.SetStateAction<ProviderAuthorizationWatch | null>
  >,
  handledAttemptIds: Set<string>,
): () => void {
  const context: ProviderCompletionContext = {
    props,
    requestRevision,
    setContent,
    setFeedback,
    authorization,
    setAuthorization,
    handledAttemptIds,
    channel:
      typeof BroadcastChannel === "undefined"
        ? null
        : new BroadcastChannel(PROVIDER_ATTEMPT_CHANNEL),
  };
  const windowListener = handleProviderCompletion.bind(null, context);
  const channelListener = handleProviderChannelCompletion.bind(null, context);
  window.addEventListener("message", windowListener);
  context.channel?.addEventListener("message", channelListener);
  return removeProviderCompletionListener.bind(
    null,
    context,
    windowListener,
    channelListener,
  );
}

function removeProviderCompletionListener(
  context: ProviderCompletionContext,
  windowListener: (event: MessageEvent<unknown>) => void,
  channelListener: (event: MessageEvent<unknown>) => void,
): void {
  window.removeEventListener("message", windowListener);
  if (context.channel === null) return;
  context.channel.removeEventListener("message", channelListener);
  context.channel.close();
}

function handleProviderCompletion(
  context: ProviderCompletionContext,
  event: MessageEvent<unknown>,
): void {
  const completion = parseProviderCompletionMessage(event.data);
  if (
    event.origin !== window.location.origin ||
    completion === null ||
    !isProviderAuthorizationWindow(event.source)
  ) {
    return;
  }
  event.source.postMessage(providerCompletionAck(completion), event.origin);
  processProviderCompletion(context, completion);
}

function handleProviderChannelCompletion(
  context: ProviderCompletionContext,
  event: MessageEvent<unknown>,
): void {
  const completion = parseProviderCompletionMessage(event.data);
  if (completion === null || context.channel === null) return;
  context.channel.postMessage(providerCompletionAck(completion));
  processProviderCompletion(context, completion);
}

function providerCompletionAck(completion: ProviderCompletionMessage): {
  readonly type: "pantry.provider-attempt.ack";
  readonly attempt_id: string;
} {
  return {
    type: "pantry.provider-attempt.ack",
    attempt_id: completion.attempt_id,
  };
}

// Acknowledged before the reload: the ack only means "the portal heard you",
// and the popup should not stay open for the length of a data refresh. The
// popup re-sends until acknowledged, so completions dedupe by attempt.
function processProviderCompletion(
  context: ProviderCompletionContext,
  completion: ProviderCompletionMessage,
): void {
  if (context.handledAttemptIds.has(completion.attempt_id)) return;
  context.handledAttemptIds.add(completion.attempt_id);
  const watch = context.authorization.current;
  const awaited =
    watch !== null && watch.pending.provider === completion.provider
      ? watch.pending
      : null;
  if (awaited !== null) context.setAuthorization(null);
  context.setFeedback(null);
  switch (completion.terminal_state) {
    case "connected": {
      toast.success(
        completion.provider === null
          ? "Connection complete."
          : `${providerLabel(completion.provider)} connected.`,
      );
      const fileProvider = parseFileContextProvider(completion.provider);
      if (
        fileProvider !== null &&
        (awaited === null || awaited.kind === "connect")
      ) {
        window.location.assign(
          initialFileAccessPath(
            context.props.organisationHandle,
            context.props.workspaceHandle,
            fileProvider,
          ),
        );
        return;
      }
      break;
    }
    case "failed":
      toast.error(providerCompletionFailureMessage(completion));
      break;
    case "cancelled":
      toast.info(
        providerCompletionProviderLabel(completion.provider, "Connection") +
          " cancelled.",
      );
      break;
    case "expired":
      toast.warning(
        providerCompletionProviderLabel(completion.provider, "Connection") +
          " expired. Start again when you’re ready.",
      );
      break;
    default:
      assertNever(completion, "Unexpected settings state");
  }
  void loadIntegrationsRoute(
    context.props,
    context.requestRevision,
    context.setContent,
  );
}

function providerCompletionFailureMessage(
  completion: VariantBy<ProviderCompletionMessage, "terminal_state", "failed">,
): string {
  if (completion.provider === "whatsapp") {
    switch (completion.failure_reason_code) {
      case "provider_account_ineligible":
        return "WhatsApp wasn’t connected. Reopen Meta and choose Edit settings. If Meta says it can’t onboard customers, Meta has not approved Purin yet.";
      case "provider_scope_missing":
        return "WhatsApp wasn’t connected. Reopen Meta, choose Edit settings, and approve all requested access.";
      case "provider_distribution_disabled":
        return "WhatsApp setup is waiting for Meta to approve Purin.";
    }
  }
  if (completion.failure_reason_code === "provider_account_already_claimed") {
    return `${providerCompletionProviderLabel(completion.provider, "Connection")} wasn’t connected. That account is already connected to another Purin Pantry organisation.`;
  }
  return `${providerCompletionProviderLabel(completion.provider, "Connection")} wasn’t connected. Review the provider window and try again.`;
}

function providerCompletionProviderLabel(
  provider: string | null,
  fallback: string,
): string {
  return provider === null ? fallback : providerLabel(provider);
}

function parseFileContextProvider(
  provider: string | null,
): FileContextProvider | null {
  return provider === "dropbox" || provider === "google_drive"
    ? provider
    : null;
}

function parseProviderCompletionMessage(
  raw: unknown,
): ProviderCompletionMessage | null {
  if (
    !isRecord(raw) ||
    raw.type !== "pantry.provider-attempt.completed" ||
    typeof raw.attempt_id !== "string" ||
    raw.attempt_id.length === 0
  ) {
    return null;
  }
  const provider =
    typeof raw.provider === "string" && raw.provider.length > 0
      ? raw.provider
      : null;
  switch (raw.terminal_state) {
    case "connected":
    case "cancelled":
    case "expired":
      return raw.failure_reason_code === null
        ? {
            type: "pantry.provider-attempt.completed",
            attempt_id: raw.attempt_id,
            terminal_state: raw.terminal_state,
            failure_reason_code: null,
            provider,
          }
        : null;
    case "failed":
      return typeof raw.failure_reason_code === "string" &&
        raw.failure_reason_code.length > 0
        ? {
            type: "pantry.provider-attempt.completed",
            attempt_id: raw.attempt_id,
            terminal_state: "failed",
            failure_reason_code: raw.failure_reason_code,
            provider,
          }
        : null;
    default:
      return null;
  }
}

function isProviderAuthorizationWindow(
  source: MessageEventSource | null,
): source is Window {
  return source !== null && "closed" in source;
}

function pollCodexAuthorization(
  props: IntegrationsRouteProps,
  requestRevision: { current: number },
  setContent: React.Dispatch<
    React.SetStateAction<SettingsRouteContent<IntegrationsRouteData>>
  >,
): void {
  void loadIntegrationsRoute(props, requestRevision, setContent);
}

function stopSettingsInterval(timer: number): void {
  window.clearInterval(timer);
}

export function emptySettingsCleanup(): void {}
