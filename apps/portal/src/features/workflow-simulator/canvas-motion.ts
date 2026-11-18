/** Samples displayed transforms so a new move can interrupt an old move. */
export function displayedCanvasPositions(
  canvas: HTMLDivElement,
): Map<string, { displayed: string; target: string }> {
  const positions = new Map<string, { displayed: string; target: string }>();
  for (const node of canvas.querySelectorAll<HTMLButtonElement>(
    "[data-operation]",
  )) {
    const id = node.dataset.operation;
    if (id !== undefined)
      positions.set(id, {
        displayed: getComputedStyle(node).transform,
        target: node.style.transform,
      });
  }
  return positions;
}

export function animateCanvasPositions(
  canvas: HTMLDivElement,
  previous: Map<string, { displayed: string; target: string }>,
  remote: boolean,
  dragging: string | null,
): void {
  const style = getComputedStyle(canvas);
  const duration =
    Number.parseFloat(
      style.getPropertyValue("--pantry-spring-quick-duration"),
    ) || 200;
  const easing =
    style.getPropertyValue("--pantry-spring-quick-ease").trim() ||
    "cubic-bezier(0.23, 1, 0.32, 1)";
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  for (const node of canvas.querySelectorAll<HTMLButtonElement>(
    "[data-operation]",
  )) {
    const id = node.dataset.operation;
    if (id === undefined) continue;
    const prior = previous.get(id);
    if (prior?.target === node.style.transform) continue;
    const from = prior?.displayed;
    for (const animation of node.getAnimations()) animation.cancel();
    const to = getComputedStyle(node).transform;
    if (
      remote &&
      !reduced &&
      id !== dragging &&
      from !== undefined &&
      from !== to
    ) {
      node.animate([{ transform: from }, { transform: to }], {
        duration,
        easing,
      });
    }
  }
}

/** Edges follow the same displayed transforms, including interrupted moves. */
export function updateCanvasEdges(canvas: HTMLDivElement): boolean {
  const positions = new Map<string, DOMMatrixReadOnly>();
  let moving = false;
  for (const node of canvas.querySelectorAll<HTMLButtonElement>(
    "[data-operation]",
  )) {
    const id = node.dataset.operation;
    if (id === undefined) continue;
    positions.set(id, new DOMMatrixReadOnly(getComputedStyle(node).transform));
    if (node.getAnimations().length > 0) moving = true;
  }
  for (const edge of canvas.querySelectorAll<SVGLineElement>(
    "line[data-from]",
  )) {
    const from = positions.get(edge.dataset.from ?? "");
    const to = positions.get(edge.dataset.to ?? "");
    if (from === undefined || to === undefined) continue;
    edge.setAttribute("x1", String(from.m41 + 80));
    edge.setAttribute("y1", String(from.m42 + 75));
    edge.setAttribute("x2", String(to.m41 + 80));
    edge.setAttribute("y2", String(to.m42 + 75));
  }
  return moving;
}
