# Shop gateway

A small program on a computer in the shop (Plan 85). It enrolls once, dials out and holds one
socket to the Platform. The shop opens no port.

- Source: `crates/shop-gateway`. Protocol: `packages/control-api/src/device-gateway.ts`.
- `build.sh` builds a binary for a Mac with Apple silicon and for ARM and x86 Linux.
- `pack.mjs` places the install script and the binaries in the Portal's assets.
- `install.sh` checks the download's SHA-256, enrolls and installs a service.

Run with no hardware: `shop-gateway run --simulate scripts/shop-gateway/simulation.json`.
Plan 24 adds a typed adapter for each physical device.
