import { bakeryBrowserInstanceId } from "@purin-labs/area-kitchen-contract/ui/features/bakery-browser-context";
import React from "react";
import {
  parseBakerySurfaceEffect,
  createBakerySurfaceReceipt,
  isPageCommandEffect,
  verifyBakerySurfaceEffect,
  type BakerySurfaceEffectV1,
  type BakerySurfaceReceiptV1,
  type PageCommandEffectV1,
} from "@purin-labs/bakery-model/bakery-surface";
import { runPageCommand } from "@purin-labs/ui/features/surface-observation";
import {
  bakerySurfaceForOrganisation,
  notifySurfaceListeners,
  deliverBakerySurfaceEffect,
  subscribeBakerySurface,
  type MountedBakerySurface,
} from "@purin-labs/area-kitchen-contract/ui/features/bakery-surface-registry";
import {
  subscribeSurfaceEffects,
  surfaceSignalsLive,
} from "@purin-labs/ui/features/surface-effect-signals";
import type { Variant } from "@purin-labs/type-utils";
import { errorMessage, isRecord } from "@purin-labs/std";
import {
  ControlApiError,
  controlRead,
  controlWrite,
  readCookie,
} from "@purin-labs/control/portal/control-client";

type BakerySurfaceEffectBridgeProps = Readonly<{
  organisationId: string;
  active: boolean;
  reveal: () => Promise<void>;
}>;

type PendingEffect = Readonly<{
  effect: Variant<
    ReturnType<typeof parseBakerySurfaceEffect>,
    "valid"
  >["value"];
}>;

const ACTIVE_POLL_MS = 150;
/** While the chat signal socket is live, it announces each new command. */
const SIGNALLED_POLL_MS = 1_000;
const RETRY_POLL_MS = 1_000;
const IDLE_POLL_INITIAL_MS = 2_000;
const IDLE_POLL_MAX_MS = 5_000;
const MAX_IN_FLIGHT = 4;

type RunningDelivery = Readonly<{
  effect: BakerySurfaceEffectV1;
  surface: MountedBakerySurface | null;
  conversationId: string;
  request: AbortController;
}>;

export class BakerySurfaceEffectBridge extends React.Component<BakerySurfaceEffectBridgeProps> {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeSignals: (() => void) | null = null;
  private signalled = false;
  private timer: number | null = null;
  private request: AbortController | null = null;
  private generation = 0;
  private idleDelay = IDLE_POLL_INITIAL_MS;
  private readonly inFlight = new Map<string, RunningDelivery>();
  private pollingSurface: MountedBakerySurface | null = null;
  private pollingOrganisation: string | null = null;
  private pollingConversationId: string | null = null;
  private readonly syncBrowserContext = this.syncSurface.bind(this);

  componentDidMount(): void {
    this.unsubscribe = subscribeBakerySurface(this.syncBrowserContext);
    this.unsubscribeSignals = subscribeSurfaceEffects(
      this.readSignalled.bind(this),
    );
    window.addEventListener("popstate", this.syncBrowserContext);
    this.syncSurface();
  }

  componentDidUpdate(previous: BakerySurfaceEffectBridgeProps): void {
    if (
      previous.organisationId !== this.props.organisationId ||
      previous.active !== this.props.active
    )
      this.syncSurface();
  }

  componentWillUnmount(): void {
    this.generation += 1;
    this.clearTimer();
    this.abortRequest();
    this.cancelDeliveries();
    this.pollingSurface = null;
    window.removeEventListener("popstate", this.syncBrowserContext);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeSignals?.();
    this.unsubscribeSignals = null;
  }

  render(): React.ReactNode {
    return null;
  }

