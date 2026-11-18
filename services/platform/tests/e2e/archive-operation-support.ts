import { env } from "cloudflare:workers";

/**
 * Archive operations of a journey, each held for a fixed time. Operations
 * that run together then overlap, and the longest chain of operations that
 * ran one after another is the number of round trips a turn waits for.
 *
 * A file that uses this must hold one journey only: the held operations of
 * one journey crash the runtime when a second journey follows in the file.
 */
export type ArchiveOperation = {
  readonly kind: string;
  readonly key: string;
  readonly startedAt: number;
  endedAt: number;
};

/**
 * Record each operation on the archive, from every Actor and the Worker, and
 * hold it for `holdMs` before it runs.
 */
export function holdArchiveOperations(
  onTestFinished: (restore: () => void) => void,
  holdMs: number,
): ArchiveOperation[] {
  const operations: ArchiveOperation[] = [];
  const bucket: Record<string, unknown> = Object.getPrototypeOf(env.ARCHIVE);
  const originals = new Map<string, unknown>();

  for (const kind of ["get", "put", "head", "list", "delete"]) {
    const original = bucket[kind];
    if (typeof original !== "function") {
      throw new Error(`The archive has no ${kind} operation`);
    }
    originals.set(kind, original);
    bucket[kind] = async function heldOperation(
      this: unknown,
      ...args: unknown[]
    ): Promise<unknown> {
      const operation: ArchiveOperation = {
        kind,
        key: typeof args[0] === "string" ? args[0] : "",
        startedAt: Date.now(),
        endedAt: Number.POSITIVE_INFINITY,
      };
      operations.push(operation);
      await scheduler.wait(holdMs);
      try {
        return await Reflect.apply(original, this, args);
      } finally {
        operation.endedAt = Date.now();
      }
    };
  }

  onTestFinished(function restoreArchive(): void {
    for (const [kind, original] of originals) bucket[kind] = original;
  });

  return operations;
}

export function isAttachmentOperation(operation: ArchiveOperation): boolean {
  return operation.key.startsWith("attachments/");
}

export function isStagingOperation(operation: ArchiveOperation): boolean {
  return operation.key.includes("/staging/");
}

/** The operation and its key, without the organisation and the digests. */
export function describeOperation(operation: ArchiveOperation): string {
  const [, , ...rest] = operation.key.split("/");
  return `${operation.kind} ${rest.map(shortSegment).join("/")}`;
}

function shortSegment(segment: string): string {
  return segment.length > 16 ? `${segment.slice(0, 8)}…` : segment;
}

/**
 * The length of the longest chain in which each operation started after the
 * one before it ended.
 */
export function longestSequence(
  operations: readonly ArchiveOperation[],
): number {
  const ordered = operations.toSorted(byStart);
  const depths: number[] = [];

  for (const [index, operation] of ordered.entries()) {
    let depth = 1;
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (ordered[earlier]!.endedAt <= operation.startedAt) {
        depth = Math.max(depth, depths[earlier]! + 1);
      }
    }
    depths.push(depth);
  }

  return Math.max(0, ...depths);
}

function byStart(left: ArchiveOperation, right: ArchiveOperation): number {
  return left.startedAt - right.startedAt;
}
