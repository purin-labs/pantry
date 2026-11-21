import {
  parsePageBrowserBinding,
  parsePageBrowserContext,
  type PageBrowserBinding,
  type PageBrowserContext,
} from "@purin-labs/contracts";
import type { BakerySurfaceToolCommandName } from "./bakery-surface.ts";

/**
 * The browser binding and the browser context of a Kitchen page. The
 * contracts own the forms, because a turn of the Session carries them and
 * they name no Kitchen concept. Kitchen keeps its names for them.
 */
export type BakeryBrowserBinding = PageBrowserBinding;
export type BakeryBrowserContext = PageBrowserContext;
export const parseBakeryBrowserBinding = parsePageBrowserBinding;
export const parseBakeryBrowserContext = parsePageBrowserContext;

export type BakeryContextPreparationCommand = Readonly<{
  kind: "prepare_context";
  schemaVersion: 1;
  binding: BakeryBrowserBinding;
  requiredCommand: BakerySurfaceToolCommandName;
  target?: never;
}>;