  private syncSurface(): void {
    const surface = bakerySurfaceForOrganisation(this.props.organisationId);
    const conversationId = bakerySurfaceConversationId();
    if (
      this.pollingOrganisation === this.props.organisationId &&
      this.pollingConversationId === conversationId &&
      this.props.active
    ) {
      this.pollingSurface = surface;
      return;
    }
    this.pollingSurface = surface;
    this.pollingOrganisation = this.props.active
      ? this.props.organisationId
      : null;
    this.pollingConversationId = this.props.active ? conversationId : null;
    this.generation += 1;
    this.clearTimer();
    this.abortRequest();
    this.cancelDeliveries();
    this.idleDelay = IDLE_POLL_INITIAL_MS;
    if (!this.props.active || conversationId === null) return;
    void this.poll(this.generation);
  }

  private async poll(generation: number): Promise<void> {
    const conversationId = bakerySurfaceConversationId();
    if (conversationId === null) return;
    let delay = this.idleDelay;
    const request = new AbortController();
    this.request = request;
    try {
      const read = await readPendingEffects(
        this.props.organisationId,
        request.signal,
        await bakeryBrowserInstanceId(),
        conversationId,
      );
      if (!this.isCurrent(generation)) return;
      if (read.kind === "denied") this.cancelDeliveries();
      const effects = read.kind === "available" ? read.effects : [];
      for (const delivery of this.inFlight.values()) {
        const present = effects.some(sameDelivery.bind(null, delivery.effect));
        // A full page cannot establish that an effect is absent.
        if (
          Date.now() >= delivery.effect.deadlineAt ||
          (!present && effects.length < MAX_IN_FLIGHT)
        )
          this.cancelDelivery(delivery);
      }
      delay =
        effects.length === 0
          ? this.nextIdleDelay()
          : surfaceSignalsLive()
            ? SIGNALLED_POLL_MS
            : ACTIVE_POLL_MS;
      if (effects.length > 0) this.idleDelay = IDLE_POLL_INITIAL_MS;
      for (const pending of effects) {
        if (!this.isCurrent(generation)) return;
        if (this.inFlight.has(pending.effect.effectId)) continue;
        if (this.inFlight.size >= MAX_IN_FLIGHT) break;
        const delivery: RunningDelivery = {
          effect: pending.effect,
          surface: this.pollingSurface,
          conversationId,
          request: new AbortController(),
        };
        this.inFlight.set(pending.effect.effectId, delivery);
        if (pending.effect.command.kind === "prepare_context")
          notifySurfaceListeners();
        void this.deliver(this.props.organisationId, delivery);
      }
    } catch {
      if (request.signal.aborted) return;
      delay = RETRY_POLL_MS;
    } finally {
      if (this.request === request) this.request = null;
    }
    if (!this.isCurrent(generation)) return;
    if (this.signalled) {
      this.signalled = false;
      delay = 0;
    }
    this.timer = window.setTimeout(this.poll.bind(this, generation), delay);
  }

  private async deliver(
    organisationId: string,
    delivery: RunningDelivery,
  ): Promise<void> {
    try {
      if (
        delivery.request.signal.aborted ||
        delivery.conversationId !== bakerySurfaceConversationId()
      )
        return;
      const receipt =
        delivery.effect.command.kind === "prepare_context"
          ? await this.prepare(organisationId, delivery)
          : isPageCommandEffect(delivery.effect)
            ? await runPageCommandEffect(organisationId, delivery.effect)
            : await deliverBakerySurfaceEffect(organisationId, delivery.effect);
      if (
        delivery.request.signal.aborted ||
        delivery.conversationId !== bakerySurfaceConversationId()
      )
        return;
      await submitSurfaceReceipt(
        organisationId,
        delivery.effect.effectId,
        receipt,
        delivery.request.signal,
      );
      notifySurfaceListeners();
    } catch {
      // The next poll retries delivery; the surface ledger retains its result.
    } finally {
      if (this.inFlight.get(delivery.effect.effectId) === delivery)
        this.inFlight.delete(delivery.effect.effectId);
    }
  }

  private cancelDelivery(delivery: RunningDelivery): void {
    delivery.request.abort();
    delivery.surface?.cancel(delivery.effect);
    this.inFlight.delete(delivery.effect.effectId);
  }

