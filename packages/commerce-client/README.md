# Commerce client (`@seams/commerce-client`)

This package is the versioned client for Commerce's admin, storefront and
entity-plane APIs. It depends on no Pantry package, and
`pnpm lint:runtime-boundary` refuses a new crossing. The boundary reads
merchant snapshots and published resource metadata, submits validated
Contracts query plans, executes exact-revision entity commands, publishes the
export preset, and reads signed observation deliveries. Its parsers retain the
complete signed receipt envelope and convert every raw response into the
authoritative contract types once at the boundary.

Commerce owns receipt and rejection semantics. `packages/commerce-contracts`
(`@seams/commerce-contracts`) owns graph-query planning and cursor validation.
Clients such as Pantry pin this supported major version and do not maintain
local copies of either contract.

Private commerce authority and persistence remain in `services/commerce`.
Pantry admits verified Commerce deliveries to its Actor, Cue, Case, policy,
approval, and ActionLedger lifecycles. Provider projections remain Commerce
Read Layer state; merchant extensions remain Commerce state.
