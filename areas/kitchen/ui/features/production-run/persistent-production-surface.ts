import type { StrictUnion } from "@purin-labs/type-utils";
import { canonicalJson, sha256Hex } from "@purin-labs/std";
import type { HostIdentity, HostView } from "@purin-labs/production-simulation";
import {
  createBakerySurfaceAttachment,
  type BakeryPersistentSurface,
  type BakeryProductionSnapshotSurface,
  type BakerySurfaceContextV1,
  type BakeryProductionControl,
  type BakeryProductionReview,
  type BakeryProductionTarget,
  type BakerySurfaceCommandResultV1,
  type BakerySurfaceEffectV1,
  type ExecutableBakerySurfaceEffectV1,
} from "@purin-labs/bakery-model/bakery-surface";
import {
  bakerySurfaceEffectIsPending,
  bakerySurfaceConversationId,
  bakerySurfaceConversationIsCurrent,
} from "../bakery-surface-effect-bridge";
import {
  registerBakerySurface,
  notifySurfaceListeners,
  type MountedBakerySurface,
} from "@purin-labs/area-kitchen-contract/ui/features/bakery-surface-registry";
import {
  APPLIANCE_FOOTPRINTS,
  isApplianceId,
} from "@purin-labs/production-simulation/floor/appliance-catalogue";

type ExecutionOwner = Readonly<{
  kind: "execution";
  identity: HostIdentity;
  bundleId: string;
  observe(): HostView | null;
  live(): boolean;
  faultedAppliances?(): Readonly<
    Record<
      string,
      Readonly<{
        code: string;
        checkpointDigest: string;
        restored: boolean;
      }>
    >
  >;
  apply(control: BakeryProductionControl): Promise<void>;
}>;
type Owner = Readonly<{ organisationId: string; changed(): void }> &
  StrictUnion<
    | ExecutionOwner
    | Readonly<{ kind: "snapshot"; snapshot: BakeryProductionSnapshotSurface }>
  >;

/** This registration lives exactly as long as its owning execution worker. */
export class PersistentProductionSurface implements MountedBakerySurface {
  readonly organisationId: string;
  readonly owner: Owner;
  private readonly sessionId = crypto.randomUUID();
  private readonly unregister: () => void;
  private closed = false;
  private pending: Readonly<{
    review: BakeryProductionReview;
    conversationId: string;
    source: "effect" | "local";
  }> | null = null;
  private preparing: string | null = null;