  private cancelDeliveries(): void {
    for (const delivery of this.inFlight.values())
      this.cancelDelivery(delivery);
  }

  private isCurrent(generation: number): boolean {
    return (
      generation === this.generation &&
      this.props.active &&
      this.pollingConversationId === bakerySurfaceConversationId()
    );
  }

  private async prepare(organisationId: string, delivery: RunningDelivery) {
    const effect = delivery.effect;
    if (effect.command.kind !== "prepare_context")
      throw new Error("Expected preparation");
    if (
      !(await verifyBakerySurfaceEffect(effect)) ||
      effect.command.binding.browserInstanceId !==
        (await bakeryBrowserInstanceId()) ||
      effect.command.binding.conversationId !== bakerySurfaceConversationId()
    )
      throw new Error("Preparation belongs to another browser request");
    if (!(await bakerySurfaceEffectIsPending(organisationId, effect)))
      throw new Error("Preparation is no longer pending");
    try {
      await this.props.reveal();
    } catch (error) {
      return createBakerySurfaceReceipt(effect, {
        kind: "delivery_failed",
        code: "surface_unavailable",
        message: errorMessage(
          error,
          "Kitchen could not preserve the current page during activation.",
        ),
      });
    }
    if (!this.props.active || delivery.request.signal.aborted)
      throw new Error("Preparation cancelled");
    const surface = bakerySurfaceForOrganisation(organisationId);
    if (surface === null) throw new Error("Kitchen is still mounting");
    const captured = await surface.capture();
    if (
      delivery.request.signal.aborted ||
      !(await bakerySurfaceEffectIsPending(organisationId, effect))
    )
      throw new Error("Preparation cancelled");
    if (
      !captured.context.supportedCommands.includes(
        effect.command.requiredCommand,
      )
    )
      return createBakerySurfaceReceipt(effect, {
        kind: "delivery_failed",
        code: "surface_unavailable",
        message:
          "The current Kitchen view does not support this operation. Inspect its current context and select a supported operation.",
      });
    return createBakerySurfaceReceipt(effect, {
      kind: "prepared",
      binding: effect.command.binding,
      surface: captured,
    });
  }

  // A signal says that a command waits: read now, not at the next poll.
  private readSignalled(): void {
    if (!this.isCurrent(this.generation)) return;
    if (this.request !== null) {
      this.signalled = true;
      return;
    }
    this.clearTimer();
    void this.poll(this.generation);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    window.clearTimeout(this.timer);
    this.timer = null;
  }

  private abortRequest(): void {
    this.request?.abort();
    this.request = null;
  }

  private nextIdleDelay(): number {
    const delay = this.idleDelay;
    this.idleDelay = Math.min(this.idleDelay * 2, IDLE_POLL_MAX_MS);
    return delay;
  }
}

/**
 * Runs an agent's command on another Portal page, such as Costs & margins
 * (Plan 87 phase 4), and answers with what the page shows after it.
 */
async function runPageCommandEffect(
  organisationId: string,
  effect: PageCommandEffectV1,
): Promise<BakerySurfaceReceiptV1> {
  if (
    !(await verifyBakerySurfaceEffect(effect)) ||
    effect.command.binding.browserInstanceId !==
      (await bakeryBrowserInstanceId()) ||
    effect.command.binding.conversationId !== bakerySurfaceConversationId()
  )
    throw new Error("The page command belongs to another browser request");
  const result = await runPageCommand(organisationId, effect.command);
  switch (result.kind) {
    case "completed":
      return createBakerySurfaceReceipt(effect, {
        kind: "page_completed",
        observation: result.observation,
      });
    case "rejected":
      return createBakerySurfaceReceipt(effect, {
        kind: "page_rejected",
        message: result.message,
      });
    case "unavailable":
      return createBakerySurfaceReceipt(effect, {
        kind: "delivery_failed",
        code: "surface_unavailable",
        message: result.message,
      });
  }
}

