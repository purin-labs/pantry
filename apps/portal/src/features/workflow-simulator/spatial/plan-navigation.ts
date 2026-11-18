import { icon, type IconName } from "./icons";
import {
  fitView,
  metres,
  panView,
  scaleBarLength,
  zoomAt,
  type PlanInsets,
  type PlanPoint,
  type PlanRect,
  type PlanSize,
  type PlanView,
} from "@seams/production-simulation/floor/plan-view";

type Gesture =
  | Readonly<{ kind: "idle" }>
  | Readonly<{
      kind: "pan";
      pointer: number;
      start: PlanPoint;
      view: PlanView;
      moved: boolean;
    }>
  | Readonly<{
      kind: "pinch";
      distance: number;
      center: PlanPoint;
      view: PlanView;
    }>
  | Readonly<{
      kind: "place";
      pointer: number;
      x: number;
      y: number;
      millimetresPerPixel: number;
      move: (xMm: number, yMm: number) => void;
      moved: boolean;
    }>;

/** What navigation needs from the drawing it moves. */
type PlanNavigationTarget = Readonly<{
  size(): PlanSize;
  insets(): PlanInsets;
  /** The area fitted whenever the viewer has not navigated or framed equipment. */
  room(): PlanRect;
  selection(): PlanRect | null;
  /** The overview is always fitted and never navigates. */
  overview(): boolean;
  /** A placement move when the pointer starts on draggable equipment. */
  grab(
    target: EventTarget | null,
    point?: PlanPoint,
  ): ((xMm: number, yMm: number) => void) | null;
  /** A click that did not end a drag. */
  click(target: EventTarget | null): void;
  render(): void;
}>;

/** Fit selection never zooms tighter than this span, in metres. */
const selectionSpan = 1.5;
/** Pixels between framed equipment and the view controls. */
const framingGap = 8;
const keyboardPan = 48;
const zoomStep = 1.4;

/**
 * Pan, zoom and fit for one plan drawing. A drag that starts on draggable
 * equipment moves that equipment instead; every other drag moves the view.
 */
export class PlanNavigation {
  readonly element = document.createElement("div");
  private readonly scale = document.createElement("div");
  private readonly stack = document.createElement("div");
  private readonly zoomInButton = navButton("plus", "Zoom in", "Zoom in (+)");
  private readonly fitRoomButton = navButton(
    "maximize",
    "Fit room",
    "Show the whole room (0)",
  );
  private readonly fitSelectionButton = navButton(
    "focus",
    "Fit selection",
    "Zoom to the selection (F)",
  );
  /** Null follows the framed equipment, or else the fitted room. */
  private view: PlanView | null = null;
  private framed: PlanRect | null = null;
  private gesture: Gesture = { kind: "idle" };
  private readonly pointers = new Map<number, PlanPoint>();
  private suppressClick = false;
  private downTarget: EventTarget | null = null;

  constructor(
    private readonly map: HTMLElement,
    private readonly target: PlanNavigationTarget,
  ) {
    this.element.className = "spatial-plan-nav";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Floor plan view");
    this.scale.className = "spatial-plan-scale";
    this.zoomInButton.addEventListener(
      "click",
      this.zoomBy.bind(this, zoomStep),
    );
    const zoomOut = navButton("minus", "Zoom out", "Zoom out (−)");
    zoomOut.addEventListener("click", this.zoomBy.bind(this, 1 / zoomStep));
    const zoom = document.createElement("div");
    zoom.className = "spatial-plan-zoom";
    zoom.append(this.zoomInButton, zoomOut);
    this.fitRoomButton.hidden = true;
    this.fitRoomButton.addEventListener(
      "click",
      this.fitRoomPressed.bind(this),
    );
    this.fitSelectionButton.hidden = true;
    this.fitSelectionButton.addEventListener(
      "click",
      this.fitSelection.bind(this),
    );
    // Zoom stays put; the fit actions stack above it only while they would
    // change the view.
    this.stack.className = "spatial-plan-stack";
    this.stack.append(this.fitRoomButton, this.fitSelectionButton, zoom);
    this.element.append(this.scale, this.stack);
    map.setAttribute(
      "aria-description",
      "Drag to pan. Scroll or pinch to zoom. Plus and minus zoom, arrow keys pan, 0 fits the room and F fits the selection.",
    );
    map.addEventListener("pointerdown", this.pointerDown.bind(this));
    map.addEventListener("pointermove", this.pointerMove.bind(this));
    map.addEventListener("pointerup", this.pointerUp.bind(this));
    map.addEventListener("pointercancel", this.pointerUp.bind(this));
    map.addEventListener("wheel", this.wheel.bind(this), { passive: false });
    map.addEventListener("click", this.click.bind(this));
    map.addEventListener("keydown", this.keyDown.bind(this));
  }

