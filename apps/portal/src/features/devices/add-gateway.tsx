import React from "react";
import {
  DEVICE_STATIONS,
  type DeviceList,
  type KitchenDeviceView,
} from "@purin-labs/control-api";

import { cancelDialog, syncDialog } from "../../dialog";
import { Button, useMutation } from "../../ui";
import { Select } from "../../ui/select";
import {
  sendDeviceCommand,
  startGateway,
  type GatewayStartResult,
} from "./requests";
import type { Variant } from "@purin-labs/type-utils";

const STATION_ITEMS = DEVICE_STATIONS.map((station) => ({
  value: station.stationId,
  label: station.label,
}));

/**
 * Add gateway: a place, one install command, then a person confirms what the
 * gateway found. A found device stays pending until that person confirms it.
 */

type Step =
  | Readonly<{ kind: "place" }>
  | Readonly<{
      kind: "install";
      gatewayId: string;
      command: string;
      expiresAt: number;
      place: Place;
    }>
  // The code ended before the gateway connected; the page stops reading.
  | Readonly<{ kind: "expired"; place: Place }>
  | Readonly<{ kind: "confirm"; gatewayId: string }>
  | Readonly<{ kind: "done"; active: number; waiting: number }>;

const STEPS = ["Place", "Install", "Confirm", "Done"] as const;

type Place = Readonly<{ name: string; location: string }>;

type Choice = Readonly<{
  checked: boolean;
  name: string;
  stationId: string;
}>;

export function AddGatewayDialog(
  props: Readonly<{
    open: boolean;
    organisationId: string;
    list: DeviceList;
    close: () => void;
    refresh: () => void;
    /** Says that a step waits for the gateway, and when it stops. */
    waiting: (on: boolean) => void;
  }>,
): React.ReactNode {
  const { open, close } = props;
  const dialog = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => syncDialog(dialog, open), [open]);
  return (
    <dialog
      ref={dialog}
      className="devices-add"
      aria-labelledby="add-gateway-title"
      onCancel={cancelDialog.bind(null, close)}
    >
      {open ? <AddGatewaySteps {...props} /> : null}
    </dialog>
  );
}

