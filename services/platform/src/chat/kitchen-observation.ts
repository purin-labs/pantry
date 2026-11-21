import {
  KITCHEN_SURFACE,
  SURFACE_OBSERVATION_MAX_BYTES,
  surfaceObservationBytes,
  type PortalPageViewFact,
  type PortalPageViewSection,
  type SurfaceObservationV2,
} from "@purin-labs/control-api";
import type { BakeryBrowserContext } from "@purin-labs/bakery-model/bakery-context";
import { isRecord } from "@purin-labs/std";
import {
  bakerySurfaceAttachmentFromState,
  parseBakerySurfaceAttachment,
  verifyBakerySurfaceAttachment,
  type BakerySurfaceAttachmentV1,
  type BakerySurfaceContextV1,
} from "@purin-labs/bakery-model/bakery-surface";
import type { ChatSurfaceState, ChatSurfaces } from "./surface-registry";

/**
 * The Kitchen behind the v2 screen observation (Plan 87 phase 2). The
 * Kitchen page sends its current view as the observation's `state`, and the
 * server makes the `view` that the model reads from that state, so a browser
 * cannot send a view that differs from its state. The Kitchen code still
 * works on a `BakerySurfaceAttachmentV1`: this adapter derives it from the
 * state, with a digest that the server computes.
 */
const KITCHEN_TITLE = "Workflow simulator";
const KITCHEN_PATH = "/workflow-simulator";
const VALUE_LENGTH = 400;

const attachments = new WeakMap<
  SurfaceObservationV2,
  BakerySurfaceAttachmentV1 | null
>();

/** The Kitchen view that an observation carries, for the Kitchen code. */
function kitchenAttachment(
  observation: SurfaceObservationV2 | undefined,
): BakerySurfaceAttachmentV1 | null {
  if (
    observation === undefined ||
    observation.surface !== KITCHEN_SURFACE ||
    observation.state === null
  )
    return null;
  const known = attachments.get(observation);
  if (known !== undefined) return known;
  const attachment = bakerySurfaceAttachmentFromState(observation.state);
  attachments.set(observation, attachment);
  return attachment;
}

/**
 * A Kitchen observation from the browser, with its state checked and its
 * view made by the server. Only the Kitchen has typed state now. Null when
 * the state breaks its contract, or names another surface session, epoch or
 * browser than the message.
 */
function admitKitchenState(
  observation: SurfaceObservationV2,
  browser: BakeryBrowserContext,
): SurfaceObservationV2 | null {
  if (observation.state === null) return observation;
  if (observation.surface !== KITCHEN_SURFACE) return null;
  const attachment = bakerySurfaceAttachmentFromState(observation.state);
  const instance = observation.instance;
  if (
    attachment === null ||
    instance === null ||
    instance.surfaceSessionId !== attachment.context.surfaceSessionId ||
    instance.epoch !== attachment.context.surfaceEpoch ||
    (browser.kind !== "unavailable" &&
      instance.browserInstanceId !== browser.binding.browserInstanceId)
  )
    return null;
  return withKitchenView({ ...observation, state: attachment.context });
}

/**
 * Whether an old tab's Kitchen attachment still has the digest of its view,
 * as the check before phase 2 required. The server keeps its own digest.
 */
function oldKitchenAttachmentIsIntact(
  attachment: BakerySurfaceAttachmentV1,
): boolean {
  return (
    bakerySurfaceAttachmentFromState(attachment.context)?.digest ===
    attachment.digest
  );
}

/**
 * The one screen observation of a message that also holds an old Kitchen
 * attachment: a stored `surface` part, or the `surfaceContext` of a tab that
 * loaded the Portal before phase 2. The attachment fills the Kitchen's own
 * observation. A message that carried another page leaves the attachment
 * out, because that page was on screen and the Kitchen was not.
 */
function withOldKitchenAttachment(
  observation: SurfaceObservationV2 | undefined,
  attachment: BakerySurfaceAttachmentV1,
  browser: BakeryBrowserContext,
): SurfaceObservationV2 | undefined {
  if (observation === undefined)
    return kitchenObservation(attachment, browser, undefined);
  if (observation.surface === KITCHEN_SURFACE && observation.state === null)
    return kitchenObservation(attachment, browser, observation);
  return observation;
}

/**
 * The Kitchen form of a page state of the chat record, for the Kitchen code.
 * Only the Kitchen page has a typed state now, so a state of another form
 * reads as no Kitchen state.
 */
export function kitchenState(
  state: ChatSurfaceState | null,
): BakerySurfaceAttachmentV1 | null {
  return state !== null && isKitchenAttachment(state) ? state : null;
}

/** Whether a page state is a Kitchen state with the digest of its view. */
export async function verifiedKitchenState(
  state: ChatSurfaceState,
): Promise<boolean> {
  const kitchen = kitchenState(state);
  return kitchen !== null && (await verifyBakerySurfaceAttachment(kitchen));
}

