import { prepareRuntimeCutoverUpdate } from "./shared-rows/organisation-row";
import type { OrganisationId } from "../ids";
import type { Result } from "../result";
import type { VariantBy } from "@seams/type-utils";
import { isNonNegativeInteger } from "@seams/std";

export type AuthoritativeRuntimeCutover =
  | {
      readonly state: "inherited_authoritative";
      readonly authoritativeRuntime: "inherited";
      readonly preparedAt: null;
      readonly activatedAt: null;
      readonly rollbackExpiresAt: null;
      readonly firstAuthoritativeWriteAt: null;
      readonly rolledBackAt: null;
    }
  | {
      readonly state: "cloudflare_prepared";
      readonly authoritativeRuntime: "inherited";
      readonly preparedAt: number;
      readonly activatedAt: null;
      readonly rollbackExpiresAt: null;
      readonly firstAuthoritativeWriteAt: null;
      readonly rolledBackAt: null;
    }
  | {
      readonly state: "cloudflare_rollback_open";
      readonly authoritativeRuntime: "cloudflare";
      readonly preparedAt: number;
      readonly activatedAt: number;
      readonly rollbackExpiresAt: number;
      readonly firstAuthoritativeWriteAt: null;
      readonly rolledBackAt: null;
    }
  | {
      readonly state: "cloudflare_forward_only";
      readonly authoritativeRuntime: "cloudflare";
      readonly preparedAt: number;
      readonly activatedAt: number;
      readonly rollbackExpiresAt: number;
      readonly firstAuthoritativeWriteAt: number;
      readonly rolledBackAt: null;
    }
  | {
      readonly state: "inherited_rolled_back";
      readonly authoritativeRuntime: "inherited";
      readonly preparedAt: number;
      readonly activatedAt: number;
      readonly rollbackExpiresAt: number;
      readonly firstAuthoritativeWriteAt: null;
      readonly rolledBackAt: number;
    };

export type AuthoritativeRuntimeReceipt = AuthoritativeRuntimeCutover & {
  readonly organisationId: OrganisationId;
};

export type CloudflareForwardOnlyRuntimeReceipt = VariantBy<
  AuthoritativeRuntimeReceipt,
  "state",
  "cloudflare_forward_only"
>;

export type AuthoritativeRuntimeCutoverError =
  | { readonly code: "organisation_not_found" }
  | { readonly code: "runtime_cutover_state_invalid" }
  | {
      readonly code: "runtime_cutover_transition_invalid";
      readonly state: AuthoritativeRuntimeCutover["state"];
    };

export type CloudflareAuthoritativeMutationError =
  | AuthoritativeRuntimeCutoverError
  | {
      readonly code: "mutation_precedes_activation";
      readonly activatedAt: number;
    }
  | {
      readonly code: "runtime_not_authoritative";
      readonly state:
        | "inherited_authoritative"
        | "cloudflare_prepared"
        | "inherited_rolled_back";
    };

type RuntimeCutoverRow = {
  readonly authoritativeRuntime: unknown;
  readonly state: unknown;
  readonly preparedAt: unknown;
  readonly activatedAt: unknown;
  readonly rollbackExpiresAt: unknown;
  readonly firstAuthoritativeWriteAt: unknown;
  readonly rolledBackAt: unknown;
};

export function parseAuthoritativeRuntimeCutover(
  row: RuntimeCutoverRow,
): Result<
  AuthoritativeRuntimeCutover,
  { readonly code: "runtime_cutover_state_invalid" }
> {
  switch (row.state) {
    case "inherited_authoritative":
      return parseInheritedAuthority(row);
    case "cloudflare_prepared":
      return parseCloudflarePrepared(row);
    case "cloudflare_rollback_open":
      return parseCloudflareRollbackOpen(row);
    case "cloudflare_forward_only":
      return parseCloudflareForwardOnly(row);
    case "inherited_rolled_back":
      return parseInheritedRolledBack(row);
    default:
      return invalidRuntimeCutoverState();
  }
}

