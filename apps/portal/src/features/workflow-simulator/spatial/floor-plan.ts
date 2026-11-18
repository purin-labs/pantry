import type { ResolvedApplianceMove } from "@seams/production-simulation/floor/collisions";
import {
  doorSweepIntersectsBox,
  findFloorPlanOpening,
} from "@seams/production-simulation/floor/openings";
import {
  buildOpeningElements,
  updateOpeningElements,
} from "./floor-plan-openings-svg";
import { floorPlanWorkspace } from "../floor-plan-workspace";
import * as THREE from "three";
import {
  type FloorPlanActor,
  type FloorPlanItem,
  type FitFinding,
  type PlanPolygon,
  type RecordedFitEvent,
  fillsEnvelope,
  footprintKey,
  modelBoxesIntersect,
  footprintsOverlap,
} from "./floor-plan-geometry";
import { SpatialPane, type SpatialPaneOptions } from "./spatial-pane";
import {
  metres,
  toFloor,
  toScreen,
  viewTransform,
  type PlanInsets,
  type PlanPoint,
  type PlanRect,
  type PlanSize,
} from "@seams/production-simulation/floor/plan-view";
import { PlanNavigation } from "./plan-navigation";
import { icon } from "./icons";
import { BAKERY_FLOOR_PLANS, bakeryGrid, bakeryRoom } from "@seams/production-simulation/floor/bakery-room";
import {
  moveApplianceWithCollisions,
  rotateApplianceWithCollisions,
  setApplianceRotationWithCollisions,
} from "../bakery-appliance-layout";
import {
  APPLIANCE_FOOTPRINTS,
  REHEARSAL_APPLIANCE_IDS,
  isApplianceId,
  type ApplianceId,
} from "@seams/production-simulation/floor/appliance-catalogue";
import "./floor-plan.css";

type PlanControl<Selection> = Readonly<{
  item: FloorPlanItem<Selection>;
  /** Physical outline in world metres; its size is never set by CSS. */
  shape: SVGGElement;
  edge: SVGPathElement;
  fill: SVGPathElement;
  tooltip: SVGTitleElement;
  envelope: SVGRectElement;
  /** False when the outline fills its envelope, so drawing both adds nothing. */
  envelopeAddsSpace: boolean;
  ghost: SVGRectElement;
  sweep: SVGRectElement;
  /** Fixed-size screen target for keyboard, touch and assistive technology. */
  button: HTMLButtonElement;
  name: HTMLSpanElement;
  sweepLabel: HTMLSpanElement;
  outline: THREE.Box3Helper;
  originalOutline: THREE.Box3Helper;
}>;

type FloorPlanOptions<Selection> = Readonly<{
  layoutControls?: HTMLElement;
  pane?: SpatialPaneOptions;
  /**
   * A host panel, which lists equipment itself, for selection and fit details
   * while the plan is closed; while it is open they open beside the scale bar.
   * Without one, the details float over the scene with their own list.
   */
  details?: HTMLElement;
  /** Hovering or focusing equipment in the plan previews it in 3D. */
  hover?: (selection: Selection | null) => void;
  /** Synchronizes the active rotation gizmo target with the 3D scene. */
  gizmoChange?: (id: string | null) => void;
  inspectEvent?: (event: RecordedFitEvent) => void;
  closed?: () => void;
}>;

type DimensionRow = Readonly<{
  label: string;
  value: string;
}>;

type CameraView = Readonly<{
  label: string;
  show: (bounds: THREE.Box3) => void;
}>;

const svgNamespace = "http://www.w3.org/2000/svg";
/** One hosted plan per page: the production workspace's. */
const detailsPanelId = "spatial-plan-details";
/** Room for the width dimension above and the depth dimension beside the room. */
const panelInsets: PlanInsets = { top: 28, right: 32, bottom: 10, left: 10 };
const minimapInsets: PlanInsets = { top: 6, right: 6, bottom: 6, left: 6 };
/** Half the marker's minimum size in CSS pixels. */
const markerRadius = 10;
const MAX_WATER_HOOKUP_REACH_M = 3.1;
const WATER_UTILITY_EQUIPMENT_IDS = new Set([
  "bake",
  "stage",
  "station-oven",
  "station-wash",
  "station-beverage-bar",
]);

type ScreenBox = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

/** A room view that sends placement commands to the shared workspace. */
export class FloorPlan<Selection> {
  private readonly pane: SpatialPane;
  private readonly panel: HTMLElement;
  private readonly drawing = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly footer = document.createElement("div");
  private readonly toolbar = document.createElement("div");
  private readonly map = document.createElement("div");
  private readonly svg = svgElement("svg", "spatial-floor-svg");
  private readonly defs = svgElement("defs");
  private readonly floorClip = svgElement("clipPath");
  private readonly world = svgElement("g", "spatial-plan-world");
  private readonly floorRect = svgElement("rect", "spatial-room-floor");
  private readonly gridPath = svgElement("path", "spatial-room-grid");
  private readonly fineGrid = svgElement("path", "spatial-room-grid-fine");
  private readonly rearWallRect = svgElement("rect", "spatial-room-wall");
  private openingElements: ReturnType<typeof buildOpeningElements> = [];
  private readonly customArchGroup = svgElement("g", "spatial-room-arch");
  private readonly utilityLinesGroup = svgElement("g", "spatial-utility-lines");
  private readonly ghosts = svgElement("g", "spatial-floor-ghosts");
  private readonly footprints = svgElement("g", "spatial-floor-footprints");
  private readonly envelopes = svgElement("g", "spatial-floor-envelopes");
  private readonly actorsGroup = svgElement("g", "spatial-floor-actors");
  private readonly gizmoGroup = svgElement("g", "spatial-rotate-gizmo");
  private readonly gizmoRing = svgElement(
    "circle",
    "spatial-rotate-gizmo-ring",
  );
  private readonly gizmoStem = svgElement("line", "spatial-rotate-gizmo-stem");
  private readonly gizmoHitRing = svgElement(
    "circle",
    "spatial-rotate-gizmo-hit",
  );
  private readonly rotateKnob = document.createElement("button");
  private readonly overlay = document.createElement("div");
  private readonly room = document.createElement("div");
  private readonly roomWidthLabel = document.createElement("span");
  private readonly roomDepthLabel = document.createElement("span");
  private readonly rearWallLabel = document.createElement("span");
  private readonly markers = document.createElement("div");
  readonly layoutControls: HTMLElement;
  private placement: Readonly<{
    id: string;
    move: (xMm: number, yMm: number) => void;
  }> | null = null;
  private readonly unsubscribeFloorPlan: () => void;
  private readonly unsubscribeOpenings: () => void;
  private readonly navigation: PlanNavigation;
  private size: PlanSize = { width: 1, height: 1 };
  private extent = roomBounds();
  private readonly dimensions = document.createElement("div");
  private readonly status = document.createElement("p");
  private readonly findings = document.createElement("ul");
  private readonly controls = new Map<string, PlanControl<Selection>>();
  private readonly focusButton = document.createElement("button");
  private readonly rotateButton = document.createElement("button");
  private readonly rotateButtonLabel = document.createElement("span");
  private readonly toolbarRotateButton = document.createElement("button");
  private gizmoTarget: string | null = null;
  private rotatingGizmo = false;
  private hoveredGizmo = false;
  private readonly onWindowKeyDown: (event: KeyboardEvent) => void;
  private items: readonly FloorPlanItem<Selection>[] = [];
  private selected: readonly string[] = [];
  private activeFinding: FitFinding | null = null;
  private fitInspectionListener: (() => void) | null = null;
  private fitFindings: readonly FitFinding[] = [];
  private recordedFindings: readonly FitFinding[] = [];
  private signature = "";
  private hovered: string | null = null;
  /** Selection and hover that last ordered the map names. */
  private namesKey = "";
  private readonly drawingSlot = document.createElement("div");
  private readonly inspectorContent = document.createElement("div");
  /** With a host panel, the details show here beside the open plan. */
  private readonly detailsToggle = document.createElement("button");
  private readonly detailsPanel = document.createElement("section");
  private readonly observer: ResizeObserver;

