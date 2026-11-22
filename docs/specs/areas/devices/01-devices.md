# DEV-01 — Devices

The Devices page of Purin Pantry shows each device in the shop in one list, in the
Kitchen navigation group. For each device, it answers one question: can this device take
the next task, and if not, why not? A shop gateway is a small computer in the shop. It
enrolls one time with a one-time code, dials out and holds one socket to the
`DeviceFleetActor` of its location. Pantry never calls the gateway. People and Sous Chef
agents read devices, pause work and change access through one set of commands, with role
checks and receipts. The Devices page has no motion control, and the gateway protocol has
no raw motion command. Emergency stop stays on the machine.

## What it does

### The Devices page

- One list holds menu screens, shop Macs, payment terminals, gateways and the kitchen
  devices behind them. The top line counts the devices, the ready and busy kitchen
  devices, and the devices that need attention.
- The controls are a search and filters for **Needs attention** and kind. The location
  filter shows only when the Organisation has more than one location.
  Kitchen devices group by station (Bakery, Bar, "No station yet"), the others by kind.
  The page reads the list every 15 s. If one kind cannot be read, a notice names it.
- The drawer of a gateway or a kitchen device shows its state, the current work (the task
  label and the run reference, with no link), the actions, the facts, the capabilities,
  the activity and the snapshots of a camera. It says "Emergency stop stays on the
  machine." The drawer of another kind links to the page that manages it.
- If a person does not have the role for an action, a dialog in place names the role and
  tells the person to ask an owner. It sends no request.

### Enrollment

1. An admin selects **Add gateway** and gives a name and a location. Pantry makes a
   gateway id (`dgw_…`) and a one-time code that ends after 15 minutes. It stores only
   the SHA-256 hash of the code.
2. The Portal shows one install command. `services/shop-gateway/install.sh` checks the
   SHA-256 of the binary and enrolls. The code works one time. It gives the credential
   `sgw1.<organisationId>.<gatewayId>.<secret>`. Pantry stores only the secret's hash.
3. The gateway opens one outbound WebSocket and sends `hello` with the devices it found.
4. Each new device is `pending` (`dev_…`). An admin confirms it with a name and a
   station. The Portal asks the admin to check the serial number. A confirm sends nothing
   to the gateway, so no machine moves.
5. A confirmed device is `active`. Only a Plan 24 bake run or the Register gives it work.

A later `hello` with other capabilities starts a new revision. The list hides a pending
gateway after one day and a revoked row after seven days, unless its result is unknown.

### The four facts and readiness

A row keeps four facts apart. A pause is a separate flag (`paused`, `pauseConfirmed`).

| Fact | Values | Source |
| --- | --- | --- |
| Enrollment | `pending`, `active`, `restricted`, `revoked` | `device_enrollment.state` |
| Connection | `connected`, `quiet`, `offline`, `unknown`, `closed`, `never_connected`, `managed_by_provider` | The receipt time of the gateway's last message, and its open socket |
| Health | `ok`, `warning`, `fault`, `not_reported` | The device, through its gateway |
| Work | `idle`, `reserved`, `running`, `result_unknown` | The Plan 24 reserve and the gateway's cobot reports |

A gateway is `quiet` when its socket is closed or it is silent for more than 90 s, and
`offline` after 180 s. A device has its gateway's connection. It is `unknown` behind a
quiet or offline gateway, and `closed` when revoked. A Square terminal is
`managed_by_provider`. When nothing blocks it, its row says "Managed by Square".

`deviceReadiness` (`services/platform/src/devices/readiness.ts`) gives the one answer:

1. Blocked, in this order: work `result_unknown`; enrollment `revoked`, `pending` or
   `restricted`; a connection that is not `connected` (`connection_lost`); health
   `fault`; a pause. A `warning` does not block.
2. Work `reserved` or `running`: `busy`, with `taskRef` and `runRef`.
3. Otherwise `ready`. A camera or a device with no capabilities is `not_applicable`.

The Plan 24 reserve (`reserveDeviceWork` in `devices/work.ts`) reads the same answer, so
the page and dispatch cannot disagree. Telemetry can block work, but it cannot complete a
task. A row needs attention when a kitchen device is blocked (not revoked), an active
gateway is not connected or is below `DEVICE_GATEWAY_MINIMUM_VERSION` (`0.1.0`), a menu
screen or an enrolled shop Mac is not connected, or a payment terminal is blocked or has
a Square problem.

### Observability and alerts

