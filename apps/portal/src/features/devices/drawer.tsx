import React from "react";
import { Link } from "react-router";
import {
  DEVICE_STATIONS,
  VOICE_ENGINES,
  type DeviceActivity,
  type DeviceView,
  type KitchenDeviceView,
} from "@seams/control-api";
import { assertNever } from "@seams/std";

import { DialogHeading, cancelDialog, syncDialog } from "../../dialog";
import { Select } from "../../ui/select";
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

/** A device's facts and actions, in a side drawer beside the list. */

const ROLE_RANK: Readonly<Record<MemberRole, number>> = {
  viewer: 1,
  operator: 2,
  admin: 3,
  owner: 4,
};

type NeededRole = "operator" | "admin";

type Panel =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "restrict"; reason: string }>
  | Readonly<{ kind: "rename"; name: string }>
  | Readonly<{ kind: "move"; stationId: string }>
  | Readonly<{ kind: "confirm"; name: string; stationId: string }>
  | Readonly<{ kind: "revoke" }>
  | Readonly<{ kind: "resume" }>
  | Readonly<{ kind: "settle" }>;

type Action = Readonly<{
  label: string;
  need: NeededRole;
  tone: "primary" | "plain" | "danger";
  run: () => void;
}>;

export function DeviceDrawer(
  props: Readonly<{
    device: DeviceView | null;
    organisationId: string;
    role: MemberRole;
    snapshotsEnabled: boolean;
    pagePaths: DevicePagePaths;
    close: () => void;
    changed: (message: string) => void;
    askRole: (action: string, need: NeededRole) => void;
  }>,
): React.ReactNode {
  const { device, close } = props;
  const dialog = React.useRef<HTMLDialogElement>(null);
  const open = device !== null;
  React.useEffect(() => syncDialog(dialog, open), [open]);
  return (
    <dialog
      ref={dialog}
      className="devices-drawer"
      aria-labelledby="device-drawer-title"
      onCancel={cancelDialog.bind(null, close)}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      {device === null ? null : (
        <DrawerBody key={device.deviceId} {...props} device={device} />
      )}
    </dialog>
  );
}