function isKitchenAttachment(
  state: ChatSurfaceState,
): state is BakerySurfaceAttachmentV1 {
  return Reflect.get(state, "kind") === "bakery-surface-context";
}

/**
 * The Kitchen in the surface registry of the chat record. The Worker
 * registers it (`worker-ports.ts`).
 */
export const KITCHEN_CHAT_SURFACES: ChatSurfaces<BakerySurfaceAttachmentV1> = {
  admitState: admitKitchenState,
  stateOf: kitchenAttachment,
  parseOldState: (raw) => {
    const parsed = parseBakerySurfaceAttachment(raw);
    return parsed.kind === "valid" ? parsed.value : null;
  },
  oldStateIsIntact: oldKitchenAttachmentIsIntact,
  withOldState: withOldKitchenAttachment,
  historicalText: historicalKitchenText,
};

// A stored Kitchen snapshot that no longer parses stays readable as text,
// without becoming live command authority.
function historicalKitchenText(raw: unknown): string | null {
  if (
    !isRecord(raw) ||
    raw.kind !== "bakery-surface-context" ||
    typeof raw.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(raw.digest) ||
    !isRecord(raw.context) ||
    raw.context.schemaVersion !== 1 ||
    raw.context.kind !== "bakery-workspace"
  )
    return null;
  return `Historical Kitchen context (read-only snapshot):\n${JSON.stringify(raw)}`;
}

function kitchenObservation(
  attachment: BakerySurfaceAttachmentV1,
  browser: BakeryBrowserContext,
  page: SurfaceObservationV2 | undefined,
): SurfaceObservationV2 {
  const context = attachment.context;
  return withKitchenView({
    kind: "surface-observation",
    schemaVersion: 2,
    surface: KITCHEN_SURFACE,
    area: "BakeryOS",
    // An attachment stored with no browser names no browser instance.
    instance:
      browser.kind === "unavailable"
        ? null
        : {
            browserInstanceId: browser.binding.browserInstanceId,
            surfaceSessionId: context.surfaceSessionId,
            epoch: context.surfaceEpoch,
          },
    title: page?.title ?? KITCHEN_TITLE,
    path: page?.path ?? KITCHEN_PATH,
    record: page?.record ?? null,
    capturedAt: context.capturedAt,
    view: [],
    state: context,
    commands: [],
    sources: page?.sources ?? [],
  });
}

// The state already fits 16 KiB, so only the view can push the observation
// past its limit; the observation then keeps its state and no view. The
// observation lists the commands that the Kitchen view supports now.
function withKitchenView(
  observation: SurfaceObservationV2 & { state: BakerySurfaceContextV1 },
): SurfaceObservationV2 {
  const viewed = {
    ...observation,
    commands: [...observation.state.supportedCommands],
    view: kitchenView(observation.state),
  };
  return surfaceObservationBytes(viewed) <= SURFACE_OBSERVATION_MAX_BYTES
    ? viewed
    : { ...viewed, view: [] };
}

/** What the model reads of the Kitchen state: a short summary of the view. */
function kitchenView(context: BakerySurfaceContextV1): PortalPageViewSection[] {
  const active = context.active;
  const facts: PortalPageViewFact[] = [
    { label: "Open view", value: activeViewName(active) },
  ];
  const status = activeStatus(active);
  if (status !== null) facts.push({ label: "State", value: status });
  if ("selection" in active && active.selection != null)
    facts.push({
      label: "Selected",
      value: clip(`${active.selection.kind}: ${active.selection.label}`),
    });
  if ("playback" in active && active.playback != null)
    facts.push({
      label: "Playback",
      value: `${active.playback.playback} at ${String(active.playback.cursorSeconds)} s`,
    });
  facts.push({
    label: "Simulation",
    value: context.simulation === null ? "None running" : "Running",
  });
  if (context.comparison !== null)
    facts.push({ label: "Comparison", value: "Open" });
  if (context.runOpenReview !== null)
    facts.push({
      label: "Run to open",
      value: clip(context.runOpenReview.name),
    });
  facts.push({
    label: "Agent commands now",
    value: clip(context.supportedCommands.join(", ") || "None"),
  });
  return [{ title: "Kitchen view", facts, table: null }];
}

function activeViewName(active: BakerySurfaceContextV1["active"]): string {
  switch (active.kind) {
    case "shift":
      return "Shift";
    case "rehearsal":
      return `Rehearsal (${active.rehearsalKind})`;
    case "production":
      return "Production";
    case "persistent":
      return "Production run";
    case "persistent-snapshot":
      return "Production run snapshot";
  }
}

function activeStatus(active: BakerySurfaceContextV1["active"]): string | null {
  switch (active.kind) {
    case "shift":
      return `Run ${active.run.state}`;
    case "rehearsal":
    case "production":
      return active.readiness;
    case "persistent":
      return active.status;
    case "persistent-snapshot":
      return null;
  }
}

function clip(value: string): string {
  return value.length <= VALUE_LENGTH
    ? value
    : `${value.slice(0, VALUE_LENGTH - 1)}…`;
}
