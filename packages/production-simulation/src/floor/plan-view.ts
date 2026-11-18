/** Screen pixels, measured from the plan viewport's top-left corner. */
export type PlanPoint = Readonly<{ x: number; y: number }>;
export type PlanSize = Readonly<{ width: number; height: number }>;
export type PlanInsets = Readonly<{
  top: number;
  right: number;
  bottom: number;
  left: number;
}>;
/** An axis-aligned floor area in world metres. */
export type PlanRect = Readonly<{
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}>;
/**
 * One uniform scale in pixels per metre and the floor point at the viewport
 * centre. A single scale keeps every footprint in true proportion.
 */
export type PlanView = Readonly<{ scale: number; x: number; z: number }>;

const scaleSteps = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20] as const;

/** Centers `rect` in the viewport area left after `insets`. */
export function fitView(
  rect: PlanRect,
  size: PlanSize,
  insets: PlanInsets,
  minimumSpan = 0,
): PlanView {
  const width = Math.max(rect.maxX - rect.minX, minimumSpan, 1e-6);
  const depth = Math.max(rect.maxZ - rect.minZ, minimumSpan, 1e-6);
  const scale = Math.max(
    1e-6,
    Math.min(
      (size.width - insets.left - insets.right) / width,
      (size.height - insets.top - insets.bottom) / depth,
    ),
  );
  return {
    scale,
    x: (rect.minX + rect.maxX) / 2 - (insets.left - insets.right) / 2 / scale,
    z: (rect.minZ + rect.maxZ) / 2 - (insets.top - insets.bottom) / 2 / scale,
  };
}

export function toScreen(
  view: PlanView,
  size: PlanSize,
  x: number,
  z: number,
): PlanPoint {
  return {
    x: (x - view.x) * view.scale + size.width / 2,
    y: (z - view.z) * view.scale + size.height / 2,
  };
}

export function toFloor(
  view: PlanView,
  size: PlanSize,
  point: PlanPoint,
): Readonly<{ x: number; z: number }> {
  return {
    x: view.x + (point.x - size.width / 2) / view.scale,
    z: view.z + (point.y - size.height / 2) / view.scale,
  };
}

/** Scales about `point`, which keeps the same floor position under it. */
export function zoomAt(
  view: PlanView,
  size: PlanSize,
  point: PlanPoint,
  factor: number,
  limits: Readonly<{ min: number; max: number }>,
): PlanView {
  const scale = Math.min(limits.max, Math.max(limits.min, view.scale * factor));
  const floor = toFloor(view, size, point);
  return {
    scale,
    x: floor.x - (point.x - size.width / 2) / scale,
    z: floor.z - (point.y - size.height / 2) / scale,
  };
}

/** Moves the drawing with the pointer by `dx`, `dy` screen pixels. */
export function panView(view: PlanView, dx: number, dy: number): PlanView {
  return {
    scale: view.scale,
    x: view.x - dx / view.scale,
    z: view.z - dy / view.scale,
  };
}

/** SVG transform that maps world metres (x, z) into viewport pixels. */
export function viewTransform(view: PlanView, size: PlanSize): string {
  const origin = toScreen(view, size, 0, 0);
  return `translate(${origin.x} ${origin.y}) scale(${view.scale})`;
}

/** Plan dimensions drop trailing zeros: 11 m, 0.5 m. */
export function metres(value: number): string {
  return `${Number(value.toFixed(2))} m`;
}

/** The longest round length in metres that fits within `maxPixels`. */
export function scaleBarLength(scale: number, maxPixels = 96): number {
  let length: number = scaleSteps[0];
  for (const step of scaleSteps) if (step * scale <= maxPixels) length = step;
  return length;
}