  get navigated(): boolean {
    return this.view !== null;
  }

  /** The overview always shows the whole room; navigation belongs to the panel. */
  current(): PlanView {
    if (this.target.overview()) return this.fitted();
    if (this.view !== null) return this.view;
    return this.framed === null
      ? this.fitted()
      : fitView(
          this.framed,
          this.target.size(),
          this.framingInsets(),
          selectionSpan,
        );
  }

  /** Keeps a rect in view, as Fit selection does, until the viewer navigates. */
  frame(rect: PlanRect | null): void {
    this.framed = rect;
    this.view = null;
  }

  /** Sizes the scale bar; Fit room shows once the view leaves the room. */
  showView(view: PlanView): void {
    const length = scaleBarLength(view.scale);
    this.scale.style.width = `${length * view.scale}px`;
    this.scale.textContent = metres(length);
    this.fitRoomButton.hidden = this.view === null && this.framed === null;
  }

  /** Fit selection shows only while there is a selection to fit. */
  setSelectable(selectable: boolean): void {
    this.fitSelectionButton.hidden = !selectable;
  }

  /** Places a control beside the scale bar, ahead of the view controls. */
  addInfoControl(control: HTMLElement): void {
    this.element.insertBefore(control, this.stack);
  }

  /** Returns to the fitted room without drawing; the caller redraws. */
  reset(): void {
    this.view = null;
  }

  /** Ends a placement drag whose equipment is no longer draggable. */
  release(): void {
    if (this.gesture.kind === "place") this.gesture = { kind: "idle" };
  }

  private fitted(): PlanView {
    return fitView(
      this.target.room(),
      this.target.size(),
      this.target.insets(),
    );
  }

  /**
   * Framed equipment stays clear of the controls at the drawing's edge. The
   * room keeps the full width; an overlap there covers only its margin.
   */
  private framingInsets(): PlanInsets {
    const insets = this.target.insets();
    const edge = this.map.getBoundingClientRect().right;
    const stack = this.stack.getBoundingClientRect();
    if (stack.width === 0) return insets;
    return {
      ...insets,
      right: Math.max(insets.right, edge - stack.left + framingGap),
    };
  }

  private limits(): Readonly<{ min: number; max: number }> {
    const fitted = this.fitted().scale;
    // 800 px per metre resolves 1.25 mm per pixel.
    return { min: fitted * 0.5, max: Math.max(fitted * 4, 800) };
  }

  private center(): PlanPoint {
    const size = this.target.size();
    return { x: size.width / 2, y: size.height / 2 };
  }

  private show(view: PlanView): void {
    const limits = this.limits();
    const scale = Math.min(limits.max, Math.max(limits.min, view.scale));
    this.view =
      scale === view.scale
        ? view
        : zoomAt(
            view,
            this.target.size(),
            this.center(),
            scale / view.scale,
            limits,
          );
    this.target.render();
  }

  private zoomBy(factor: number): void {
    this.show(
      zoomAt(
        this.current(),
        this.target.size(),
        this.center(),
        factor,
        this.limits(),
      ),
    );
  }

  private fitRoom(): void {
    this.view = null;
    this.framed = null;
    this.target.render();
  }

  /** The button hides once the room is fitted, so focus stays on the zoom. */
  private fitRoomPressed(): void {
    const focused = document.activeElement === this.fitRoomButton;
    this.fitRoom();
    if (focused) this.zoomInButton.focus();
  }

  private fitSelection(): void {
    const selection = this.target.selection();
    if (selection === null) return;
    this.show(
      fitView(
        selection,
        this.target.size(),
        this.framingInsets(),
        selectionSpan,
      ),
    );
  }

