import { Type, type Static } from "typebox";
import { recordParser, NonNegativeInteger } from "@purin-labs/contract-schema";
import { KITCHEN_SURFACE } from "./surface-observation.ts";

/**
 * A command that the agent runs on a Portal page in the person's browser
 * (Plan 87 phase 4). It changes only the view, as the person's own clicks
 * do: a save stays a tool with its own approval and receipt. It names the
 * page instance of the observation that the request carried, so a command
 * never lands on a page that the person opened later.
 */
export const COSTS_SURFACE = "costs";
export const REGISTER_SURFACE = "register";

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

/** The view commands of Café › Register (Plan 90): basket staging only, zero money movement. */
export const REGISTER_VIEW_COMMANDS = [
  "register_add_item",
  "register_update_line",
  "register_remove_line",
  "register_clear_basket",
] as const;

export type CostsViewCommandName = (typeof COSTS_VIEW_COMMANDS)[number];
export type CostsTab = (typeof COSTS_TABS)[number];
export type PastryBenchViewCommandName =
  (typeof PASTRY_BENCH_VIEW_COMMANDS)[number];
export type RegisterViewCommandName = (typeof REGISTER_VIEW_COMMANDS)[number];
export type PageViewCommandName =
  | CostsViewCommandName
  | PastryBenchViewCommandName
  | RegisterViewCommandName;

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

export const registerViewCommandSchema = Type.Union([
  Type.Object({
    name: Type.Literal("register_add_item"),
    menuEntryId: identifier,
    modifierOptionIds: Type.Optional(
      Type.Array(identifier, { maxItems: 20 }),
    ),
    quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 99 })),
  }),
  Type.Object({
    name: Type.Literal("register_update_line"),
    lineKey: identifier,
    quantity: Type.Integer({ minimum: 1, maximum: 99 }),
  }),
  Type.Object({
    name: Type.Literal("register_remove_line"),
    lineKey: identifier,
  }),
  Type.Object({
    name: Type.Literal("register_clear_basket"),
  }),
]);

const pageCommandBindingSchema = Type.Object({
  browserInstanceId: Type.String({ minLength: 1, maxLength: 160 }),
  conversationId: Type.String({ minLength: 1, maxLength: 160 }),
});

const pageCommandTargetSchema = Type.Object({
  surfaceSessionId: identifier,
  epoch: NonNegativeInteger,
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
  Type.Object({
    kind: Type.Literal("page_command"),
    schemaVersion: Type.Literal(1),
    surface: Type.Literal(REGISTER_SURFACE),
    binding: pageCommandBindingSchema,
    target: pageCommandTargetSchema,
    command: registerViewCommandSchema,
    agentLabel: Type.String({ minLength: 1, maxLength: 60 }),
  }),
]);

export type CostsViewCommand = Static<typeof costsViewCommandSchema>;
export type PastryBenchViewCommand = Static<typeof pastryBenchViewCommandSchema>;
export type RegisterViewCommand = Static<typeof registerViewCommandSchema>;
export type PageViewCommand =
  | CostsViewCommand
  | PastryBenchViewCommand
  | RegisterViewCommand;
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
  ...REGISTER_VIEW_COMMANDS,
]);

export function isPageViewCommandName(
  name: string,
): name is PageViewCommandName {
  return PAGE_VIEW_COMMAND_SET.has(name);
}

export function pageViewCommandSurface(
  command: PageViewCommand,
): typeof COSTS_SURFACE | typeof KITCHEN_SURFACE | typeof REGISTER_SURFACE {
  switch (command.name) {
    case "open_tab":
    case "filter_category":
    case "select_product":
      return COSTS_SURFACE;
    case "configure_pastry_bench":
    case "prepare_pastry_bench":
      return KITCHEN_SURFACE;
    case "register_add_item":
    case "register_update_line":
    case "register_remove_line":
    case "register_clear_basket":
      return REGISTER_SURFACE;
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
    case "register_add_item":
      return `register:item:${command.menuEntryId}`;
    case "register_update_line":
    case "register_remove_line":
      return `register:line:${command.lineKey}`;
    case "register_clear_basket":
      return "register:basket";
  }
}
