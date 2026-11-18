import React from "react";
import { Link } from "react-router";
import {
  DEVICE_STATIONS,
  type DeviceAlertSetting,
  type DeviceKind,
  type DeviceList,
  type DeviceView,
} from "@seams/control-api";

import { cancelDialog, syncDialog } from "../../dialog";
import {
  EmptyState,
  Notice,
  PageSkeleton,
  RecoverableError,
} from "../../page-components";
import { Select } from "../../ui/select";
import { AddGatewayDialog } from "./add-gateway";
import { DeviceDrawer, StatusLine } from "./drawer";
import { readAlertSetting, readDevices, writeAlertSetting } from "./requests";
import {
  clockTime,
  currentWork,
  hardwareLabel,
  kindLabel,
  lastHeard,
} from "./status";
import "./devices.css";

/**
 * The Devices page (Plan 85): one list of the shop's screens, Macs, payment
 * terminals, gateways and the devices behind them. A row opens its facts in a
 * drawer. Gateways and kitchen devices are managed here. The other kinds link
 * to the page that manages them. The page has no motion control: emergency stop
 * stays on the machine.
 */

export type DevicePagePaths = Readonly<{
  menus: string;
  terminals: string;
  chat: string;
}>;

export type MemberRole = "owner" | "admin" | "operator" | "viewer";

type Loaded =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{
      kind: "ready";
      list: DeviceList;
      readAt: number;
      /** The last refresh failed, so `list` is the previous answer. */
      stale: boolean;
    }>;

type Filter = "all" | "attention";
type RoleRequest = Readonly<{ action: string; need: "operator" | "admin" }>;

const REFRESH_MS = 15_000;
const OTHER_GROUPS: readonly Readonly<{ kind: DeviceKind; title: string }>[] = [
  { kind: "gateway", title: "Gateways" },
  { kind: "menu_screen", title: "Menu screens" },
  { kind: "shop_mac", title: "Shop Macs" },
  { kind: "payment_terminal", title: "Payment terminals" },
];
const KIND_ITEMS: readonly Readonly<{ value: string; label: string }>[] = [
  { value: "all", label: "All kinds" },
  { value: "kitchen_device", label: kindLabel("kitchen_device") },
  ...OTHER_GROUPS.map((item) => ({
    value: item.kind,
    label: kindLabel(item.kind),
  })),
];

