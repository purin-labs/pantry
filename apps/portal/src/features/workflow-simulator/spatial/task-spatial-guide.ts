import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { trayHandoff, taskWait, waitLabel } from "@seams/production-simulation/simulator/task-guidance";
import type { WorkcellView } from "@seams/production-simulation/simulator/workcell-view";
import { workcellStatusLabel } from "@seams/production-simulation/simulator/workcell-view";
import type { WorkcellSelection } from "@seams/production-simulation/simulator/selection";
import type { WorkcellResourceId } from "@seams/production-simulation/recipes/bakery/workcell-input";
import { workcellResource } from "@seams/production-simulation/recipes/bakery/workcell-input";
import type { PhysicsModel } from "./physics-model";

/** One task/resource mapping supplies scene pins and their keyboard list. */
export class TaskSpatialGuide {
  readonly root = new THREE.Group();
  readonly element = document.createElement("section");
  readonly pins: CSS2DObject[] = [];
  private bakeryTaskId: string | null = null;
  private signature = "";
  private readonly anchors = new Map<CSS2DObject, WorkcellResourceId>();
  private readonly selections = new Map<
    WorkcellResourceId,
    readonly HTMLButtonElement[]
  >();
  private transfer: Readonly<{
    from: WorkcellResourceId;
    to: WorkcellResourceId;
    arrow: THREE.ArrowHelper;
  }> | null = null;

  constructor(
    private readonly model: PhysicsModel,
    private readonly select: (selection: WorkcellSelection) => void,
  ) {
    this.element.className = "spatial-task-guide";
    this.element.setAttribute("aria-label", "Selected task spatial guide");
  }

  update(view: WorkcellView): void {
    if (view.kind === "active" && view.selection.kind === "task")
      this.bakeryTaskId = view.selection.id;
    const task =
      view.kind === "active"
        ? view.tasks.find(matchesTask.bind(null, this.bakeryTaskId))
        : undefined;
    const handoff =
      view.kind === "active" && task !== undefined
        ? trayHandoff(view, task)
        : null;
    const signature = JSON.stringify([task, handoff]);
    if (signature === this.signature) {
      this.refreshAnchors();
      this.refreshSelection(view.kind === "active" ? view.selection : null);
      return;
    }
    this.signature = signature;
    this.clear();
    this.element.hidden = task === undefined || handoff === null;
    if (view.kind !== "active" || task === undefined || handoff === null)
      return;
    const title = document.createElement("strong");
    title.textContent = task.name;
    const nav = document.createElement("nav");
    nav.setAttribute("aria-label", "Task callouts");
    const resources: readonly WorkcellResourceId[] = [
      handoff.from,
      view.attempt.input.bindings.arm,
      handoff.to,
    ];
    const items = this.model.floorPlanItems();
    for (const id of resources) {
      const bounds = this.model.resourceBounds(id);
      if (bounds.isEmpty()) continue;
      const number = items.findIndex(matchesResource.bind(null, id)) + 1;
      const name = `${number}. ${workcellResource(id).name}`;
      const selected =
        view.selection.kind === "resource" && view.selection.id === id;
      const list = this.button(id, name, selected);
      nav.append(list);
      const pinButton = this.button(id, name, selected);
      this.selections.set(id, [list, pinButton]);
      const pin = new CSS2DObject(pinButton);
      pin.element.tabIndex = -1;
      pin.element.classList.add("workflow-scene-label", "workflow-task-pin");
      // Anchors derive from authored model solids, in the same world frame as the plan.
      pin.position.copy(bounds.getCenter(new THREE.Vector3()));
      pin.position.y = bounds.max.y + 0.12;
      this.root.add(pin);
      this.pins.push(pin);
      this.anchors.set(pin, id);
    }
    const wait = taskWait(view, task);
    const before = document.createElement("p");
    before.textContent = `Before starting: ${wait === null ? "No unresolved prerequisite in the current run." : waitLabel(wait)} Physical service clearances require measurements.`;
    const result = document.createElement("p");
    result.textContent = `Result: ${workcellStatusLabel(task.status)}. Inspecting this step changes only the view; acceptance uses the recorded evidence controls.`;
    const cue = document.createElement("p");
    cue.textContent = `Intended transfer: ${workcellResource(handoff.from).name} → ${workcellResource(handoff.to).name}. Illustrative direction only; robot motion comes from the recording.`;
    this.element.append(title, nav, before, result, cue);
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      1,
      0x64748b,
      0.12,
      0.06,
    );
    this.transfer = { from: handoff.from, to: handoff.to, arrow };
    this.root.add(arrow);
    this.refreshAnchors();
  }

  refreshAnchors(): void {
    for (const [pin, id] of this.anchors) {
      const bounds = this.model.resourceBounds(id);
      pin.position.copy(bounds.getCenter(new THREE.Vector3()));
      pin.position.y = bounds.max.y + 0.12;
    }
    if (this.transfer === null) return;
    const { from: source, to: destination, arrow } = this.transfer;
    const from = this.model
      .resourceBounds(source)
      .getCenter(new THREE.Vector3());
    const to = this.model
      .resourceBounds(destination)
      .getCenter(new THREE.Vector3());
    from.y = to.y = Math.max(from.y, to.y) + 0.2;
    const direction = to.clone().sub(from);
    arrow.visible = direction.length() > 0.05;
    if (!arrow.visible) return;
    arrow.position.copy(from);
    arrow.setDirection(direction.clone().normalize());
    arrow.setLength(direction.length(), 0.12, 0.06);
  }

  private refreshSelection(selection: WorkcellSelection | null): void {
    for (const [id, buttons] of this.selections) {
      const selected = selection?.kind === "resource" && selection.id === id;
      for (const button of buttons)
        button.setAttribute("aria-pressed", String(selected));
    }
  }

  private button(
    id: WorkcellResourceId,
    label: string,
    selected: boolean,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.setAttribute("aria-pressed", String(selected));
    button.addEventListener(
      "click",
      this.select.bind(null, { kind: "resource", id }),
    );
    return button;
  }

  private clear(): void {
    for (const pin of this.pins) pin.element.remove();
    this.pins.length = 0;
    this.anchors.clear();
    this.selections.clear();
    this.transfer = null;
    this.root.traverse(disposeArrow);
    this.root.clear();
    this.element.replaceChildren();
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
    this.element.remove();
  }
}

function matchesTask(
  id: string | null,
  task: Readonly<{ id: string }>,
): boolean {
  return task.id === id;
}
function matchesResource(id: string, item: Readonly<{ id: string }>): boolean {
  return item.id === id;
}
function disposeArrow(object: THREE.Object3D): void {
  // ArrowHelper shares its geometry across instances; only per-instance materials are owned here.
  if (object instanceof THREE.ArrowHelper) {
    for (const part of [object.line, object.cone]) {
      const materials = Array.isArray(part.material)
        ? part.material
        : [part.material];
      for (const material of materials) material.dispose();
    }
  }
}