| Signal | From | Stored in | Kept for |
| --- | --- | --- | --- |
| Heartbeat | Gateway, every 30 s | The socket attachment, and `device_gateway.last_heard_at` at most every 5 minutes | Latest value |
| Connection change | `DeviceFleetActor` | `gateway_presence` (Actor SQLite) and a `device_event` row | 90 days |
| Health change, fault | Device, through its gateway | `device_enrollment` and a `device_event` row, only on a change | 90 days |
| Samples | Gateway, every 60 s | `device_sample` (Actor SQLite), one value per measure per minute | 7 days |
| Person and agent commands | Platform | A `device_event` row; its `event_id` is the receipt id | 90 days |
| Snapshot images | Camera, through its gateway | R2 `ARCHIVE` and `device_snapshot` | 7 days |

| Alert kind | Opens when | Slack card |
| --- | --- | --- |
| `task_connection_lost` | A gateway is quiet or offline, and a device behind it has a reserved or running task | At once |
| `task_device_fault` | A device with a reserved or running task reports a fault | At once |
| `task_result_unknown` | A task result becomes unknown: an `indeterminate` report, a lost socket, or a revoke during a task | At once |
| `gateway_offline` | A gateway is offline, in shop hours, and silent for the offline delay | After the delay: 5 minutes, or 1 to 120. The alert also needs `offline` (180 s), so a delay below 3 minutes acts as 3 minutes |

- One subject has at most one open alert of each kind. One incident makes one Slack card,
  and its end updates that card. The card has its text and an **Open Devices** link
  (`slack/device-alert-card.ts`). The alert card controls no device. The Plan 24 bake
  run card has a **Pause** button, which reaches `runDeviceCommand`.
- `deliverOperationsCard` sends the card to the operations Slack channel through the
  Connector, which keeps the receipt. No agent turn takes part. A send that fails in the
  Actor alarm goes again after 60 s. A send that fails in a route command (revoke,
  settle) waits for the next alarm of that Actor, at most one day. With no operations
  channel, or when the incident ends first, no card goes.
- An admin sets the time zone, the shop hours and the offline delay (**Alert times**).
  With no alert times, all hours are shop hours. Platform errors go to `traceWarn`.

### Cameras

- Snapshots are off for each Organisation until an admin turns them on
  (`device_camera_policy`). A camera sends one still JPEG on a fault or when a person
  asks. Pantry keeps no live or recorded video. Reads of an image stop after 7 days. The
  daily upkeep of the Actor deletes the image, so it can stay about 8 days, and only
  while that Actor knows a gateway.
- A new fault on a device asks each active camera at the same station, behind a gateway
  of the same location. The gateway uploads the image within 2 minutes, for its own
  camera only. Pantry refuses an image above 1 MiB or an image that is not a JPEG.
- An admin or an owner sees snapshots. An operator needs a grant on `device.camera.read`.

### Agents

The tools are in `services/platform/src/agent-tools/devices/`. A turn offers a tool when
it holds the capability. No image reaches a model.

| Tool | Capability | Effect | What it does |
| --- | --- | --- | --- |
| `device_read` | `device.read` | Read | Gateways, kitchen devices and shop Macs, as the page shows them. Fault text (`deviceSaid`) only when the person who asked is an operator or higher. No Mac network address |
| `device_snapshot_read` | `device.camera.read` | Read | The time and reason of each snapshot, with no image. The person who asked must be an operator or higher |
| `device_pause` | `device.pause` | Receipt | Stops new work on one device and asks its gateway to pause. The person who asked must be an operator or higher |
| `device_propose` | `device.read` | Proposal | Stages a restriction or a resume as a `device_command` configuration draft. The person who asked must be an operator or higher, and confirms it on a card in the chat |

## Contracts

- Regional D1 (`services/platform/migrations-regional/0001_current_schema.sql`):
  `device_gateway`, `device_enrollment`, `device_event`, `device_alert`,
  `device_alert_setting`, `device_camera_policy` and `device_snapshot`.
- `DeviceFleetActor` (`services/platform/src/actors/device-fleet.ts`): one for each
  Organisation and location, named `device_fleet:<organisationId>:<locationId>` and
  placed with the Organisation (`devices/contract/fleet-stub.ts`). Its SQLite tables
  (`device-fleet-schema.ts`) are `device_fleet_scope`, `gateway_presence`,
  `device_sample`, `fleet_upkeep` and `device_command`. Plans 90 and 24 add task tables.
