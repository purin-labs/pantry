import { icon } from "./icons";

type ResizeGesture =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "dragging";
      pointerId: number;
      startX: number;
      startWidth: number;
    }>;

/**
 * "pane" shows its own Floor plan / 3D view buttons. "external" leaves the
 * open state to the host shell's navigation and adds a corner overview map.
 * The host decides when the overview shows; the pane reports whether it fits
 * and when its own header hides it.
 */
export type SpatialPaneOptions =
  | Readonly<{ trigger: "pane" }>
  | Readonly<{
      trigger: "external";
      panelId: string;
      openChange: (open: boolean) => void;
      minimapChange: (visible: boolean) => void;
      /** Whether the layout leaves room for the corner overview at all. */
      overviewRoomChange: (fits: boolean) => void;
    }>;

const widthKey = "bakery-floor-plan-width";
const defaultWidth = 440;
const minimapClearance = 300;
const occluderSelector =
  ".workflow-topbar, .workflow-playback, .workflow-scene-controls, .workflow-dock, .workflow-surface-edit, .workflow-chrome-restore, .physics-header, .physics-controls";

/** Owns view layout only; scene cameras and equipment selection stay with their scenes. */
export class SpatialPane {
  readonly viewport = document.createElement("div");
  readonly panel = document.createElement("section");
  readonly inspection = document.createElement("div");
  readonly minimapBody = document.createElement("div");
  private readonly root = document.createElement("div");
  private readonly stage = document.createElement("div");
  private readonly views = document.createElement("div");
  private readonly toggle = document.createElement("button");
  private readonly threeD = document.createElement("button");
  private readonly separator = document.createElement("div");
  private readonly minimap = document.createElement("section");
  private readonly observer: ResizeObserver;
  private drawing: Readonly<{
    element: HTMLElement;
    slot: HTMLElement;
  }> | null = null;
  private open = false;
  private compact = false;
  /** The host's choice; a narrow or crowded corner still hides the overview. */
  private minimapShown = false;
  private overviewFits: boolean | null = null;
  private width: number;
  private gesture: ResizeGesture = { kind: "idle" };

  constructor(
    private readonly host: HTMLElement,
    private readonly options: SpatialPaneOptions = { trigger: "pane" },
    private readonly closed?: () => void,
  ) {
    this.width = readWidth();
    this.root.className = "spatial-workspace";
    this.root.dataset.trigger = options.trigger;
    this.views.className = "spatial-view-controls";
    this.views.setAttribute("role", "group");
    this.views.setAttribute("aria-label", "Spatial views");
    this.toggle.type = "button";
    this.toggle.textContent = "Floor plan";
    this.toggle.addEventListener("click", this.togglePlan.bind(this));
    this.threeD.type = "button";
    this.threeD.textContent = "3D view";
    this.threeD.addEventListener("click", this.close.bind(this));
    this.views.append(this.toggle, this.threeD);
    this.stage.className = "spatial-view-stage";
    this.panel.className = "spatial-floor-plan";
    this.panel.setAttribute("aria-label", "Floor plan");
    if (options.trigger === "external") this.panel.id = options.panelId;
    this.panel.addEventListener("keydown", this.panelKeyDown.bind(this));
    this.viewport.className = "spatial-scene-viewport";
    this.separator.className = "spatial-pane-resizer";
    this.separator.setAttribute("data-resize-handle", "");
    this.separator.tabIndex = 0;
    this.separator.setAttribute("role", "separator");
    this.separator.setAttribute("aria-orientation", "vertical");
    this.separator.setAttribute("aria-label", "Resize floor plan");
    this.separator.addEventListener("pointerdown", this.startResize.bind(this));
    this.separator.addEventListener(
      "pointermove",
      this.resizePointer.bind(this),
    );
    this.separator.addEventListener("pointerup", this.finishResize.bind(this));
    this.separator.addEventListener(
      "pointercancel",
      this.cancelResize.bind(this),
    );
    this.separator.addEventListener("keydown", this.resizeKeyDown.bind(this));
    this.stage.append(this.panel, this.separator, this.viewport);
    if (options.trigger === "pane") this.root.append(this.views, this.stage);
    else {
      this.buildMinimap();
      this.root.append(this.views, this.stage, this.minimap);
    }
    this.inspection.className = "spatial-inspection-panel";
    this.root.append(this.inspection);
    host.append(this.root);
    this.observer = new ResizeObserver(this.layout.bind(this));
    this.observer.observe(host);
    const scope = this.scope();
    for (const element of scope.querySelectorAll(
      ".physics-header, .workflow-topbar, .physics-controls, .workflow-bottom-bar, .workflow-playback",
    ))
      this.observer.observe(element);
    this.layout();
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? "" : "none";
  }

