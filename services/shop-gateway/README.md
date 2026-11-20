# Shop gateway

A small program on a computer in the shop (Plan 85). It enrolls once, dials out and holds one
socket to the Platform. The shop opens no port.

- Source: `crates/shop-gateway`. Protocol: `packages/control-api/src/device-gateway.ts`.
- `build.sh` builds a binary for a Mac with Apple silicon and for ARM and x86 Linux.
- `pack.mjs` places the install script and the binaries in the Portal's assets.
- `install.sh` checks the download's SHA-256, enrolls and installs a service.

Run with no hardware: `shop-gateway run --simulate scripts/shop-gateway/simulation.json`.
Plan 24 adds a typed adapter for each physical device.

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