export function DevicesRoute(
  props: Readonly<{
    organisationId: string;
    role: MemberRole;
    pagePaths: DevicePagePaths;
  }>,
): React.ReactNode {
  const { organisationId, role, pagePaths } = props;
  const [loaded, setLoaded] = React.useState<Loaded>({ kind: "loading" });
  const [filter, setFilter] = React.useState<Filter>("all");
  const [query, setQuery] = React.useState("");
  const [kind, setKind] = React.useState<DeviceKind | "all">("all");
  const [location, setLocation] = React.useState("all");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [settings, setSettings] = React.useState(false);
  const [roleRequest, setRoleRequest] = React.useState<RoleRequest | null>(
    null,
  );
  const [message, setMessage] = React.useState<string | null>(null);
  const load = React.useCallback(async (): Promise<void> => {
    const list = await readDevices(organisationId);
    setLoaded((previous) =>
      list !== null
        ? { kind: "ready", list, readAt: Date.now(), stale: false }
        : previous.kind === "ready"
          ? { ...previous, stale: true }
          : { kind: "failed" },
    );
  }, [organisationId]);
  const refresh = React.useCallback(() => {
    void load();
  }, [load]);
  React.useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  if (loaded.kind === "loading")
    return <PageSkeleton label="Loading devices" />;
  if (loaded.kind === "failed")
    return (
      <RecoverableError
        message="The devices could not be read."
        action={
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setLoaded({ kind: "loading" });
              void load();
            }}
          >
            Try again
          </button>
        }
      />
    );

  const { devices, unavailableKinds } = loaded.list;
  const attention = devices.filter((device) => device.needsAttention).length;
  const ready = devices.filter(
    (device) =>
      device.kind === "kitchen_device" && device.readiness.kind === "ready",
  ).length;
  const busy = devices.filter(
    (device) =>
      device.kind === "kitchen_device" && device.readiness.kind === "busy",
  ).length;
  const needle = query.trim().toLowerCase();
  const shown = devices.filter(
    (device) =>
      (filter === "all" || device.needsAttention) &&
      (kind === "all" || device.kind === kind) &&
      (location === "all" || locationOf(device, devices) === location) &&
      (needle === "" || searchText(device).includes(needle)),
  );
  const selected =
    devices.find((device) => device.deviceId === selectedId) ?? null;
  const mayAdd = role === "owner" || role === "admin";
  const addButton = (
    <button
      type="button"
      className="primary-button"
      onClick={() => {
        if (mayAdd) setAdding(true);
        else setRoleRequest({ action: "add a gateway", need: "admin" });
      }}
    >
      Add gateway
    </button>
  );
  const dialogs = (
    <>
      <DeviceDrawer
        device={selected}
        organisationId={organisationId}
        role={role}
        snapshotsEnabled={loaded.list.snapshotsEnabled}
        pagePaths={pagePaths}
        close={() => setSelectedId(null)}
        changed={(text) => {
          setMessage(text);
          refresh();
        }}
        askRole={(action, need) => setRoleRequest({ action, need })}
      />
      <AddGatewayDialog
        open={adding}
        organisationId={organisationId}
        list={loaded.list}
        close={() => setAdding(false)}
        refresh={refresh}
      />
      <AlertSettingsDialog
        open={settings}
        organisationId={organisationId}
        close={() => setSettings(false)}
        saved={() => {
          setSettings(false);
          setMessage("Alert times saved.");
        }}
      />
      <RoleDialog
        request={roleRequest}
        role={role}
        close={() => setRoleRequest(null)}
      />
    </>
  );
  const notices = (
    <>
      {unavailableKinds.length === 0 ? null : (
        <Notice tone="warning" announcement="polite">
          Pantry could not read{" "}
          {[...new Set(unavailableKinds.map(kindPlural))].join(" and ")}. This
          list can be incomplete.
        </Notice>
      )}
      {loaded.stale ? (
        <Notice tone="warning" announcement="polite">
          This list could not refresh. It shows the read from{" "}
          {clockTime(loaded.readAt)}.
        </Notice>
      ) : null}
      {message === null ? null : (
        <Notice tone="success" announcement="polite">
          {message}
        </Notice>
      )}
    </>
  );
  if (devices.length === 0)
    return (
      <div className="devices">
        {notices}
        <EmptyState
          title="No devices yet"
          detail="Add a gateway for kitchen devices. A menu screen or a payment terminal shows here after you pair it."
          action={
            <div className="devices-empty-links">
              {addButton}
              <Link to={pagePaths.menus}>Open Menus</Link>
              <Link to={pagePaths.terminals}>Open Counters &amp; payments</Link>
            </div>
          }
        />
        {dialogs}
      </div>
    );
  return (
    <div className="devices">
      <div className="devices-head">
        <p className="devices-summary">
          {summary(devices.length, ready, busy, attention)}
        </p>
        <div className="devices-head-actions">
          {role === "owner" || role === "admin" ? (
            <button
              type="button"
              className="secondary"
              onClick={() => setSettings(true)}
            >
              Alert times
            </button>
          ) : null}
          {addButton}
        </div>
      </div>
      {notices}
      <div className="devices-tools">
        <div
          className="devices-segment"
          role="group"
          aria-label="Filter by attention"
        >
          <button
            type="button"
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            type="button"
            aria-pressed={filter === "attention"}
            onClick={() => setFilter("attention")}
          >
            Needs attention ({attention})
          </button>
        </div>
        <label className="devices-field devices-search">
          Search
          <input
            type="search"
            value={query}
            placeholder="Name, kind or model"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {loaded.list.locations.length > 1 ? (
          <label className="devices-field devices-kind">
            Location
            <Select.Root
              items={[
                { value: "all", label: "All locations" },
                ...loaded.list.locations.map((item) => ({
                  value: item,
                  label: item,
                })),
              ]}
              value={location}
              onValueChange={(value) => {
                if (value !== null) setLocation(value);
              }}
            >
              <Select.Trigger>
                <Select.Value />
              </Select.Trigger>
              <Select.Popup>
                <Select.Item value="all">All locations</Select.Item>
                {loaded.list.locations.map((item) => (
                  <Select.Item key={item} value={item}>
                    {item}
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Root>
          </label>
        ) : null}
        <label className="devices-field devices-kind">
          Kind
          <Select.Root
            items={KIND_ITEMS}
            value={kind}
            onValueChange={(value) => {
              if (value !== null) setKind(parseKind(value));
            }}
          >
            <Select.Trigger>
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {KIND_ITEMS.map((item) => (
                <Select.Item key={item.value} value={item.value}>
                  {item.label}
                </Select.Item>
              ))}
            </Select.Popup>
          </Select.Root>
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="devices-none">
          <p>No device matches these filters.</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setFilter("all");
              setQuery("");
              setKind("all");
              setLocation("all");
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        groupsOf(shown).map((group) => (
          <section key={group.title} className="devices-group">
            <h2>{group.title}</h2>
            <ul className="devices-list">
              {group.rows.map((device) => (
                <li key={device.deviceId}>
                  <button
                    type="button"
                    className="devices-row"
                    aria-haspopup="dialog"
                    onClick={() => {
                      setMessage(null);
                      setSelectedId(device.deviceId);
                    }}
                  >
                    <span className="devices-identity">
                      <span className="devices-name">{device.name}</span>
                      {device.kind === "kitchen_device" ? (
                        <span className="devices-reason-flat">
                          {hardwareLabel(device)}
                        </span>
                      ) : null}
                    </span>
                    <StatusLine device={device} />
                    <span className="devices-work">{currentWork(device)}</span>
                    <span className="devices-heard">{lastHeard(device)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {dialogs}
    </div>
  );
}

function groupsOf(
  devices: readonly DeviceView[],
): readonly Readonly<{ title: string; rows: readonly DeviceView[] }>[] {
  const stations = [
    ...DEVICE_STATIONS.map((station) => ({
      title: station.label,
      rows: devices.filter(
        (device) =>
          device.kind === "kitchen_device" &&
          device.stationId === station.stationId,
      ),
    })),
    {
      title: "No station yet",
      rows: devices.filter(
        (device) =>
          device.kind === "kitchen_device" && device.stationId === null,
      ),
    },
  ];
  const others = OTHER_GROUPS.map((group) => ({
    title: group.title,
    rows: devices.filter((device) => device.kind === group.kind),
  }));
  return [...stations, ...others].filter((group) => group.rows.length > 0);
}

/** A kitchen device stands where its gateway stands. */
function locationOf(
  device: DeviceView,
  devices: readonly DeviceView[],
): string | null {
  switch (device.kind) {
    case "gateway":
      return device.locationId;
    case "payment_terminal":
      return device.name;
    case "kitchen_device": {
      const gateway = devices.find(
        (item) => item.deviceId === device.gatewayId,
      );
      return gateway?.kind === "gateway" ? gateway.locationId : null;
    }
    default:
      return null;
  }
}

function searchText(device: DeviceView): string {
  const detail =
    device.kind === "kitchen_device"
      ? `${hardwareLabel(device)} ${device.model} ${device.gatewayName}`
      : "";
  return `${device.name} ${kindLabel(device.kind)} ${detail}`.toLowerCase();
}

function summary(
  total: number,
  ready: number,
  busy: number,
  attention: number,
): string {
  const devices = `${total} ${total === 1 ? "device" : "devices"}.`;
  const work = ready + busy > 0 ? ` ${ready} ready, ${busy} busy.` : "";
  const need =
    attention === 0
      ? " None need attention."
      : ` ${attention} ${attention === 1 ? "needs" : "need"} attention.`;
  return `${devices}${work}${need}`;
}

function kindPlural(kind: DeviceKind): string {
  return `${kindLabel(kind).toLowerCase()}s`;
}

function parseKind(value: string): DeviceKind | "all" {
  return value === "menu_screen" ||
    value === "shop_mac" ||
    value === "payment_terminal" ||
    value === "gateway" ||
    value === "kitchen_device"
    ? value
    : "all";
}

/** Says which role an action needs, in place, where the person asked. */
function RoleDialog(
  props: Readonly<{
    request: RoleRequest | null;
    role: MemberRole;
    close: () => void;
  }>,
): React.ReactNode {
  const { request, close } = props;
  const dialog = React.useRef<HTMLDialogElement>(null);
  const open = request !== null;
  React.useEffect(() => syncDialog(dialog, open), [open]);
  return (
    <dialog
      ref={dialog}
      className="devices-add devices-add-small"
      aria-labelledby="device-role-title"
      onCancel={cancelDialog.bind(null, close)}
    >
      {request === null ? null : (
        <div className="devices-add-body">
          <h2 id="device-role-title">You cannot {request.action} yet</h2>
          <p className="devices-add-lead">
            This action needs the {titled(request.need)} role. You have the{" "}
            {titled(props.role)} role. Ask an owner of this workspace to change
            your role in Workspace settings.
          </p>
          <div className="devices-add-foot">
            <button type="button" className="primary-button" onClick={close}>
              Close
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}

function titled(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** Shop hours decide when an offline gateway with no task reaches Slack. */
function AlertSettingsDialog(
  props: Readonly<{
    open: boolean;
    organisationId: string;
    close: () => void;
    saved: () => void;
  }>,
): React.ReactNode {
  const { open, organisationId, close } = props;
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => syncDialog(dialog, open), [open]);
  return (
    <dialog
      ref={dialog}
      className="devices-add devices-add-small"
      aria-labelledby="device-alert-title"
      onCancel={cancelDialog.bind(null, close)}
    >
      {open ? (
        <AlertSettingsForm
          organisationId={organisationId}
          close={close}
          saved={props.saved}
        />
      ) : null}
    </dialog>
  );
}

function AlertSettingsForm(
  props: Readonly<{
    organisationId: string;
    close: () => void;
    saved: () => void;
  }>,
): React.ReactNode {
  const { organisationId } = props;
  const [setting, setSetting] = React.useState<DeviceAlertSetting>(() => ({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    opensAtMinute: 7 * 60,
    closesAtMinute: 19 * 60,
    offlineDelayMinutes: 5,
  }));
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    let current = true;
    void readAlertSetting(organisationId).then((read) => {
      if (current && read !== null) setSetting(read);
    });
    return () => {
      current = false;
    };
  }, [organisationId]);
  return (
    <form
      className="devices-add-body"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setFailed(false);
        void writeAlertSetting(organisationId, setting).then((ok) => {
          setBusy(false);
          if (ok) props.saved();
          else setFailed(true);
        });
      }}
    >
      <h2 id="device-alert-title">Alert times</h2>
      <p className="devices-add-lead">
        A gateway with no task reaches Slack only during shop hours, after the
        delay. A lost connection or a fault during a task reaches Slack at once.
      </p>
      <label className="devices-field">
        Time zone
        <input
          required
          value={setting.timeZone}
          onChange={(event) =>
            setSetting({ ...setting, timeZone: event.target.value })
          }
        />
      </label>
      <div className="devices-add-pair">
        <label className="devices-field">
          Shop opens
          <input
            type="time"
            required
            value={minuteText(setting.opensAtMinute)}
            onChange={(event) =>
              setSetting({
                ...setting,
                opensAtMinute: minuteOf(event.target.value),
              })
            }
          />
        </label>
        <label className="devices-field">
          Shop closes
          <input
            type="time"
            required
            value={minuteText(setting.closesAtMinute)}
            onChange={(event) =>
              setSetting({
                ...setting,
                closesAtMinute: minuteOf(event.target.value),
              })
            }
          />
        </label>
      </div>
      <label className="devices-field">
        Delay in minutes
        <input
          type="number"
          required
          min={1}
          max={120}
          value={setting.offlineDelayMinutes}
          onChange={(event) =>
            setSetting({
              ...setting,
              offlineDelayMinutes: Number(event.target.value),
            })
          }
        />
      </label>
      {failed ? (
        <p className="error-text" role="alert">
          The times did not save. Check the time zone name.
        </p>
      ) : null}
      <div className="devices-add-foot">
        <button type="button" className="devices-link" onClick={props.close}>
          Cancel
        </button>
        <button type="submit" className="primary-button" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

function minuteText(minute: number): string {
  const hours = String(Math.floor(minute / 60)).padStart(2, "0");
  const minutes = String(minute % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function minuteOf(text: string): number {
  const [hours, minutes] = text.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}