  private buildMinimap(): void {
    this.minimap.className = "spatial-minimap";
    this.minimap.setAttribute("aria-label", "Floor plan overview");
    const header = document.createElement("div");
    header.className = "spatial-minimap-header";
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "spatial-minimap-expand";
    expand.title = "Open floor plan";
    const title = document.createElement("span");
    title.textContent = "Floor plan";
    expand.append(title, icon("expand"));
    expand.addEventListener("click", this.requestOpen.bind(this));
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "spatial-minimap-hide";
    hide.title = "Hide overview";
    hide.setAttribute("aria-label", "Hide floor plan overview");
    hide.append(icon("minus"));
    hide.addEventListener("click", this.hideMinimap.bind(this));
    header.append(expand, hide);
    this.minimapBody.className = "spatial-minimap-body";
    this.minimap.append(header, this.minimapBody);
  }

  private scope(): Element {
    return (
      this.host.closest(
        ".recording-candidate-preview, .production-native-preview, .production-layout-preview, .oven-physics-scene, .physics-replay, .workflow-simulator",
      ) ?? this.host
    );
  }

  private layout(): void {
    const host = this.host.getBoundingClientRect();
    this.compact = host.width < 840;
    const planOnly = this.compact && this.open;
    const floorPlanOnly = this.host.classList.contains(
      "physics-floor-plan-only",
    );
    this.root.dataset.planOnly = String(planOnly);
    const scope = this.scope();
    const header = scope
      .querySelector(".physics-header, .workflow-topbar")
      ?.getBoundingClientRect();
    const controls = scope
      .querySelector(
        ".physics-controls, .workflow-bottom-bar, .workflow-playback",
      )
      ?.getBoundingClientRect();
    const appHeader = this.host
      .closest(".portal-shell-workspace")
      ?.querySelector(".portal-workspace-header")
      ?.getBoundingClientRect();
    const headerBottom =
      planOnly && !floorPlanOnly ? appHeader?.bottom : header?.bottom;
    const toolbarTop = Math.max(12, (headerBottom ?? host.top) - host.top + 8);
    const contentTop =
      this.options.trigger === "pane" || planOnly
        ? toolbarTop + 52
        : toolbarTop;
    const contentBottom =
      planOnly && !floorPlanOnly
        ? 12
        : Math.max(12, host.bottom - (controls?.top ?? host.bottom) + 8);
    this.root.style.setProperty("--spatial-toolbar-top", `${toolbarTop}px`);
    this.root.style.setProperty("--spatial-content-top", `${contentTop}px`);
    this.root.style.setProperty(
      "--spatial-content-bottom",
      `${contentBottom}px`,
    );
    this.width = this.clampWidth(this.width);
    this.root.dataset.compact = String(this.compact);
    this.root.style.setProperty("--spatial-pane-width", `${this.width}px`);
    const closing = !this.panel.hidden && !this.open;
    this.panel.hidden = !this.open;
    if (closing) this.closed?.();
    this.separator.hidden = !this.open || this.compact;
    this.viewport.dataset.visible = String(!this.open || !this.compact);
    this.viewport.inert = this.open && this.compact;
    // A compact plan has no room for the 340 px inspection card: it would
    // cover the map, and the equipment under it could not take a drag.
    this.inspection.hidden = planOnly;
    this.threeD.hidden = !this.compact;
    this.views.hidden = this.options.trigger === "external" && !planOnly;
    this.toggle.hidden = this.options.trigger === "external";
    this.toggle.setAttribute("aria-pressed", String(this.open));
    this.threeD.setAttribute("aria-pressed", String(!this.open));
    this.separator.setAttribute("aria-valuemin", "280");
    this.separator.setAttribute("aria-valuemax", String(this.maxWidth()));
    this.separator.setAttribute(
      "aria-valuenow",
      String(Math.round(this.width)),
    );
    this.separator.setAttribute(
      "aria-valuetext",
      `${Math.round(this.width)} pixels`,
    );
    const fits =
      !this.compact &&
      host.height - toolbarTop - contentBottom >= minimapClearance;
    this.minimap.hidden =
      this.options.trigger !== "external" ||
      !fits ||
      this.open ||
      !this.minimapShown;
    this.placeDrawing();
    if (this.options.trigger === "external" && fits !== this.overviewFits) {
      this.overviewFits = fits;
      this.options.overviewRoomChange(fits);
    }
  }