export function parseAuthoritativeRuntimeReceipt(
  row: RuntimeCutoverRow & { readonly organisationId: unknown },
  expectedOrganisationId: OrganisationId,
): Result<
  AuthoritativeRuntimeReceipt,
  { readonly code: "runtime_cutover_state_invalid" }
> {
  if (row.organisationId !== expectedOrganisationId) {
    return invalidRuntimeCutoverState();
  }
  const cutover = parseAuthoritativeRuntimeCutover(row);
  if (!cutover.ok) {
    return cutover;
  }
  switch (cutover.value.state) {
    case "inherited_authoritative":
      return {
        ok: true,
        value: {
          organisationId: expectedOrganisationId,
          state: "inherited_authoritative",
          authoritativeRuntime: "inherited",
          preparedAt: null,
          activatedAt: null,
          rollbackExpiresAt: null,
          firstAuthoritativeWriteAt: null,
          rolledBackAt: null,
        },
      };
    case "cloudflare_prepared":
      return {
        ok: true,
        value: {
          organisationId: expectedOrganisationId,
          state: "cloudflare_prepared",
          authoritativeRuntime: "inherited",
          preparedAt: cutover.value.preparedAt,
          activatedAt: null,
          rollbackExpiresAt: null,
          firstAuthoritativeWriteAt: null,
          rolledBackAt: null,
        },
      };
    case "cloudflare_rollback_open":
      return {
        ok: true,
        value: {
          organisationId: expectedOrganisationId,
          state: "cloudflare_rollback_open",
          authoritativeRuntime: "cloudflare",
          preparedAt: cutover.value.preparedAt,
          activatedAt: cutover.value.activatedAt,
          rollbackExpiresAt: cutover.value.rollbackExpiresAt,
          firstAuthoritativeWriteAt: null,
          rolledBackAt: null,
        },
      };
    case "cloudflare_forward_only":
      return {
        ok: true,
        value: {
          organisationId: expectedOrganisationId,
          state: "cloudflare_forward_only",
          authoritativeRuntime: "cloudflare",
          preparedAt: cutover.value.preparedAt,
          activatedAt: cutover.value.activatedAt,
          rollbackExpiresAt: cutover.value.rollbackExpiresAt,
          firstAuthoritativeWriteAt: cutover.value.firstAuthoritativeWriteAt,
          rolledBackAt: null,
        },
      };
    case "inherited_rolled_back":
      return {
        ok: true,
        value: {
          organisationId: expectedOrganisationId,
          state: "inherited_rolled_back",
          authoritativeRuntime: "inherited",
          preparedAt: cutover.value.preparedAt,
          activatedAt: cutover.value.activatedAt,
          rollbackExpiresAt: cutover.value.rollbackExpiresAt,
          firstAuthoritativeWriteAt: null,
          rolledBackAt: cutover.value.rolledBackAt,
        },
      };
  }
}

export async function readAuthoritativeRuntime(input: {
  readonly db: D1Database;
  readonly organisationId: OrganisationId;
}): Promise<
  Result<AuthoritativeRuntimeReceipt, AuthoritativeRuntimeCutoverError>
> {
  const row = await readRuntimeCutoverRow(input.db, input.organisationId);

  if (row === null) {
    return { ok: false, error: { code: "organisation_not_found" } };
  }

  return parseAuthoritativeRuntimeReceipt(
    {
      organisationId: input.organisationId,
      authoritativeRuntime: row.authoritativeRuntime,
      state: row.state,
      preparedAt: row.preparedAt,
      activatedAt: row.activatedAt,
      rollbackExpiresAt: row.rollbackExpiresAt,
      firstAuthoritativeWriteAt: row.firstAuthoritativeWriteAt,
      rolledBackAt: row.rolledBackAt,
    },
    input.organisationId,
  );
}

