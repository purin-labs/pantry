import type { readCounterSaleView } from "../../commerce/counter-register";
import type { readMenuScreenList } from "../../control/routes/menu-boards";
import type { readTerminalOperations } from "../../data/terminal-operations-readback";
import { definePort } from "../../port";

/**
 * The Café reads that other areas use: the menu screens and the payment
 * terminals that the Devices page lists, and the counter sale that the
 * commerce tools show. Café owns them, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type CafeServices = Readonly<{
  /** The Organisation's screens for the Devices page, or null if unread. */
  readMenuScreenList: typeof readMenuScreenList;
  /** The counters and their terminal assignments. */
  readTerminalOperations: typeof readTerminalOperations;
  /** The open sale of a counter, for the agent's Register tools. */
  readCounterSaleView: typeof readCounterSaleView;
}>;

export const cafeServices = definePort<CafeServices>("cafe_services");