  constructor(owner: Owner) {
    this.owner = owner;
    this.organisationId = owner.organisationId;
    this.unregister = registerBakerySurface(this);
  }
  surfaceSessionId(): string {
    return this.sessionId;
  }
  surfaceEpoch(): number {
    return 0;
  }
  get review(): BakeryProductionReview | null {
    return this.pending?.review ?? null;
  }
  close(): void {
    this.closed = true;
    this.pending = null;
    this.preparing = null;
    this.unregister();
  }
  async capture() {
    if (this.closed)
      throw new Error("The production surface is no longer available.");
    const active =
      this.owner.kind === "snapshot"
        ? this.owner.snapshot
        : executionContext(this.owner, this.review);
    return createBakerySurfaceAttachment({
      schemaVersion: 1,
      kind: "bakery-workspace",
      surfaceSessionId: this.sessionId,
      surfaceEpoch: 0,
      capturedAt: Date.now(),
      comparison: null,
      simulation: null,
      runOpenReview: null,
      supportedCommands:
        this.owner.kind === "snapshot"
          ? ["inspect_surface"]
          : ["inspect_surface", "prepare_production_control"],
      active,
    });
  }
  attachFile(): Promise<never> {
    return Promise.reject(new Error("Open production files through Recipes."));
  }
  cancel(effect: BakerySurfaceEffectV1): void {
    if (this.preparing === effect.effectId) this.preparing = null;
  }
  private current(effect: ExecutableBakerySurfaceEffectV1): boolean {
    return (
      !this.closed &&
      (this.owner.kind === "snapshot" || this.owner.observe() !== null) &&
      effect.deadlineAt > Date.now() &&
      effect.command.target.surfaceSessionId === this.sessionId &&
      effect.command.target.surfaceEpoch === 0
    );
  }
  async execute(
    effect: ExecutableBakerySurfaceEffectV1,
  ): Promise<BakerySurfaceCommandResultV1> {
    const command = effect.command;
    const conversationId = bakerySurfaceConversationId();
    if (conversationId === null)
      return reject(
        command.kind,
        "Select the current chat before proposing a control.",
      );
    if (
      !this.current(effect) ||
      !(await bakerySurfaceEffectIsPending(this.organisationId, effect)) ||
      !this.current(effect)
    )
      return reject(
        command.kind,
        "The execution target or current workspace authority is stale.",
      );
    if (command.kind === "inspect_surface")
      return {
        kind: "succeeded",
        command: command.kind,
        surface: await this.capture(),
        output: { kind: "surface" },
      };
    if (
      command.kind !== "prepare_production_control" ||
      this.owner.kind === "snapshot"
    )
      return {
        kind: "rejected",
        command: command.kind,
        code: "unsupported_command",
        message: "Use persistent production controls for this execution.",
      };
    const view = this.owner.observe();
    if (
      view === null ||
      !this.owner.live() ||
      canonicalJson(productionTarget(this.owner, view)) !==
        canonicalJson(command.production)
    )
      return reject(
        command.kind,
        "Return to the live execution and capture its current control revision.",
      );
    const problem = controlProblem(command.control, view, this.owner);
    if (problem !== null)
      return {
        kind: "rejected",
        command: command.kind,
        code: "invalid_edit",
        message: problem,
      };
    if (this.pending !== null || this.preparing !== null)
      return reject(
        command.kind,
        "Confirm or discard the current proposal before preparing another control.",
      );
    this.preparing = effect.effectId;
    const digest = await sha256Hex(
      canonicalJson({
        target: command.production,
        control: command.control,
        expiresAt: effect.deadlineAt,
      }),
    );
    if (!this.current(effect) || this.preparing !== effect.effectId)
      return reject(
        command.kind,
        "The proposal expired or was cancelled during preparation.",
      );
    this.preparing = null;
    const updated = this.owner.observe();
    if (
      updated === null ||
      canonicalJson(productionTarget(this.owner, updated)) !==
        canonicalJson(command.production)
    )
      return reject(
        command.kind,
        "The control revision changed during preparation.",
      );
    this.pending = {
      conversationId,
      source: "effect",
      review: {
        digest,
        target: command.production,
        control: command.control,
        expiresAt: effect.deadlineAt,
      },
    };
    this.owner.changed();
    notifySurfaceListeners();
    return {
      kind: "succeeded",
      command: command.kind,
      surface: await this.capture(),
      output: { kind: "surface" },
    };
  }
  async proposeLocalControl(
    control: BakeryProductionControl,
  ): Promise<BakeryProductionReview> {
    if (this.closed || this.owner.kind === "snapshot")
      throw new Error("Use persistent production controls for this execution.");
    const view = this.owner.observe();
    if (view === null || !this.owner.live())
      throw new Error(
        "Return to the live execution and capture its current control revision.",
      );
    const problem = controlProblem(control, view, this.owner);
    if (problem !== null) throw new Error(problem);
    if (this.pending !== null || this.preparing !== null)
      throw new Error(
        "Confirm or discard the current proposal before preparing another control.",
      );
    const target = productionTarget(this.owner, view);
    const expiresAt = Date.now() + 300_000;
    const digest = await sha256Hex(
      canonicalJson({
        target,
        control,
        expiresAt,
      }),
    );
    const review: BakeryProductionReview = {
      digest,
      target,
      control,
      expiresAt,
    };
    this.pending = {
      conversationId: bakerySurfaceConversationId() ?? "morning-shift-chat",
      source: "local",
      review,
    };
    this.owner.changed();
    notifySurfaceListeners();
    return review;
  }
  discard(): void {
    this.pending = null;
    this.owner.changed();
    notifySurfaceListeners();
  }
  async confirm(): Promise<void> {
    if (this.owner.kind !== "execution")
      throw new Error("A saved snapshot cannot control execution.");
    const pending = this.pending;
    if (pending === null)
      throw new Error("The production proposal is no longer available.");
    if (
      pending.source === "effect" &&
      !(await bakerySurfaceConversationIsCurrent(
        this.organisationId,
        pending.conversationId,
      ))
    )
      throw new Error(
        "Current workspace and chat authority could not be verified.",
      );
    if (this.pending !== pending)
      throw new Error("The proposal changed during confirmation.");
    const review = pending.review;
    const view = this.owner.observe();
    if (review === null || view === null || this.closed)
      throw new Error("The production proposal is no longer available.");
    if (
      !this.owner.live() ||
      review.expiresAt <= Date.now() ||
      canonicalJson(review.target) !==
        canonicalJson(productionTarget(this.owner, view))
    )
      throw new Error(
        "The proposal expired or its execution changed. Prepare a new proposal.",
      );
    const problem = controlProblem(review.control, view, this.owner);
    if (problem !== null) throw new Error(problem);
    this.pending = null;
    this.owner.changed();
    notifySurfaceListeners();
    await this.owner.apply(review.control);
  }
}
function reject(
  command: BakerySurfaceCommandResultV1["command"],
  message: string,
): BakerySurfaceCommandResultV1 {
  return { kind: "rejected", command, code: "stale_surface", message };
}
function surfaceStatus(view: HostView): BakeryPersistentSurface["status"] {
  switch (view.status.kind) {
    case "ready":
    case "advancing":
    case "awaiting-execution":
      return "running";
    case "pause-requested":
      return "busy";
    default:
      return view.status.kind;
  }
}
function controlProblem(
  control: BakeryProductionControl,
  view: HostView,
  owner?: ExecutionOwner,
): string | null {
  if (control.kind === "pause")
    return surfaceStatus(view) === "running"
      ? null
      : "Only a running execution can pause.";
  const settledForLayout =
    (control.kind === "move-equipment" ||
      control.kind === "rotate-equipment") &&
    (view.status.kind === "paused" ||
      view.status.kind === "awaiting-inspection");
  if (!settledForLayout && view.status.kind !== "paused")
    return "Pause the execution before preparing this control.";
  switch (control.kind) {
    case "resume":
      return null;
    case "extend-horizon":
      return control.horizon > view.horizon
        ? null
        : "The new horizon must follow the current horizon.";
    case "close-arrivals":
      if (view.production.kind === "available")
        for (const source of view.production.arrivals)
          if (source.id === control.source && source.kind === "open")
            return null;
      return "The named arrival source is not open.";
    case "withhold-resource":
      if (control.interval.start <= view.time)
        return "The unavailability interval must start in the future.";
      if (view.logistics.kind === "available")
        for (const resource of view.logistics.resources)
          if (resource.id === control.resource) return null;
      return "The named resource does not belong to this execution.";
    case "recover-appliance-fault": {
      const fault = owner?.faultedAppliances?.()[control.appliance];
      if (fault !== undefined) {
        if (fault.restored)
          return `Appliance ${control.appliance} has already been restored from its checkpoint.`;
        if (fault.checkpointDigest !== control.checkpointDigest)
          return `Checkpoint digest mismatch for ${control.appliance}.`;
        return null;
      }
      return control.appliance.length > 0 &&
        /^[0-9a-f]{8,64}$/i.test(control.checkpointDigest)
        ? null
        : "Specify a faulted appliance and its checkpoint digest.";
    }
    case "move-equipment":
      if (!isApplianceId(control.applianceId))
        return "The named equipment is not on this floor plan.";
      if (
        !Number.isSafeInteger(control.xMm) ||
        control.xMm < -20_000 ||
        control.xMm > 20_000 ||
        !Number.isSafeInteger(control.zMm) ||
        control.zMm < -20_000 ||
        control.zMm > 20_000
      )
        return "Equipment coordinates must be integer millimetres within the shop bounds.";
      return null;
    case "rotate-equipment":
      return isApplianceId(control.applianceId)
        ? null
        : "The named equipment is not on this floor plan.";
  }
}
export function productionControlDescription(
  control: BakeryProductionControl,
): string {
  switch (control.kind) {
    case "pause":
      return "Pause production at a committed physics boundary.";
    case "resume":
      return "Resume this paused production execution.";
    case "close-arrivals":
      return `Close arrivals from ${control.source}. Admitted work continues.`;
    case "extend-horizon":
      return `Extend the horizon to ${control.horizon / 1e6} seconds.`;
    case "withhold-resource":
      return `Make ${control.resource} unavailable for new work from ${control.interval.start / 1e6} to ${control.interval.end / 1e6} seconds.`;
    case "recover-appliance-fault":
      return `Restore faulted appliance ${control.appliance} from checkpoint ${control.checkpointDigest.slice(0, 8)} and release held linked cobot cells.`;
    case "move-equipment": {
      const label = isApplianceId(control.applianceId)
        ? APPLIANCE_FOOTPRINTS[control.applianceId].label
        : control.applianceId;
      return `Move ${label} to (${(control.xMm / 1000).toFixed(2)} m, ${(control.zMm / 1000).toFixed(2)} m) on the floor plan and update future worker walk routes.`;
    }
    case "rotate-equipment": {
      const label = isApplianceId(control.applianceId)
        ? APPLIANCE_FOOTPRINTS[control.applianceId].label
        : control.applianceId;
      return `Rotate ${label} by 90° on the floor plan and update future worker walk routes.`;
    }
  }
}

function productionTarget(
  owner: ExecutionOwner,
  view: HostView,
): BakeryProductionTarget {
  return {
    runId: owner.identity.runId,
    executionId: owner.identity.executionId,
    hostSession: owner.identity.hostSession,
    bundleId: owner.bundleId,
    controlRevision: view.controlRevision,
  };
}
function executionContext(
  owner: ExecutionOwner,
  review: BakeryProductionReview | null,
): BakerySurfaceContextV1["active"] {
  const view = owner.observe();
  if (view === null)
    throw new Error("The production execution is no longer available.");
  const resources: string[] = [];
  const arrivals: string[] = [];
  if (view.logistics.kind === "available")
    for (const resource of view.logistics.resources)
      resources.push(resource.id);
  if (view.production.kind === "available")
    for (const source of view.production.arrivals)
      if (source.kind === "open") arrivals.push(source.id);
  return {
    kind: "persistent",
    target: productionTarget(owner, view),
    status: surfaceStatus(view),
    time: view.time,
    horizon: view.horizon,
    events: view.events,
    resources,
    arrivals,
    pendingControl: review,
  };
}
