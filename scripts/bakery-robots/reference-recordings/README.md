# Frozen Python migration observations

These gzip JSON files retain the Python reference outputs captured on 23 September
2026 with MuJoCo 3.13.0, Python 3.11 and NumPy on macOS arm64. They cover rack and
oven nominal/blocked/unreachable/slip, the closed-door case, nominal half-timestep
runs and nominal retrieval at both timesteps. They retain their original Python
request/model provenance and are used only by `../verify-native.mjs`.

The original controllers and comparison harness are in Git commit
`202912bc59fd7c4b7257f919df8b8b44f468c845` under `scripts/bakery-robots/`.
The capture used those controllers with named component defaults in the model
builder; naming fixes XML serialization and does not change dynamics. The live
Python and Rust comparison passed before Python controller removal, with exact
event/sample steps and maximum motion component differences below 4.2e-12.

`verify-native.mjs` continues to require matching outcome, failure reason,
disposition, event steps and sample steps. Numerical limits remain 0.002 radians
for joints, 0.001 for pose components and 0.001 for each placement metric; settled
placement must also satisfy the physical thresholds. Rust repeat, checkpoint and
handoff continuations must agree exactly within the same runtime.

To investigate a reference regression, check out that commit separately and use
its pinned Python environment and `transfer.execute_transfer` / `oven_cycle.retrieve_tray`.
Normal execution, packaging and regression verification use Rust without Python.
