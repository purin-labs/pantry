# Ingredient loads in the native appliance labs

Execution uses the shared [Rust controller](../../crates/bakery-native/src/appliance_run.rs). The browser builds
that controller with MuJoCo into Wasm. Native and browser jobs use the same
request, recording and continuation format.

See the [execution ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/appliance-rust-browser-execution.md) for repeatable commands and evidence.
The BakeryOS appliance workspace supports recorded playback, interrupted-run
recovery, workspace saves and shared canvas positions.

Python files in `scripts/bakery-mujoco` author and export geometry or submit
requests to Rust. All controller execution belongs to Rust.

## Physical effects

| Appliance                          | Batch effect                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OHAUS R31PE6                       | Added mass loads the native spring sensor. Its computed reading drives the display.                                                   |
| Both induction hobs                | Added mass changes pan support forces. Batch mass and specific heat control the contents' temperature rise.                           |
| AICOH MS-30 and Hobart HL200       | Contents add bowl mass and inertia. Mass, temperature and resistance determine additional tool drag.                                  |
| Vitamix Quiet One and Waring WSG60 | Contents add vessel mass and inertia. The motor works against additional drag and dissipates energy into the batch.                   |
| Severin SM 3587                    | The jug and contents exchange heat. Completion follows contents temperature. The stirrer also experiences batch drag.                 |
| Maruzen MBCO-5E                    | Contents add tray mass and exchange heat with the tray. Loaded cooldown includes the contents' temperature.                           |
| Hoshizaki RT-120SNJ                | Contents add container mass and exchange heat with the container. Cabinet cooling depends on its existing native inside/outside test. |
| Winterhalter UC-L                  | A declared rack load adds mass and exchanges heat with wash water during wash/rinse. Use suitable properties for the wash load.       |

The scale uses a rigid load attached to its pan. Other loads attach to the
existing vessel or rack. The surface marks the approximate fill level and has
no collision geometry. Contents remain contained under tilting. Fluid motion,
pouring, granular motion, phase changes and ingredient chemistry are absent.

Additional motor damping follows this assumed relationship:

```text
damping = appliance coefficient × mass × resistance × temperature factor
temperature factor = exp(clamp((20 − temperature_C) / 60, −2, 2))
```

The damping acts in native dynamics. The controller measures the resulting speed
and torque, so existing stall detection remains active. Dissipated drag work
heats the contents. This relationship does not claim a measured viscosity curve.

Finite thermal reservoirs exchange equal and opposite energy with the batch.
Passive cooling on other appliances uses an assumed room exchange coefficient.
The hob retains its pan/contents/plate model with batch-specific heat capacity.

Thermal rates, forces and motor loads remain assumptions pending measurements.
Earlier rendered evidence remains available as historical model work. Current
execution evidence lives in `combined-bakery/rust-evidence`.
