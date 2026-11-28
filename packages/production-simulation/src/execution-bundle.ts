import {
  canonicalJson,
  hasExactKeys,
  isNonNegativeInteger,
  isPositiveInteger,
  isRecord,
  sha256Hex,
} from "@purin-labs/std";
import { parseSha256Hex, type Sha256Hex } from "./identity.ts";
import {
  resumeSupport,
  type ExecutionBackend,
  type ExecutionBundle,
  type ResumeSupport,
} from "./physics.ts";
import { err, ok, type Result } from "./result.ts";
import type { Variant } from "@purin-labs/type-utils";

/**
 * An execution bundle: the engine and adapter build, and the controller
 * runtime it drives, kept together under one identity. A saved run names the
 * bundle that made it. A host of that bundle restores the checkpoints of the
 * save. A host of another bundle never reads those checkpoints: it runs the
 * inputs of the save again (`replay.ts`).
 */

export const EXECUTION_MANIFEST_SCHEMA_VERSION = 1;
/**
 * The operations a host calls on an engine module. Version 6 added the
 * replay origin, the cells of another build and the replay report.
 */
export const HOST_PROTOCOL_VERSION = 6;
/** Version 2 added the rest observation a settled hold is entered from. */
export const CELL_CHECKPOINT_SCHEMA_VERSION = 4;

export type RetainedFile = Readonly<{
  file: string;
  sha256: Sha256Hex;
  byteLength: number;
}>;

export type ExecutionManifest = Readonly<{
  schemaVersion: typeof EXECUTION_MANIFEST_SCHEMA_VERSION;
  /** Its `id` is the digest of everything else in this manifest. */
  bundle: ExecutionBundle;
  /** The engine, host loop and adapter as one module. */
  engine: RetainedFile;
  /** The controller's runtime bundle, by its own identity and files. */
  runtime: Readonly<{ id: Sha256Hex; files: readonly RetainedFile[] }>;
}>;

type Content = Readonly<{
  identity: Omit<ExecutionBundle, "id">;
  engine: RetainedFile;
  runtime: ExecutionManifest["runtime"];
}>;

async function contentIdentity(content: Content): Promise<Sha256Hex> {
  const digest = parseSha256Hex(
    await sha256Hex(
      canonicalJson({
        schemaVersion: EXECUTION_MANIFEST_SCHEMA_VERSION,
        ...content,
      }),
    ),
  );
  if (!digest.ok) throw new Error("A digest is a digest");
  return digest.value;
}

/**
 * Names a bundle by its contents. The engine's hash is its retained file's,
 * so the identity binds the exact engine and runtime bytes together.
 */
export async function executionManifest(
  identity: Omit<ExecutionBundle, "id" | "engineHash">,
  engine: RetainedFile,
  runtime: ExecutionManifest["runtime"],
): Promise<ExecutionManifest> {
  const complete = { ...identity, engineHash: engine.sha256 };
  return {
    schemaVersion: EXECUTION_MANIFEST_SCHEMA_VERSION,
    bundle: {
      id: await contentIdentity({ identity: complete, engine, runtime }),
      ...complete,
    },
    engine,
    runtime,
  };
}

export type ManifestProblem =
  | Readonly<{ code: "invalid_manifest"; where: string }>
  | Readonly<{ code: "identity_differs"; expected: Sha256Hex }>;

function digestAt(raw: Record<string, unknown>, key: string): Sha256Hex | null {
  const parsed = parseSha256Hex(raw[key]);
  return parsed.ok ? parsed.value : null;
}

function parseFile(raw: unknown): RetainedFile | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["file", "sha256", "byteLength"]))
    return null;
  const sha256 = digestAt(raw, "sha256");
  const { file, byteLength } = raw;
  // A retained file is named, never addressed by a path or a URL.
  return sha256 !== null &&
    typeof file === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(file) &&
    isPositiveInteger(byteLength)
    ? { file, sha256, byteLength }
    : null;
}

