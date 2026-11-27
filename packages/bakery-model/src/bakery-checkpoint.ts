import { isRecord } from "@purin-labs/std";

/**
 * The engine writes each checkpoint in one envelope (Refactor 16, step 6D):
 * `{ schema, kind, engine, payload, sha256 }`. The engine checks the
 * envelope's engine and SHA-256 when it restores one. This helper only
 * routes a checkpoint: the Portal reads the build identity and the cell
 * definition of a saved state, to open it on the bundle that wrote it.
 */
const CHECKPOINT_ENVELOPE_SCHEMA = 1;

/**
 * The fields of a checkpoint: the payload of an envelope, or a checkpoint
 * that a retained bundle wrote before the envelope, as it is. The retained
 * bundle restores its own checkpoints.
 */
export function checkpointBody(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) return null;
  if (raw.schema === CHECKPOINT_ENVELOPE_SCHEMA && "payload" in raw)
    return isRecord(raw.payload) ? raw.payload : null;
  return raw;
}
