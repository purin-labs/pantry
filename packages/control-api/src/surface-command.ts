import { Type, type Static } from "typebox";
import { recordParser } from "@seams/commerce-contracts/schema";
import { KITCHEN_SURFACE } from "./surface-observation";

/**
 * A command that the agent runs on a Portal page in the person's browser
 * (Plan 87 phase 4). It changes only the view, as the person's own clicks
 * do: a save stays a tool with its own approval and receipt. It names the
 * page instance of the observation that the request carried, so a command
 * never lands on a page that the person opened later.
 */
export const COSTS_SURFACE = "costs";

export const COSTS_TABS = [
  "margins",
  "weekly",
  "actuals",
  "forecast",
  "supplies",
] as const;

/** The view commands of Costs & margins, as the observation lists them. */
export const COSTS_VIEW_COMMANDS = [
  "open_tab",
  "filter_category",
  "select_product",
] as const;

export const PASTRY_BENCH_PIE_TYPES = [
  "steak-and-pepper",
  "beef-bourguignon",
] as const;

export const PASTRY_BENCH_THICKNESS_MM = [2.5, 3.0, 3.5] as const;
export const PASTRY_BENCH_CRIMP_FORCE_N = [36, 42, 52] as const;
export const PASTRY_BENCH_FAULT_CHECKS = ["none", "unfloured-bench"] as const;
export const PASTRY_BENCH_CAMERA_PRESETS = [
  "bench",
  "dough-block",
  "tin-cavity",
  "roller",
  "overhead",
  "oven",
] as const;

/** The view commands of the Kitchen Pie Pastry Bench workspace. */
export const PASTRY_BENCH_VIEW_COMMANDS = [
  "configure_pastry_bench",
  "prepare_pastry_bench",
] as const;

export type CostsViewCommandName = (typeof COSTS_VIEW_COMMANDS)[number];
export type CostsTab = (typeof COSTS_TABS)[number];
export type PastryBenchViewCommandName =
  (typeof PASTRY_BENCH_VIEW_COMMANDS)[number];
export type PageViewCommandName =
  | CostsViewCommandName
  | PastryBenchViewCommandName;

const identifier = Type.String({ minLength: 1, maxLength: 200 });

export const costsViewCommandSchema = Type.Union([
  Type.Object({
    name: Type.Literal("open_tab"),
    tab: Type.Union([
      Type.Literal("margins"),
      Type.Literal("weekly"),
      Type.Literal("actuals"),
      Type.Literal("forecast"),
      Type.Literal("supplies"),
    ]),
  }),
  Type.Object({
    name: Type.Literal("filter_category"),
    /** `all`, or a product type that the page shows as a filter chip. */
    category: Type.String({ minLength: 1, maxLength: 60 }),
  }),
  Type.Object({
    name: Type.Literal("select_product"),
    productId: identifier,
  }),
]);

export const pastryBenchViewCommandSchema = Type.Union([
  Type.Object({
    name: Type.Literal("configure_pastry_bench"),
    pieType: Type.Optional(
      Type.Union([
        Type.Literal("steak-and-pepper"),
        Type.Literal("beef-bourguignon"),
      ]),
    ),
    targetThicknessMm: Type.Optional(
      Type.Union([Type.Literal(2.5), Type.Literal(3.0), Type.Literal(3.5)]),
    ),
    crimpForceN: Type.Optional(
      Type.Union([Type.Literal(36), Type.Literal(42), Type.Literal(52)]),
    ),
    faultCheck: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("unfloured-bench")]),
    ),
    cameraPreset: Type.Optional(
      Type.Union([
        Type.Literal("bench"),
        Type.Literal("dough-block"),
        Type.Literal("tin-cavity"),
        Type.Literal("roller"),
        Type.Literal("overhead"),
        Type.Literal("oven"),
      ]),
    ),
  }),
  Type.Object({
    name: Type.Literal("prepare_pastry_bench"),
  }),
]);

const pageCommandBindingSchema = Type.Object({
  browserInstanceId: Type.String({ minLength: 1, maxLength: 160 }),
  conversationId: Type.String({ minLength: 1, maxLength: 160 }),
});

const pageCommandTargetSchema = Type.Object({
  surfaceSessionId: identifier,
  epoch: Type.Integer({ minimum: 0 }),
});

export const surfacePageCommandSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("page_command"),
    schemaVersion: Type.Literal(1),
    surface: Type.Literal(COSTS_SURFACE),
    /** The browser and chat of the request, which alone receive the command. */
    binding: pageCommandBindingSchema,
    /** The page instance of the observation that the request carried. */
    target: pageCommandTargetSchema,
    command: costsViewCommandSchema,
    /** The name that the label on the page shows, such as the agent's name. */
    agentLabel: Type.String({ minLength: 1, maxLength: 60 }),
  }),
  Type.Object({
    kind: Type.Literal("page_command"),
    schemaVersion: Type.Literal(1),
    surface: Type.Literal(KITCHEN_SURFACE),
    /** The browser and chat of the request, which alone receive the command. */
    binding: pageCommandBindingSchema,
    /** The page instance of the observation that the request carried. */
    target: pageCommandTargetSchema,
    command: pastryBenchViewCommandSchema,
    /** The name that the label on the page shows, such as the agent's name. */
    agentLabel: Type.String({ minLength: 1, maxLength: 60 }),
  }),
]);

export type CostsViewCommand = Static<typeof costsViewCommandSchema>;
export type PastryBenchViewCommand = Static<typeof pastryBenchViewCommandSchema>;
export type PageViewCommand = CostsViewCommand | PastryBenchViewCommand;
export type SurfacePageCommandV1 = Static<typeof surfacePageCommandSchema>;

const decodeSurfacePageCommand = recordParser(surfacePageCommandSchema);

export function parseSurfacePageCommand(
  raw: unknown,
): SurfacePageCommandV1 | null {
  const decoded = decodeSurfacePageCommand(raw);
  return decoded.ok ? decoded.value : null;
}

const PAGE_VIEW_COMMAND_SET: ReadonlySet<string> = new Set<string>([
  ...COSTS_VIEW_COMMANDS,
  ...PASTRY_BENCH_VIEW_COMMANDS,
]);

export function isPageViewCommandName(
  name: string,
): name is PageViewCommandName {
  return PAGE_VIEW_COMMAND_SET.has(name);
}

export function pageViewCommandSurface(
  command: PageViewCommand,
): typeof COSTS_SURFACE | typeof KITCHEN_SURFACE {
  switch (command.name) {
    case "open_tab":
    case "filter_category":
    case "select_product":
      return COSTS_SURFACE;
    case "configure_pastry_bench":
    case "prepare_pastry_bench":
      return KITCHEN_SURFACE;
  }
}

/**
 * The element that a command acts on, as the page marks it with
 * `data-surface-target`. The label overlay draws the agent's label there.
 */
export function surfaceCommandTarget(command: PageViewCommand): string {
  switch (command.name) {
    case "open_tab":
      return `tab:${command.tab}`;
    case "filter_category":
      return `category:${command.category}`;
    case "select_product":
      return `row:${command.productId}`;
    case "configure_pastry_bench":
      return command.cameraPreset !== undefined &&
        command.pieType === undefined &&
        command.targetThicknessMm === undefined &&
        command.crimpForceN === undefined &&
        command.faultCheck === undefined
        ? `pastry-bench:camera:${command.cameraPreset}`
        : "pastry-bench:controls";
    case "prepare_pastry_bench":
      return "pastry-bench:prepare";
  }
}