/** A saved run's claim of the bundle it resumes through. */
export function parseExecutionBundle(raw: unknown): ExecutionBundle | null {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, [
      "id",
      "backend",
      "protocolVersion",
      "checkpointSchemaVersion",
      "engineHash",
      "controllerSourceHash",
      "controllerHash",
      "runtimeHash",
    ])
  )
    return null;
  const id = digestAt(raw, "id");
  const engineHash = digestAt(raw, "engineHash");
  const controllerSourceHash = digestAt(raw, "controllerSourceHash");
  const controllerHash = digestAt(raw, "controllerHash");
  const runtimeHash = digestAt(raw, "runtimeHash");
  const { backend, protocolVersion, checkpointSchemaVersion } = raw;
  return id !== null &&
    engineHash !== null &&
    controllerSourceHash !== null &&
    controllerHash !== null &&
    runtimeHash !== null &&
    (backend === "browser" || backend === "headless") &&
    isNonNegativeInteger(protocolVersion) &&
    isNonNegativeInteger(checkpointSchemaVersion)
    ? {
        id,
        backend,
        protocolVersion,
        checkpointSchemaVersion,
        engineHash,
        controllerSourceHash,
        controllerHash,
        runtimeHash,
      }
    : null;
}

/** Reads a retained manifest and checks that its identity is its content. */
export async function parseExecutionManifest(
  raw: unknown,
): Promise<Result<ExecutionManifest, ManifestProblem>> {
  if (
    !isRecord(raw) ||
    !hasExactKeys(raw, ["schemaVersion", "bundle", "engine", "runtime"]) ||
    raw.schemaVersion !== EXECUTION_MANIFEST_SCHEMA_VERSION
  )
    return err({ code: "invalid_manifest", where: "manifest" });
  const bundle = parseExecutionBundle(raw.bundle);
  if (bundle === null)
    return err({ code: "invalid_manifest", where: "bundle" });
  const engine = parseFile(raw.engine);
  if (engine === null)
    return err({ code: "invalid_manifest", where: "engine" });
  const runtime = raw.runtime;
  const runtimeId = isRecord(runtime) ? digestAt(runtime, "id") : null;
  if (
    !isRecord(runtime) ||
    !hasExactKeys(runtime, ["id", "files"]) ||
    runtimeId === null ||
    !Array.isArray(runtime.files)
  )
    return err({ code: "invalid_manifest", where: "runtime" });
  const files: RetainedFile[] = [];
  for (const candidate of runtime.files) {
    const file = parseFile(candidate);
    if (file === null)
      return err({ code: "invalid_manifest", where: "runtime.files" });
    files.push(file);
  }
  const { id, ...identity } = bundle;
  const expected = await contentIdentity({
    identity,
    engine,
    runtime: { id: runtimeId, files },
  });
  if (id !== expected || bundle.engineHash !== engine.sha256)
    return err({ code: "identity_differs", expected });
  return ok({
    schemaVersion: EXECUTION_MANIFEST_SCHEMA_VERSION,
    bundle,
    engine,
    runtime: { id: runtimeId, files },
  });
}

/** What a host finds where a retained file should be, or null for nothing. */
export type RetainedMeasure = (
  manifest: ExecutionManifest,
  file: RetainedFile,
  part: "engine" | "runtime",
) => Promise<Readonly<{ sha256: string; byteLength: number }> | null>;

export type ResolveProblem =
  | Readonly<{
      code: "inspection_only";
      reason: Variant<ResumeSupport, "inspection-only">["reason"];
    }>
  | Readonly<{ code: "file_missing"; file: string }>
  | Readonly<{ code: "file_altered"; file: string }>;

/**
 * Finds the retained bundle a saved run names and checks that every one of
 * its files is present and unaltered. Only the exact bundle resolves: a
 * newer build, another backend or an edited file never substitutes.
 */
export async function resolveExecution(
  saved: ExecutionBundle,
  backend: ExecutionBackend,
  retained: readonly ExecutionManifest[],
  measure: RetainedMeasure,
): Promise<Result<ExecutionManifest, ResolveProblem>> {
  const bundles: ExecutionBundle[] = [];
  for (const manifest of retained) bundles.push(manifest.bundle);
  const support = resumeSupport(saved, backend, bundles);
  if (support.kind === "inspection-only")
    return err({ code: "inspection_only", reason: support.reason });
  for (const manifest of retained) {
    if (manifest.bundle.id !== saved.id) continue;
    const parts = [
      ["engine", [manifest.engine]],
      ["runtime", manifest.runtime.files],
    ] as const;
    for (const [part, files] of parts)
      for (const file of files) {
        const found = await measure(manifest, file, part);
        if (found === null)
          return err({ code: "file_missing", file: file.file });
        if (
          found.sha256 !== file.sha256 ||
          found.byteLength !== file.byteLength
        )
          return err({ code: "file_altered", file: file.file });
      }
    return ok(manifest);
  }
  return err({ code: "inspection_only", reason: "bundle_unavailable" });
}
