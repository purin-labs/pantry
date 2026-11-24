import type { MenuScreenSummary } from "@purin-labs/cafe-control-api";
import type { TerminalCounterReadback } from "@purin-labs/control-api";
import type { AuthorizedOrganisationRequest } from "@purin-labs/control/worker/authorization";
import type { OrganisationDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";
import type { OrganisationId } from "@purin-labs/kernel/ids";
import { definePort } from "@purin-labs/kernel/port";
import type {
  CounterRegisterDeps,
  CounterRegisterResult,
  CounterSaleView,
} from "./counter-sale";

/**
 * What an operator needs in order to answer "can this counter take a payment
 * right now, and if not, why".
 *
 * Every field is a fact Pantry already holds. Nothing is inferred from elapsed
 * time, and device health is reported beside collection eligibility rather than
 * folded into it: a device Square has not heard from is a provider-time
 * collection failure, not a loss of authority.
 */
export type TerminalOperationsReadback = Readonly<{
  schemaVersion: "pantry.terminal-operations.v2";
  organisationId: OrganisationId;
  generatedAt: string;
  counters: readonly TerminalCounterReadback[];
  /**
   * Rows that could not be parsed. Surfaced as a count rather than dropped,
   * because a counter Pantry cannot describe is still a counter that exists.
   */
  unreadableAssignments: number;
}>;

/** The counters of one Organisation that a terminal readback lists. */
export type TerminalOperationsRequest = Readonly<{
  db: OrganisationDatabase;
  organisationId: OrganisationId;
  now: number;
  /** The Square locations whose payments Commerce takes (Plan 80). */
  linkedLocationIds: ReadonlySet<string>;
}>;

type ReadMenuScreenList = (
  env: Env,
  authorized: AuthorizedOrganisationRequest,
) => Promise<readonly MenuScreenSummary[] | null>;

type ReadTerminalOperations = (
  input: TerminalOperationsRequest,
) => Promise<TerminalOperationsReadback>;

type ReadCounterSaleView = (
  deps: CounterRegisterDeps,
  checkoutId: string,
) => Promise<CounterRegisterResult<CounterSaleView>>;

/**
 * The Café reads that other areas use: the menu screens and the payment
 * terminals that the Devices page lists, and the counter sale that the
 * commerce tools show. Café owns them, and the Worker registers the
 * implementation (`worker-ports.ts`).
 */
export type CafeServices = Readonly<{
  /** The Organisation's screens for the Devices page, or null if unread. */
  readMenuScreenList: ReadMenuScreenList;
  /** The counters and their terminal assignments. */
  readTerminalOperations: ReadTerminalOperations;
  /** The open sale of a counter, for the agent's Register tools. */
  readCounterSaleView: ReadCounterSaleView;
}>;

export const cafeServices = definePort<CafeServices>("cafe_services");
