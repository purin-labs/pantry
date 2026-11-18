import {
  COSTS_SURFACE,
  type PageViewCommand,
  type SurfacePageCommandV1,
} from "@seams/control-api";

/**
 * How a chat names an agent command on a Portal page (Plan 87 phase 4). The
 * commands change only the view, so the chat shows them as reads.
 */
export function pageCommandDestination(command: SurfacePageCommandV1): string {
  return command.surface === COSTS_SURFACE ? "Costs & margins" : "Kitchen";
}

export function pageCommandAction(command: SurfacePageCommandV1): string {
  return PAGE_ACTIONS[command.command.name];
}

export function pageCommandObject(command: SurfacePageCommandV1): string {
  return pageObject(command.command);
}

export function pageCommandSummary(command: SurfacePageCommandV1): string {
  return `${pageCommandAction(command)} on ${pageCommandDestination(command)}: ${pageCommandObject(command)}. Nothing was saved.`;
}

const PAGE_ACTIONS: Readonly<Record<PageViewCommand["name"], string>> = {
  open_tab: "Open tab",
  filter_category: "Filter by category",
  select_product: "Select product",
  configure_pastry_bench: "Configure pie pastry bench",
  prepare_pastry_bench: "Run pie pastry bench simulation",
};

const TAB_NAMES = {
  margins: "Product Margins",
  weekly: "Mon–Sun Plan",
  actuals: "Plan vs Actuals",
  forecast: "12-Week P&L & Cash",
  supplies: "Supplier Pack Prices",
} as const;

function pageObject(command: PageViewCommand): string {
  switch (command.name) {
    case "open_tab":
      return TAB_NAMES[command.tab];
    case "filter_category":
      return command.category === "all" ? "All items" : command.category;
    case "select_product":
      return command.productId;
    case "configure_pastry_bench": {
      const parts: string[] = [];
      if (command.pieType !== undefined) parts.push(command.pieType);
      if (command.targetThicknessMm !== undefined)
        parts.push(`${command.targetThicknessMm.toFixed(1)} mm`);
      if (command.crimpForceN !== undefined)
        parts.push(`${command.crimpForceN} N crimp`);
      if (command.faultCheck !== undefined) parts.push(command.faultCheck);
      if (command.cameraPreset !== undefined)
        parts.push(`${command.cameraPreset} view`);
      return parts.length > 0 ? parts.join(" · ") : "Pie pastry bench";
    }
    case "prepare_pastry_bench":
      return "MuJoCo 4.0.0 3D dough press, deformable shortcrust, puff lid & Maruzen oven";
  }
}