  constructor(
    host: HTMLElement,
    private scene: THREE.Scene,
    private readonly select: (selection: Selection) => void,
    private readonly focus: (bounds: THREE.Box3) => void,
    private readonly resetView: () => void,
    cameraViews: readonly CameraView[],
    private readonly options: FloorPlanOptions<Selection> = {},
  ) {
    this.layoutControls =
      options.layoutControls ?? document.createElement("div");
    this.pane = new SpatialPane(host, options.pane, options.closed);
    this.panel = this.pane.panel;
    this.body.className = "spatial-plan-body";
    this.buildMap();
    this.navigation = new PlanNavigation(this.map, {
      size: this.mapSize.bind(this),
      insets: this.insets.bind(this),
      room: this.roomRect.bind(this),
      selection: this.selectionRect.bind(this),
      overview: this.isOverview.bind(this),
      grab: this.grab.bind(this),
      click: this.clickTarget.bind(this),
      render: this.renderView.bind(this),
    });
    this.dimensions.className = "spatial-dimensions";
    this.status.setAttribute("role", "status");
    this.status.className = "spatial-fit-status";
    this.findings.className = "spatial-fit-findings";
    this.toolbar.className = "spatial-plan-toolbar";
    this.focusButton.type = "button";
    this.focusButton.textContent = "Focus selection";
    this.focusButton.addEventListener("click", this.focusSelection.bind(this));
    this.toolbarRotateButton.type = "button";
    this.toolbarRotateButton.textContent = "Rotate 90° (R)";
    this.toolbarRotateButton.title =
      "Rotate selected appliance 90° (R or double-click)";
    this.toolbarRotateButton.addEventListener(
      "click",
      this.rotateActive.bind(this),
    );
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Whole scene";
    reset.addEventListener("click", this.resetScene.bind(this));
    // A host panel sits beside a 3D view with its own camera controls.
    if (options.details === undefined)
      this.toolbar.append(this.focusButton, this.toolbarRotateButton, reset);
    else this.toolbar.append(this.toolbarRotateButton);
    this.rotateButton.type = "button";
    this.rotateButton.className = "spatial-plan-details-toggle";
    this.rotateButton.title =
      "Rotate selected appliance 90° (R or double-click)";
    this.rotateButton.setAttribute("aria-label", "Rotate 90° (R)");
    this.rotateButtonLabel.textContent = "Rotate 90° (R)";
    this.rotateButton.append(icon("rotate"), this.rotateButtonLabel);
    this.rotateButton.addEventListener("click", this.rotateActive.bind(this));
    this.navigation.addInfoControl(this.rotateButton);
    this.map.addEventListener("dblclick", this.doubleClickTarget.bind(this));
    this.onWindowKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      ) {
        return;
      }
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        (active instanceof HTMLElement &&
          active.closest("[role=combobox], [role=listbox]") !== null) ||
        (active instanceof HTMLElement && active.isContentEditable)
      ) {
        return;
      }
      if (!this.pane.isOpen && !this.panel.contains(active)) return;
      if (event.key === "Escape") {
        if (this.gizmoTarget !== null) {
          this.setGizmoTarget(null, true);
          event.preventDefault();
        }
        return;
      }
      if (event.key !== "r" && event.key !== "R") return;
      if (this.rotateActive()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", this.onWindowKeyDown);
    for (const view of cameraViews) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = view.label;
      button.addEventListener("click", this.showCameraView.bind(this, view));
      this.toolbar.append(button);
    }
    const legend = document.createElement("p");
    legend.className = "spatial-plan-legend";
    for (const [state, text] of [
      ["selected", "Selected"],
      ["blocked", "Blocked"],
      ["unchecked", "Unchecked"],
      ["envelope", "Check envelope"],
    ] as const) {
      const key = document.createElement("span");
      key.textContent = text;
      key.dataset.state = state;
      legend.append(key);
    }
    this.drawing.className = "spatial-plan-drawing";
    this.drawing.append(this.map);
    this.drawingSlot.className = "spatial-plan-drawing-slot";
    const inspectorContent = this.inspectorContent;
    inspectorContent.className = "spatial-inspector-content";
    inspectorContent.append(
      this.status,
      this.findings,
      this.dimensions,
      legend,
      this.toolbar,
    );
    if (options.details === undefined) {
      const inspector = document.createElement("section");
      inspector.className = "spatial-selection-inspector";
      inspector.setAttribute("aria-label", "Selection and fit");
      inspector.append(inspectorContent);
      this.pane.inspection.append(inspector);
    } else {
      this.buildDetailsPanel();
    }
    this.layoutControls.className = "spatial-layout-controls";
    this.footer.className = "spatial-plan-footer";
    this.footer.append(this.navigation.element, this.layoutControls);
    this.body.append(this.footer);
    this.panel.append(this.drawingSlot, this.body);
    this.pane.adoptDrawing(this.drawing, this.drawingSlot);
    this.observer = new ResizeObserver(this.layoutMap.bind(this));
    this.observer.observe(this.drawing);
    this.observer.observe(this.panel);
    this.observer.observe(this.footer);
    this.unsubscribeFloorPlan = floorPlanWorkspace.subscribePlan(() => {
      this.syncRoomSpec();
      this.navigation.reset();
      this.signature = "";
      this.updateGeometry();
    });
    this.unsubscribeOpenings = floorPlanWorkspace.subscribeOpenings(
      this.syncOpenings.bind(this),
    );
  }

  /**
   * The host panel may not share the screen with the plan, so while the plan
   * is open its details open over the drawing from beside the scale bar.
   */
  private buildDetailsPanel(): void {
    this.detailsToggle.type = "button";
    this.detailsToggle.className = "spatial-plan-details-toggle";
    this.detailsToggle.setAttribute("aria-expanded", "false");
    this.detailsToggle.setAttribute("aria-controls", detailsPanelId);
    const label = document.createElement("span");
    label.textContent = "Layout and fit";
    this.detailsToggle.append(icon("info"), label);
    this.detailsToggle.addEventListener("click", this.toggleDetails.bind(this));
    this.detailsPanel.id = detailsPanelId;
    this.detailsPanel.className = "spatial-plan-details";
    this.detailsPanel.setAttribute("aria-label", "Layout and fit");
    this.detailsPanel.hidden = true;
    this.detailsPanel.addEventListener(
      "keydown",
      this.detailsKeyDown.bind(this),
    );
    this.navigation.addInfoControl(this.detailsToggle);
    this.body.append(this.detailsPanel);
    this.placeDetails();
  }

  private placeDetails(): void {
    const host = this.options.details;
    if (host === undefined) return;
    const target = this.pane.isOpen ? this.detailsPanel : host;
    if (this.inspectorContent.parentElement !== target)
      target.append(this.inspectorContent);
    if (!this.pane.isOpen) this.showDetails(false);
  }

  private toggleDetails(): void {
    this.showDetails(Boolean(this.detailsPanel.hidden));
  }

  private showDetails(open: boolean): void {
    const closing = !this.detailsPanel.hidden && !open;
    this.detailsPanel.hidden = !open;
    this.detailsToggle.setAttribute("aria-expanded", String(open));
    if (closing) this.options.closed?.();
  }

  /** Escape closes the details before it would close the plan. */
  private detailsKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    this.showDetails(false);
    this.detailsToggle.focus();
  }

  /** The room drawing: SVG in world metres beneath an HTML control overlay. */
  private buildMap(): void {
    this.map.className = "spatial-floor-map";
    this.map.setAttribute("role", "group");
    this.map.setAttribute("aria-label", "Equipment floor plan");
    this.svg.setAttribute("aria-hidden", "true");
    this.gizmoGroup.setAttribute("hidden", "");
    this.gizmoGroup.append(this.gizmoStem, this.gizmoRing, this.gizmoHitRing);
    const enterGizmo = (): void => {
      this.hoveredGizmo = true;
      this.syncGizmoActiveState();
    };
    const leaveGizmo = (): void => {
      this.hoveredGizmo = false;
      this.syncGizmoActiveState();
    };
    this.gizmoHitRing.addEventListener("pointerenter", enterGizmo);
    this.gizmoHitRing.addEventListener("pointerleave", leaveGizmo);
    this.rotateKnob.addEventListener("pointerenter", enterGizmo);
    this.rotateKnob.addEventListener("pointerleave", leaveGizmo);
    this.world.append(
      this.floorRect,
      this.fineGrid,
      this.gridPath,
      this.rearWallRect,
      this.customArchGroup,
      this.utilityLinesGroup,
      this.ghosts,
      this.footprints,
      this.envelopes,
      this.actorsGroup,
      this.gizmoGroup,
    );
    this.floorClip.setAttribute("id", "spatial-room-zones-clip");
    this.defs.append(this.floorClip);
    this.svg.append(this.defs, this.world);
    this.customArchGroup.addEventListener(
      "keydown",
      this.openingKeyDown.bind(this),
    );
    this.room.className = "spatial-room-boundary";
    this.room.setAttribute("role", "img");
    this.roomWidthLabel.className = "spatial-room-width";
    this.roomDepthLabel.className = "spatial-room-depth";
    this.rearWallLabel.className = "spatial-room-wall-label";
    this.rearWallLabel.textContent = "Rear wall";
    this.room.append(
      this.roomWidthLabel,
      this.roomDepthLabel,
      this.rearWallLabel,
    );
    this.syncRoomSpec();
    this.rotateKnob.type = "button";
    this.rotateKnob.className = "spatial-rotate-gizmo-knob";
    this.rotateKnob.hidden = true;
    this.rotateKnob.title =
      "Drag around circle to rotate (or click to rotate 90°)";
    this.rotateKnob.setAttribute("aria-label", "Rotate handle");
    this.rotateKnob.append(icon("rotate", 12));
    this.markers.className = "spatial-floor-markers";
    this.overlay.className = "spatial-plan-overlay";
    this.overlay.append(this.room, this.markers, this.rotateKnob);
    this.map.append(this.svg, this.overlay);
  }

  private syncRoomSpec(): void {
    const planId = floorPlanWorkspace.getActivePlan();
    const spec = BAKERY_FLOOR_PLANS[planId];
    const hasVoids = (spec.voids?.length ?? 0) > 0;
    setRect(this.floorRect, roomBounds());
    this.gridPath.setAttribute(
      "d",
      roomGrid(bakeryGrid.primary, 0, spec.width, spec.depth),
    );
    this.fineGrid.setAttribute(
      "d",
      roomGrid(
        bakeryGrid.secondary,
        bakeryGrid.primary,
        spec.width,
        spec.depth,
      ),
    );
    this.floorClip.replaceChildren();
    if (hasVoids) {
      for (const zone of spec.zones) {
        const zRect = svgElement("rect");
        zRect.setAttribute("x", String(Math.min(zone.x0, zone.x1)));
        zRect.setAttribute("y", String(Math.min(zone.z0, zone.z1)));
        zRect.setAttribute("width", String(Math.abs(zone.x1 - zone.x0)));
        zRect.setAttribute("height", String(Math.abs(zone.z1 - zone.z0)));
        this.floorClip.append(zRect);
      }
      const clipRef = "url(#spatial-room-zones-clip)";
      this.floorRect.setAttribute("clip-path", clipRef);
      this.fineGrid.setAttribute("clip-path", clipRef);
      this.gridPath.setAttribute("clip-path", clipRef);
    } else {
      this.floorRect.removeAttribute("clip-path");
      this.fineGrid.removeAttribute("clip-path");
      this.gridPath.removeAttribute("clip-path");
    }
    this.rearWallRect.toggleAttribute("hidden", hasVoids);
    this.rearWallLabel.hidden = hasVoids;
    this.room.style.borderColor = hasVoids ? "transparent" : "";
    this.rearWallRect.setAttribute("x", String(-spec.width / 2));
    this.rearWallRect.setAttribute(
      "y",
      String(-spec.depth / 2 - bakeryRoom.rearWallThickness / 2),
    );
    this.rearWallRect.setAttribute("width", String(spec.width));
    this.rearWallRect.setAttribute(
      "height",
      String(bakeryRoom.rearWallThickness),
    );
    this.customArchGroup.replaceChildren();
    this.openingElements = [];
    if (planId !== "reference") {
      for (const wall of spec.walls) {
        const wRect = svgElement("rect", "spatial-room-wall");
        const halfT = wall.thickness / 2;
        const dx = wall.x1 - wall.x0;
        const dz = wall.z1 - wall.z0;
        if (Math.abs(dx) > 1e-3 && Math.abs(dz) > 1e-3) {
          const len = Math.hypot(dx, dz);
          const cx = (wall.x0 + wall.x1) * 0.5;
          const cz = (wall.z0 + wall.z1) * 0.5;
          const deg = (Math.atan2(dz, dx) * 180) / Math.PI;
          wRect.setAttribute("x", String(-len * 0.5));
          wRect.setAttribute("y", String(-halfT));
          wRect.setAttribute("width", String(len));
          wRect.setAttribute("height", String(wall.thickness));
          wRect.setAttribute(
            "transform",
            `translate(${cx.toFixed(4)} ${cz.toFixed(4)}) rotate(${deg.toFixed(2)})`,
          );
        } else {
          const x0 = Math.min(wall.x0, wall.x1) - halfT;
          const z0 = Math.min(wall.z0, wall.z1) - halfT;
          const x1 = Math.max(wall.x0, wall.x1) + halfT;
          const z1 = Math.max(wall.z0, wall.z1) + halfT;
          wRect.setAttribute("x", String(x0));
          wRect.setAttribute("y", String(z0));
          wRect.setAttribute("width", String(x1 - x0));
          wRect.setAttribute("height", String(z1 - z0));
        }
        wRect.setAttribute("opacity", wall.exterior ? "0.85" : "0.7");
        this.customArchGroup.append(wRect);
      }
      for (const col of spec.columns) {
        const cRect = svgElement("rect", "spatial-room-wall");
        cRect.setAttribute("x", String(col.x0));
        cRect.setAttribute("y", String(col.z0));
        cRect.setAttribute("width", String(col.x1 - col.x0));
        cRect.setAttribute("height", String(col.z1 - col.z0));
        this.customArchGroup.append(cRect);
      }
      for (const stair of spec.stairs ?? []) {
        const sGroup = svgElement("g", "spatial-room-stair");
        sGroup.dataset.stair = stair.id;
        const sTitle = svgElement("title");
        sTitle.textContent = stair.label;
        const outline = svgElement("path", "spatial-room-fixture-base");
        outline.setAttribute(
          "d",
          `M ${stair.x1} ${stair.lowerTopZ} L ${stair.x1} ${stair.z1} L ${stair.x0} ${stair.z1} L ${stair.x0} ${stair.z0} L ${stair.turnSplitX} ${stair.z0} L ${stair.turnSplitX} ${stair.lowerTopZ} Z`,
        );
        const treads = svgElement("path");
        const parts: string[] = [];
        const lowerSteps = 4;
        for (let i = 0; i <= lowerSteps; i += 1) {
          const tx =
            stair.turnSplitX + ((stair.x1 - stair.turnSplitX) * i) / lowerSteps;
          parts.push(
            `M ${tx.toFixed(3)} ${stair.lowerTopZ} L ${tx.toFixed(3)} ${stair.z1}`,
          );
        }
        const winderTargets: readonly (readonly [number, number])[] = [
          [
            stair.turnSplitX - (stair.turnSplitX - stair.x0) * 0.52,
            stair.z1,
          ],
          [stair.x0, stair.z1],
          [
            stair.x0,
            stair.lowerTopZ + (stair.z1 - stair.lowerTopZ) * 0.48,
          ],
          [stair.x0, stair.lowerTopZ],
        ];
        for (const [wx, wz] of winderTargets) {
          parts.push(
            `M ${stair.turnSplitX} ${stair.lowerTopZ} L ${wx.toFixed(3)} ${wz.toFixed(3)}`,
          );
        }
        const upperSteps = 3;
        for (let i = 1; i < upperSteps; i += 1) {
          const tz =
            stair.lowerTopZ - ((stair.lowerTopZ - stair.z0) * i) / upperSteps;
          parts.push(
            `M ${stair.x0} ${tz.toFixed(3)} L ${stair.turnSplitX} ${tz.toFixed(3)}`,
          );
        }
        const midLowerZ = (stair.lowerTopZ + stair.z1) * 0.5;
        const midUpperX = (stair.x0 + stair.turnSplitX) * 0.5;
        const arrowTopZ = stair.z0 + (stair.lowerTopZ - stair.z0) * 0.34;
        const arrowTipX = midUpperX + 0.16;
        parts.push(
          `M ${(stair.x1 - 0.12).toFixed(3)} ${midLowerZ.toFixed(3)} L ${midUpperX.toFixed(3)} ${midLowerZ.toFixed(3)} L ${midUpperX.toFixed(3)} ${arrowTopZ.toFixed(3)} L ${arrowTipX.toFixed(3)} ${arrowTopZ.toFixed(3)}`,
          `M ${(arrowTipX - 0.09).toFixed(3)} ${(arrowTopZ - 0.06).toFixed(3)} L ${arrowTipX.toFixed(3)} ${arrowTopZ.toFixed(3)} L ${(arrowTipX - 0.09).toFixed(3)} ${(arrowTopZ + 0.06).toFixed(3)}`,
        );
        treads.setAttribute("d", parts.join(" "));
        treads.setAttribute("fill", "none");
        treads.setAttribute("stroke", "currentColor");
        treads.setAttribute("stroke-width", "0.022");
        treads.setAttribute("opacity", "0.62");
        sGroup.append(sTitle, outline, treads);
        this.customArchGroup.append(sGroup);
      }
      for (const fix of spec.fixtures) {
        const fGroup = svgElement("g", "spatial-room-fixture");
        fGroup.dataset.fixture = fix.id;
        fGroup.dataset.fixtureKind = fix.kind;
        const title = svgElement("title");
        title.textContent =
          fix.kind === "sink-counter"
            ? `${fix.label} · Water & drain hookup`
            : fix.label;
        const rect = svgElement("rect", "spatial-room-fixture-base");
        rect.setAttribute("x", String(fix.x0));
        rect.setAttribute("y", String(fix.z0));
        rect.setAttribute("width", String(fix.x1 - fix.x0));
        rect.setAttribute("height", String(fix.z1 - fix.z0));
        rect.setAttribute("rx", "0.04");
        fGroup.append(title, rect);
        const cx = (fix.x0 + fix.x1) / 2;
        const cz = (fix.z0 + fix.z1) / 2;
        const basin = svgElement("circle", "spatial-room-fixture-basin");
        basin.setAttribute("cx", String(cx));
        basin.setAttribute("cy", String(cz));
        basin.setAttribute(
          "r",
          String(Math.min(fix.x1 - fix.x0, fix.z1 - fix.z0) * 0.28),
        );
        fGroup.append(basin);
        this.customArchGroup.append(fGroup);
      }
      this.openingElements = buildOpeningElements(spec, this.customArchGroup);
    }
    this.syncOpenings(planId);
    this.room.setAttribute(
      "aria-label",
      `Assumed room: ${spec.width} by ${spec.depth} metres. Rear wall modeled; remaining wall positions and openings unspecified.`,
    );
    this.roomWidthLabel.textContent = metres(spec.width);
    this.roomDepthLabel.textContent = metres(spec.depth);
  }

  private syncOpenings(planId: string): void {
    if (planId !== floorPlanWorkspace.getActivePlan()) return;
    updateOpeningElements(this.openingElements, floorPlanWorkspace);
  }

  private openingKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    const id = openingAt(event.target);
    if (id === null) return;
    const opening = findFloorPlanOpening(
      floorPlanWorkspace.getActivePlan(),
      id,
    );
    if (opening === null) return;
    event.preventDefault();
    event.stopPropagation();
    floorPlanWorkspace.toggleOpening(opening);
  }

  setVisible(visible: boolean): void {
    this.pane.setVisible(visible);
  }

  bindScene(scene: THREE.Scene): void {
    this.scene = scene;
    for (const control of this.controls.values()) {
      scene.add(control.outline, control.originalOutline);
    }
  }

  get isInspectingFit(): boolean {
    return this.activeFinding !== null;
  }

  onFitInspectionChange(listener: (() => void) | null): void {
    this.fitInspectionListener = listener;
  }

  private setActiveFinding(finding: FitFinding | null, notify: boolean): void {
    const wasActive = this.activeFinding !== null;
    this.activeFinding = finding;
    if (notify && wasActive !== (finding !== null)) {
      this.fitInspectionListener?.();
    }
  }

  get viewport(): HTMLElement {
    return this.pane.viewport;
  }

  addInspectionControl(element: HTMLElement): void {
    this.inspectorContent.append(element);
  }

  setPlacement(
    placement: Readonly<{
      id: string;
      move: (xMm: number, yMm: number) => void;
    }> | null,
  ): void {
    this.placement = placement;
    if (placement === null) this.navigation.release();
    for (const [id, control] of this.controls) {
      const draggable = String(this.isDraggableItem(id));
      control.button.dataset.draggable = draggable;
      control.shape.dataset.draggable = draggable;
    }
  }

  private isDraggableItem(id: string): boolean {
    if (this.placement !== null) return this.placement.id === id;
    const cleanId = id.replace(/^context:/u, "");
    return isApplianceId(cleanId);
  }

  /** Frames the named equipment until the viewer navigates. */
  frame(ids: readonly string[]): void {
    const bounds = new THREE.Box3();
    for (const id of ids) {
      const control = this.controls.get(id);
      if (control !== undefined) bounds.union(control.item.bounds);
    }
    this.navigation.frame(bounds.isEmpty() ? null : boxRect(bounds));
    this.renderView();
  }

  get isOpen(): boolean {
    return this.pane.isOpen;
  }

  setOpen(open: boolean): void {
    this.pane.setOpen(open);
    this.placeDetails();
  }

  setMinimap(shown: boolean): void {
    this.pane.setMinimap(shown);
  }

  occluders(): DOMRect[] {
    return this.pane.occluders();
  }

  /** Mirrors a hover that started in the 3D view; it does not call back. */
  setHovered(id: string | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.updateSelection();
  }

  private hoverItem(id: string | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.updateSelection();
    const control = id === null ? undefined : this.controls.get(id);
    this.options.hover?.(control?.item.selection ?? null);
  }

  private isOverview(): boolean {
    return this.drawing.dataset.variant === "minimap";
  }

  private insets(): PlanInsets {
    if (this.isOverview()) return minimapInsets;
    const map = this.map.getBoundingClientRect();
    const body = this.body.getBoundingClientRect();
    const footer = this.footer.getBoundingClientRect();
    return {
      top: Math.max(panelInsets.top, body.top - map.top + panelInsets.top),
      right: panelInsets.right,
      bottom: Math.max(
        panelInsets.bottom,
        map.bottom - footer.top + panelInsets.bottom,
      ),
      left: panelInsets.left,
    };
  }

  private mapSize(): PlanSize {
    return this.size;
  }

  private roomRect(): PlanRect {
    return boxRect(this.extent);
  }

  private selectionRect(): PlanRect | null {
    const bounds = this.selectionBounds();
    return bounds.isEmpty() ? null : boxRect(bounds);
  }

  /** Starts moving or rotating equipment when the pointer lands on an item or its circular gizmo. */
  private grab(
    target: EventTarget | null,
    startPoint?: PlanPoint,
  ): ((xMm: number, yMm: number) => void) | null {
    const rotateGizmoId = rotateGizmoAt(target);
    if (rotateGizmoId !== null) {
      const cleanId = rotateGizmoId.replace(/^context:/u, "");
      if (!isApplianceId(cleanId)) return null;
      this.setGizmoTarget(rotateGizmoId, true);
      this.rotatingGizmo = true;
      this.syncGizmoActiveState();
      const endRotate = (): void => {
        this.rotatingGizmo = false;
        this.syncGizmoActiveState();
        window.removeEventListener("pointerup", endRotate);
        window.removeEventListener("pointercancel", endRotate);
      };
      window.addEventListener("pointerup", endRotate);
      window.addEventListener("pointercancel", endRotate);
      const planId = floorPlanWorkspace.getActivePlan();
      const startPose = floorPlanWorkspace.getPose(planId, cleanId);
      const fp = APPLIANCE_FOOTPRINTS[cleanId];
      const radius = Math.hypot(fp.halfWidth, fp.halfDepth) + 0.16;
      const startFloor =
        startPoint !== undefined
          ? toFloor(this.navigation.current(), this.size, startPoint)
          : {
              x: startPose.x + Math.sin(startPose.rotY) * radius,
              z: startPose.z + Math.cos(startPose.rotY) * radius,
            };
      const startAngle = Math.atan2(
        startFloor.x - startPose.x,
        startFloor.z - startPose.z,
      );
      const gestureId = `fp-rot:${cleanId}:${Date.now()}:${Math.random()}`;
      return (xMm: number, yMm: number): void => {
        const curFloorX = startFloor.x + xMm / 1000;
        const curFloorZ = startFloor.z - yMm / 1000;
        const curAngle = Math.atan2(
          curFloorX - startPose.x,
          curFloorZ - startPose.z,
        );
        const nextRotY = startPose.rotY + (curAngle - startAngle);
        setApplianceRotationWithCollisions(
          floorPlanWorkspace.getActivePlan(),
          cleanId,
          nextRotY,
          REHEARSAL_APPLIANCE_IDS,
          true,
          gestureId,
        );
      };
    }

    const id = resourceAt(target);
    if (id === null) return null;
    const placement = this.placement;
    if (placement !== null) {
      if (placement.id !== id) return null;
      const selection = this.controls.get(id)?.item.selection;
      if (selection !== undefined && selection !== null) this.select(selection);
      return placement.move;
    }
    const cleanId = id.replace(/^context:/u, "");
    if (!isApplianceId(cleanId)) return null;
    this.setGizmoTarget(id, true);
    const selection = this.controls.get(id)?.item.selection;
    if (selection !== undefined && selection !== null) this.select(selection);
    const planId = floorPlanWorkspace.getActivePlan();
    const startPose = floorPlanWorkspace.getPose(planId, cleanId);
    const gestureId = `fp-move:${cleanId}:${Date.now()}:${Math.random()}`;
    return (xMm: number, yMm: number): void => {
      moveApplianceWithCollisions(
        floorPlanWorkspace.getActivePlan(),
        cleanId,
        startPose.x + xMm / 1000,
        startPose.z - yMm / 1000,
        REHEARSAL_APPLIANCE_IDS,
        gestureId,
      );
    };
  }

  private clickTarget(target: EventTarget | null): void {
    const rotateGizmoId = rotateGizmoAt(target);
    if (rotateGizmoId !== null) {
      const cleanId = rotateGizmoId.replace(/^context:/u, "");
      if (isApplianceId(cleanId)) {
        this.setGizmoTarget(rotateGizmoId, true);
        this.rotateAppliance(cleanId);
      }
      return;
    }
    const id = resourceAt(target);
    if (id !== null) {
      this.choose(id);
      return;
    }
    const openingId = openingAt(target);
    if (openingId !== null) {
      const opening = findFloorPlanOpening(
        floorPlanWorkspace.getActivePlan(),
        openingId,
      );
      if (opening !== null) floorPlanWorkspace.toggleOpening(opening);
      return;
    }
    this.setActiveFinding(null, true);
    this.selected = [];
    this.setGizmoTarget(null, true);
  }

  private doubleClickTarget(event: MouseEvent): void {
    const id = resourceAt(event.target);
    if (id === null) return;
    const cleanId = id.replace(/^context:/u, "");
    if (!isApplianceId(cleanId)) return;
    this.setGizmoTarget(id, true);
    this.choose(id);
    this.rotateAppliance(cleanId);
    event.preventDefault();
  }

  private rotateTargetId(): ApplianceId | null {
    if (this.gizmoTarget !== null) {
      const cleanGizmo = this.gizmoTarget.replace(/^context:/u, "");
      if (isApplianceId(cleanGizmo)) return cleanGizmo;
    }
    for (const id of this.selectedIds()) {
      const cleanId = id.replace(/^context:/u, "");
      if (isApplianceId(cleanId)) return cleanId;
    }
    if (this.hovered !== null) {
      const cleanHovered = this.hovered.replace(/^context:/u, "");
      if (isApplianceId(cleanHovered)) return cleanHovered;
    }
    return null;
  }

  showPlacementResult(result: ResolvedApplianceMove): void {
    if (result.kind === "blocked") {
      this.status.dataset.fit = "blocked";
      this.status.textContent =
        "There is not enough room. The appliance position stays unchanged.";
    }
  }

  private rotateAppliance(id: ApplianceId): void {
    const result = rotateApplianceWithCollisions(
      floorPlanWorkspace.getActivePlan(),
      id,
      REHEARSAL_APPLIANCE_IDS,
    );
    this.showPlacementResult(result);
  }

  rotateActive(): boolean {
    const cleanId = this.rotateTargetId();
    if (cleanId === null) return false;
    this.setGizmoTarget(cleanId, true);
    this.rotateAppliance(cleanId);
    return true;
  }

  private layoutMap(): void {
    const width = Math.max(1, this.drawing.clientWidth);
    let height = Math.max(1, this.drawing.clientHeight);
    if (this.isOverview()) {
      const rect = boxRect(this.extent);
      const scale =
        (width - minimapInsets.left - minimapInsets.right) /
        Math.max(0.3, rect.maxX - rect.minX);
      height = Math.max(
        1,
        Math.min(
          132,
          Math.max(0.3, rect.maxZ - rect.minZ) * scale +
            minimapInsets.top +
            minimapInsets.bottom,
        ),
      );
    }
    this.map.style.width = `${width}px`;
    this.map.style.height = `${height}px`;
    this.size = { width, height };
    this.map.dataset.labels = String(!this.isOverview() && width >= 280);
    this.renderView();
  }

  /** Places world geometry and the screen-sized controls for one view. */
  private renderView(): void {
    const view = this.navigation.current();
    const size = this.size;
    this.world.setAttribute("transform", viewTransform(view, size));
    this.map.dataset.navigated = String(this.navigation.navigated);
    const spec = BAKERY_FLOOR_PLANS[floorPlanWorkspace.getActivePlan()];
    const roomTopLeft = toScreen(view, size, -spec.width / 2, -spec.depth / 2);
    this.room.style.left = `${roomTopLeft.x}px`;
    this.room.style.top = `${roomTopLeft.y}px`;
    this.room.style.width = `${spec.width * view.scale}px`;
    this.room.style.height = `${spec.depth * view.scale}px`;
    for (const control of this.controls.values()) {
      const bounds = control.item.bounds;
      const center = toScreen(
        view,
        size,
        (bounds.min.x + bounds.max.x) / 2,
        (bounds.min.z + bounds.max.z) / 2,
      );
      // Names sit just in front of the footprint, clear of the marker.
      const front = toScreen(view, size, 0, bounds.max.z).y;
      control.button.style.left = `${center.x}px`;
      control.button.style.top = `${center.y}px`;
      control.name.style.left = `${center.x}px`;
      control.name.style.top = `${Math.max(front + 4, center.y + markerRadius + 2)}px`;
      const sweep = control.item.sweepEnvelope;
      if (sweep !== undefined) {
        const corner = toScreen(view, size, sweep.min.x, sweep.min.z);
        control.sweepLabel.style.left = `${corner.x + 4}px`;
        control.sweepLabel.style.top = `${corner.y + 2}px`;
        control.sweepLabel.style.maxWidth = `${Math.max(0, (sweep.max.x - sweep.min.x) * view.scale - 8)}px`;
      }
    }
    this.syncRotationGizmo();
    this.navigation.showView(view);
    this.arrangeNames();
  }

  setGizmoTarget(id: string | null, notify = false): void {
    let resolved: string | null = null;
    if (id !== null) {
      const clean = id.replace(/^context:/u, "");
      if (isApplianceId(clean)) {
        resolved = this.controls.has(id)
          ? id
          : this.controls.has(`context:${clean}`)
            ? `context:${clean}`
            : clean;
      }
    }
    const prevClean = this.gizmoTarget?.replace(/^context:/u, "") ?? null;
    const nextClean = resolved?.replace(/^context:/u, "") ?? null;
    this.gizmoTarget = resolved;
    this.updateSelection();
    if (notify && prevClean !== nextClean) {
      this.options.gizmoChange?.(nextClean);
    }
  }

  private syncGizmoActiveState(): void {
    const active = this.rotatingGizmo || this.hoveredGizmo;
    if (active) {
      this.gizmoGroup.dataset.active = "true";
      this.rotateKnob.dataset.active = "true";
    } else {
      delete this.gizmoGroup.dataset.active;
      delete this.rotateKnob.dataset.active;
    }
  }

  private selectedGizmoId(): string | null {
    return this.gizmoTarget;
  }

  private syncRotationGizmo(): void {
    const targetId = this.isOverview() ? null : this.selectedGizmoId();
    if (targetId === null || this.size.width <= 1 || this.size.height <= 1) {
      this.gizmoGroup.setAttribute("hidden", "");
      this.rotateKnob.hidden = true;
      return;
    }
    const cleanId = targetId.replace(/^context:/u, "");
    if (!isApplianceId(cleanId)) {
      this.gizmoGroup.setAttribute("hidden", "");
      this.rotateKnob.hidden = true;
      return;
    }
    const fp = APPLIANCE_FOOTPRINTS[cleanId];
    const pose = floorPlanWorkspace.getPose(
      floorPlanWorkspace.getActivePlan(),
      cleanId,
    );
    const radius = Math.hypot(fp.halfWidth, fp.halfDepth) + 0.16;
    const handleX = pose.x + Math.sin(pose.rotY) * radius;
    const handleZ = pose.z + Math.cos(pose.rotY) * radius;

    for (const circle of [this.gizmoRing, this.gizmoHitRing]) {
      circle.setAttribute("cx", String(pose.x));
      circle.setAttribute("cy", String(pose.z));
    }
    this.gizmoRing.setAttribute("r", String(radius));
    this.gizmoHitRing.setAttribute("r", String(radius));
    this.gizmoHitRing.dataset.rotateGizmo = targetId;

    this.gizmoStem.setAttribute("x1", String(pose.x));
    this.gizmoStem.setAttribute("y1", String(pose.z));
    this.gizmoStem.setAttribute("x2", String(handleX));
    this.gizmoStem.setAttribute("y2", String(handleZ));
    this.gizmoGroup.removeAttribute("hidden");

    const view = this.navigation.current();
    const knobScreen = toScreen(view, this.size, handleX, handleZ);
    this.rotateKnob.style.left = `${knobScreen.x}px`;
    this.rotateKnob.style.top = `${knobScreen.y}px`;
    this.rotateKnob.dataset.rotateGizmo = targetId;
    const deg = Math.round((pose.rotY * 180) / Math.PI);
    this.rotateKnob.title = `Drag circular ring to rotate ${fp.label} (${deg}°) · Click for +90°`;
    this.rotateKnob.hidden = false;
  }

  /**
   * Hides names that would cover a marker or a more important name. Selected
   * and hovered equipment win, then modeled equipment over assumed context.
   */
  private arrangeNames(): void {
    if (this.map.dataset.labels !== "true") return;
    const taken: ScreenBox[] = [];
    for (const control of this.controls.values()) {
      const x = parseFloat(control.button.style.left);
      const y = parseFloat(control.button.style.top);
      taken.push({
        left: x - markerRadius,
        top: y - markerRadius,
        right: x + markerRadius,
        bottom: y + markerRadius,
      });
    }
    for (const control of [...this.controls.values()].sort(namePriority)) {
      const name = control.name;
      name.dataset.collides = "false";
      if (name.dataset.fit === "blocked") continue;
      const left = parseFloat(name.style.left) - name.offsetWidth / 2;
      const top = parseFloat(name.style.top);
      const box = {
        left,
        top,
        right: left + name.offsetWidth,
        bottom: top + name.offsetHeight,
      };
      if (taken.some(overlaps.bind(null, box))) name.dataset.collides = "true";
      else taken.push(box);
    }
  }

  private resetScene(): void {
    this.pane.focusScene();
    this.resetView();
  }

  private showCameraView(view: CameraView): void {
    this.pane.focusScene();
    view.show(this.selectionBounds());
  }

  update(
    items: readonly FloorPlanItem<Selection>[],
    selected: readonly string[],
    recordedFindings: readonly FitFinding[],
  ): void {
    this.items = items.filter(hasBounds);
    if (this.items.length === 0) this.navigation.reset();
    this.recordedFindings = recordedFindings;
    if (!sameIds(this.selected, selected)) {
      this.setActiveFinding(null, false);
      if (this.options.gizmoChange === undefined) {
        let nextGizmo: string | null = null;
        for (const id of selected) {
          const clean = id.replace(/^context:/u, "");
          if (isApplianceId(clean)) {
            nextGizmo = id;
            break;
          }
        }
        this.gizmoTarget = nextGizmo;
      }
    }
    this.selected = selected;
    const signature = JSON.stringify([
      this.items.map(itemSignature),
      recordedFindings.map(findingSignature),
    ]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.updateGeometry();
    }
    // Live state changes every frame without changing geometry.
    for (const item of this.items) {
      const control = this.controls.get(item.id);
      if (control !== undefined && control.item !== item)
        this.controls.set(item.id, { ...control, item });
    }
    this.updateSelection();
  }

  setActors(actors: readonly FloorPlanActor[]): void {
    this.actorsGroup.replaceChildren();
    for (const actor of actors) {
      const g = svgElement("g", "spatial-floor-actor");
      g.dataset.actor = actor.id;
      g.dataset.actorKind = actor.kind;
      g.dataset.carrying = String(actor.carrying);
      const title = svgElement("title");
      title.textContent = actor.label;
      const body = svgElement("circle", "spatial-floor-actor-body");
      body.setAttribute("cx", actor.x.toFixed(3));
      body.setAttribute("cy", actor.z.toFixed(3));
      body.setAttribute("r", actor.kind === "customer" ? "0.17" : "0.19");
      body.setAttribute("fill", actor.color);
      const noseX = actor.x + Math.sin(actor.facingYawRad) * 0.24;
      const noseZ = actor.z + Math.cos(actor.facingYawRad) * 0.24;
      const heading = svgElement("line", "spatial-floor-actor-heading");
      heading.setAttribute("x1", actor.x.toFixed(3));
      heading.setAttribute("y1", actor.z.toFixed(3));
      heading.setAttribute("x2", noseX.toFixed(3));
      heading.setAttribute("y2", noseZ.toFixed(3));
      g.append(title, body, heading);
      if (actor.carrying) {
        const tray = svgElement("circle", "spatial-floor-actor-tray");
        tray.setAttribute("cx", noseX.toFixed(3));
        tray.setAttribute("cy", noseZ.toFixed(3));
        tray.setAttribute("r", "0.075");
        g.append(tray);
      }
      this.actorsGroup.append(g);
    }
  }

  private updateGeometry(): void {
    const extent = roomBounds();
    for (const item of this.items) {
      extent.union(item.bounds);
      if (item.originalBounds !== undefined) extent.union(item.originalBounds);
      if (item.sweepEnvelope !== undefined) extent.union(item.sweepEnvelope);
    }
    this.extent = extent;
    const present = new Set(this.items.map(itemId));
    for (const [id, control] of this.controls) {
      if (present.has(id)) continue;
      disposeControl(control);
      this.controls.delete(id);
    }
    for (const [index, item] of this.items.entries()) {
      const control = this.controls.get(item.id) ?? this.createControl(item);
      const itemSize = item.bounds.getSize(new THREE.Vector3());
      const reference = String(item.number ?? index + 1);
      const number = document.createElement("span");
      number.className = "spatial-footprint-number";
      number.textContent = reference;
      control.button.replaceChildren(number);
      control.name.textContent = item.label;
      if (this.markers.children[index * 2] !== control.button)
        this.markers.insertBefore(
          control.button,
          this.markers.children[index * 2] ?? null,
        );
      control.button.after(control.name);
      const dimensions = `${item.label}: ${itemSize.x.toFixed(2)} × ${itemSize.z.toFixed(2)} m envelope`;
      control.button.title = dimensions;
      control.tooltip.textContent = dimensions;
      control.button.dataset.resource = item.id;
      // Only the marker is the resource control; the outline names its item.
      control.shape.dataset.footprint = item.id;
      control.envelope.dataset.envelope = item.id;
      control.shape.dataset.context = String(item.context === true);
      control.button.dataset.context = String(item.context === true);
      const draggable = String(this.isDraggableItem(item.id));
      control.button.dataset.draggable = draggable;
      control.shape.dataset.draggable = draggable;
      const footprint =
        item.footprint.length > 0 ? item.footprint : [boxPolygon(item.bounds)];
      const path = footprintPath(footprint);
      control.edge.setAttribute("d", path);
      control.fill.setAttribute("d", path);
      setRect(control.envelope, item.bounds);
      control.ghost.toggleAttribute(
        "hidden",
        item.originalBounds === undefined,
      );
      control.originalOutline.visible = item.originalBounds !== undefined;
      if (item.originalBounds !== undefined) {
        control.originalOutline.box.copy(item.originalBounds);
        setRect(control.ghost, item.originalBounds);
      }
      const sweep = item.sweepEnvelope;
      control.sweep.toggleAttribute("hidden", sweep === undefined);
      control.sweepLabel.hidden = sweep === undefined;
      if (sweep !== undefined) setRect(control.sweep, sweep);
      control.outline.box.copy(item.bounds);
      this.controls.set(item.id, {
        ...control,
        item,
        envelopeAddsSpace: !fillsEnvelope(footprint, item.bounds),
      });
    }
    this.layoutMap();
    this.updateFindings();
  }

  private createControl(
    item: FloorPlanItem<Selection>,
  ): PlanControl<Selection> {
    const id = item.id;
    const shape = svgElement("g", "spatial-footprint");
    const tooltip = svgElement("title");
    // The wide edge sits under an opaque fill, so only the union's outer
    // boundary shows and internal part edges stay hidden, as in a top view.
    const edge = svgElement("path", "spatial-footprint-edge");
    const fill = svgElement("path", "spatial-footprint-fill");
    shape.append(tooltip, edge, fill);
    const envelope = svgElement("rect", "spatial-check-envelope");
    const ghost = svgElement("rect", "spatial-original-placement");
    const sweep = svgElement("rect", "spatial-opening-envelope");
    this.footprints.append(shape);
    this.envelopes.append(envelope);
    this.ghosts.append(ghost, sweep);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "spatial-footprint-marker";
    const name = document.createElement("span");
    name.className = "spatial-footprint-label";
    name.setAttribute("aria-hidden", "true");
    const sweepLabel = document.createElement("span");
    sweepLabel.className = "spatial-opening-label";
    sweepLabel.textContent = "Door opening envelope · 0–110°";
    this.markers.append(button, name);
    this.overlay.append(sweepLabel);
    for (const target of [shape, button]) {
      target.addEventListener("pointerenter", this.hoverItem.bind(this, id));
      target.addEventListener("pointerleave", this.hoverItem.bind(this, null));
    }
    button.addEventListener("focus", this.hoverItem.bind(this, id));
    button.addEventListener("blur", this.hoverItem.bind(this, null));
    const originalOutline = new THREE.Box3Helper(new THREE.Box3(), 0x64748b);
    for (const material of outlineMaterials(originalOutline))
      material.dispose();
    originalOutline.material = new THREE.LineDashedMaterial({
      color: 0x64748b,
      dashSize: 0.08,
      gapSize: 0.05,
      depthTest: false,
    });
    const originalGeometry = originalOutline.geometry;
    originalOutline.geometry = originalGeometry.toNonIndexed();
    originalGeometry.dispose();
    originalOutline.computeLineDistances();
    originalOutline.renderOrder = 9;
    this.scene.add(originalOutline);
    const outline = new THREE.Box3Helper(new THREE.Box3(), 0x2563eb);
    this.scene.add(outline);
    for (const material of outlineMaterials(outline))
      material.depthTest = false;
    outline.renderOrder = 10;
    const control: PlanControl<Selection> = {
      item,
      shape,
      edge,
      fill,
      tooltip,
      envelope,
      envelopeAddsSpace: false,
      ghost,
      sweep,
      button,
      name,
      sweepLabel,
      outline,
      originalOutline,
    };
    this.controls.set(id, control);
    return control;
  }

  /** Assumed context stays visible for orientation but is not fit-checked. */
  private checkedItems(): readonly FloorPlanItem<Selection>[] {
    return this.items.filter(isEquipment);
  }

  private updateFindings(): void {
    const findings: FitFinding[] = [...this.recordedFindings];
    const planId = floorPlanWorkspace.getActivePlan();
    const spec = BAKERY_FLOOR_PLANS[planId];
    const hasVoids = (spec.voids?.length ?? 0) > 0;
    const room = roomBounds();
    const items = this.checkedItems();
    for (const item of items) {
      if (
        item.bounds.min.x < room.min.x - 0.001 ||
        item.bounds.max.x > room.max.x + 0.001 ||
        item.bounds.min.z < room.min.z - 0.001 ||
        item.bounds.max.z > room.max.z + 0.001
      ) {
        findings.push({
          source: "geometry",
          rule: "room-boundary",
          kind: "unchecked",
          first: item.id,
          second: "room-boundary",
          message: `Room limit: ${item.label} extends beyond the ${spec.width} × ${spec.depth} m floor. Verify the room dimensions.`,
        });
      }
      if (!hasVoids) {
        const wallFront = -spec.depth / 2 + bakeryRoom.rearWallThickness / 2;
        const wallBack = -spec.depth / 2 - bakeryRoom.rearWallThickness / 2;
        if (
          item.bounds.min.z < wallFront - 0.001 &&
          item.bounds.max.z > wallBack + 0.001 &&
          item.bounds.min.x < room.max.x &&
          item.bounds.max.x > room.min.x &&
          item.bounds.min.y < bakeryRoom.rearWallHeight &&
          item.bounds.max.y > 0
        ) {
          findings.push({
            source: "geometry",
            rule: "wall-overlap",
            kind: "unchecked",
            first: item.id,
            second: "room-boundary",
            message: `Room constraint: ${item.label}'s envelope overlaps the modeled rear wall. Verify wall position and solid geometry.`,
          });
        }
      }
    }
    for (const [first, a] of items.entries()) {
      for (const b of items.slice(first + 1)) {
        if (findings.some(coversOverlap.bind(null, a.id, b.id))) continue;
        if (!footprintsOverlap(a.bounds, b.bounds)) continue;
        const blocked = modelBoxesIntersect(a, b);
        findings.push({
          source: "geometry",
          rule: "solid-overlap",
          kind: blocked ? "blocked" : "unchecked",
          first: a.id,
          second: b.id,
          message: blocked
            ? `Blocked: ${a.label} intersects ${b.label} (modeled geometry).`
            : `Unchecked: ${a.label} and ${b.label} have overlapping check envelopes.`,
        });
      }
    }
    this.utilityLinesGroup.replaceChildren();
    if (planId !== "reference") {
      for (const item of this.items) {
        const box = {
          x0: item.bounds.min.x,
          z0: item.bounds.min.z,
          x1: item.bounds.max.x,
          z1: item.bounds.max.z,
        };
        for (const door of spec.doors) {
          if (doorSweepIntersectsBox(door, box)) {
            findings.push({
              source: "geometry",
              rule: "door-sweep",
              kind: "blocked",
              first: item.id,
              second: `door:${door.id}`,
              message: `Blocked: ${item.label} obstructs the swing arc of ${door.label}.`,
            });
          }
        }
      }
      const sinkFixture = spec.fixtures.find((f) => f.kind === "sink-counter");
      if (sinkFixture !== undefined) {
        const sinkX = (sinkFixture.x0 + sinkFixture.x1) / 2;
        const sinkZ = (sinkFixture.z0 + sinkFixture.z1) / 2;
        for (const item of items) {
          const cleanId = item.id.replace(/^context:/u, "");
          if (!WATER_UTILITY_EQUIPMENT_IDS.has(cleanId)) continue;
          const itemX = (item.bounds.min.x + item.bounds.max.x) / 2;
          const itemZ = (item.bounds.min.z + item.bounds.max.z) / 2;
          const dist = Math.hypot(itemX - sinkX, itemZ - sinkZ);
          const overReach = dist > MAX_WATER_HOOKUP_REACH_M;
          const line = svgElement("line", "spatial-utility-line");
          line.dataset.utilityHookup = cleanId;
          line.dataset.overReach = String(overReach);
          line.setAttribute("x1", sinkX.toFixed(3));
          line.setAttribute("y1", sinkZ.toFixed(3));
          line.setAttribute("x2", itemX.toFixed(3));
          line.setAttribute("y2", itemZ.toFixed(3));
          this.utilityLinesGroup.append(line);
          if (overReach) {
            findings.push({
              source: "geometry",
              rule: "utility-reach",
              kind: "unchecked",
              first: item.id,
              second: `fixture:${sinkFixture.id}`,
              message: `Utility reach: ${item.label} is ${dist.toFixed(1)} m from ${sinkFixture.label} (> ${MAX_WATER_HOOKUP_REACH_M.toFixed(1)} m hose/drain run).`,
            });
          }
        }
      }
    }
    if (
      JSON.stringify(findings.map(findingSignature)) ===
        JSON.stringify(this.fitFindings.map(findingSignature)) &&
      this.status.textContent !== ""
    )
      return;
    this.fitFindings = findings;
    this.setActiveFinding(null, false);
    const messages: HTMLLIElement[] = [];
    let blockedCount = 0;
    for (const finding of findings) {
      if (finding.kind !== "blocked") continue;
      blockedCount++;
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = finding.message;
      button.dataset.fit = finding.kind;
      button.title =
        finding.source === "recording" &&
        this.options.inspectEvent !== undefined
          ? `Inspect recorded failure at ${finding.event.time.toFixed(2)} s`
          : "Inspect both objects in 3D";
      button.addEventListener("click", this.inspectFinding.bind(this, finding));
      item.append(button);
      messages.push(item);
    }
    this.findings.replaceChildren(...messages);
    this.findings.hidden = messages.length === 0;
    this.status.dataset.fit = blockedCount > 0 ? "blocked" : "unchecked";
    this.status.textContent =
      blockedCount > 0
        ? `${blockedCount} fit ${blockedCount === 1 ? "conflict" : "conflicts"} · Select to inspect`
        : "No confirmed conflicts · Checks limited";
  }

  private choose(id: string): void {
    const cleanId = id.replace(/^context:/u, "");
    if (isApplianceId(cleanId)) {
      this.setGizmoTarget(id, true);
    } else {
      this.setGizmoTarget(null, true);
    }
    const selection = this.controls.get(id)?.item.selection;
    if (selection === undefined || selection === null) return;
    this.setActiveFinding(null, true);
    this.select(selection);
  }

  private inspectFinding(finding: FitFinding): void {
    if (finding.source === "recording")
      this.options.inspectEvent?.(finding.event);
    this.setActiveFinding(finding, true);
    this.updateSelection();
    this.focusSelection();
  }

  private selectedIds(): readonly string[] {
    return this.activeFinding === null
      ? this.selected
      : [this.activeFinding.first, this.activeFinding.second];
  }

  selectionBounds(): THREE.Box3 {
    const bounds = new THREE.Box3();
    const spec = BAKERY_FLOOR_PLANS[floorPlanWorkspace.getActivePlan()];
    for (const id of this.selectedIds()) {
      if (id === "room-boundary") bounds.union(roomBounds());
      if (id.startsWith("door:")) {
        const door = spec.doors.find((d) => `door:${d.id}` === id);
        if (door !== undefined) {
          bounds.expandByPoint(
            new THREE.Vector3(
              door.hingeX - door.width,
              0,
              door.hingeZ - door.width,
            ),
          );
          bounds.expandByPoint(
            new THREE.Vector3(
              door.hingeX + door.width,
              door.height,
              door.hingeZ + door.width,
            ),
          );
        }
      }
      const control = this.controls.get(id);
      if (control !== undefined) bounds.union(control.item.bounds);
    }
    return bounds;
  }

  private focusSelection(): void {
    const bounds = this.selectionBounds();
    if (!bounds.isEmpty()) {
      this.pane.focusScene();
      this.focus(bounds);
    }
  }

  private updateSelection(): void {
    this.room.dataset.selected = String(
      this.selectedIds().includes("room-boundary"),
    );
    const dimensions: DimensionRow[] = [];
    for (const [id, control] of this.controls) {
      const selected = this.selectedIds().includes(id);
      const blocked = this.fitFindings.some(involves.bind(null, id, "blocked"));
      const unchecked = this.fitFindings.some(
        involves.bind(null, id, "unchecked"),
      );
      let fit = "unmeasured";
      if (blocked) fit = "blocked";
      else if (unchecked) fit = "unchecked";
      const hovered = this.hovered === id;
      const context = control.item.context === true;
      for (const target of [control.button, control.shape, control.name]) {
        target.dataset.fit = fit;
        target.dataset.hovered = String(hovered);
        target.dataset.selected = String(selected);
        if (control.item.state === undefined) delete target.dataset.state;
        else target.dataset.state = control.item.state;
      }
      control.button.setAttribute(
        "aria-label",
        `${control.item.label}${context ? " · Bakery context" : ""}${blocked ? ": blocked" : ""}`,
      );
      control.button.setAttribute("aria-pressed", String(selected));
      control.button.setAttribute(
        "aria-disabled",
        String(control.item.selection === null),
      );
      control.envelope.toggleAttribute(
        "hidden",
        !control.envelopeAddsSpace || !(selected || blocked || hovered),
      );
      control.outline.visible = selected || blocked || hovered;
      for (const material of outlineMaterials(control.outline)) {
        if (material instanceof THREE.LineBasicMaterial)
          material.color.set(
            blocked ? 0xd92d20 : selected ? 0x2563eb : 0x93c5fd,
          );
      }
      if (selected) {
        const size = control.item.bounds.getSize(new THREE.Vector3());
        dimensions.push({
          label: `${control.item.label}:`,
          value: `${size.x.toFixed(2)} × ${size.z.toFixed(2)} m envelope · ${size.y.toFixed(2)} m high`,
        });
      }
    }
    const rotateId = this.rotateTargetId();
    const rotateFootprint =
      rotateId !== null ? APPLIANCE_FOOTPRINTS[rotateId] : undefined;
    this.rotateButton.disabled = rotateId === null;
    this.toolbarRotateButton.disabled = rotateId === null;
    const rotateTitle =
      rotateFootprint !== undefined
        ? `Rotate ${rotateFootprint.label} 90° (press R or double-click)`
        : "Rotate selected appliance 90° (press R or double-click)";
    this.rotateButton.title = rotateTitle;
    this.toolbarRotateButton.title = rotateTitle;
    this.syncRotationGizmo();
    this.focusButton.disabled = dimensions.length === 0;
    this.navigation.setSelectable(!this.selectionBounds().isEmpty());
    const namesKey = `${this.selectedIds().join()}|${this.hovered}`;
    if (namesKey !== this.namesKey) {
      this.namesKey = namesKey;
      this.arrangeNames();
    }
    if (dimensions.length === 0) {
      const hint = "Select equipment in either view to see model dimensions.";
      if (this.dimensions.textContent !== hint)
        this.dimensions.textContent = hint;
      return;
    }
    if (this.dimensions.textContent !== dimensions.map(dimensionText).join(""))
      this.dimensions.replaceChildren(...dimensions.map(dimensionElement));
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onWindowKeyDown);
    this.unsubscribeFloorPlan();
    this.unsubscribeOpenings();
    this.observer.disconnect();
    for (const control of this.controls.values()) disposeControl(control);
    this.controls.clear();
    this.inspectorContent.remove();
    this.pane.dispose();
  }
}