function sameDelivery(
  effect: BakerySurfaceEffectV1,
  candidate: PendingEffect,
): boolean {
  return (
    candidate.effect.effectId === effect.effectId &&
    candidate.effect.dispatchId === effect.dispatchId &&
    candidate.effect.commandDigest === effect.commandDigest
  );
}

export async function bakerySurfaceEffectIsPending(
  organisationId: string,
  effect: BakerySurfaceEffectV1,
): Promise<boolean> {
  const conversationId = bakerySurfaceConversationId();
  if (conversationId === null) return false;
  try {
    const pending = await readPendingEffects(
      organisationId,
      AbortSignal.timeout(5_000),
      await bakeryBrowserInstanceId(),
      conversationId,
    );
    if (pending.kind === "denied" || Date.now() >= effect.deadlineAt)
      return false;
    for (const candidate of pending.effects) {
      if (
        candidate.effect.effectId === effect.effectId &&
        candidate.effect.commandDigest === effect.commandDigest &&
        candidate.effect.dispatchId === effect.dispatchId
      )
        return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function readPendingEffects(
  organisationId: string,
  signal: AbortSignal,
  browserInstanceId: string,
  conversationId: string,
): Promise<
  | Readonly<{ kind: "available"; effects: readonly PendingEffect[] }>
  | Readonly<{ kind: "denied" }>
> {
  let raw: unknown;
  try {
    raw = await controlRead(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/chat/surface-effects?browserInstanceId=${encodeURIComponent(browserInstanceId)}&conversationId=${encodeURIComponent(conversationId)}`,
      signal,
    );
  } catch (error) {
    if (!(error instanceof ControlApiError) || error.status === null)
      throw error;
    if (error.status === 401 || error.status === 403 || error.status === 404)
      return { kind: "denied" };
    raw = null;
  }
  if (!isRecord(raw) || raw.ok !== true || !Array.isArray(raw.effects))
    throw new Error("Kitchen effect delivery is unavailable");
  const effects: PendingEffect[] = [];
  for (const candidate of raw.effects) {
    if (!isRecord(candidate) || Object.keys(candidate).length !== 1)
      throw new Error("Kitchen returned an invalid surface effect");
    const parsed = parseBakerySurfaceEffect(candidate.effect);
    if (parsed.kind === "invalid")
      throw new Error("Kitchen returned an invalid surface effect");
    effects.push({ effect: parsed.value });
  }
  return { kind: "available", effects };
}

async function submitSurfaceReceipt(
  organisationId: string,
  effectId: string,
  receipt: Awaited<ReturnType<typeof deliverBakerySurfaceEffect>>,
  signal: AbortSignal,
): Promise<void> {
  const csrf = readCookie("pantry_csrf");
  if (csrf === null) throw new Error("The control session is unavailable");
  try {
    await controlWrite(
      `/v1/control/organisations/${encodeURIComponent(organisationId)}/chat/surface-effects/${encodeURIComponent(effectId)}/receipt`,
      "POST",
      { receipt },
      signal,
    );
  } catch (error) {
    if (error instanceof ControlApiError)
      throw new Error("Kitchen receipt settlement failed");
    throw error;
  }
}

export function bakerySurfaceConversationId(): string | null {
  return new URLSearchParams(window.location.search).get("conversation");
}

/** Recheck membership and conversation after an operator reviews a proposal. */
export async function bakerySurfaceConversationIsCurrent(
  organisationId: string,
  conversationId: string,
): Promise<boolean> {
  if (bakerySurfaceConversationId() !== conversationId) return false;
  try {
    const pending = await readPendingEffects(
      organisationId,
      AbortSignal.timeout(5000),
      await bakeryBrowserInstanceId(),
      conversationId,
    );
    return (
      pending.kind === "available" &&
      bakerySurfaceConversationId() === conversationId
    );
  } catch {
    return false;
  }
}