function AddGatewaySteps(
  props: Readonly<{
    organisationId: string;
    list: DeviceList;
    close: () => void;
    refresh: () => void;
    /** Says that a step waits for the gateway, and when it stops. */
    waiting: (on: boolean) => void;
  }>,
): React.ReactNode {
  const { organisationId, list, refresh, waiting } = props;
  const [step, setStep] = React.useState<Step>({ kind: "place" });
  const index =
    step.kind === "place"
      ? 0
      : step.kind === "install" || step.kind === "expired"
        ? 1
        : step.kind === "confirm"
          ? 2
          : 3;
  // While a step waits for the gateway, the page reads more often.
  const stepWaits = step.kind === "install" || step.kind === "confirm";
  React.useEffect(() => {
    if (!stepWaits) return undefined;
    waiting(true);
    return () => waiting(false);
  }, [stepWaits, waiting]);
  React.useEffect(() => {
    if (step.kind !== "install") return;
    const gateway = list.devices.find(
      (device) =>
        device.kind === "gateway" && device.deviceId === step.gatewayId,
    );
    if (gateway?.connection.state === "connected")
      setStep({ kind: "confirm", gatewayId: step.gatewayId });
  }, [list, step]);
  React.useEffect(() => {
    if (step.kind !== "install") return;
    const place = step.place;
    const timer = setTimeout(
      () =>
        setStep((current) =>
          current === step ? { kind: "expired", place } : current,
        ),
      Math.max(0, step.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [step]);
  const started = (place: Place, start: GatewayStart): void => {
    refresh();
    setStep({
      kind: "install",
      gatewayId: start.gatewayId,
      command: start.installCommand,
      expiresAt: start.expiresAt,
      place,
    });
  };
  return (
    <div className="devices-add-body">
      <div className="devices-add-top">
        <span>Add gateway</span>
        <span>
          Step {index + 1} of {STEPS.length}
        </span>
      </div>
      <div className="devices-add-bar" aria-hidden="true">
        {STEPS.map((label, position) => (
          <span key={label} data-on={position <= index}>
            {label}
          </span>
        ))}
      </div>
      {step.kind === "place" ? (
        <PlaceStep
          organisationId={organisationId}
          locations={list.locations}
          close={props.close}
          started={started}
        />
      ) : step.kind === "install" ? (
        <InstallStep
          command={step.command}
          expiresAt={step.expiresAt}
          close={props.close}
        />
      ) : step.kind === "expired" ? (
        <ExpiredStep
          organisationId={organisationId}
          place={step.place}
          close={props.close}
          started={started}
        />
      ) : step.kind === "confirm" ? (
        <ConfirmStep
          organisationId={organisationId}
          found={list.devices.filter(
            (device): device is KitchenDeviceView =>
              device.kind === "kitchen_device" &&
              device.gatewayId === step.gatewayId &&
              device.enrollment === "pending",
          )}
          finished={(active, waiting) => {
            refresh();
            setStep({ kind: "done", active, waiting });
          }}
        />
      ) : (
        <>
          <h2 id="add-gateway-title">The gateway is connected</h2>
          <p className="devices-add-lead">
            {doneText(step.active, step.waiting)}
          </p>
          <div className="devices-add-foot">
            <Button variant="primary" size="lg" onClick={props.close}>
              Done
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function doneText(active: number, waiting: number): string {
  const confirmed = `${active} ${active === 1 ? "device is" : "devices are"} active`;
  const left = waiting === 0 ? "" : `, and ${waiting} stay pending`;
  const rule =
    active + waiting === 1
      ? "It takes no work until a physical run names it."
      : "They take no work until a physical run names them.";
  return `${confirmed}${left}. ${rule}`;
}

type GatewayStart = Variant<GatewayStartResult, "started">["start"];

type StartFailure = Exclude<GatewayStartResult, { kind: "started" }>;

/**
 * One gateway start for each attempt: a retry of the same place after a
 * failure sends the same idempotency key, and a started gateway ends the
 * attempt.
 */
function useGatewayStart(
  organisationId: string,
  started: (place: Place, start: GatewayStart) => void,
): Readonly<{
  busy: boolean;
  failure: StartFailure | null;
  start: (place: Place) => void;
}> {
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<StartFailure | null>(null);
  const attempt = React.useRef<Readonly<{ key: string; place: Place }> | null>(
    null,
  );
  const start = (place: Place): void => {
    const current = attempt.current;
    const key =
      current !== null &&
      current.place.name === place.name &&
      current.place.location === place.location
        ? current.key
        : `portal-${crypto.randomUUID()}`;
    attempt.current = { key, place };
    setBusy(true);
    setFailure(null);
    void startGateway(organisationId, place.name, place.location, key).then(
      (result) => {
        setBusy(false);
        if (result.kind !== "started") return setFailure(result);
        attempt.current = null;
        started(place, result.start);
      },
    );
  };
  return { busy, failure, start };
}

function StartFailureText(
  props: Readonly<{ failure: StartFailure | null }>,
): React.ReactNode {
  const { failure } = props;
  if (failure === null) return null;
  return (
    <p className="error-text" role="alert">
      {failure.kind === "unanswered"
        ? "Pantry did not answer. Check your connection, then try again."
        : failure.error === "device_gateway_invalid"
          ? "The gateway could not start. Use letters and numbers in the location."
          : "The gateway could not start. Try again."}
    </p>
  );
}

function PlaceStep(
  props: Readonly<{
    organisationId: string;
    locations: readonly string[];
    close: () => void;
    started: (place: Place, start: GatewayStart) => void;
  }>,
): React.ReactNode {
  const known = props.locations.length > 0 ? props.locations : ["Main shop"];
  const [name, setName] = React.useState("");
  const [location, setLocation] = React.useState(known[0] ?? "Main shop");
  const { busy, failure, start } = useGatewayStart(
    props.organisationId,
    props.started,
  );
  return (
    <form
      className="devices-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        start({ name: name.trim(), location: location.trim() });
      }}
    >
      <h2 id="add-gateway-title">Where is this gateway?</h2>
      <p className="devices-add-lead">
        A gateway is a small computer in the shop. It connects your devices to
        Purin Pantry, and it dials out, so the shop opens no port.
      </p>
      <label className="devices-field">
        Gateway name
        <input
          autoFocus
          required
          maxLength={120}
          placeholder="Bakery gateway"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="devices-field">
        Location
        <input
          required
          maxLength={64}
          list="device-gateway-locations"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
        />
        <datalist id="device-gateway-locations">
          {known.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </label>
      <StartFailureText failure={failure} />
      <div className="devices-add-foot">
        <Button variant="link" onClick={props.close}>
          Cancel
        </Button>
        <Button variant="primary" size="lg" type="submit" disabled={busy}>
          Continue
        </Button>
      </div>
    </form>
  );
}

function InstallStep(
  props: Readonly<{ command: string; expiresAt: number; close: () => void }>,
): React.ReactNode {
  const [copied, setCopied] = React.useState<"no" | "yes" | "failed">("no");
  return (
    <>
      <h2 id="add-gateway-title">Run this command on the gateway</h2>
      <p className="devices-add-lead">
        The code works one time. It ends at{" "}
        {new Date(props.expiresAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
        .
      </p>
      <div className="devices-command">
        <code>{props.command}</code>
        <Button
          onClick={() => {
            navigator.clipboard.writeText(props.command).then(
              () => setCopied("yes"),
              () => setCopied("failed"),
            );
          }}
        >
          {copied === "yes" ? "Copied" : "Copy command"}
        </Button>
      </div>
      {copied === "failed" ? (
        <p className="error-text">Select the command and copy it by hand.</p>
      ) : null}
      <p className="devices-add-lead" role="status">
        Waiting for the gateway to connect.
      </p>
      <div className="devices-add-foot">
        <Button variant="link" onClick={props.close}>
          Close
        </Button>
      </div>
    </>
  );
}

function ExpiredStep(
  props: Readonly<{
    organisationId: string;
    place: Place;
    close: () => void;
    started: (place: Place, start: GatewayStart) => void;
  }>,
): React.ReactNode {
  const { busy, failure, start } = useGatewayStart(
    props.organisationId,
    props.started,
  );
  return (
    <>
      <h2 id="add-gateway-title">The code ended</h2>
      <p className="devices-add-lead">
        The gateway did not connect before the code ended. Make a new code, then
        run the new command on the gateway.
      </p>
      <StartFailureText failure={failure} />
      <div className="devices-add-foot">
        <Button variant="link" onClick={props.close}>
          Close
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={busy}
          onClick={() => start(props.place)}
        >
          Make a new code
        </Button>
      </div>
    </>
  );
}

/** The one write of the confirm step. */
const CONFIRM = "confirm";

function ConfirmStep(
  props: Readonly<{
    organisationId: string;
    found: readonly KitchenDeviceView[];
    finished: (active: number, waiting: number) => void;
  }>,
): React.ReactNode {
  const { found } = props;
  const [choices, setChoices] = React.useState<
    Readonly<Record<string, Choice>>
  >({});
  // One write for the form: each chosen device gets its command.
  const confirm = useMutation(
    async (devices: readonly KitchenDeviceView[]): Promise<void> => {
      const results = await Promise.allSettled(
        devices.map((device) => {
          const choice = choiceOf(device);
          return sendDeviceCommand(
            props.organisationId,
            device.deviceId,
            "confirm",
            { name: choice.name.trim(), stationId: choice.stationId },
          );
        }),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("A device did not save.");
    },
  );
  const confirming = confirm.state(CONFIRM);
  const choiceOf = (device: KitchenDeviceView): Choice =>
    choices[device.deviceId] ?? {
      checked: false,
      name: device.name,
      stationId: DEVICE_STATIONS[0].stationId,
    };
  const change = (device: KitchenDeviceView, patch: Partial<Choice>) =>
    setChoices((previous) => ({
      ...previous,
      [device.deviceId]: { ...choiceOf(device), ...patch },
    }));
  const chosen = found.filter((device) => choiceOf(device).checked);
  return (
    <form
      className="devices-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        void confirm.run(CONFIRM, chosen).then((outcome) => {
          if (outcome.kind === "done")
            props.finished(chosen.length, found.length - chosen.length);
        });
      }}
    >
      <h2 id="add-gateway-title">Confirm what the gateway found</h2>
      <p className="devices-add-lead">
        A found device stays pending until you confirm it. Check each serial
        number on the device.
      </p>
      {found.length === 0 ? (
        <p role="status">The gateway reports no device yet.</p>
      ) : (
        <ul className="devices-found">
          {found.map((device) => {
            const choice = choiceOf(device);
            return (
              <li key={device.deviceId}>
                <input
                  type="checkbox"
                  aria-label={`Confirm ${device.name}`}
                  checked={choice.checked}
                  onChange={(event) =>
                    change(device, { checked: event.target.checked })
                  }
                />
                <div>
                  <input
                    aria-label={`Name for ${device.name}`}
                    maxLength={120}
                    required
                    value={choice.name}
                    onChange={(event) =>
                      change(device, { name: event.target.value })
                    }
                  />
                  <span className="devices-reason-flat">
                    {device.model}
                    {device.serial === null ? "" : `, serial ${device.serial}`}
                  </span>
                </div>
                <Select.Root
                  items={STATION_ITEMS}
                  value={choice.stationId}
                  onValueChange={(stationId) => {
                    if (stationId !== null) change(device, { stationId });
                  }}
                >
                  <Select.Trigger aria-label={`Station for ${device.name}`}>
                    <Select.Value />
                  </Select.Trigger>
                  <Select.Popup>
                    {STATION_ITEMS.map((station) => (
                      <Select.Item key={station.value} value={station.value}>
                        {station.label}
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Root>
              </li>
            );
          })}
        </ul>
      )}
      {confirming.kind === "failed" ? (
        <p className="error-text" role="alert">
          A device did not save. Try again.
        </p>
      ) : null}
      <div className="devices-add-foot">
        <Button
          variant="primary"
          size="lg"
          type="submit"
          disabled={confirming.kind === "running"}
        >
          {chosen.length === 0
            ? "Finish without confirming"
            : `Confirm ${chosen.length} ${chosen.length === 1 ? "device" : "devices"}`}
        </Button>
      </div>
    </form>
  );
}