async function recordFirstAuthoritativeCloudflareWrite(input: {
  readonly db: D1Database;
  readonly organisationId: OrganisationId;
  readonly occurredAt: number;
}): Promise<
  Result<AuthoritativeRuntimeReceipt, AuthoritativeRuntimeCutoverError>
> {
  const current = await readAuthoritativeRuntime(input);

  if (!current.ok) {
    return current;
  }
  return applyRuntimeTransition({
    db: input.db,
    organisationId: input.organisationId,
    transition: prepareRuntimeControlTransition(
      input.db,
      current.value,
      input.occurredAt,
    ),
  });
}

export async function authorizeCloudflareAuthoritativeMutation(input: {
  readonly db: D1Database;
  readonly organisationId: OrganisationId;
  readonly occurredAt: number;
}): Promise<
  Result<
    CloudflareForwardOnlyRuntimeReceipt,
    CloudflareAuthoritativeMutationError
  >
> {
  const current = await readAuthoritativeRuntime(input);

  if (!current.ok) {
    return current;
  }

  switch (current.value.state) {
    case "cloudflare_forward_only": {
      if (input.occurredAt < current.value.activatedAt) {
        return mutationPrecedesActivation(current.value.activatedAt);
      }
      return { ok: true, value: current.value };
    }
    case "cloudflare_rollback_open": {
      if (input.occurredAt < current.value.activatedAt) {
        return mutationPrecedesActivation(current.value.activatedAt);
      }
      const recorded = await recordFirstAuthoritativeCloudflareWrite(input);

      if (!recorded.ok) {
        if (recorded.error.code === "runtime_cutover_transition_invalid") {
          const accepted = await readAuthoritativeRuntime(input);

          if (
            accepted.ok &&
            accepted.value.state === "cloudflare_forward_only"
          ) {
            return { ok: true, value: accepted.value };
          }
        }
        return recorded;
      }
      return recorded.value.state === "cloudflare_forward_only"
        ? { ok: true, value: recorded.value }
        : invalidTransition(recorded.value.state);
    }
    case "inherited_authoritative":
    case "cloudflare_prepared":
    case "inherited_rolled_back":
      return {
        ok: false,
        error: {
          code: "runtime_not_authoritative",
          state: current.value.state,
        },
      };
  }
}

function mutationPrecedesActivation(
  activatedAt: number,
): Result<never, CloudflareAuthoritativeMutationError> {
  return {
    ok: false,
    error: { code: "mutation_precedes_activation", activatedAt },
  };
}

type RuntimeControlTransition = {
  readonly runtime: AuthoritativeRuntimeReceipt;
  readonly statement: D1PreparedStatement | null;
};

async function applyRuntimeTransition(input: {
  readonly db: D1Database;
  readonly organisationId: OrganisationId;
  readonly transition: Result<
    RuntimeControlTransition,
    AuthoritativeRuntimeCutoverError
  >;
}): Promise<
  Result<AuthoritativeRuntimeReceipt, AuthoritativeRuntimeCutoverError>
> {
  if (!input.transition.ok) {
    return input.transition;
  }
  if (input.transition.value.statement !== null) {
    await input.transition.value.statement.run();
  }
  const current = await readAuthoritativeRuntime({
    db: input.db,
    organisationId: input.organisationId,
  });
  if (!current.ok) {
    return current;
  }
  return sameRuntimeCutover(current.value, input.transition.value.runtime)
    ? { ok: true, value: current.value }
    : invalidTransition(current.value.state);
}

function prepareRuntimeControlTransition(
  db: Pick<D1DatabaseSession, "prepare">,
  current: AuthoritativeRuntimeReceipt,
  now: number,
): Result<RuntimeControlTransition, AuthoritativeRuntimeCutoverError> {
  const next = nextForwardOnlyRuntime(current, now);
  if (!next.ok) {
    return next;
  }
  return {
    ok: true,
    value: {
      runtime: next.value,
      statement: sameRuntimeCutover(current, next.value)
        ? null
        : prepareRuntimeCutoverUpdate(db, current, next.value),
    },
  };
}

