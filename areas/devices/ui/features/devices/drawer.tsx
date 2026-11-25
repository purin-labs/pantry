import React from "react";
import { Link } from "react-router";
import {
  DEVICE_STATIONS,
  VOICE_ENGINES,
  type DeviceActivity,
  type DeviceView,
  type KitchenDeviceView,
} from "@purin-labs/control-api";
import { assertNever } from "@purin-labs/std";

import {
  Button,
  ConfirmInPlace,
  SideDrawer,
  useLatestRead,
  useMutation,
  type ConfirmInPlaceProps,
} from "@purin-labs/ui/index";
import { Select } from "@purin-labs/ui/select";
import {
  readDeviceActivity,
  readDeviceSnapshots,
  sendDeviceCommand,
  snapshotImagePath,
  takeDeviceSnapshot,
  writeSnapshotsEnabled,
  type SnapshotRead,
} from "./requests";
import {
  credentialLabel,
  currentWork,
  dateTime,
  hardwareLabel,
  kindLabel,
  kitchenAnswer,
  lastHeard,
  modelLabel,
  stationLabel,
  deviceStatus,
} from "./status";
import type { DevicePagePaths, MemberRole } from "./route";

/**
 * A device's facts and actions, in a side drawer beside the list. From the
 * top: the state, the one action that the state asks for, the facts, the
 * name and station, the activity, and access (restrict and revoke).
 */

const ROLE_RANK: Readonly<Record<MemberRole, number>> = {
  viewer: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};

type NeededRole = "operator" | "admin";

type Command = Readonly<{
  command: string;
  body: Readonly<Record<string, unknown>>;
}>;

type DrawerProps = Readonly<{
  device: DeviceView | null;
  organisationId: string;
  role: MemberRole;
  snapshotsEnabled: boolean;
  pagePaths: DevicePagePaths;
  close: () => void;
  changed: (message: string) => void;
  askRole: (action: string, need: NeededRole) => void;
}>;

/** What the parts of the drawer need to send a command for one device. */
type DeviceTools = Readonly<{
  device: DeviceView;
  busy: boolean;
  /** Runs `then` if the person has the role, or names the role it needs. */
  gate: (action: string, need: NeededRole, then: () => void) => () => void;
  allowed: (need: NeededRole) => boolean;
  /** Sends one command. It is true when the command saved. */
  send: (
    command: string,
    body: Readonly<Record<string, unknown>>,
  ) => Promise<boolean>;
  changed: (message: string) => void;
}>;

export function DeviceDrawer(props: DrawerProps): React.ReactNode {
  const { device } = props;
  return (
    <SideDrawer
      open={device !== null}
      title={device?.name ?? ""}
      close={props.close}
      className="devices-drawer"
    >
      {device === null ? null : (
        <DrawerBody key={device.deviceId} {...props} device={device} />
      )}
    </SideDrawer>
  );
}

