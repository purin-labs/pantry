# Planetary mixer physics labs

Execution uses the shared [Rust controller](../../crates/bakery-native/src/appliance_run.rs). The browser builds
that controller with MuJoCo into Wasm. Native and browser jobs use the same
request, recording and continuation format.

See the [execution ledger](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/appliance-rust-browser-execution.md) for repeatable commands and evidence.
The BakeryOS appliance workspace supports recorded playback, interrupted-run
recovery, workspace saves and shared canvas positions.

Python files in `scripts/bakery-mujoco` author and export geometry or submit
requests to Rust. All controller execution belongs to Rust.

## Mechanisms and reference limits

| Property                        | AICOH MS-30            | Hobart HL200                 |
| ------------------------------- | ---------------------- | ---------------------------- |
| Installed tool                  | Wire whip              | Flat beater                  |
| Published nominal speeds        | 120, 220, 320, 430 rpm | 59 (STIR), 107, 198, 365 rpm |
| Reference appliance dry mass    | 287 kg                 | 85.7 kg                      |
| Assumed carrier torque limit    | ±16 N·m                | ±8 N·m                       |
| Bounded bowl lowering           | 120 mm                 | 20 mm                        |
| Bounded guard opening           | +180°                  | −120°                        |
| Carrier / relative tool damping | 0.05 / 0.025 N·m·s/rad | 0.02 / 0.01 N·m·s/rad        |

The [AICOH reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/aicoh-ms-30/README.md) supplies nominal speeds, overall mass and dimensions.
Its archived manufacturer page describes the guard proximity switch.
The exact operator manual remains unavailable. Timer behavior, bowl interlock and restart policy are lab assumptions for this model.

The [Hobart reference pack](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/equipment/hobart-hl200/README.md) supplies the Japanese drawing and nominal speeds.
The [US family manual](../../docs/equipment/hobart-hl200/specifications/operator-manual-us.pdf), English pages 7 and 11–14, describes operating interlocks and timer behavior.
It requires a closed guard and a raised, locked bowl. Opening the guard stops operation; closing it requires explicit restart.
It also describes timer pause/resume, speed changes during operation and tool coast-down.
Applicability to the supplied Japanese revision remains unconfirmed. Count-up mode is outside this lab.

The transmission ratio is an explicit assumption for both models:

```text
relative tool angle = −4 × carrier angle
world tool angle = carrier angle + relative tool angle
requested carrier speed = selected nominal speed / 3
```

The lab interprets nominal RPM as the magnitude of world tool rotation.
Neither that interpretation nor the −4 ratio establishes the actual transmission.
The load causes some speed droop. Acceptance requires measured speed within 4% of the selected target.

MuJoCo advances at 0.5 ms with the implicitfast integrator.
The gear constraint uses a 1 ms time constant. This limits deflection during sudden load changes.
No animation writes joint poses during stepping.

Thermal rates, forces and motor loads remain assumptions pending measurements.
Earlier rendered evidence remains available as historical model work. Current
execution evidence lives in `combined-bakery/rust-evidence`.