- TypeBox contracts in `packages/control-api/src/`: `devices.ts` (page views),
  `device-gateway.ts` (the protocol), `device-cobot.ts` (Plan 24), `device-shapes.ts`.
- The gateway: `crates/shop-gateway` (Rust, for macOS on Apple silicon and ARM and x86
  Linux) and `services/shop-gateway/README.md`. A production Platform upload refuses a
  Portal build without the three builds (`check-pack.mjs`).
- The gateway protocol (`device-gateway.ts`) has no shell, no file transfer and no raw
  motion command. This area owns `hello`, `heartbeat`, `health`, `samples` and `ack`
  from the gateway, and `welcome`, `pause`, `resume`, `snapshot` and `refused` to it.
  Plan 90 owns the `terminal_*`, `printer_result`, `receipt_print` and `cash_drawer_kick`
  messages. Plan 24 owns the `cobot_*` messages and `stop`.
- A message is at most 64 KiB, and a `hello` lists at most 64 devices. A message that
  fails the parse closes the socket (1008). A report about a key that the gateway does
  not hold gets `refused`. A newer socket closes the older one (4001). A revoke closes it
  with 4403, and the gateway stops. The Actor closes a socket that is silent for 180 s.
- The gateway routes (`devices/gateway-routes.ts`): `POST /v1/device-gateways/enroll`
  exchanges the code. The credential works only on `GET /v1/device-gateways/socket` and
  `POST /v1/device-gateways/snapshots/:id`.

The control routes (`services/platform/src/control/routes/devices.ts`) are under
`/v1/control/organisations/:id/devices`:

| Route | Role | Purpose |
| --- | --- | --- |
| `GET` | Viewer | The list of all kinds |
| `GET`, `PUT` `/alert-settings` | Viewer, admin | Read or change shop hours and the offline delay |
| `POST /gateways` | Admin | Start an enrollment: the code and the install command |
| `PUT /camera-policy` | Admin | Turn snapshots on or off |
| `POST /:id/snapshot`, `GET /:id/snapshots`, `GET /snapshots/:snapshotId` | Operator with snapshot access | Ask for, list and read images |
| `GET /:id/activity` | Operator | The newest 50 events and 30 samples |
| `POST /:id/:command` | The role of the command | `confirm`, `rename`, `move`, `restrict`, `lift`, `pause`, `resume`, `settle`, `revoke` |

`runDeviceCommand` (`devices/commands.ts`) is the one command path for the control
routes, the agent tools, the configuration drafts (the `deviceCommands` port) and the
Plan 24 bake runs. The control route checks the role in `DEVICE_COMMAND_ROLE`. The agent
tools and the drafts check `roleMayOperate`. A bake run uses no role map. The same `Idempotency-Key` gives the same receipt. The
capabilities `device.read`, `device.pause` and `device.camera.read` are in
`services/platform/src/authorization/capability-catalogue.ts`. An agent can ask for each
in the permission prompt. Each needs `scripts/capability-policy-backfill-sql.mjs`. An
agent read enters the turn under the `device_fleet` information-flow source label.

## Rules and limits

| Action | Viewer | Operator | Admin and owner | Agent |
| --- | --- | --- | --- | --- |
| See the list, readiness and last heard | Yes | Yes | Yes | `device_read` |
| See activity and a device's fault text | No | Yes | Yes | Fault text if the person who asked is an operator |
| See a Mac's private address | No | No | Yes | No |
| Rename a gateway or a device | No | Yes | Yes | No |
| Request a pause | No | Yes | Yes | `device_pause`, with a receipt |
| Resume after a pause | No | Yes, with a confirmation | Yes, with a confirmation | Proposal only |
| Restrict a device, with a reason | No | Yes | Yes | Proposal only |
| Mark an unknown task result as checked (`settle`) | No | Yes | Yes | No |
| Confirm or move a device, lift a restriction | No | No | Yes | No |
| Start a gateway enrollment | No | No | Yes | No |
| Revoke a gateway or a device | No | No | Yes, with a confirmation | No |
| Set alert times, turn snapshots on or off | No | No | Yes | No |
| Ask for and see a camera snapshot | No | With a `device.camera.read` grant | Yes | Time and reason only |
| Raw motion, safety functions, emergency stop | No | No | No | No |

