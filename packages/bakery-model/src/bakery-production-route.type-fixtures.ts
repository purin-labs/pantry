import type { PersistentOvenCell } from "./bakery-physics.ts";
import type {
  ProductionAssignment,
  ProductionRoute,
  ProductionScenario,
} from "./bakery-production-scenario.ts";

declare const cell: PersistentOvenCell;
declare const oven: Extract<ProductionScenario, { route: "oven-rack" }>;
declare const cold: Extract<ProductionScenario, { route: "cold-racking" }>;
declare const assignment: ProductionAssignment;

// @ts-expect-error An oven route must pin its fixture.
const missingCell: ProductionRoute = { route: "oven-rack" };
// @ts-expect-error An authored oven route must identify a retained build.
const missingBuild: ProductionRoute = { route: "oven-rack", cell };
// @ts-expect-error Cold-racking assignments cannot claim an oven fixture.
const mixedRoute: ProductionRoute = { route: "cold-racking", cell };
// @ts-expect-error A spread cannot erase the pinned fixture.
const erasedCell: ProductionScenario = { ...oven, cell: undefined };
// @ts-expect-error Oven routes cannot include cold-racking assignments.
const mixedAssignments: ProductionScenario = {
  ...oven,
  assignments: [assignment],
};
// @ts-expect-error A cold-racking scenario cannot become an oven route by casting.
const castRoute = cold as Extract<ProductionScenario, { route: "oven-rack" }>;