function svgElement<Tag extends keyof SVGElementTagNameMap>(
  tag: Tag,
  className?: string,
): SVGElementTagNameMap[Tag] {
  const element = document.createElementNS(svgNamespace, tag);
  if (className !== undefined) element.setAttribute("class", className);
  return element;
}

function setRect(element: SVGRectElement, bounds: THREE.Box3): void {
  element.setAttribute("x", String(bounds.min.x));
  element.setAttribute("y", String(bounds.min.z));
  element.setAttribute("width", String(bounds.max.x - bounds.min.x));
  element.setAttribute("height", String(bounds.max.z - bounds.min.z));
}

function boxRect(bounds: THREE.Box3): PlanRect {
  return {
    minX: bounds.min.x,
    maxX: bounds.max.x,
    minZ: bounds.min.z,
    maxZ: bounds.max.z,
  };
}

function boxPolygon(bounds: THREE.Box3): PlanPolygon {
  return [
    [bounds.min.x, bounds.min.z],
    [bounds.max.x, bounds.min.z],
    [bounds.max.x, bounds.max.z],
    [bounds.min.x, bounds.max.z],
  ];
}

/** One path per item keeps several hundred parts to a single SVG node. */
function footprintPath(polygons: readonly PlanPolygon[]): string {
  let path = "";
  for (const polygon of polygons) {
    for (const [index, [x, z]] of polygon.entries())
      path += `${index === 0 ? "M" : "L"}${x.toFixed(4)} ${z.toFixed(4)}`;
    path += "Z";
  }
  return path;
}

