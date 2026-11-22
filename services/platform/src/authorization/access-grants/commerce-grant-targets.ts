import type { Variant } from "@purin-labs/type-utils";
import { definePort } from "@purin-labs/kernel/port";
import type { Result } from "@purin-labs/kernel/result";
import type { AccessGrantTarget, CommerceReadGrantScope } from "./types";

/** A commerce part of a grant target, or the field that it refuses. */
export type CommerceGrantTargetParse<T> = Result<
  T,
  Readonly<{ field: string }>
>;

type CommerceCommandTarget = Variant<AccessGrantTarget, "commerce_command">;

/**
 * The parsers of the commerce parts of a stored grant target: the scope of a
 * read grant, and the scope and the mutation target of a command grant. The
 * grant store parses the rest of the row. Commerce owns the graph queries and
 * the commands that the parts name, so it gives the implementation, and the
 * Worker registers it (`worker-ports.ts`).
 */
export type CommerceGrantTargets = Readonly<{
  parseReadScope(
    raw: unknown,
  ): CommerceGrantTargetParse<CommerceReadGrantScope>;
  parseCommandScope(
    raw: unknown,
  ): CommerceGrantTargetParse<CommerceCommandTarget["scope"]>;
  parseCommandTarget(
    raw: unknown,
  ): CommerceGrantTargetParse<CommerceCommandTarget["target"]>;
}>;

export const commerceGrantTargets = definePort<CommerceGrantTargets>(
  "commerce_grant_targets",
);
