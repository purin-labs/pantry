# Cobot controller simulator

`cobot-controller` answers on localhost like the controllers of two FAIRINO
FR10 arms (`cobot-1`, `cobot-2`) and one deck oven (`oven-1`) (Plan 24 S2,
decisions D3 and D5). It runs as its own process on the gateway computer. The
shop gateway's `cobot` adapter (`crates/shop-gateway/src/cobot.rs`) talks to
it. It has no physical dispatch authority. The types of the device lines are in
`crates/cobot-protocol`, which the adapter also uses. `port.rs` holds the lines
of the control port, which only the simulator has.

The source stays in `controller/`, outside `src/`, so the engine identity and
the pinned browser bundle do not change (`pnpm lint:physics-bundle`).

## Start it

```sh
export MUJOCO_DIR=/tmp/bakery-sdk
cargo build --locked --release --manifest-path crates/bakery-native/Cargo.toml --bin cobot-controller
crates/bakery-native/target/release/cobot-controller --root . --port 47110 --time-scale 10
```

- `--root`: the repository root, with the verified model assets.
- `--port`: `cobot-1` listens on the port, `cobot-2` on port + 1, `oven-1` on
  port + 2, and the control port on port + 3. All four bind `127.0.0.1`.
  With `--port 0`, the system picks four free ports and the ready line names
  them.
- `--time-scale`: device seconds for each wall second (default 1). At 10, a
  38.5 s loading takes 3.85 s.
- `--state-dir`: optional. The simulator writes `controller-state.json`, the
  `state` answer, after each change. Tasks do not survive a restart: a new
  process answers `status` with `unknown`.

At start the simulator runs each physics case one time and prints one line:
`{"event":"ready","ports":{...},"timeScale":10,"physics":[...]}`.

## Physics

| Move                               | Physics case                | Engine run                                              |
| ---------------------------------- | --------------------------- | ------------------------------------------------------- |
| `cold_rack` → `oven`               | `table-to-oven-nominal`     | FR10 `table-to-oven`, the loading of a `cycle`          |
| `oven` → `cooling_rack`            | `oven-to-table-nominal`     | FR10 `oven-to-table`, the retrieval of the same `cycle` |
| `cold_rack` → `oven`, lost grip    | `table-to-oven-slip`        | FR10 `table-to-oven`, case `slip`                       |
| `cold_rack` → `oven`, blocked door | `table-to-oven-closed-door` | FR10 `table-to-oven`, case `closed-door`                |

The runs use `program::prepare`, `program::first` (which opens the cell with
`Assets::open`) and the transfer runner. A task replays its case's timeline:
its length, its phases and its pickup step. The `state` answer gives each
task's `physicsCase` and `physicsDigest` (the SHA-256 of the engine output),
and the ready line gives each case's length. Other moves have no physics case
and the device rejects them (`no_physics_case`). A bake takes its
`programSeconds` on the device clock.

## Protocol

Each device port carries JSON lines (Plan 24 protocol, part B). The gateway
sends `hello`, `submit`, `status`, `pause`, `resume` and `stop`. The device
sends `hello`, `task`, `control`, `clock` (every 250 ms of wall time),
`fault`, `fault_cleared` and `observed`. Each line has the device's own
`sequence`, which only rises, and its `clockMs`.

- A second `submit` with a known `taskId` runs nothing. The answer is the
  `task` event of its present state.
- `status` for a task that the device never saw answers `state: "unknown"`.
- A task goes `accepted`, then `running` on the next tick, then `completed`
  or `indeterminate`. A refused task is `rejected` with a reason:
  `unsupported_task`, `estop_active`, `device_fault`, `device_stopped`,
  `device_paused`, `device_busy`, `invalid_place`, `invalid_task`,
  `no_physics_case`, `not_at_source`, `destination_occupied`, `oven_baking`,
  `oven_empty`, `oven_door_in_use` or `door_blocked`.
- A running task sends a `task` event at each phase. `carrierAt` is `source`
  before the physics pickup, `tool` after it and `destination` at the end.
- `pause` holds a task where it is. `resume` continues it. `stop` ends the
  open task as `indeterminate` (`stop_requested`) and holds the device until
  `resume`. During an emergency stop, `pause` and `resume` answer `refused`.

World: mould group `g` starts on cold rack shelf `g` (1 to 12). The oven has
shelves 1 to 4, the cooling rack shelves 1 to 12. A completed move places the
group at `to`. A task that ends early places it where `carrierAt` says.

## Control port

One JSON line in, one line out:

```json
{ "op": "inject", "device": "cobot-1", "fault": "grip_lost", "atProgress": 0.5 }
{ "op": "clear", "device": "cobot-1" }
{ "op": "stale", "device": "cobot-1" }
{ "op": "freeze", "device": "cobot-1" }
{ "op": "script", "device": "cobot-1", "moves": [{ "moveId": "m1", "task": {}, "afterMs": 0 }] }
{ "op": "state" }
{ "op": "reset" }
```

- `clear`: a person at the machine clears the device's fault, its stop and a
  frozen clock. A `clear` of any device ends an emergency stop. A mould group
  that stayed on the cleared arm's tool becomes `unknown`.
- `stale`: the device sends again an older event, with its old sequence and
  clock (a `task` event when it has one).
- `freeze`: the device clock stops. The socket stays open, and the device
  sends and answers nothing until `clear`.
- `script`: shadow mode (S5). Each move starts on the device clock after
  `afterMs` and sends `observed` events (`started`, then `completed` or
  `failed`), not `task` events.
- `reset`: the default layout again. Sequences and clocks keep rising.

## Faults

Each fault ends the open task as `indeterminate` with the fault's reason,
sends a `fault` event with its code, and holds the device until `clear`. The
gateway reports each one as `health: "fault"`.

| `inject`                                                             | Code            | Where the outcome comes from                                                                                                                          |
| -------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grip_lost` on a loading (`cold_rack` → `oven`) with no `atProgress` | `GRIP_LOST`     | Physics: the `slip` run gives the time of the loss and `carrierAt: "unknown"`. A running loading switches to it while it is before the loss           |
| `grip_lost` on a retrieval, or with `atProgress`                     | `GRIP_LOST`     | Playback: the grip goes at `atProgress`, or halfway between the pickup and the end. `carrierAt` is `source` before the pickup, else `unknown`         |
| `door_blocked` before a loading                                      | `DOOR_BLOCKED`  | Physics: the `closed-door` run fails before its first step, so the device rejects the task (`door_blocked`)                                           |
| `door_blocked` before a retrieval, or during a move before the door  | `DOOR_BLOCKED`  | Playback: a retrieval is rejected; a running move stops when it reaches the door (the start of `align_oven`), with the tray where the playback has it |
| `arm_stop`                                                           | `ARM_STOP`      | Playback: the arm stops now or at `atProgress` and holds; `carrierAt` comes from the timeline                                                         |
| `estop`                                                              | `ESTOP`         | Playback: every device stops. An open move is `source` before its pickup, else `unknown`. Only `clear` ends it                                        |
| (no inject) two arms inside the oven door                            | `DOOR_CONFLICT` | Playback of both physics timelines: the door is from `align_oven` to `clear_oven_front` (retrieval) or `settled` (loading)                            |

## Journey

`node scripts/plan-24/controller-journey.mjs` starts the simulator, runs a
move on each arm, a bake and a retrieval, checks a duplicate submit, injects
each fault and writes `output/plan-24/controller-journey.json`. It compares
each move time with a separate `bakery-native` run of the same case.
