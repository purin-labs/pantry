import type { CommerceEntityPlaneError } from "@seams/commerce-contracts";

export class EntityPlaneHttpError extends Error {
  readonly status: number;
  readonly error: CommerceEntityPlaneError | undefined;
  readonly queryFailure: "cursor_stale" | null;

  constructor(
    status: number,
    message: string,
    error: CommerceEntityPlaneError | undefined = undefined,
    queryFailure: "cursor_stale" | null = null,
  ) {
    super(message);
    this.name = "EntityPlaneHttpError";
    this.status = status;
    this.error = error;
    this.queryFailure = queryFailure;
  }
}