  private localPoint(event: MouseEvent): PlanPoint {
    const rect = this.map.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private pointerDown(event: PointerEvent): void {
    this.suppressClick = false;
    this.downTarget = event.target;
    if (this.target.overview()) return;
    const point = this.localPoint(event);
    const move =
      event.button === 0 ? this.target.grab(event.target, point) : null;
    if (move !== null) {
      this.gesture = {
        kind: "place",
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        millimetresPerPixel: 1000 / this.current().scale,
        move,
        moved: false,
      };
      this.map.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    if (event.pointerType === "mouse" && event.button > 1) return;
    this.pointers.set(event.pointerId, point);
    if (this.pointers.size === 2) {
      const [first, second] = [...this.pointers.values()];
      if (first === undefined || second === undefined) return;
      this.gesture = {
        kind: "pinch",
        distance: Math.max(1, distance(first, second)),
        center: midpoint(first, second),
        view: this.current(),
      };
      return;
    }
    this.gesture = {
      kind: "pan",
      pointer: event.pointerId,
      start: point,
      view: this.current(),
      moved: false,
    };
  }

  private pointerMove(event: PointerEvent): void {
    const gesture = this.gesture;
    if (gesture.kind === "place") {
      if (event.pointerId !== gesture.pointer) return;
      const dx = event.clientX - gesture.x;
      const dy = gesture.y - event.clientY;
      if (!gesture.moved && Math.abs(dx) + Math.abs(dy) < 2) return;
      if (!gesture.moved) this.gesture = { ...gesture, moved: true };
      gesture.move(
        Math.round(dx * gesture.millimetresPerPixel),
        Math.round(dy * gesture.millimetresPerPixel),
      );
      return;
    }
    if (!this.pointers.has(event.pointerId)) return;
    const point = this.localPoint(event);
    this.pointers.set(event.pointerId, point);
    if (gesture.kind === "pinch") {
      const [first, second] = [...this.pointers.values()];
      if (first === undefined || second === undefined) return;
      const center = midpoint(first, second);
      this.show(
        panView(
          zoomAt(
            gesture.view,
            this.target.size(),
            gesture.center,
            distance(first, second) / gesture.distance,
            this.limits(),
          ),
          center.x - gesture.center.x,
          center.y - gesture.center.y,
        ),
      );
      return;
    }
    if (gesture.kind !== "pan" || event.pointerId !== gesture.pointer) return;
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      // Capture only once dragging starts, so a plain click keeps its target.
      this.map.setPointerCapture(event.pointerId);
      this.map.dataset.panning = "true";
      this.gesture = { ...gesture, moved: true };
    }
    this.show(panView(gesture.view, dx, dy));
  }

  private pointerUp(event: PointerEvent): void {
    const gesture = this.gesture;
    this.pointers.delete(event.pointerId);
    if (gesture.kind === "place" || gesture.kind === "pan") {
      if (event.pointerId !== gesture.pointer) return;
      this.suppressClick = gesture.moved;
    } else if (gesture.kind === "pinch") this.suppressClick = true;
    else return;
    if (this.map.hasPointerCapture(event.pointerId))
      this.map.releasePointerCapture(event.pointerId);
    delete this.map.dataset.panning;
    this.gesture = { kind: "idle" };
    this.pointers.clear();
  }

  private wheel(event: WheelEvent): void {
    if (this.target.overview()) return;
    event.preventDefault();
    let delta = event.deltaY;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
    else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
      delta *= this.target.size().height;
    // Trackpad pinches arrive as ctrl-wheel events with small deltas.
    const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015));
    this.show(
      zoomAt(
        this.current(),
        this.target.size(),
        this.localPoint(event),
        factor,
        this.limits(),
      ),
    );
  }

  private click(event: MouseEvent): void {
    const target = this.downTarget ?? event.target;
    this.downTarget = null;
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    this.target.click(target);
  }

  private keyDown(event: KeyboardEvent): void {
    if (
      this.target.overview() ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    switch (event.key) {
      case "+":
      case "=":
        this.zoomBy(zoomStep);
        break;
      case "-":
      case "_":
        this.zoomBy(1 / zoomStep);
        break;
      case "0":
        this.fitRoom();
        break;
      case "f":
      case "F":
        this.fitSelection();
        break;
      case "ArrowLeft":
        this.show(panView(this.current(), keyboardPan, 0));
        break;
      case "ArrowRight":
        this.show(panView(this.current(), -keyboardPan, 0));
        break;
      case "ArrowUp":
        this.show(panView(this.current(), 0, keyboardPan));
        break;
      case "ArrowDown":
        this.show(panView(this.current(), 0, -keyboardPan));
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}

function navButton(
  name: IconName,
  label: string,
  title: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", label);
  button.append(icon(name, 16));
  return button;
}

function distance(a: PlanPoint, b: PlanPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: PlanPoint, b: PlanPoint): PlanPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