| Time limit | Value | Constant |
| --- | --- | --- |
| One-time code | 15 minutes | `DEVICE_GATEWAY_CODE_TTL_MS` |
| Quiet, offline | 90 s, 180 s | `DEVICE_CONNECTION_QUIET_MS`, `DEVICE_CONNECTION_OFFLINE_MS` |
| D1 summary of the last heard time | 5 minutes | `SUMMARY_INTERVAL_MS` |
| Event, sample, snapshot retention | 90, 7, 7 days | `DEVICE_EVENT_RETENTION_MS`, `SAMPLE_RETENTION_MS`, `SNAPSHOT_RETENTION_MS` |
| Settled pause and resume commands | 7 days | `SETTLED_RETENTION_MS` |

The Actor deletes old rows one time a day. While it knows a gateway, its alarm wakes it
at least one time a day for this work. A heartbeat writes only the 5-minute D1 summary.

- **Device text is untrusted.** `devices/store.ts` removes control characters from the
  names, models, labels and fault text that a gateway sends. Sample names and units go
  into Actor SQLite as sent. A fault code is at most 16 characters (`A-Z`, `0-9`, `_`,
  `-`), and a fault text 500. The page shows fault text in quotation marks, and a viewer
  never reads it. `device_read` marks the name, the model and `deviceSaid`
  as untrusted. `device_propose` tells the agent to act only when a person asks.
- **Revocation.** A revoke of a gateway also revokes its devices. A reserved or running
  task becomes `result_unknown`. The revoke clears the credential hash, so each new
  connection is refused. Pantry asks the Actor to close the socket at once. If that call
  fails, the socket closes at its next D1 summary (every 5 minutes).
- **End of an Organisation.** The archive cleanup revokes each gateway and its devices
  (`revokeOrganisationDevicesStatements` in `devices/store.ts`). `devices/purge.ts`
  erases each fleet Actor and deletes each snapshot image.
- **Plan 24** owns cobot dispatch and receipts. It meets Devices in
  `services/platform/src/actors/bake-run-ports.ts`: the reserve, the Work fact, the
  pause, resume and settle commands for a run's cobots, and the dispatch ledger
  (`device-fleet-cobot.ts`). The Actor forwards reports, clocks, faults, lost sockets and
  revokes to the run. For an unknown result, it sends `cobot_inquire`, not the task.
- **Plan 90** owns the counter receipt printer and the LAN payment terminal. The Register
  prints on the first active `receipt_printer` that an admin confirmed, behind an active
  gateway of its location (`#boundPrinter` in `actors/device-fleet.ts`).
  `actors/device-fleet-printer.ts` keeps the print jobs. The Register does not read
  `deviceReadiness`: a paused or faulted printer still prints. A pause stops only Plan 24
  dispatch.
- Menu screens (Plan 40B), shop Macs (Plans 82 and 82C) and Square terminals keep their
  records and pages. The Devices page only reads them.
- **Out of scope:** firmware updates; a VPN, private DNS and network rules for each
  device; live or recorded video and loss prevention; fleet optimization across sites.
  Repair access uses Cloudflare Tunnel with Access, not the Portal
  ([runbook](../../../runbooks/shop-gateway-repair-access.md)).

## Open work

- The gateway has no camera adapter: only a `--simulate` file sends an image. It has
  adapters for cobots, the oven and the receipt printer. Its LAN payment terminal
  adapter is a simulation. For another device, it answers a pause with `done` only.
- Only a `--simulate` file sends samples. No real adapter reports them.
- Only `station_bakery` and `station_bar` exist. A location is a name of at most 64
  letters, digits, spaces, `_` and `-`, with no location table.
- The drawer names the run with no link, and the `task_result_unknown` card links only
  to the Devices page. The drawer lists the samples with no chart.
- The role dialog sends no request. Pantry has no record for a request to change a role.
- Roles are Organisation roles. Grants for one location (Plan 85 D8) are not built.

## Sources

- [Plan 85](../../../history/plan-85-device-fleet-page.md). Where it differs from the code, this
  spec follows the code. Its evidence in the archive:
  [Phase 1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-85-phase-1.md),
  [Phases 2 to 4](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-85-phases-2-4.md),
  [Phase 5](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-85-phase-5.md).
  The boundaries: [Plan 24](../../../plan-24-cafeos-bakery-automation.md) and
  [Plan 90](../../../plan-90-cafe-pos-checkout.md).
- E2E journeys in `services/platform/tests/e2e/`: `devices-page.test.ts`,
  `device-fleet.test.ts`, `device-agent.test.ts`, `device-fleet-camera.test.ts`,
  `device-commands.test.ts` and `device-fleet-end.test.ts`.
