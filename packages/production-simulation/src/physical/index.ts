/**
 * Plan 24 S4: the physical execution adapter of the production engine. One
 * approved bake run with two cobots and one oven, driven only by dispatch
 * records and device receipts. It has no Platform, network or storage code;
 * a Durable Object holds its values and calls it.
 */
export { compileBakeRun, planBakeRun, type BakeRunInput } from "./compile.ts";
export {
  drivePhysicalRun,
  openDisposition,
  startPhysicalRun,
  type PhysicalRun,
  type PhysicalStop,
} from "./drive.ts";
export { observeBakeRun, type BakeRunView } from "./observe.ts";
export { correlateShadowMoves } from "./shadow.ts";
export { type ClockOrigin, type PhysicalEvidence } from "./protocol.ts";