function DrawerBody(
  props: Readonly<{
    device: DeviceView;
    organisationId: string;
    role: MemberRole;
    snapshotsEnabled: boolean;
    pagePaths: DevicePagePaths;
    close: () => void;
    changed: (message: string) => void;
    askRole: (action: string, need: NeededRole) => void;
  }>,
): React.ReactNode {
  const { device, organisationId, role } = props;
  const [panel, setPanel] = React.useState<Panel>({ kind: "none" });
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const managed = device.kind === "gateway" || device.kind === "kitchen_device";
  const mayRead = ROLE_RANK[role] >= ROLE_RANK.operator;
  const run = async (
    command: string,
    body: Readonly<Record<string, unknown>>,
    message: string,
  ): Promise<void> => {
    setBusy(true);
    setFailed(false);
    const ok = await sendDeviceCommand(
      organisationId,
      device.deviceId,
      command,
      body,
    );
    setBusy(false);
    if (!ok) {
      setFailed(true);
      return;
    }
    setPanel({ kind: "none" });
    props.changed(message);
  };
  const gated = (label: string, need: NeededRole, then: () => void) => () => {
    if (ROLE_RANK[role] < ROLE_RANK[need]) props.askRole(label, need);
    else then();
  };
  const actions = managed ? deviceActions(device, gated, setPanel, run) : [];
  return (
    <div className="devices-drawer-body">
      <DialogHeading
        id="device-drawer-title"
        title={device.name}
        close={props.close}
      />
      <p className="devices-drawer-kind">{subtitle(device)}</p>
      <div className="devices-answer">
        <StatusLine device={device} />
        {device.kind === "kitchen_device" ? (
          <p>{kitchenAnswer(device)}</p>
        ) : null}
      </div>
      {currentWork(device) === "" ? null : (
        <div>
          <p className="devices-drawer-kind">Current work</p>
          <p className="devices-work-line">{currentWork(device)}</p>
        </div>
      )}
      {actions.length === 0 ? null : (
        <div className="devices-actions">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className={`secondary devices-action-${action.tone}`}
              disabled={busy}
              onClick={action.run}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <ActionPanel
        panel={panel}
        device={device}
        busy={busy}
        setPanel={setPanel}
        run={run}
      />
      {failed ? (
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
      {device.kind === "kitchen_device" && device.capabilities.length > 0 ? (
        <details className="devices-fold">
          <summary>Capabilities</summary>
          <ul>
            {device.capabilities.map((capability) => (
              <li key={capability.id}>
                {capability.label} (revision {capability.revision})
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {device.kind === "kitchen_device" && device.hardware === "camera" ? (
        <CameraSnapshots
          deviceId={device.deviceId}
          organisationId={organisationId}
          role={role}
          enabled={props.snapshotsEnabled}
          gated={gated}
          changed={props.changed}
          askRole={props.askRole}
        />
      ) : null}
      {managed ? (
        mayRead ? (
          <ActivityList
            organisationId={organisationId}
            subjectId={device.deviceId}
            refreshKey={JSON.stringify(device)}
          />
        ) : (
          <div className="devices-fold">
            <p className="devices-fold-title">Activity</p>
            <button
              type="button"
              className="devices-link"
              onClick={() => props.askRole("read activity", "operator")}
            >
              Ask for access to activity
            </button>
          </div>
        )
      ) : (
        <ManageLink device={device} pagePaths={props.pagePaths} />
      )}
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
      <span className="devices-reason">{status.reason}</span>
    </span>
  );
}

function subtitle(device: DeviceView): string {
  return device.kind === "kitchen_device"
    ? `${hardwareLabel(device)}, ${stationLabel(device.stationId)}`
    : kindLabel(device.kind);
}

type Gated = (label: string, need: NeededRole, then: () => void) => () => void;

function deviceActions(
  device: DeviceView,
  gated: Gated,
  setPanel: (panel: Panel) => void,
  run: (
    command: string,
    body: Readonly<Record<string, unknown>>,
    message: string,
  ) => Promise<void>,
): readonly Action[] {
  if (device.kind === "gateway") {
    if (device.enrollment === "revoked") return [];
    return [
      {
        label: "Rename",
        need: "operator",
        tone: "plain",
        run: gated("rename a gateway", "operator", () =>
          setPanel({ kind: "rename", name: device.name }),
        ),
      },
      {
        label: "Revoke",
        need: "admin",
        tone: "danger",
        run: gated("revoke a gateway", "admin", () =>
          setPanel({ kind: "revoke" }),
        ),
      },
    ];
  }
  if (device.kind !== "kitchen_device") return [];
  const actions: Action[] = [];
  if (device.work.state === "result_unknown")
    actions.push({
      label: "Mark as checked",
      need: "operator",
      tone: "primary",
      run: gated("mark a task result as checked", "operator", () =>
        setPanel({ kind: "settle" }),
      ),
    });
  if (device.enrollment === "revoked") return actions;
  if (device.enrollment === "pending")
    actions.push({
      label: "Confirm device",
      need: "admin",
      tone: "primary",
      run: gated("confirm a device", "admin", () =>
        setPanel({
          kind: "confirm",
          name: device.name,
          stationId: DEVICE_STATIONS[0].stationId,
        }),
      ),
    });
  else if (device.paused)
    actions.push({
      label: "Resume",
      need: "operator",
      tone: "primary",
      run: gated("resume a device", "operator", () =>
        setPanel({ kind: "resume" }),
      ),
    });
  else
    actions.push({
      label: "Request pause",
      need: "operator",
      tone: device.work.state === "idle" ? "plain" : "primary",
      run: gated("request a pause", "operator", () => {
        void run(
          "pause",
          {},
          "Pause requested. New work on this device stopped.",
        );
      }),
    });
  if (device.enrollment === "restricted")
    actions.push({
      label: "Lift restriction",
      need: "admin",
      tone: "plain",
      run: gated("lift a restriction", "admin", () => {
        void run("lift", {}, "Restriction lifted.");
      }),
    });
  else if (device.enrollment === "active")
    actions.push({
      label: "Restrict",
      need: "operator",
      tone: "plain",
      run: gated("restrict a device", "operator", () =>
        setPanel({ kind: "restrict", reason: "" }),
      ),
    });
  actions.push({
    label: "Rename",
    need: "operator",
    tone: "plain",
    run: gated("rename a device", "operator", () =>
      setPanel({ kind: "rename", name: device.name }),
    ),
  });
  if (device.enrollment !== "pending")
    actions.push({
      label: "Move",
      need: "admin",
      tone: "plain",
      run: gated("move a device", "admin", () =>
        setPanel({
          kind: "move",
          stationId: device.stationId ?? DEVICE_STATIONS[0].stationId,
        }),
      ),
    });
  actions.push({
    label: "Revoke",
    need: "admin",
    tone: "danger",
    run: gated("revoke a device", "admin", () => setPanel({ kind: "revoke" })),
  });
  return actions;
}

function ActionPanel(
  props: Readonly<{
    panel: Panel;
    device: DeviceView;
    busy: boolean;
    setPanel: (panel: Panel) => void;
    run: (
      command: string,
      body: Readonly<Record<string, unknown>>,
      message: string,
    ) => Promise<void>;
  }>,
): React.ReactNode {
  const { panel, device, busy, setPanel, run } = props;
  const cancel = (
    <button
      type="button"
      className="devices-link"
      onClick={() => setPanel({ kind: "none" })}
    >
      Cancel
    </button>
  );
  const stationItems = DEVICE_STATIONS.map((station) => ({
    value: station.stationId,
    label: station.label,
  }));
  const stations = (
    <>
      <Select.Trigger>
        <Select.Value />
      </Select.Trigger>
      <Select.Popup>
        {stationItems.map((station) => (
          <Select.Item key={station.value} value={station.value}>
            {station.label}
          </Select.Item>
        ))}
      </Select.Popup>
    </>
  );
  switch (panel.kind) {
    case "none":
      return null;
    case "restrict":
      return (
        <form
          className="devices-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "restrict",
              { reason: panel.reason.trim() },
              `${device.name} is restricted. Seams Pantry sends it no new task.`,
            );
          }}
        >
          <p>
            Restrict {device.name}? Seams Pantry sends it no new task. A task
            that runs now continues.
          </p>
          <label className="devices-field">
            Reason
            <input
              autoFocus
              required
              maxLength={200}
              value={panel.reason}
              onChange={(event) =>
                setPanel({ kind: "restrict", reason: event.target.value })
              }
            />
          </label>
          <div className="devices-panel-actions">
            {cancel}
            <button type="submit" className="primary-button" disabled={busy}>
              Restrict device
            </button>
          </div>
        </form>
      );
    case "rename":
      return (
        <form
          className="devices-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void run("rename", { name: panel.name.trim() }, "Name saved.");
          }}
        >
          <label className="devices-field">
            New name
            <input
              autoFocus
              required
              maxLength={120}
              value={panel.name}
              onChange={(event) =>
                setPanel({ kind: "rename", name: event.target.value })
              }
            />
          </label>
          <div className="devices-panel-actions">
            {cancel}
            <button type="submit" className="primary-button" disabled={busy}>
              Save name
            </button>
          </div>
        </form>
      );
    case "move":
      return (
        <form
          className="devices-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "move",
              { stationId: panel.stationId },
              `${device.name} moved to ${stationLabel(panel.stationId)}.`,
            );
          }}
        >
          <p>A move changes which runs can use this device.</p>
          <label className="devices-field">
            Station
            <Select.Root
              items={stationItems}
              value={panel.stationId}
              onValueChange={(stationId) => {
                if (stationId !== null) setPanel({ kind: "move", stationId });
              }}
            >
              {stations}
            </Select.Root>
          </label>
          <div className="devices-panel-actions">
            {cancel}
            <button type="submit" className="primary-button" disabled={busy}>
              Move device
            </button>
          </div>
        </form>
      );
    case "confirm":
      return (
        <form
          className="devices-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              "confirm",
              { name: panel.name.trim(), stationId: panel.stationId },
              `${panel.name.trim()} is active.`,
            );
          }}
        >
          <p>
            Check the serial number on the machine before you confirm it.
            {device.kind === "kitchen_device" && device.serial !== null
              ? ` It should read ${device.serial}.`
              : ""}
          </p>
          <label className="devices-field">
            Name
            <input
              autoFocus
              required
              maxLength={120}
              value={panel.name}
              onChange={(event) =>
                setPanel({ ...panel, name: event.target.value })
              }
            />
          </label>
          <label className="devices-field">
            Station
            <Select.Root
              items={stationItems}
              value={panel.stationId}
              onValueChange={(stationId) => {
                if (stationId !== null) setPanel({ ...panel, stationId });
              }}
            >
              {stations}
            </Select.Root>
          </label>
          <div className="devices-panel-actions">
            {cancel}
            <button type="submit" className="primary-button" disabled={busy}>
              Confirm device
            </button>
          </div>
        </form>
      );
    case "revoke":
      return (
        <div className="devices-panel">
          <p>
            {device.kind === "gateway"
              ? `Revoke ${device.name}? Its connection closes and Seams Pantry refuses its credential within 5 seconds. Its devices lose access too.`
              : `Revoke ${device.name}? Seams Pantry sends it no more work. A task that runs now becomes result unknown.`}
          </p>
          <div className="devices-panel-actions">
            {cancel}
            <button
              type="button"
              className="secondary devices-action-danger"
              disabled={busy}
              onClick={() => {
                void run("revoke", {}, `${device.name} has no access now.`);
              }}
            >
              Revoke access
            </button>
          </div>
        </div>
      );
    case "resume":
      return (
        <div className="devices-panel">
          <p>
            Resume {device.name}? Check that the area around it is clear. Seams
            Pantry can send it new tasks after this.
          </p>
          <div className="devices-panel-actions">
            {cancel}
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => {
                void run("resume", {}, `${device.name} resumed.`);
              }}
            >
              Resume
            </button>
          </div>
        </div>
      );
    case "settle":
      return (
        <div className="devices-panel">
          <p>
            Did a person check {device.name} in the shop? Seams Pantry then
            treats its last task as closed. Pantry repeats nothing.
          </p>
          <div className="devices-panel-actions">
            {cancel}
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => {
                void run("settle", {}, "Task result marked as checked.");
              }}
            >
              Mark as checked
            </button>
          </div>
        </div>
      );
    default:
      return assertNever(panel, "Unexpected panel");
  }
}

