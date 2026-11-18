# Grinder, ingredient scale and dishwasher native labs

Execution uses the shared [Rust controller](../../crates/bakery-native/src/appliance_run.rs). The browser builds
that controller with MuJoCo into Wasm. Native and browser jobs use the same
request, recording and continuation format.

See the [execution ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/appliance-rust-browser-execution.md) for repeatable commands and evidence.
The BakeryOS appliance workspace supports recorded playback, interrupted-run
recovery, workspace saves and shared canvas positions.

Python files in `scripts/bakery-mujoco` author and export geometry or submit
requests to Rust. All controller execution belongs to Rust.

Thermal rates, forces and motor loads remain assumptions pending measurements.
Earlier rendered evidence remains available as historical model work. Current
execution evidence lives in `combined-bakery/rust-evidence`.
