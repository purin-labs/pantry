import type { SingleDatabase } from "@purin-labs/kernel/database-handles";
import type { Env } from "@purin-labs/kernel/env";

/**
 * A unit test's `Env`: its one database holds both schemas, so `DB` serves
 * as the global database and as every Organisation's database.
 */
export type UnitTestEnv = Omit<Env, "DB"> & { DB: SingleDatabase };

/**
 * A Worker `Env` holding only the bindings a test needs. Binding names are
 * checked against `Env`, so a misspelt binding fails to compile; values stay
 * whatever fake the test supplies.
 */
export function platformEnv(
  bindings: Readonly<{ [K in keyof Env]?: unknown }>,
): UnitTestEnv {
  return bindings as UnitTestEnv;
}

/** An ExecutionContext whose hooks do nothing unless a test supplies them. */
export function testExecutionContext(
  overrides: Partial<ExecutionContext> = {},
): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
    props: {},
    ...overrides,
  } as ExecutionContext;
}
