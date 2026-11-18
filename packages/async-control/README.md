# `@seams/async-control`

Small, dependency-free ownership primitives shared by Lowerarchy TypeScript
runtimes. The package preserves each consumer's existing domain `Result`
types and supplies only lifecycle mechanics.

## Build and verify

```sh
pnpm --filter @seams/async-control build
pnpm --filter @seams/async-control typecheck
pnpm --filter @seams/async-control test
pnpm --filter @seams/async-control test:exports
```

The root workspace consumes the package through `workspace:*`. The root
`async-control:check` script builds the package before root consumers run.
Generated output remains ignored; source is never copied into a consumer. A
clean checkout therefore builds this package before compiling any consumer.

To compile a root consumer directly, build the shared package first:

```sh
pnpm async-control:build
pnpm --filter @seams/platform check:types
```

## Choosing a primitive

- Use a runtime-native abort timeout for one abort-aware request or delay.
- Use `runTaskBeforeDeadline` when the operation can synchronously return a
  real cancellation handle.
- Choose a fail-stop queue when one failure invalidates later work.
- Choose a continue-after-failure queue when later work remains independent.
- Use a keyed continue queue to serialize one identity while allowing
  different identities to proceed concurrently.
- Transfer work that must outlive its caller to a durable runtime owner.

Each task adapter must resolve cancellation only after the task has released
everything it owns. `createCancellableTask` memoizes the adapter's settlement;
`runTaskBeforeDeadline` also waits for completion before returning a deadline
outcome. A bare `Promise` does not satisfy the deadline contract.