  /** The plan drawing lives in the panel when open, else in the overview. */
  adoptDrawing(element: HTMLElement, slot: HTMLElement): void {
    this.drawing = { element, slot };
    this.placeDrawing();
  }

  private placeDrawing(): void {
    if (this.drawing === null) return;
    const target = this.minimap.hidden ? this.drawing.slot : this.minimapBody;
    this.drawing.element.dataset.variant =
      target === this.minimapBody ? "minimap" : "panel";
    if (this.drawing.element.parentElement !== target)
      target.append(this.drawing.element);
  }

  private maxWidth(): number {
    return Math.max(280, this.host.clientWidth - 360);
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.layout();
  }

  setMinimap(shown: boolean): void {
    if (this.minimapShown === shown) return;
    this.minimapShown = shown;
    this.layout();
  }

  /** Floating controls in this view that scene labels should avoid. */
  occluders(): DOMRect[] {
    const rects: DOMRect[] = [];
    const elements = [
      ...this.scope().querySelectorAll<HTMLElement>(occluderSelector),
      this.views,
      this.minimap,
      ...this.inspection.querySelectorAll<HTMLElement>(
        ".spatial-selection-inspector",
      ),
    ];
    for (const element of elements) {
      if (!element.isConnected || element.hidden) continue;
      if (!element.checkVisibility({ visibilityProperty: true })) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) rects.push(rect);
    }
    return rects;
  }

  private clampWidth(width: number): number {
    return Math.max(280, Math.min(this.maxWidth(), width));
  }

  private togglePlan(): void {
    this.open = this.compact || !this.open;
    this.layout();
  }

  private requestOpen(): void {
    if (this.options.trigger !== "external") return;
    this.open = true;
    this.layout();
    this.options.openChange(true);
    this.panel.querySelector<HTMLElement>("button")?.focus();
  }

  /** The host moves focus to its own overview control. */
  private hideMinimap(): void {
    if (this.options.trigger !== "external") return;
    this.minimapShown = false;
    this.layout();
    this.options.minimapChange(false);
  }

  close(): void {
    this.open = false;
    this.layout();
    if (this.options.trigger === "external") {
      this.options.openChange(false);
      return;
    }
    this.toggle.focus();
  }

  focusScene(): void {
    if (this.compact) this.close();
  }

  private panelKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    this.close();
  }

  private startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.gesture = {
      kind: "dragging",
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: this.width,
    };
    this.separator.setPointerCapture(event.pointerId);
  }

  private resizePointer(event: PointerEvent): void {
    if (
      this.gesture.kind !== "dragging" ||
      this.gesture.pointerId !== event.pointerId
    )
      return;
    this.width = this.clampWidth(
      this.gesture.startWidth + event.clientX - this.gesture.startX,
    );
    this.layout();
  }

  private finishResize(event: PointerEvent): void {
    if (
      this.gesture.kind !== "dragging" ||
      this.gesture.pointerId !== event.pointerId
    )
      return;
    this.gesture = { kind: "idle" };
    this.separator.releasePointerCapture(event.pointerId);
    rememberWidth(this.width);
  }

  private cancelResize(event: PointerEvent): void {
    if (
      this.gesture.kind !== "dragging" ||
      this.gesture.pointerId !== event.pointerId
    )
      return;
    this.width = this.gesture.startWidth;
    this.finishResize(event);
    this.layout();
  }

  private resizeKeyDown(event: KeyboardEvent): void {
    let width = this.width;
    switch (event.key) {
      case "ArrowLeft":
        width -= 24;
        break;
      case "ArrowRight":
        width += 24;
        break;
      case "Home":
        width = 280;
        break;
      case "End":
        width = this.maxWidth();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.width = this.clampWidth(width);
    this.layout();
    rememberWidth(this.width);
  }

  dispose(): void {
    this.observer.disconnect();
    this.root.remove();
  }
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(widthKey));
    return Number.isFinite(stored) && stored >= 280 ? stored : defaultWidth;
  } catch {
    return defaultWidth;
  }
}

function rememberWidth(width: number): void {
  try {
    localStorage.setItem(widthKey, String(Math.round(width)));
  } catch {
    /* The pane keeps its width for this session when storage is unavailable. */
  }
}