/** Grid lines across the room at multiples of `step` from the world origin. */
function roomGrid(
  step: number,
  skip: number,
  width: number = bakeryRoom.width,
  depth: number = bakeryRoom.depth,
): string {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  let path = "";
  for (
    let x = Math.ceil(-halfWidth / step) * step;
    x <= halfWidth + 1e-9;
    x += step
  ) {
    if (skip > 0 && isMultiple(x, skip)) continue;
    path += `M${x} ${-halfDepth}V${halfDepth}`;
  }
  for (
    let z = Math.ceil(-halfDepth / step) * step;
    z <= halfDepth + 1e-9;
    z += step
  ) {
    if (skip > 0 && isMultiple(z, skip)) continue;
    path += `M${-halfWidth} ${z}H${halfWidth}`;
  }
  return path;
}

function isMultiple(value: number, step: number): boolean {
  return Math.abs(value / step - Math.round(value / step)) < 1e-6;
}

function rotateGizmoAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement | SVGElement>(
    "[data-rotate-gizmo]",
  );
  return element?.dataset.rotateGizmo ?? null;
}

function openingAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement | SVGElement>("[data-opening]");
  return element?.dataset.opening ?? null;
}

function resourceAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement | SVGElement>(
    "[data-resource], [data-footprint]",
  );
  return element?.dataset.resource ?? element?.dataset.footprint ?? null;
}