function DrawerBody(
  props: DrawerProps & Readonly<{ device: DeviceView }>,
): React.ReactNode {
  const { device, organisationId, role } = props;
  // One command for this device at a time.
  const command = useMutation((sent: Command, idempotencyKey: string) =>
    sendDeviceCommand(
      organisationId,
      device.deviceId,
      sent.command,
      sent.body,
      idempotencyKey,
    ),
  );
  const sending = command.state(device.deviceId);
  const allowed = (need: NeededRole): boolean =>
    ROLE_RANK[role] >= ROLE_RANK[need];
  const tools: DeviceTools = {
    device,
    busy: sending.kind === "running",
    allowed,
    gate: (action, need, then) => () => {
      if (allowed(need)) then();
      else props.askRole(action, need);
    },
    send: async (name, body) =>
      (await command.run(device.deviceId, { command: name, body })).kind ===
      "done",
    changed: props.changed,
  };
  const managed = device.kind === "gateway" || device.kind === "kitchen_device";
  const enrolled = managed && device.enrollment !== "revoked";
  const pending =
    device.kind === "kitchen_device" && device.enrollment === "pending";
  const work = currentWork(device);
  return (
    <div className="side-drawer-body devices-drawer-body">
      <p className="devices-drawer-kind">{subtitle(device)}</p>
      <div className="devices-answer">
        <StatusLine device={device} />
        {device.kind === "kitchen_device" ? (
          <p>{kitchenAnswer(device)}</p>
        ) : null}
        {work === "" ? null : <p>Current work: {work}</p>}
      </div>
      {device.kind === "kitchen_device" ? (
        <MainAction tools={tools} device={device} />
      ) : null}
      {sending.kind === "failed" ? (
        <p className="error-text" role="alert">
          The change did not save. Read the device again and try again.
        </p>
      ) : null}
      <dl className="devices-facts">
        {deviceFacts(device).map((fact) => (
          <div key={fact.term}>
            <dt>{fact.term}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
      {enrolled && !pending ? (
        <EditForm
          key={`${device.name}:${stationOf(device) ?? ""}`}
          tools={tools}
        />
      ) : null}
      {device.kind === "kitchen_device" && device.hardware === "camera" ? (
        <CameraSnapshots
          deviceId={device.deviceId}
          organisationId={organisationId}
          enabled={props.snapshotsEnabled}
          tools={tools}
          askRole={props.askRole}
        />
      ) : null}
      {!managed ? (
        <ManageLink device={device} pagePaths={props.pagePaths} />
      ) : allowed("operator") ? (
        <ActivityList
          organisationId={organisationId}
          subjectId={device.deviceId}
          refreshKey={JSON.stringify(device)}
        />
      ) : (
        <section className="devices-section">
          <h3>Activity</h3>
          <Button
            variant="link"
            onClick={() => props.askRole("read activity", "operator")}
          >
            Ask for access to activity
          </Button>
        </section>
      )}
      {enrolled ? <AccessSection tools={tools} /> : null}
      {managed ? (
        <p className="devices-safety">Emergency stop stays on the machine.</p>
      ) : null}
    </div>
  );
}

export function StatusLine(
  props: Readonly<{ device: DeviceView }>,
): React.ReactNode {
  const status = deviceStatus(props.device);
  return (
    <span className="devices-status">
      <span className="devices-state" data-tone={status.tone}>
        <span className="devices-dot" aria-hidden="true" />
        {status.label}
      </span>
      {status.reason === null ? null : (
        <span className="devices-reason">{status.reason}</span>
      )}
    </span>
  );
}

function subtitle(device: DeviceView): string {
  return device.kind === "kitchen_device"
    ? `${hardwareLabel(device)}, ${stationLabel(device.stationId)}`
    : kindLabel(device.kind);
}

function stationOf(device: DeviceView): string | null {
  return device.kind === "kitchen_device" ? device.stationId : null;
}

/** Sends a command, and on success tells the page what changed. */
async function run(
  tools: DeviceTools,
  command: string,
  body: Readonly<Record<string, unknown>>,
  message: string,
): Promise<boolean> {
  const saved = await tools.send(command, body);
  if (saved) tools.changed(message);
  return saved;
}

/**
 * A confirm in place for a person with the role. For a person without it,
 * the same button names the role that the action needs.
 */
function GatedConfirm(
  props: ConfirmInPlaceProps &
    Readonly<{ tools: DeviceTools; action: string; need: NeededRole }>,
): React.ReactNode {
  const { tools, action, need, ...confirm } = props;
  if (tools.allowed(need)) return <ConfirmInPlace {...confirm} />;
  return (
    <Button
      variant={confirm.variant ?? "danger"}
      disabled={confirm.busy}
      onClick={tools.gate(action, need, () => undefined)}
    >
      {confirm.label}
    </Button>
  );
}

/**
 * The one action that the state of a kitchen device asks for: check an
 * unknown task result, confirm a new device, resume after a pause, or
 * request a pause. A person can pause a device with an unknown result too.
 */
function MainAction(
  props: Readonly<{ tools: DeviceTools; device: KitchenDeviceView }>,
): React.ReactNode {
  const { tools, device } = props;
  if (device.enrollment === "pending")
    return <ConfirmDeviceForm tools={tools} device={device} />;
  const unknown = device.work.state === "result_unknown";
  const actions: React.ReactNode[] = [];
  if (unknown)
    actions.push(
      <GatedConfirm
        key="settle"
        tools={tools}
        action="mark a task result as checked"
        need="operator"
        variant="primary"
        label="Mark as checked…"
        question={`Did a person check ${device.name} in the shop?`}
        consequence="Purin Pantry then treats its last task as closed. Pantry repeats nothing."
        confirmLabel="Mark as checked"
        busy={tools.busy}
        onConfirm={() => {
          void run(tools, "settle", {}, "Task result marked as checked.");
        }}
      />,
    );
  if (device.enrollment !== "revoked" && device.paused)
    actions.push(
      <GatedConfirm
        key="resume"
        tools={tools}
        action="resume a device"
        need="operator"
        variant={unknown ? "secondary" : "primary"}
        label="Resume…"
        question={`Resume ${device.name}?`}
        consequence="Check that the area around it is clear. Purin Pantry can send it new tasks after this."
        confirmLabel="Resume"
        busy={tools.busy}
        onConfirm={() => {
          void run(tools, "resume", {}, `${device.name} resumed.`);
        }}
      />,
    );
  else if (device.enrollment !== "revoked")
    actions.push(
      <Button
        key="pause"
        variant={
          unknown || device.work.state === "idle" ? "secondary" : "primary"
        }
        disabled={tools.busy}
        onClick={tools.gate("request a pause", "operator", () => {
          void run(
            tools,
            "pause",
            {},
            "Pause requested. New work on this device stopped.",
          );
        })}
      >
        Request pause
      </Button>,
    );
  if (actions.length === 0) return null;
  return <div className="devices-actions">{actions}</div>;
}

function stationItems(): { value: string; label: string }[] {
  return DEVICE_STATIONS.map((station) => ({
    value: station.stationId,
    label: station.label,
  }));
}

function StationField(
  props: Readonly<{
    value: string | null;
    change: (stationId: string) => void;
  }>,
): React.ReactNode {
  const items = stationItems();
  return (
    <label className="devices-field">
      Station
      <Select.Root
        items={items}
        value={props.value}
        onValueChange={(stationId) => {
          if (stationId !== null) props.change(stationId);
        }}
      >
        <Select.Trigger>
          <Select.Value placeholder="Choose a station" />
        </Select.Trigger>
        <Select.Popup>
          {items.map((station) => (
            <Select.Item key={station.value} value={station.value}>
              {station.label}
            </Select.Item>
          ))}
        </Select.Popup>
      </Select.Root>
      <span className="devices-field-hint">
        The station decides which runs can use this device.
      </span>
    </label>
  );
}

function NameField(
  props: Readonly<{ value: string; change: (name: string) => void }>,
): React.ReactNode {
  return (
    <label className="devices-field">
      Name
      <input
        required
        maxLength={120}
        value={props.value}
        onChange={(event) => props.change(event.target.value)}
      />
    </label>
  );
}

/** A new device: check its serial number, then name it and give a station. */
function ConfirmDeviceForm(
  props: Readonly<{ tools: DeviceTools; device: KitchenDeviceView }>,
): React.ReactNode {
  const { tools, device } = props;
  const [name, setName] = React.useState(device.name);
  const [stationId, setStationId] = React.useState<string>(
    DEVICE_STATIONS[0].stationId,
  );
  return (
    <form
      className="devices-panel"
      onSubmit={(event) => {
        event.preventDefault();
        tools.gate("confirm a device", "admin", () => {
          void run(
            tools,
            "confirm",
            { name: name.trim(), stationId },
            `${name.trim()} is active.`,
          );
        })();
      }}
    >
      <p>
        Check the serial number on the machine before you confirm it.
        {device.serial === null ? "" : ` It should read ${device.serial}.`}
      </p>
      <NameField value={name} change={setName} />
      <StationField value={stationId} change={setStationId} />
      <div className="devices-panel-actions">
        <Button variant="primary" type="submit" disabled={tools.busy}>
          Confirm device
        </Button>
      </div>
    </form>
  );
}

/** The name, and the station of a kitchen device, saved with one press. */
function EditForm(props: Readonly<{ tools: DeviceTools }>): React.ReactNode {
  const { tools } = props;
  const { device } = tools;
  const kitchen = device.kind === "kitchen_device";
  const station = stationOf(device);
  const [name, setName] = React.useState(device.name);
  const [stationId, setStationId] = React.useState(station);
  const renamed = name.trim() !== "" && name.trim() !== device.name;
  const moved = stationId !== null && stationId !== station;
  const save = async (): Promise<void> => {
    if (renamed && !(await tools.send("rename", { name: name.trim() }))) return;
    if (moved && !(await tools.send("move", { stationId }))) return;
    tools.changed(
      moved
        ? `${name.trim()} is at ${stationLabel(stationId)} now.`
        : "Name saved.",
    );
  };
  return (
    <form
      className="devices-section"
      onSubmit={(event) => {
        event.preventDefault();
        const action = moved
          ? "move a device"
          : `rename a ${kitchen ? "device" : "gateway"}`;
        tools.gate(action, moved ? "admin" : "operator", () => {
          void save();
        })();
      }}
    >
      <h3>{kitchen ? "Name and station" : "Name"}</h3>
      <NameField value={name} change={setName} />
      {kitchen ? (
        <StationField value={stationId} change={setStationId} />
      ) : null}
      <div className="devices-panel-actions">
        <Button
          variant="secondary"
          type="submit"
          disabled={tools.busy || !(renamed || moved)}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

/** Restrict or lift, and revoke: the actions that change access. */
function AccessSection(
  props: Readonly<{ tools: DeviceTools }>,
): React.ReactNode {
  const { tools } = props;
  const { device } = tools;
  const [reason, setReason] = React.useState<string | null>(null);
  const kitchen = device.kind === "kitchen_device" ? device : null;
  const revoke = (
    <GatedConfirm
      tools={tools}
      action={kitchen === null ? "revoke a gateway" : "revoke a device"}
      need="admin"
      label="Revoke access…"
      question={`Revoke ${device.name}?`}
      consequence={
        kitchen === null
          ? "Its connection closes and Purin Pantry refuses its credential within 5 seconds. Its devices lose access too."
          : "Purin Pantry sends it no more work. A task that runs now becomes result unknown."
      }
      confirmLabel="Revoke access"
      busy={tools.busy}
      onConfirm={() => {
        void run(tools, "revoke", {}, `${device.name} has no access now.`);
      }}
    />
  );
  if (reason !== null && kitchen !== null)
    return (
      <section className="devices-section">
        <h3>Access</h3>
        <form
          className="devices-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              tools,
              "restrict",
              { reason: reason.trim() },
              `${device.name} is restricted. Purin Pantry sends it no new task.`,
            ).then((saved) => {
              if (saved) setReason(null);
            });
          }}
        >
          <p>
            <strong>Restrict {device.name}?</strong> Purin Pantry sends it no
            new task. A task that runs now continues.
          </p>
          <label className="devices-field">
            Reason
            <input
              autoFocus
              required
              maxLength={200}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="devices-panel-actions">
            <Button variant="primary" type="submit" disabled={tools.busy}>
              Restrict device
            </Button>
            <Button variant="secondary" onClick={() => setReason(null)}>
              Cancel
            </Button>
          </div>
        </form>
      </section>
    );
  return (
    <section className="devices-section">
      <h3>Access</h3>
      <div className="devices-actions">
        {kitchen === null ? null : kitchen.enrollment === "restricted" ? (
          <Button
            variant="secondary"
            disabled={tools.busy}
            onClick={tools.gate("lift a restriction", "admin", () => {
              void run(tools, "lift", {}, "Restriction lifted.");
            })}
          >
            Lift restriction
          </Button>
        ) : kitchen.enrollment === "active" ? (
          <Button
            variant="secondary"
            disabled={tools.busy}
            onClick={tools.gate("restrict a device", "operator", () =>
              setReason(""),
            )}
          >
            Restrict…
          </Button>
        ) : null}
        {revoke}
      </div>
    </section>
  );
}

function CameraSnapshots(
  props: Readonly<{
    deviceId: string;
    organisationId: string;
    enabled: boolean;
    tools: DeviceTools;
    askRole: (action: string, need: NeededRole) => void;
  }>,
): React.ReactNode {
  const { deviceId, organisationId, enabled, tools, askRole } = props;
  const mayAsk = tools.allowed("operator");
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState("");
  const [read, setRead] = React.useState<SnapshotRead | null>(null);
  React.useEffect(() => {
    if (!enabled || !mayAsk) return undefined;
    let current = true;
    void readDeviceSnapshots(organisationId, deviceId).then((next) => {
      if (current) setRead(next);
    });
    return () => {
      current = false;
    };
  }, [enabled, mayAsk, organisationId, deviceId]);
  const setEnabled = async (next: boolean): Promise<void> => {
    setBusy(true);
    const saved = await writeSnapshotsEnabled(organisationId, next);
    setBusy(false);
    if (!saved) {
      setNote("The change did not save. Try again.");
      return;
    }
    setNote("");
    tools.changed(next ? "Snapshots are on." : "Snapshots are off.");
  };
  const take = async (): Promise<void> => {
    setBusy(true);
    setNote("");
    const answer = await takeDeviceSnapshot(organisationId, deviceId);
    if (answer === "no_access") {
      setBusy(false);
      askRole("see camera snapshots", "admin");
      return;
    }
    if (answer === "failed") {
      setBusy(false);
      setNote("The camera cannot send an image now. Check its gateway.");
      return;
    }
    setNote("The camera will send the image in a few seconds.");
    const count = read?.kind === "read" ? read.snapshots.length : 0;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const next = await readDeviceSnapshots(organisationId, deviceId);
      setRead(next);
      if (next.kind === "read" && next.snapshots.length > count) {
        setNote("");
        break;
      }
    }
    setBusy(false);
  };
  const status = note === "" ? null : <p role="status">{note}</p>;
  if (!enabled)
    return (
      <section className="devices-section">
        <h3>Snapshots</h3>
        <p>Snapshots are off. This camera sends no image to Purin.</p>
        <GatedConfirm
          tools={tools}
          action="turn on snapshots"
          need="admin"
          variant="secondary"
          label="Turn on snapshots…"
          question="Turn on snapshots for this workspace?"
          consequence="An image of staff is personal data. Check your privacy duties and tell your staff first. A camera sends one still image on a fault or when a person asks. Purin deletes each image after seven days and keeps no video."
          confirmLabel="Turn on snapshots"
          busy={busy}
          onConfirm={() => setEnabled(true)}
        />
        {status}
      </section>
    );
  if (!mayAsk || read?.kind === "no_access")
    return (
      <section className="devices-section">
        <h3>Snapshots</h3>
        <Button
          variant="link"
          onClick={() => askRole("see camera snapshots", "admin")}
        >
          Ask for access to snapshots
        </Button>
      </section>
    );
  const snapshots = read?.kind === "read" ? read.snapshots : [];
  return (
    <section className="devices-section">
      <h3>Snapshots</h3>
      <p>Purin deletes each image after seven days and keeps no video.</p>
      <div className="devices-actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            void take();
          }}
        >
          Take a snapshot
        </Button>
        <Button
          variant="link"
          disabled={busy}
          onClick={tools.gate("turn off snapshots", "admin", () => {
            void setEnabled(false);
          })}
        >
          Turn off snapshots
        </Button>
      </div>
      {status}
      {read?.kind === "failed" ? (
        <p role="alert">The snapshots could not be read.</p>
      ) : null}
      {snapshots.length === 0 ? null : (
        <ul className="devices-snapshots">
          {snapshots.map((snapshot) => (
            <li key={snapshot.snapshotId}>
              <img
                src={snapshotImagePath(organisationId, snapshot.snapshotId)}
                alt={`The camera at ${dateTime(snapshot.takenAt)}`}
                loading="lazy"
              />
              <span className="devices-time">{dateTime(snapshot.takenAt)}</span>
              <span>
                {snapshot.reason === "fault"
                  ? "A fault asked for this image."
                  : "A person asked for this image."}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Sample = DeviceActivity["samples"][number];

/** The newest sample of each name. The samples come newest first. */
function latestSamples(samples: readonly Sample[]): readonly Sample[] {
  const seen = new Set<string>();
  return samples.filter((sample) => {
    if (seen.has(sample.name)) return false;
    seen.add(sample.name);
    return true;
  });
}

function ActivityList(
  props: Readonly<{
    organisationId: string;
    subjectId: string;
    refreshKey: string;
  }>,
): React.ReactNode {
  const { organisationId, subjectId, refreshKey } = props;
  const readActivity = React.useCallback(
    (signal: AbortSignal) =>
      readDeviceActivity(organisationId, subjectId, signal),
    [organisationId, subjectId],
  );
  // The activity can change when the device does, so it reads again then.
  const { read } = useLatestRead(readActivity, { reloadOn: refreshKey });
  if (read.kind === "failed" || (read.kind === "ready" && read.stale))
    return (
      <section className="devices-section">
        <h3>Activity</h3>
        <p>Activity could not be read.</p>
      </section>
    );
  if (read.kind === "loading") return null;
  const activity = read.value;
  const samples = latestSamples(activity.samples);
  return (
    <>
      {samples.length === 0 ? null : (
        <section className="devices-section">
          <h3>Latest readings</h3>
          <ul>
            {samples.map((sample) => (
              <li key={sample.name}>
                <span className="devices-time">{dateTime(sample.at)}</span>
                <span>
                  {sample.name}: {sample.value} {sample.unit}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="devices-section">
        <h3>Activity</h3>
        {activity.events.length === 0 ? (
          <p>Nothing is recorded yet.</p>
        ) : (
          <ul>
            {activity.events.map((event) => (
              <li key={event.eventId}>
                <span className="devices-time">
                  {dateTime(event.createdAt)}
                </span>
                <span>{event.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ManageLink(
  props: Readonly<{ device: DeviceView; pagePaths: DevicePagePaths }>,
): React.ReactNode {
  const { device, pagePaths } = props;
  switch (device.kind) {
    case "menu_screen":
      return (
        <Link className="devices-manage" to={pagePaths.menus}>
          Manage in Menus
        </Link>
      );
    case "payment_terminal":
      return (
        <Link className="devices-manage" to={pagePaths.terminals}>
          Manage in Counters &amp; payments
        </Link>
      );
    case "shop_mac":
      return (
        <p className="devices-manage-note">
          Admins manage this Mac in the voice control menu of{" "}
          <Link to={pagePaths.chat}>Chat</Link>.
        </p>
      );
    default:
      return null;
  }
}

function deviceFacts(
  device: DeviceView,
): readonly Readonly<{ term: string; value: string }>[] {
  const heard = { term: "Last heard", value: lastHeard(device) };
  switch (device.kind) {
    case "menu_screen":
      return [heard, { term: "Paired", value: dateTime(device.pairedAt) }];
    case "shop_mac":
      return [
        heard,
        {
          term: "Enrollment",
          value: device.enrollment === "pending" ? "Pending" : "Enrolled",
        },
        {
          term: "Service version",
          value: device.serviceVersion ?? "Not reported",
        },
        { term: "Speech model", value: modelLabel(device.modelState) },
        {
          term: "Speech engine",
          value:
            device.engine === null
              ? "Not reported"
              : VOICE_ENGINES[device.engine].label,
        },
        ...(device.network === null
          ? []
          : [
              { term: "Hostname", value: device.network.hostname },
              {
                term: "Private address",
                value: device.network.privateAddress ?? "Not reported",
              },
            ]),
      ];
    case "payment_terminal":
      return [
        heard,
        {
          term: "Square connection",
          value: credentialLabel(device.credentialHealth),
        },
        {
          term: "Device",
          value: device.simulated ? "Simulated" : "Square Terminal",
        },
      ];
    case "gateway":
      return [
        heard,
        { term: "Enrollment", value: titled(device.enrollment) },
        { term: "Location", value: device.locationId },
        {
          term: "Version",
          value: device.serviceVersion ?? "Not reported",
        },
      ];
    case "kitchen_device":
      return kitchenFacts(device, heard);
    default:
      return assertNever(device, "Unexpected device");
  }
}

function kitchenFacts(
  device: KitchenDeviceView,
  heard: Readonly<{ term: string; value: string }>,
): readonly Readonly<{ term: string; value: string }>[] {
  return [
    { term: "Enrollment", value: titled(device.enrollment) },
    { term: "Connection", value: titled(device.connection.state) },
    {
      term: "Health",
      value:
        device.health === "not_reported"
          ? "Not reported"
          : titled(device.health),
    },
    heard,
    { term: "Model", value: device.model },
    { term: "Gateway", value: device.gatewayName },
    ...(device.serial === null
      ? []
      : [{ term: "Serial", value: device.serial }]),
    ...(device.firmwareVersion === null
      ? []
      : [{ term: "Firmware", value: device.firmwareVersion }]),
    ...(device.capabilities.length === 0
      ? []
      : [
          {
            term: "Capabilities",
            value: `${device.capabilities.map((capability) => capability.label).join(", ")} (revision ${device.revision})`,
          },
        ]),
    ...(device.faultText === null
      ? []
      : [{ term: "The device said", value: `"${device.faultText}"` }]),
  ];
}

function titled(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
