# Shared account contracts

`@seams-internal/console-shared@0.1.3` comes from `seams-monorepo/packages/console-shared-ts`.
Console and Satyr share one set of wire types and parsers.
Source commit: `aee87e9a` on `dev` (Plan 88).
Version 0.1.3 adds the Jev customer price `satyr-jev-input-tokens-customer-v1` (D9).
Version 0.1.2 added the meter `satyr.jev_input_tokens` and `pantryJevExecutionIdV1` to 0.1.1.
Version 0.1.1 added the Satyr instance release contract to 0.1.0 (`f209d8e3`).
The package remains private. This directory contains its generated internal distribution.

Artifact: `seams-internal-console-shared-0.1.3-ebed186cf39a.tgz`.

SHA-256: `ebed186cf39ac6a707ebd5f67da72cb63d9b9df2f8fe7a0f1e53a15a870abe0a`.

Both `services/platform` and `packages/control-api` pin this exact file.
The lockfile also pins its integrity. The archive contains compiled JavaScript, declarations, and package metadata.
Runtime imports require no sibling checkout or private server sources.

## Rebuild

From the Console checkout:

```sh
pnpm -C packages/console-shared-ts pack --pack-destination /tmp/shared-account-contracts
shasum -a 256 /tmp/shared-account-contracts/seams-internal-console-shared-0.1.3.tgz
```

For an intentional contract change, bump the package version before creating another release.
Copy the generated tarball here with its version and the first twelve SHA-256 characters in the filename.
Update both dependency pins, run `pnpm install`, and run the composed acceptance in
`docs/evidence/account-wire-contracts.md`. Retire the previous archive after its consumers move.
Never edit generated archive contents or replace a committed artifact in place.

Package releases have their own version. Current HTTP messages retain wire version 1.
