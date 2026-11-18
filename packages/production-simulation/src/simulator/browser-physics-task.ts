import type { RobotModel } from "@seams/bakery-model/bakery-robots";
import type { NativeContinuation } from "../recipes/bakery/native-continuation.ts";
import type {
  PhysicsReplay,
  IngredientLoad,
  PhysicsRequest,
} from "@seams/bakery-model/bakery-physics";

// What one browser MuJoCo job runs and returns. Kept apart from the worker
// host so schedulers and tests can name tasks without a DOM.
export type BrowserPhysicsMode =
  "transfer" | "oven-cycle" | "rack-cycle" | "loading" | "oven-handoff";
export type BrowserPhysicsTask =
  | Readonly<{
      kind: "selection";
      ingredients: IngredientLoad;
      robot: RobotModel;
      task: "table-to-rack" | "table-to-oven";
      scenario: "nominal" | "blocked" | "unreachable";
      request?: never;
      mode?: never;
      handoff?: never;
      rackCase?: never;
    }>
  | Readonly<{
      kind: "request" | "prepared-request";
      request: PhysicsRequest;
      mode: BrowserPhysicsMode;
      handoff?: never;
      rackCase?: never;
    }>
  | Readonly<{
      kind: "continuation";
      handoff: NativeContinuation;
      rackCase: "nominal" | "slip";
      request?: never;
      mode?: never;
    }>;
export type BrowserPhysicsOutcome = Readonly<{
  request: PhysicsRequest;
  recording: PhysicsReplay;
  handoff: NativeContinuation | null;
  recordingDigest: string;
  bytes: number;
  elapsedMs: number;
}>;