function nextForwardOnlyRuntime(
  current: AuthoritativeRuntimeReceipt,
  now: number,
): Result<AuthoritativeRuntimeReceipt, AuthoritativeRuntimeCutoverError> {
  if (current.state === "cloudflare_forward_only") {
    return { ok: true, value: current };
  }
  if (current.state !== "cloudflare_rollback_open") {
    return invalidTransition(current.state);
  }
  if (now < current.activatedAt) {
    return invalidTransition(current.state);
  }
  return {
    ok: true,
    value: {
      organisationId: current.organisationId,
      state: "cloudflare_forward_only",
      authoritativeRuntime: "cloudflare",
      preparedAt: current.preparedAt,
      activatedAt: current.activatedAt,
      rollbackExpiresAt: current.rollbackExpiresAt,
      firstAuthoritativeWriteAt: now,
      rolledBackAt: null,
    },
  };
}

function sameRuntimeCutover(
  left: AuthoritativeRuntimeReceipt,
  right: AuthoritativeRuntimeReceipt,
): boolean {
  return (
    left.organisationId === right.organisationId &&
    left.state === right.state &&
    left.authoritativeRuntime === right.authoritativeRuntime &&
    left.preparedAt === right.preparedAt &&
    left.activatedAt === right.activatedAt &&
    left.rollbackExpiresAt === right.rollbackExpiresAt &&
    left.firstAuthoritativeWriteAt === right.firstAuthoritativeWriteAt &&
    left.rolledBackAt === right.rolledBackAt
  );
}

async function readRuntimeCutoverRow(
  db: D1Database,
  organisationId: OrganisationId,
): Promise<RuntimeCutoverRow | null> {
  return db
    .prepare(
      `SELECT authoritative_runtime AS authoritativeRuntime,
              runtime_cutover_state AS state,
              cloudflare_prepared_at AS preparedAt,
              cloudflare_activated_at AS activatedAt,
              runtime_rollback_expires_at AS rollbackExpiresAt,
              first_cloudflare_write_at AS firstAuthoritativeWriteAt,
              runtime_rolled_back_at AS rolledBackAt
       FROM organisation
       WHERE organisation_id = ?`,
    )
    .bind(organisationId)
    .first<RuntimeCutoverRow>();
}

function parseInheritedAuthority(
  row: RuntimeCutoverRow,
): Result<
  AuthoritativeRuntimeCutover,
  { readonly code: "runtime_cutover_state_invalid" }
> {
  if (
    row.authoritativeRuntime !== "inherited" ||
    row.preparedAt !== null ||
    row.activatedAt !== null ||
    row.rollbackExpiresAt !== null ||
    row.firstAuthoritativeWriteAt !== null ||
    row.rolledBackAt !== null
  ) {
    return invalidRuntimeCutoverState();
  }

  return {
    ok: true,
    value: {
      state: "inherited_authoritative",
      authoritativeRuntime: "inherited",
      preparedAt: null,
      activatedAt: null,
      rollbackExpiresAt: null,
      firstAuthoritativeWriteAt: null,
      rolledBackAt: null,
    },
  };
}

function parseCloudflarePrepared(
  row: RuntimeCutoverRow,
): Result<
  AuthoritativeRuntimeCutover,
  { readonly code: "runtime_cutover_state_invalid" }
> {
  if (
    row.authoritativeRuntime !== "inherited" ||
    !isNonNegativeInteger(row.preparedAt) ||
    row.activatedAt !== null ||
    row.rollbackExpiresAt !== null ||
    row.firstAuthoritativeWriteAt !== null ||
    row.rolledBackAt !== null
  ) {
    return invalidRuntimeCutoverState();
  }

  return {
    ok: true,
    value: {
      state: "cloudflare_prepared",
      authoritativeRuntime: "inherited",
      preparedAt: row.preparedAt,
      activatedAt: null,
      rollbackExpiresAt: null,
      firstAuthoritativeWriteAt: null,
      rolledBackAt: null,
    },
  };
}