function CameraSnapshots(
  props: Readonly<{
    deviceId: string;
    organisationId: string;
    role: MemberRole;
    enabled: boolean;
    gated: Gated;
    changed: (message: string) => void;
    askRole: (action: string, need: NeededRole) => void;
  }>,
): React.ReactNode {
  const { deviceId, organisationId, enabled, gated, askRole } = props;
  const mayAsk = ROLE_RANK[props.role] >= ROLE_RANK.operator;
  const [confirming, setConfirming] = React.useState(false);
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
    setConfirming(false);
    setNote("");
    props.changed(next ? "Snapshots are on." : "Snapshots are off.");
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
  if (!enabled)
    return (
      <div className="devices-fold">
        <p className="devices-fold-title">Snapshots</p>
        <p>Snapshots are off. This camera sends no image to Seams.</p>
        {confirming ? (
          <div className="devices-panel devices-snapshot-confirm">
            <p>
              Turn on snapshots for this workspace? An image of staff is
              personal data. Check your privacy duties and tell your staff
              first.
            </p>
            <p>
              A camera sends one still image on a fault or when a person asks.
              Seams deletes each image after seven days and keeps no video.
            </p>
            <div className="devices-panel-actions">
              <button
                type="button"
                className="devices-link"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => {
                  void setEnabled(true);
                }}
              >
                Turn on snapshots
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="devices-link"
            onClick={gated("turn on snapshots", "admin", () =>
              setConfirming(true),
            )}
          >
            Turn on snapshots
          </button>
        )}
        {note === "" ? null : <p role="status">{note}</p>}
      </div>
    );
  if (!mayAsk || read?.kind === "no_access")
    return (
      <div className="devices-fold">
        <p className="devices-fold-title">Snapshots</p>
        <button
          type="button"
          className="devices-link"
          onClick={() => askRole("see camera snapshots", "admin")}
        >
          Ask for access to snapshots
        </button>
      </div>
    );
  const snapshots = read?.kind === "read" ? read.snapshots : [];
  return (
    <div className="devices-fold">
      <p className="devices-fold-title">Snapshots</p>
      <p>Seams deletes each image after seven days and keeps no video.</p>
      <div className="devices-snapshot-actions">
        <button
          type="button"
          className="secondary devices-action-plain"
          disabled={busy}
          onClick={() => {
            void take();
          }}
        >
          Take a snapshot
        </button>
        <button
          type="button"
          className="devices-link"
          disabled={busy}
          onClick={gated("turn off snapshots", "admin", () => {
            void setEnabled(false);
          })}
        >
          Turn off snapshots
        </button>
      </div>
      {note === "" ? null : <p role="status">{note}</p>}
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
    </div>
  );
}

