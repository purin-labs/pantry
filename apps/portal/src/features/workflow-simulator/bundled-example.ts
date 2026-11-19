import {
  parsePhysicsReplay,
  type PhysicsReplay,
} from "@purin-labs/bakery-model/bakery-physics";
import type { ReadExample } from "@purin-labs/production-simulation/simulator/rehearsal-presets";

import { readExample } from "./rehearsal-examples.ts";

// Recordings are fetched only when requested.
export async function readBundledExample(
  example: Parameters<ReadExample>[0],
): Promise<PhysicsReplay> {
  const parsed = parsePhysicsReplay(await readExample(example));
  if (parsed.kind === "rejected") throw new Error(parsed.message);
  return parsed.recording;
}
