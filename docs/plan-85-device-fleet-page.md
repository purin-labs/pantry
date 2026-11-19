# Plan 85 — Devices page for Satyr Kitchen

Status: Phases 1 to 5 are live in production since 3 November 2026. Phase 5 stays off for each
Organisation until an admin turns it on, which keeps D5's default of no cameras. Date: 3 November 2026.
Owners: Satyr platform and Portal. Evidence: [Phase 1](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-85-phase-1.md),
[Phases 2 to 4](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-85-phases-2-4.md), [Phase 5](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-85-phase-5.md).

## Release of Phases 2 to 5

Released 3 November 2026 at 01:21 UTC, on the owner's word. Each regional database took
`plan-85-devices-d1-patch.sql`, `plan-85-camera-d1-patch.sql` and the capability backfill first. The
[Phase 5 evidence](https://github.com/seams-tech/pantry-history/blob/2cf5676a714978ce2887a78523b1b0f6c87a53a8/docs/evidence/plan-85-phase-5.md) holds the production journey and what it did not cover.
A later release needs none of these steps again. A new schema change needs its own patch file.

An upload of the Platform alone at 02:24 UTC the same day left out the gateway builds, because only the
full deploy script runs `services/shop-gateway/build.sh`. Its installer stopped on every computer with
"This Satyr release has no gateway build". Since then a production Platform upload refuses a Portal build
without the three builds and their digests (`services/shop-gateway/check-pack.mjs`).
A release at 02:56 UTC restored the installer, and each served build matches its digest.

## What differs from the first design

- Rows of the three existing kinds group by kind, because a screen and a Mac have no station.
- A found device can stand only at `station_bakery` or `station_bar`, the ids that exist today. A
  station table waits for a device that needs another station.
- Plan 24 has no physical runs yet, so `devices/work.ts` holds only the reservation that dispatch
  will call, and the drawer names the run with no link. A pause applies to one device, not a run.
- A person who lacks a role sees a dialog in place that names the role and who can change it.
  Satyr has no record for a request by one person to change a person's role, so this dialog sends
  nothing. The agent's prompt does use the permission modal.
- An alert is one Connector delivery, named by its incident, as the paid placement receipt is. No
  agent turn takes part, so the Connector holds its receipts and no Case does.
- An agent reads only when a camera took an image, and why. The image stays in the Portal, so it never
  reaches a model. The access table's agent grant covers this smaller read.
- A snapshot asks only the cameras that the same fleet Actor holds at the fault's station. A camera at
  another location takes no image for that fault.
- A restriction or a resume that an agent proposes uses the existing draft card. Its confirmation
  accepts an operator, and a setup change still needs an admin.
- A revoke of a gateway also revokes its devices, because no device can report without it.

This plan builds on [Plan 24](plan-24-cafeos-bakery-automation.md),
[Plan 40B](plan-40B-collaborative-menu-editor.md),
[Plan 81](plan-81-agent-portal-control.md) and
[Plan 82](plan-82-portal-voice-control.md). Plan 24 keeps physical dispatch and receipt
reconciliation. This plan owns the device list, enrollment, health and device access.
The public name is Satyr Kitchen. Code identifiers keep `bakery`.

## Outcome and scope

An operator opens one page and sees every device in the shop. For each device, the page
answers one question: **can this device take the next task, and if not, why not?** The
operator can add a device, read its recent activity, pause work, and remove its access.
Each of these actions has a permission check and a receipt.

In scope:

- One list of screens, shop Macs, payment terminals, gateways and devices behind a gateway.
- Enrollment of a gateway and of each device behind it.
- Health, activity, alerts and bounded telemetry.
- Device permissions for people and agents.
- A gateway simulator, so that all of this works before the shop buys hardware.

Out of scope:

- Physical dispatch, physical runs and receipts. Plan 24 owns them.
- Raw motion commands, safety functions and emergency stop. These stay on the machine.
- Firmware updates. Plan 24 excludes the replacement of device firmware.
- A VPN, private DNS for gateways, and per-device network rules. The gateway dials out.
- Live video, recording, access control and loss prevention.
- Multi-site fleet optimization.

## Facts from the code

### Satyr already has three kinds of device, on three separate pages

| Device | Where it is stored | Enrollment | Health that exists | Who can read it | Who can manage it |
| --- | --- | --- | --- | --- | --- |
| Menu screen | `menu_screen` in `OrganisationDO` SQLite, with `screen_pairing` in global D1 | Six-letter code on the TV | WebSocket state and `last_seen_at` | Viewer | Operator |
| Shop Mac | `voice_mac` in regional D1 | Install command with a 15-minute one-time code | Heartbeat, version, model state, private address | Admin | Admin |
| Square Terminal | `cafe_terminal_assignment` in regional D1 | Square device code | No heartbeat. The panel does not treat a quiet device as blocked | Viewer | Admin |

Plan 82's Mac path is the nearest model for a gateway. The credential is limited to its own
routes, only its hash is stored, and the Platform never calls the Mac.

### Robots and appliances have no runtime

Plan 24 states that the repository has no physical robot controller or fleet runtime. No
device enrollment table exists. Its lifecycle is defined only in the plan text: `pending`,
`active`, `restricted` and `revoked`.

### Locations and stations are partial

`satyr_location_id` exists on terminal assignments. The commerce engine's café scenario
(`services/commerce/src/plugins/food-service/cafe-scenario.ts`) holds the fixed
stations `station_bakery` and `station_bar`, and the order queue uses station ids. No general
site or station table exists. This plan uses those existing ids first. It adds a station
table only if a device needs a station that the existing ids do not hold.

### What the Tailscale dashboard maps to

| Tailscale tab | Satyr |
| --- | --- |
| Machines | Devices list (this plan) |
| Apps and Services | Device capabilities (this plan) |
| Users | Existing Organisation members |
| Access Controls | Existing capabilities, roles and permission modal, with new device capabilities |
| Logs | Activity in the device drawer (this plan) |
| DNS | Not needed. Plan 82's Mac names stay as they are |
| Settings | Alert times for each Organisation (this plan) |

Tailscale has no equivalent of current work, readiness, approvals or receipts.

## 1. The page

The page follows the Portal layout rule: one quiet list, with details in a side drawer.

- **Top line:** one sentence, such as "14 devices. 11 ready, 2 busy, 1 needs attention."
- **Controls:** search, a **Needs attention** filter, and filters for kind and location.
- **List:** rows grouped by location and station.
- **Columns:** name and kind, station, readiness with its reason, current work, last heard.

The drawer shows:

- **Overview:** readiness, enrollment state, connection, version, gateway and model.
- **Capabilities:** the typed tasks that this device can accept, with their revision.
- **Current work:** a link to the run in the canvas, the timeline and the 3D view.
- **Activity:** state changes, faults and human actions, newest first.
- **Actions:** the actions for this device. An action that the person cannot use raises the
  permission modal in place, and the person does not go to the Access page.

The drawer always says: "Emergency stop stays on the machine." It has no motion controls.

### Four separate facts

A device row must not merge these facts into one status:

| Fact | Values | Source |
| --- | --- | --- |
| Enrollment: may it take work? | `pending`, `active`, `restricted`, `revoked` | Platform record |
| Connection: can we hear it? | `never_connected`, `connected`, `quiet`, `offline`, `unknown` | Time of the last message that the Platform received |
| Health: what does it report? | `ok`, `warning`, `fault`, `not_reported` | Device, through its gateway |
| Work: what is it doing? | `idle`, `reserved`, `running`, `result_unknown` | Plan 24 task records |

The Platform computes **readiness** from these four facts in one function. Plan 24 dispatch
calls the same function, so the page and dispatch cannot disagree.

```ts
type DeviceReadiness =
  | {
      kind: "ready";
    }
  | {
      kind: "busy";
      runId: string;
      taskId: string;
    }
  | {
      kind: "blocked";
      reason: DeviceBlockedReason;
      since: number;
    }
  | {
      kind: "not_applicable";
    };
```

Rules that come from Plan 24:

- A device behind an offline gateway shows `unknown`, not `offline`. Satyr only knows that it
  cannot hear the device.
- An unknown task result stays `result_unknown`. The page offers no retry.
- Telemetry is evidence, not authority. A health report cannot complete a task.
- A camera and a device with no capabilities show `not_applicable`, because they take no tasks.

## 2. Enrollment

1. An admin selects **Add gateway** and chooses a location.
2. The Portal shows one install command with a one-time code that lasts 15 minutes.
3. The gateway exchanges the code for a credential. The Platform stores only its hash.
4. The gateway opens an outbound WebSocket and lists the devices that it finds.
5. A person confirms each device: name, station, model and capability set.
6. The device becomes `active`. Satyr still sends it no task until Plan 24 allows that.

A found device never becomes active by itself. Verification must not move a machine. A lamp
or a code on the device's own display is acceptable. Otherwise, the person confirms the
serial number.

A gateway credential can do only four things: report its own devices, send a heartbeat, send
observations, and read the tasks that Plan 24 gives it. The Platform refuses a report about a
device that belongs to another gateway.

Only Plan 24's operations cross this boundary: read health, reserve, submit a bounded task,
request a pause and read a receipt. The protocol has no shell, no file transfer and no raw
motion command.

## 3. Observability

| Signal | From | Stored in | Kept for | Used by |
| --- | --- | --- | --- | --- |
| Heartbeat | Gateway, one batched message every 30 s | Actor memory, with a D1 summary every 5 minutes | Latest value only | Connection state |
| State change | Platform and gateway | Regional D1 | 90 days | Activity, alerts |
| Fault | Device, through its gateway | Regional D1, linked to the Case when a run is active | 90 days | Activity, alerts, Plan 24 |
| Samples such as temperature or load | Device, one a minute | Actor SQLite | 7 days | Drawer chart, shadow comparison |
| Human and agent actions | Platform | Existing action ledger and receipts | Same as other receipts | Audit |
| Task receipts | Plan 24 | Plan 24 records | Plan 24 rule | Evidence |
| Platform errors | Worker | Workers Logs through `traceWarn` | Workers Logs limit | Engineers |

Time limits:

- Connection is `quiet` after 90 s with no message, and `offline` after 3 minutes. Plan 82
  already uses 3 minutes for a fresh Mac.
- A device is not ready for new work when its connection is `quiet` or worse.
- Last heard uses the Platform's receipt time. The device's own time is kept only as a report.

Alerts:

| Event | Action |
| --- | --- |
| A device with an assigned task goes `quiet` or reports a fault | Slack card at once, and the Needs attention filter |
| A gateway goes `offline` during shop hours with no task | Slack card after 5 minutes |
| A device is offline outside shop hours | Needs attention filter only |
| A task result is unknown | Slack card at once, with a link to the run |
| A gateway version is below the supported version | Needs attention filter only |

One incident makes one Slack card. A reconnect updates the same card. The alert path uses the
existing Case and Connector receipt model. No Slack message controls a device directly.

## 4. Access permissions

| Action | Viewer | Operator | Admin and owner | Agent |
| --- | --- | --- | --- | --- |
| See the list, readiness and last heard | Yes | Yes | Yes | With `device.read` |
| See activity and fault text | No | Yes | Yes | With `device.read` |
| See a Mac's private address | No | No | Yes | No |
| Rename a device | No | Yes | Yes | No |
| Request a workflow pause | No | Yes | Yes | With `device.pause`, and a receipt |
| Resume after a pause | No | Yes, with a confirmation | Yes, with a confirmation | Proposal only |
| Restrict a device | No | Yes | Yes | Proposal only |
| Lift a restriction | No | No | Yes | No |
| Move a device to another station | No | No | Yes | No |
| Enroll a gateway or a device | No | No | Yes | No |
| Revoke a gateway or a device | No | No | Yes, with a confirmation | No |
| See a camera snapshot (phase 5) | No | With a grant | Yes | With a grant, and an information-flow label |
| Raw motion, safety functions, emergency stop | No | No | No | No |

The rule is simple. An action that stops work is easy. An action that starts work, widens
access or changes a mapping needs more authority.

Other rules:

- **Same list, same rules.** The combined list must not widen existing access. A viewer still
  cannot read a Mac's private address, so the route leaves that field out.
- **Revocation is immediate.** Revoke closes the socket, refuses the credential and blocks new
  tasks within 5 s. A task that was in flight becomes `result_unknown`.
- **New capabilities:** `device.read`, `device.pause` and `device.camera.read`. Each one goes
  in the capability catalogue, can be requested through the permission modal, and needs
  `scripts/capability-policy-backfill-sql.mjs`.
- **Device text is untrusted.** A device name, a fault message or a log line can reach a model.
  It enters through the information-flow boundary as data, never as an instruction. Run
  `pnpm lint:ifc-boundaries` and one allowed and one denied journey for each new source.
- **Agents use the Plan 81 path:** the person's own checks, approvals and receipts.

## 5. Costs for one shop

The reference shop has one gateway and 20 devices. Prices are the Cloudflare list prices that
I read on 3 November 2026. The sums ignore the included allowances, so they are upper limits.

| Item | Sum | Cost per month |
| --- | --- | --- |
| Heartbeats | 86,400 messages, billed at 20:1 as 4,320 requests | Below $0.01 |
| Actor awake all month, the worst case | 2,592,000 s × 0.125 GB = 324,000 GB-s at $12.50 per million | $4.05 |
| Samples, one a minute | 864,000 rows at $1.00 per million | $0.86 |
| Samples, every 10 s, the rejected rate | 5,184,000 rows at $1.00 per million | $5.18 |
| D1 gateway summary, every 5 minutes | 8,640 rows at $1.00 per million | $0.01 |

The recommended design costs at most about **$5 per shop a month**. Hibernation should remove
most of the actor time. The real figure is not measured, and Phase 3 measures it.

## 6. Phases, costs and acceptance

Times are estimates in agent days.

| Phase | Result for the operator | Agent days | Gate |
| --- | --- | --- | --- |
| 0. Mock | Clickable mock of the list and the drawer in light and dark themes | 0.5 | The owner chooses a layout |
| 1. One list | The page shows existing screens, Macs and terminals. Rows link to their current pages | 3 | J1 |
| 2. Enrollment | Gateway protocol, simulator, enrollment records, confirm, restrict, revoke | 6–8 | J2, J4 |
| 3. Observability | Readiness, activity, samples, alerts and Slack cards | 4–5 | J3, cost measure |
| 4. Agents | `device_read`, `device_pause` and restrict proposals through Plan 81 | 2–3 | J5 |
| 5. Cameras (optional) | Snapshot on a fault or on request, off until an admin turns it on | 2–3 | J6. An admin checks the privacy duty before the switch |

The total is 15–20 agent days, or 18–23 with cameras. Phase 1 is useful alone and needs no new
table. Phase 2 gives Plan 24 B1 its enrollment record. Phase 3 gives Plan 24 B2 its observation
path.

### E2E acceptance journeys

Each journey produces a repeatable artifact in `docs/evidence/plan-85-*`. The simulator is a
separate process that speaks the real protocol. It may only report and answer. Product code
must produce each asserted outcome.

- **J1 — One list.** An Organisation has a screen, a Mac and a terminal. All three show in one
  list. A viewer sees no actions and no private address. A second Organisation sees nothing.
- **J2 — Enrollment.** A simulated gateway enrolls with its code. An expired code and a used
  code are refused. A found device stays `pending` until a person confirms it. A report about
  another gateway's device is refused.
- **J3 — A fault during a task.** The gateway drops while a device has a reserved task. The row
  shows `unknown`, readiness blocks new work, the operator gets one Slack card, and the
  reconnect updates that card. The 3D view shows no invented movement.
- **J4 — Revoke.** An admin revokes a gateway. The socket closes within 5 s, its credential is
  refused and a new task is refused. An operator who tries this gets the permission modal.
- **J5 — Agent.** A person asks in chat if the oven is ready. The agent raises the permission
  modal and then answers from `device_read`. A fault message that holds instructions stays
  data. The agent cannot revoke a device.

One real journey runs before a release: the gateway on a real Mac against production, with
simulated devices behind it. It needs one command from the owner. It does not need purchased
hardware.

### Risks

- A list of many kinds can become a weak summary of other pages. Phase 1 therefore links to
  the existing pages, and it does not copy their controls.
- Square Terminal has no heartbeat in Satyr, so its row shows less than the others. The row
  says "Managed by Square". It must not show a false connected state.
- A stolen gateway has a valid credential until a person revokes it. The credential has a
  narrow scope, and Plan 24's exact-revision checks stay in place.

## Decisions

The cost column states what the recommendation costs beyond the phase, or what it gives up.

| ID | Decision | Recommendation | Cost | Default |
| --- | --- | --- | --- | --- |
| D1 | First release | Show the three existing device kinds first, before any robot work | About 3 agent days. The page has no robots until Phase 2 | Recommendation |
| D2 | Place in the Portal | **Devices** in the Satyr Kitchen navigation group. Screens and terminals stay managed on their current pages | A menu screen shows under a kitchen heading | Recommendation |
| D3 | Connection home | A new `DeviceFleetActor` for each Organisation and location, with hibernating WebSockets, so that telemetry does not load `OrganisationDO` | One more Durable Object class and one more migration | Recommendation |
| D4 | Engineer repair access | Build none in the Portal. When the first real gateway is installed, use Cloudflare Tunnel with Access for SSH, by the [repair access runbook](runbooks/shop-gateway-repair-access.md). Tailscale is the alternative if direct manual control is needed later | About 30 minutes for each gateway. Tunnel has no charge, and Access has no charge below 50 users (checked 3 November 2026) | Recommendation |
| D5 | Cameras | Keep Phase 5 optional: snapshots on a fault or on request, 7 days, no live video and no recording. Four cameras at one 200 KB image a minute for 12 h a day cost about $0.45 a month, and on-demand use costs less. Staff images are personal data, so check the privacy duty first | An operator cannot watch motion remotely | No cameras |
| D6 | Telemetry rate and retention | One sample a minute for 7 days, and state changes for 90 days | No fine-grained motion history. A rate of one every 10 s adds about $4.30 a month for each shop | Recommendation |
| D7 | Agent authority | Agents read and pause. They propose a restriction or a resume. They never enroll, move, lift a restriction or revoke | A person must act in a fault | Recommendation |
| D8 | Location-level roles | Use Organisation roles now. Add location grants when a second shop exists | All admins can act on all shops | Organisation roles |
| D9 | Gateway language | Rust: one binary for ARM Linux and macOS, with no runtime to install. Python is about 1–2 agent days cheaper, as with the shop Mac service, but it needs a managed runtime on each gateway | About 1–2 agent days | Rust |

## Effect on other plans

- **Plan 24:** B1 uses this plan's enrollment record. Its credential reference should name the
  gateway credential, because the Platform does not connect to a device. Its non-goal on cameras
  stays, and D5 adds only production evidence. Update Plan 24 when Phase 2 starts.
- **Plan 40B and Plan 82:** Their records and pages stay. This plan only reads them.
- **Plan 81:** It gains the device tools in Phase 4.
- **Plan 42:** Its views link to and from a device by the same identity.