function ActivityList(
  props: Readonly<{
    organisationId: string;
    subjectId: string;
    refreshKey: string;
  }>,
): React.ReactNode {
  const { organisationId, subjectId, refreshKey } = props;
  const [activity, setActivity] = React.useState<
    DeviceActivity | null | "failed"
  >(null);
  React.useEffect(() => {
    let current = true;
    void readDeviceActivity(organisationId, subjectId).then((read) => {
      if (current) setActivity(read ?? "failed");
    });
    return () => {
      current = false;
    };
  }, [organisationId, subjectId, refreshKey]);
  if (activity === "failed")
    return <p className="devices-fold-title">Activity could not be read.</p>;
  if (activity === null) return null;
  return (
    <>
      {activity.samples.length === 0 ? null : (
        <details className="devices-fold">
          <summary>Samples, one a minute</summary>
          <ul>
            {activity.samples.map((sample) => (
              <li key={`${sample.name}:${sample.at}`}>
                <span className="devices-time">{dateTime(sample.at)}</span>
                <span>
                  {sample.name}: {sample.value} {sample.unit}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <details className="devices-fold" open>
        <summary>Activity</summary>
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
      </details>
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
    ...(device.faultText === null
      ? []
      : [{ term: "The device said", value: `"${device.faultText}"` }]),
  ];
}

function titled(value: string): string {
  const spaced = value.replaceAll("_", " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