function parseCloudflareRollbackOpen(
  row: RuntimeCutoverRow,
): Result<
  AuthoritativeRuntimeCutover,
  { readonly code: "runtime_cutover_state_invalid" }
> {
  if (
    row.authoritativeRuntime !== "cloudflare" ||
    !isNonNegativeInteger(row.preparedAt) ||
    !isNonNegativeInteger(row.activatedAt) ||
    !isNonNegativeInteger(row.rollbackExpiresAt) ||
    row.rollbackExpiresAt <= row.activatedAt ||
    row.firstAuthoritativeWriteAt !== null ||
    row.rolledBackAt !== null
  ) {
    return invalidRuntimeCutoverState();
  }

  return {
    ok: true,
    value: {
      state: "cloudflare_rollback_open",
      authoritativeRuntime: "cloudflare",
      preparedAt: row.preparedAt,
      activatedAt: row.activatedAt,
      rollbackExpiresAt: row.rollbackExpiresAt,
      firstAuthoritativeWriteAt: null,
      rolledBackAt: null,
    },
  };
}

function parseCloudflareForwardOnly(
  row: RuntimeCutoverRow,
): Result<
  AuthoritativeRuntimeCutover,
  { readonly code: "runtime_cutover_state_invalid" }
> {
  if (
    row.authoritativeRuntime !== "cloudflare" ||
    !isNonNegativeInteger(row.preparedAt) ||
    !isNonNegativeInteger(row.activatedAt) ||
    !isNonNegativeInteger(row.rollbackExpiresAt) ||
    !isNonNegativeInteger(row.firstAuthoritativeWriteAt) ||
    row.rollbackExpiresAt <= row.activatedAt ||
    row.firstAuthoritativeWriteAt < row.activatedAt ||
    row.rolledBackAt !== null
  ) {
    return invalidRuntimeCutoverState();
  }

  return {
    ok: true,
    value: {
      state: "cloudflare_forward_only",
      authoritativeRuntime: "cloudflare",
      preparedAt: row.preparedAt,
      activatedAt: row.activatedAt,
      rollbackExpiresAt: row.rollbackExpiresAt,
      firstAuthoritativeWriteAt: row.firstAuthoritativeWriteAt,
      rolledBackAt: null,
    },
  };
}

function parseInheritedRolledBack(
  row: RuntimeCutoverRow,
): Result<
  AuthoritativeRuntimeCutover,
  { readonly code: "runtime_cutover_state_invalid" }
> {
  if (
    row.authoritativeRuntime !== "inherited" ||
    !isNonNegativeInteger(row.preparedAt) ||
    !isNonNegativeInteger(row.activatedAt) ||
    !isNonNegativeInteger(row.rollbackExpiresAt) ||
    row.firstAuthoritativeWriteAt !== null ||
    !isNonNegativeInteger(row.rolledBackAt) ||
    row.rolledBackAt < row.activatedAt
  ) {
    return invalidRuntimeCutoverState();
  }

  return {
    ok: true,
    value: {
      state: "inherited_rolled_back",
      authoritativeRuntime: "inherited",
      preparedAt: row.preparedAt,
      activatedAt: row.activatedAt,
      rollbackExpiresAt: row.rollbackExpiresAt,
      firstAuthoritativeWriteAt: null,
      rolledBackAt: row.rolledBackAt,
    },
  };
}

function invalidRuntimeCutoverState(): {
  readonly ok: false;
  readonly error: { readonly code: "runtime_cutover_state_invalid" };
} {
  return { ok: false, error: { code: "runtime_cutover_state_invalid" } };
}

function invalidTransition(state: AuthoritativeRuntimeCutover["state"]): {
  readonly ok: false;
  readonly error: {
    readonly code: "runtime_cutover_transition_invalid";
    readonly state: AuthoritativeRuntimeCutover["state"];
  };
} {
  return {
    ok: false,
    error: { code: "runtime_cutover_transition_invalid", state },
  };
}
