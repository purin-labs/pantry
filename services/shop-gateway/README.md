# Shop gateway

A small program on a computer in the shop (Plan 85). It enrolls once, dials out and holds one
socket to the Platform. The shop opens no port.

- Source: `crates/shop-gateway`. Protocol: `packages/control-api/src/device-gateway.ts`.
- `build.sh` builds a binary for a Mac with Apple silicon and for ARM and x86 Linux.
- `pack.mjs` places the install script and the binaries in the Portal's assets.
- `install.sh` checks the download's SHA-256, enrolls and installs a service.

Run with no hardware: `shop-gateway run --simulate scripts/shop-gateway/simulation.json`.
Plan 24 adds a typed adapter for each physical device.

`shop-gateway relay` runs the same session as `run` on standard input and
output, with no socket: each input line is one Platform message, or
`{"relay":"connected"}` (the gateway sends its hello again) or
`{"relay":"disconnected"}`. Each output line is one gateway message. The E2E
journeys carry these lines to their simulated socket.

## Cobots and the oven (Plan 24)

The `cobot` adapter speaks the controller protocol: JSON lines over TCP, one
connection for each device. Pantry sends named tasks (`cobot_task`,
`cobot_inquire`) and `pause`, `resume` and `stop`; it never talks to a
controller. Write `cobots.json` in the gateway's folder:

```json
{ "controllers": [{ "sourceKey": "cobot-1", "host": "127.0.0.1", "port": 47110 }] }
```

A `--simulate` file takes the same list as `cobots`. The adapter adds each
controller's device to the hello. `cobot-journal.json` records each dispatch
before the `submit`: a second `cobot_task` with the same `requestId` answers
from the journal with `replayed: true` and sends nothing. After a reconnect to
a controller, a welcome or a restart, the adapter asks `status` for each open
task; it never submits again. A pause, a resume or a stop gets its `ack` after
the controller answers, or `refused` after 5 s. The controller simulator is
[`crates/bakery-native/controller`](../../crates/bakery-native/controller/README.md).
The types of the controller lines are in `crates/cobot-protocol`. The adapter
and the simulator both use that crate.

While the journal holds an open task, the adapter sends `cobot_clock` at most
one time each second. A bake run needs the clocks before its first task, so
Pantry sends `cobot_clock_read` with a `requestId`. The adapter answers at once
with a `cobot_clock` that has the same `requestId` and the last clock of each
controller. It asks no controller. If no controller has sent a clock, the
adapter sends nothing and writes the reason to stderr.

## Receipt printer and cash drawer (Plan 90 Phase 5)

The gateway prints on a Star mC-Print3 (`MCP31LB`) over the shop LAN, and it
opens an `mJ-Drawer` on the printer's DK port. Pantry sends a receipt layout;
the gateway encodes StarPRNT. Pantry never learns the printer's address.

1. Give the printer a fixed address on the shop network.
2. Write `printers.json` in the gateway's folder (`~/.satyr-gateway`):

   ```json
   [{ "sourceKey": "printer-1", "host": "192.168.1.50", "port": 9100, "drawer": true, "name": "Counter printer" }]
   ```

3. Restart the gateway. It reports the printer in its hello.
4. On the Devices page, an admin confirms the printer. A printer on a gateway
   of the counter's location then prints for the Register.

`printer-journal.json` in the same folder records each request. A request that
comes again gets its first answer, so a socket drop never prints twice or opens
the drawer twice. To check a printer by hand, pipe one `receipt_print` or
`cash_drawer_kick` message into `shop-gateway answer`.

For a run with no printer, add `printers` to the simulation file:
`{ "sourceKey": "printer-1", "drawer": true, "status": "ready", "outputDir": "out" }`.
The status can be `ready`, `offline`, `paper_out` or `cover_open`. A simulated
printer appends the StarPRNT bytes to `<sourceKey>.starprnt` and a plain-text
rendering to `<sourceKey>.txt` in `outputDir`.
