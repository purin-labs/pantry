import type { BakeryFloorPlanSpec } from "@purin-labs/production-simulation/floor/bakery-room";
import {
  doorOpening,
  windowOpening,
  openingId,
  doorAngle,
  windowSashGeometry,
  windowSashRotation,
  type FloorPlanOpening,
} from "@purin-labs/production-simulation/floor/openings";
import type { FloorPlanWorkspace } from "../floor-plan-workspace";

type OpeningElement = Readonly<{
  opening: FloorPlanOpening;
  element: SVGGElement;
  leaves: readonly SVGLineElement[];
}>;

const namespace = "http://www.w3.org/2000/svg";

function group(opening: FloorPlanOpening): SVGGElement {
  const element = document.createElementNS(namespace, "g");
  element.classList.add("spatial-room-opening");
  element.dataset.opening = openingId(opening);
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  element.setAttribute(
    "aria-label",
    opening.kind === "door" ? opening.door.label : opening.window.label,
  );
  return element;
}

function line(
  className: string,
  x: number,
  z: number,
  endX: number,
  endZ: number,
): SVGLineElement {
  const element = document.createElementNS(namespace, "line");
  element.classList.add(className);
  element.setAttribute("x1", String(x));
  element.setAttribute("y1", String(z));
  element.setAttribute("x2", String(endX));
  element.setAttribute("y2", String(endZ));
  return element;
}

/** Builds static frames once. Subsequent frames only update leaf coordinates. */
export function buildOpeningElements(
  spec: BakeryFloorPlanSpec,
  root: SVGGElement,
): readonly OpeningElement[] {
  const elements: OpeningElement[] = [];
  for (const window of spec.windows) {
    const opening = windowOpening(spec.id, window);
    const element = group(opening);
    element.append(
      line(
        "spatial-room-opening-hit",
        window.x0,
        window.z0,
        window.x1,
        window.z1,
      ),
      line(
        "spatial-room-window-frame",
        window.x0,
        window.z0,
        window.x1,
        window.z1,
      ),
    );
    const leaves: SVGLineElement[] = [];
    for (let panel = 0; panel < window.panels; panel += 1) {
      const geometry = windowSashGeometry(window, panel);
      const leaf = line(
        "spatial-room-window-sash",
        geometry.x,
        geometry.z,
        geometry.x,
        geometry.z,
      );
      leaves.push(leaf);
      element.append(leaf);
    }
    root.append(element);
    elements.push({ opening, element, leaves });
  }
  for (const door of spec.doors) {
    const opening = doorOpening(spec.id, door);
    const element = group(opening);
    const arc = document.createElementNS(namespace, "path");
    arc.classList.add("spatial-room-door-arc");
    let path = `M${door.hingeX} ${door.hingeZ}`;
    for (let step = 0; step <= 16; step += 1) {
      const angle = doorAngle(door, 1) + (door.swingRad * step) / 16;
      path += `L${door.hingeX + Math.cos(angle) * door.width} ${door.hingeZ + Math.sin(angle) * door.width}`;
    }
    arc.setAttribute("d", `${path}Z`);
    const hit = line(
      "spatial-room-opening-hit",
      door.hingeX,
      door.hingeZ,
      door.hingeX,
      door.hingeZ,
    );
    const leaf = line(
      "spatial-room-door-leaf",
      door.hingeX,
      door.hingeZ,
      door.hingeX,
      door.hingeZ,
    );
    element.append(arc, hit, leaf);
    root.append(element);
    elements.push({ opening, element, leaves: [hit, leaf] });
  }
  return elements;
}

export function updateOpeningElements(
  elements: readonly OpeningElement[],
  workspace: FloorPlanWorkspace,
): void {
  for (const { opening, element, leaves } of elements) {
    const progress = workspace.progress(opening);
    element.dataset.open = String(progress > 0.5);
    element.setAttribute("aria-pressed", String(progress > 0.5));
    for (const [panel, leaf] of leaves.entries()) {
      switch (opening.kind) {
        case "door": {
          const angle = doorAngle(opening.door, progress);
          leaf.setAttribute(
            "x2",
            String(opening.door.hingeX + Math.cos(angle) * opening.door.width),
          );
          leaf.setAttribute(
            "y2",
            String(opening.door.hingeZ + Math.sin(angle) * opening.door.width),
          );
          break;
        }
        case "window": {
          const geometry = windowSashGeometry(opening.window, panel);
          const angle = geometry.angle - windowSashRotation(panel, progress);
          leaf.setAttribute(
            "x2",
            String(geometry.x + Math.cos(angle) * geometry.width),
          );
          leaf.setAttribute(
            "y2",
            String(geometry.z + Math.sin(angle) * geometry.width),
          );
          break;
        }
      }
    }
  }
}