function overlaps(a: ScreenBox, b: ScreenBox): boolean {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

function namePriority<Selection>(
  a: PlanControl<Selection>,
  b: PlanControl<Selection>,
): number {
  return nameRank(a) - nameRank(b);
}

function nameRank<Selection>(control: PlanControl<Selection>): number {
  if (control.name.dataset.selected === "true") return 0;
  if (control.name.dataset.hovered === "true") return 1;
  return control.item.context === true ? 3 : 2;
}

function hasBounds<Selection>(item: FloorPlanItem<Selection>): boolean {
  return !item.bounds.isEmpty();
}

function isEquipment<Selection>(item: FloorPlanItem<Selection>): boolean {
  return item.context !== true;
}

function roomBounds(): THREE.Box3 {
  const spec = BAKERY_FLOOR_PLANS[floorPlanWorkspace.getActivePlan()];
  return new THREE.Box3(
    new THREE.Vector3(-spec.width / 2, 0, -spec.depth / 2),
    new THREE.Vector3(
      spec.width / 2,
      bakeryRoom.rearWallHeight,
      spec.depth / 2,
    ),
  );
}

function dimensionText(row: DimensionRow): string {
  return row.label + row.value;
}

function dimensionElement(row: DimensionRow): HTMLElement {
  const element = document.createElement("p");
  const name = document.createElement("strong");
  name.textContent = row.label;
  const value = document.createElement("span");
  value.textContent = row.value;
  element.append(name, value);
  return element;
}

function itemId<Selection>(item: FloorPlanItem<Selection>): string {
  return item.id;
}

function findingSignature(finding: FitFinding): unknown {
  return [
    finding.kind,
    finding.rule,
    finding.first,
    finding.second,
    finding.message,
    finding.source === "recording"
      ? [
          finding.event.request.modelHash,
          finding.event.request.runId,
          finding.event.request.attemptId,
          finding.event.eventIndex,
          finding.event.time,
        ]
      : "geometry",
  ];
}

function itemSignature<Selection>(item: FloorPlanItem<Selection>): unknown {
  return [
    item.id,
    item.label,
    item.number,
    item.context,
    item.bounds.min.toArray(),
    item.bounds.max.toArray(),
    footprintKey(item.footprint),
    item.originalBounds,
    item.sweepEnvelope,
    item.geometry,
  ];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every(sameId.bind(null, b));
}

function sameId(ids: readonly string[], id: string, index: number): boolean {
  return ids[index] === id;
}

function involves(
  id: string,
  kind: FitFinding["kind"],
  finding: FitFinding,
): boolean {
  return (
    finding.kind === kind && (finding.first === id || finding.second === id)
  );
}

function coversOverlap(
  first: string,
  second: string,
  finding: FitFinding,
): boolean {
  return (
    finding.rule === "solid-overlap" &&
    ((finding.first === first && finding.second === second) ||
      (finding.first === second && finding.second === first))
  );
}

function disposeControl<Selection>(control: PlanControl<Selection>): void {
  control.shape.remove();
  control.envelope.remove();
  control.ghost.remove();
  control.sweep.remove();
  control.sweepLabel.remove();
  control.name.remove();
  control.originalOutline.removeFromParent();
  control.originalOutline.geometry.dispose();
  for (const material of outlineMaterials(control.originalOutline))
    material.dispose();
  control.button.remove();
  control.outline.removeFromParent();
  control.outline.geometry.dispose();
  for (const material of outlineMaterials(control.outline)) material.dispose();
}

function outlineMaterials(
  outline: THREE.Box3Helper,
): readonly THREE.Material[] {
  return Array.isArray(outline.material)
    ? outline.material
    : [outline.material];
}
