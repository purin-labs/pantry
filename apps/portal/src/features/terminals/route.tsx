import { Select } from "../../ui/select";
import React from "react";
import { toast } from "sonner";
import { PageSkeleton, RecoverableError } from "../../page-components";
import { cancelDialog, DialogHeading, syncDialog } from "../../dialog";

import {
  activateTerminalPairing,
  configureSandboxTerminal,
  readTerminalOperations,
  readTerminalPairing,
  startTerminalPairing,
  retireTerminalCounter,
  type TerminalMutationTransport,
} from "./api";
import type {
  TerminalConfiguration,
  ReadyTerminalConfiguration,
  TerminalOperationsView,
} from "@seams/control-api/portal/terminals";
import { CounterSaleRoute } from "./counter-sale-route";
import { openCounterSale } from "./counter-sale-api";
import "./styles.css";
import type {
  TerminalConfigurationRequest,
  TerminalCounterReadback,
  TerminalPairingReadback,
} from "@seams/control-api";

type TerminalState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "ready"; view: TerminalOperationsView }>;

type TerminalOperationsPanelProps = Readonly<{
  organisationId: string;
  canManage: boolean;
  mutate: TerminalMutationTransport;
}>;

/**
 * The counters this merchant takes card-present payments on.
 *
 * The panel states what Pantry knows and nothing more. A counter is shown as
 * blocked only for a recorded reason — a retired assignment — never because
 * a device has been quiet, and a counter whose location Commerce has not
 * linked for payments is labelled rather than hidden.
 */
export function TerminalOperationsPanel(
  props: TerminalOperationsPanelProps,
): React.ReactNode {
  const [state, setState] = React.useState<TerminalState>({ kind: "loading" });
  const [readRevision, setReadRevision] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirming, setConfirming] =
    React.useState<TerminalCounterReadback | null>(null);
  const [activeCheckoutId, setActiveCheckoutId] = React.useState<string | null>(
    readCounterSaleFromLocation,
  );

  React.useEffect(
    loadTerminalsEffect.bind(null, props.organisationId, setState),
    [props.organisationId, readRevision],
  );

  if (state.kind === "loading") {
    return <PageSkeleton label="Loading counters" />;
  }
  if (state.kind === "failed") {
    return (
      <RecoverableError
        message={state.message}
        action={
          <button
            type="button"
            onClick={setReadRevision.bind(null, incrementTerminalReadRevision)}
          >
            Try again
          </button>
        }
      />
    );
  }
  const operations = state.view.operations;

  return (
    <section className="terminal-panel">
      <header className="terminal-panel-heading">
        <h2>Card-present counters</h2>
        <span className="terminal-panel-timestamp">
          As of {new Date(operations.generatedAt).toLocaleString()}
        </span>
      </header>
      {operations.counters.length === 0 &&
      operations.unreadableAssignments === 0 ? (
        <p className="terminal-panel-warning">
          No counter takes card-present payments yet.
        </p>
      ) : null}
      {operations.unreadableAssignments > 0 ? (
        <p className="terminal-panel-warning">
          {operations.unreadableAssignments} assignment
          {operations.unreadableAssignments === 1 ? "" : "s"} could not be read.
          Those counters exist but Seams Pantry cannot describe them.
        </p>
      ) : null}
      <ul className="terminal-list">
        {operations.counters.map(
          renderTerminalCounter.bind(null, {
            organisationId: props.organisationId,
            canManage: props.canManage,
            busy,
            setConfirming,
          }),
        )}
      </ul>
      {props.canManage ? (
        <CounterSaleOpenForm
          organisationId={props.organisationId}
          configuration={state.view.configuration}
          counters={operations.counters}
          mutate={props.mutate}
          setCheckoutId={showCounterSale.bind(null, setActiveCheckoutId)}
        />
      ) : null}
      {props.canManage ? (
        <details
          className="terminal-settings"
          open={operations.counters.length === 0}
        >
          <summary>Terminal setup</summary>
          <TerminalSetup
            organisationId={props.organisationId}
            configuration={state.view.configuration}
            mutate={props.mutate}
            replace={operations.counters.length > 0}
            setView={setTerminalView.bind(null, setState)}
          />
        </details>
      ) : null}
      {activeCheckoutId === null ? null : (
        <CounterSaleRoute
          key={activeCheckoutId}
          organisationId={props.organisationId}
          checkoutId={activeCheckoutId}
          collection={{ kind: "enabled", mutate: props.mutate }}
          onUpdated={refreshTerminalView.bind(
            null,
            props.organisationId,
            setState,
          )}
        />
      )}
      {confirming === null ? null : (
        <RetireCounterDialog
          counter={confirming}
          busy={busy === confirming.satyrLocationId}
          close={setConfirming.bind(null, null)}
          confirm={retireCounter.bind(
            null,
            props,
            state,
            setState,
            setBusy,
            setConfirming,
            confirming,
          )}
        />
      )}
    </section>
  );
}

function RetireCounterDialog(
  props: Readonly<{
    counter: TerminalCounterReadback;
    busy: boolean;
    close: () => void;
    confirm: () => Promise<void>;
  }>,
): React.ReactNode {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const keep = React.useRef<HTMLButtonElement>(null);
  React.useLayoutEffect(openRetireCounterDialog.bind(null, dialog, keep), []);
  return (
    <dialog
      ref={dialog}
      className="access35-dialog terminal-confirm"
      aria-labelledby="terminal-retire-title"
      aria-describedby="terminal-retire-description"
      onCancel={cancelDialog.bind(null, props.close)}
    >
      <div className="terminal-confirm-content">
        <DialogHeading
          id="terminal-retire-title"
          title="Retire counter"
          close={props.close}
        />
        <p id="terminal-retire-description">
          <strong>{props.counter.satyrLocationId}</strong> will stop taking card
          payments. Payments it has already taken are unaffected, and pairing it
          again needs the device in hand.
        </p>
        <div className="terminal-confirm-actions">
          <button ref={keep} type="button" onClick={props.close}>
            Keep it running
          </button>
          <button
            type="button"
            className="terminal-confirm-proceed"
            disabled={props.busy}
            onClick={props.confirm}
          >
            Stop taking payments
          </button>
        </div>
      </div>
    </dialog>
  );
}

function openRetireCounterDialog(
  dialog: React.RefObject<HTMLDialogElement | null>,
  keep: React.RefObject<HTMLButtonElement | null>,
): () => void {
  syncDialog(dialog, true);
  keep.current?.focus();
  return syncDialog.bind(null, dialog, false);
}

function renderTerminalCounter(
  context: Readonly<{
    organisationId: string;
    canManage: boolean;
    busy: string | null;
    setConfirming: React.Dispatch<
      React.SetStateAction<TerminalCounterReadback | null>
    >;
  }>,
  counter: TerminalCounterReadback,
): React.ReactNode {
  return (
    <li key={counter.satyrLocationId} className="terminal-row">
      <div className="terminal-row-identity">
        <span className="terminal-row-location">{counter.satyrLocationId}</span>
        <span className="terminal-row-device">
          Credentials {credentialHealthLabel(counter.credentialHealth)}
        </span>
        <span className="terminal-row-device">
          {counter.assignment.targetKind === "sandbox_simulated"
            ? "Source: Square Sandbox test scenario · physical health unknown"
            : "Source: Square Devices API"}
        </span>
      </div>
      <div className="terminal-row-state">
        <span className={`terminal-badge terminal-badge-${badgeTone(counter)}`}>
          {statusLabel(counter)}
        </span>
        {counter.paymentsLinked ? null : (
          <span className="terminal-badge terminal-badge-caution">
            Not linked for payments
          </span>
        )}
        {counter.assignment.healthIsObservable ? null : (
          <span className="terminal-badge terminal-badge-quiet">
            Health not reported
          </span>
        )}
        {counter.assignment.capabilityCurrent ? null : (
          <span className="terminal-badge terminal-badge-caution">
            Configuration out of date
          </span>
        )}
      </div>
      {context.canManage && counter.blockedReason !== "assignment_retired" ? (
        <button
          type="button"
          className="terminal-row-action"
          disabled={context.busy === counter.satyrLocationId}
          onClick={context.setConfirming.bind(null, counter)}
        >
          Stop taking payments
        </button>
      ) : null}
    </li>
  );
}

async function retireCounter(
  props: TerminalOperationsPanelProps,
  state: TerminalState,
  setState: React.Dispatch<React.SetStateAction<TerminalState>>,
  setBusy: React.Dispatch<React.SetStateAction<string | null>>,
  setConfirming: React.Dispatch<
    React.SetStateAction<TerminalCounterReadback | null>
  >,
  counter: TerminalCounterReadback,
): Promise<void> {
  setBusy(counter.satyrLocationId);
  try {
    const operations = await retireTerminalCounter(
      props.organisationId,
      counter,
      props.mutate,
    );
    if (state.kind === "ready") {
      setState({
        kind: "ready",
        view: { operations, configuration: state.view.configuration },
      });
    }
    setConfirming(null);
    toast.success(`${counter.satyrLocationId} no longer takes card payments.`);
  } catch (cause) {
    toast.error(
      cause instanceof Error
        ? cause.message
        : "The counter could not be retired.",
    );
  } finally {
    setBusy(null);
  }
}

function statusLabel(counter: TerminalCounterReadback): string {
  switch (counter.blockedReason) {
    case null:
      return "Ready";
    case "assignment_retired":
      return "Retired";
  }
}

function badgeTone(counter: TerminalCounterReadback): "ready" | "quiet" {
  switch (counter.blockedReason) {
    case null:
      return "ready";
    case "assignment_retired":
      return "quiet";
  }
}

function credentialHealthLabel(
  health: TerminalCounterReadback["credentialHealth"],
): string {
  switch (health) {
    case "active":
      return "active";
    case "degraded":
      return "degraded";
    case "reauth_required":
      return "need reconnection";
    case "disabled":
      return "disabled";
    case "revoked":
      return "revoked";
    case "unavailable":
      return "unavailable";
  }
}

function loadTerminalsEffect(
  organisationId: string,
  setState: (state: TerminalState) => void,
): () => void {
  setState({ kind: "loading" });
  let cancelled = false;
  readTerminalOperations(organisationId).then(
    (view) => {
      if (!cancelled) setState({ kind: "ready", view });
    },
    (cause: unknown) => {
      if (cancelled) return;
      setState({
        kind: "failed",
        message:
          cause instanceof Error ? cause.message : "Counters are unavailable.",
      });
    },
  );
  return () => {
    cancelled = true;
  };
}

function incrementTerminalReadRevision(revision: number): number {
  return revision + 1;
}

function setTerminalView(
  setState: (state: TerminalState) => void,
  view: TerminalOperationsView,
): void {
  setState({ kind: "ready", view });
}

async function refreshTerminalView(
  organisationId: string,
  setState: (state: TerminalState) => void,
): Promise<void> {
  setTerminalView(setState, await readTerminalOperations(organisationId));
}

function readCounterSaleFromLocation(): string | null {
  const checkoutId = new URL(window.location.href).searchParams.get(
    "counterSale",
  );
  return checkoutId === null || checkoutId.length === 0 ? null : checkoutId;
}

function showCounterSale(
  setCheckoutId: (checkoutId: string) => void,
  checkoutId: string,
): void {
  const url = new URL(window.location.href);
  url.searchParams.set("counterSale", checkoutId);
  window.history.replaceState(window.history.state, "", url);
  setCheckoutId(checkoutId);
}

function TerminalSetup(
  props: Readonly<{
    organisationId: string;
    configuration: TerminalConfiguration;
    mutate: TerminalMutationTransport;
    replace: boolean;
    setView: (view: TerminalOperationsView) => void;
  }>,
): React.ReactNode {
  const [busy, setBusy] = React.useState(false);
  if (props.configuration.kind === "blocked") {
    return (
      <div className="terminal-setup terminal-panel-quiet">
        Set up Seams Checkout before assigning a Square terminal.
      </div>
    );
  }
  if (props.configuration.environment === "production") {
    return (
      <TerminalPairingSetup
        organisationId={props.organisationId}
        configuration={props.configuration}
        mutate={props.mutate}
        replace={props.replace}
        setView={props.setView}
      />
    );
  }
  const locations = squareLocationOptions(props.configuration);
  const canConfigure =
    props.configuration.satyrLocations.length > 0 &&
    locations.length > 0 &&
    props.configuration.testDevices.length > 0;
  return (
    <form
      className="terminal-setup"
      onSubmit={submitTerminalConfiguration.bind(null, props, setBusy)}
    >
      <div className="terminal-setup-heading">
        <h3>
          {props.replace
            ? "Replace Sandbox terminal"
            : "Set up Sandbox terminal"}
        </h3>
        <p>
          Choose the Seams Checkout counter, Square payment location, and
          documented test scenario.
        </p>
      </div>
      <div className="terminal-setup-fields">
        <label>
          <span>Seams Checkout location</span>
          <TerminalSelect
            name="satyrLocationId"
            items={props.configuration.satyrLocations.map(pantryLocationItem)}
            disabled={!canConfigure || busy}
            required
          />
        </label>
        <label>
          <span>Square account and location</span>
          <TerminalSelect
            name="squareLocation"
            items={locations}
            disabled={!canConfigure || busy}
            required
          />
        </label>
        <label>
          <span>Sandbox test device</span>
          <TerminalSelect
            name="testDeviceId"
            items={props.configuration.testDevices.map(testDeviceItem)}
            disabled={!canConfigure || busy}
            required
          />
        </label>
      </div>
      {canConfigure ? (
        <button type="submit" className="terminal-row-action" disabled={busy}>
          {busy
            ? "Saving…"
            : props.replace
              ? "Replace terminal"
              : "Activate terminal"}
        </button>
      ) : (
        <p className="terminal-panel-warning">
          Publish a counter policy and refresh an active Square account’s
          locations first.
        </p>
      )}
    </form>
  );
}

type PairingInProgress = Readonly<{
  pairing: TerminalPairingReadback;
  satyrLocationId: string;
  integrationAccountId: string;
}>;

/**
 * Pairs a physical Square Terminal (production). Pantry asks Square for a
 * code; the owner types it on the signed-out Terminal; once Square names the
 * device, the counter takes it. The code is checked every five seconds.
 */
function TerminalPairingSetup(
  props: Readonly<{
    organisationId: string;
    configuration: ReadyTerminalConfiguration;
    mutate: TerminalMutationTransport;
    replace: boolean;
    setView: (view: TerminalOperationsView) => void;
  }>,
): React.ReactNode {
  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<PairingInProgress | null>(
    null,
  );
  React.useEffect(
    watchTerminalPairing.bind(null, props, progress, setProgress),
    [props.organisationId, progress],
  );
  const locations = squareLocationOptions(props.configuration);
  const canPair =
    props.configuration.satyrLocations.length > 0 && locations.length > 0;
  if (progress !== null)
    return (
      <section className="terminal-setup">
        <div className="terminal-setup-heading">
          <h3>Pair the Square Terminal</h3>
          {progress.pairing.status === "expired" ? (
            <p>This code has expired. Get a new code to try again.</p>
          ) : (
            <p>
              On the Square Terminal, sign out, tap “Use a device code” on the
              sign-in screen, and type this code
              {progress.pairing.pairBy === null
                ? "."
                : ` before ${new Date(progress.pairing.pairBy).toLocaleTimeString()}.`}
            </p>
          )}
        </div>
        {progress.pairing.status === "expired" ? null : (
          <p className="terminal-pairing-code">{progress.pairing.code}</p>
        )}
        <button
          type="button"
          className="terminal-row-action"
          disabled={busy}
          onClick={setProgress.bind(null, null)}
        >
          {progress.pairing.status === "expired" ? "Get a new code" : "Cancel"}
        </button>
      </section>
    );
  return (
    <form
      className="terminal-setup"
      onSubmit={submitTerminalPairing.bind(null, props, setBusy, setProgress)}
    >
      <div className="terminal-setup-heading">
        <h3>
          {props.replace ? "Replace Square Terminal" : "Pair a Square Terminal"}
        </h3>
        <p>
          Choose the Seams Checkout counter and the Square location of the
          Terminal. Seams Pantry then shows a code to type on the Terminal.
        </p>
      </div>
      <div className="terminal-setup-fields">
        <label>
          <span>Seams Checkout location</span>
          <TerminalSelect
            name="satyrLocationId"
            items={props.configuration.satyrLocations.map(pantryLocationItem)}
            disabled={!canPair || busy}
            required
          />
        </label>
        <label>
          <span>Square account and location</span>
          <TerminalSelect
            name="squareLocation"
            items={locations}
            disabled={!canPair || busy}
            required
          />
        </label>
        <label>
          <span>Terminal name</span>
          <input
            name="deviceName"
            defaultValue="Front counter"
            maxLength={128}
            disabled={!canPair || busy}
            required
          />
        </label>
      </div>
      {canPair ? (
        <button type="submit" className="terminal-row-action" disabled={busy}>
          {busy ? "Asking Square…" : "Get a pairing code"}
        </button>
      ) : (
        <p className="terminal-panel-warning">
          Publish a counter policy and refresh an active Square account’s
          locations first.
        </p>
      )}
    </form>
  );
}

async function submitTerminalPairing(
  props: Readonly<{
    organisationId: string;
    mutate: TerminalMutationTransport;
  }>,
  setBusy: (busy: boolean) => void,
  setProgress: (progress: PairingInProgress) => void,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const deviceName = form.get("deviceName");
  const selection = parseTerminalSelection(withSandboxPlaceholder(form));
  if (selection === null || typeof deviceName !== "string") {
    toast.error("Choose a Seams Checkout location and a Square location.");
    return;
  }
  setBusy(true);
  try {
    const pairing = await startTerminalPairing(
      props.organisationId,
      {
        satyrLocationId: selection.satyrLocationId,
        integrationAccountId: selection.integrationAccountId,
        providerLocationId: selection.providerLocationId,
        deviceName: deviceName.trim(),
      },
      props.mutate,
    );
    setProgress({
      pairing,
      satyrLocationId: selection.satyrLocationId,
      integrationAccountId: selection.integrationAccountId,
    });
  } catch (cause) {
    toast.error(
      cause instanceof Error ? cause.message : "Square gave no pairing code.",
    );
  } finally {
    setBusy(false);
  }
}

/** The sandbox selection parser needs a test device; pairing has none. */
function withSandboxPlaceholder(form: FormData): FormData {
  const copy = new FormData();
  for (const [key, value] of form.entries()) copy.append(key, value);
  copy.set("testDeviceId", "paired_physical");
  return copy;
}

function watchTerminalPairing(
  props: Readonly<{
    organisationId: string;
    mutate: TerminalMutationTransport;
    replace: boolean;
    setView: (view: TerminalOperationsView) => void;
  }>,
  progress: PairingInProgress | null,
  setProgress: (progress: PairingInProgress | null) => void,
): (() => void) | undefined {
  if (progress === null || progress.pairing.status !== "open") return undefined;
  let stopped = false;
  const timer = setTimeout(async () => {
    try {
      const pairing = await readTerminalPairing(
        props.organisationId,
        progress.pairing.deviceCodeId,
        progress.integrationAccountId,
      );
      if (stopped) return;
      if (pairing.status !== "paired") {
        setProgress({ ...progress, pairing });
        return;
      }
      props.setView(
        await activateTerminalPairing(
          props.organisationId,
          pairing.deviceCodeId,
          {
            satyrLocationId: progress.satyrLocationId,
            integrationAccountId: progress.integrationAccountId,
          },
          props.mutate,
        ),
      );
      setProgress(null);
      toast.success(
        props.replace ? "Square Terminal replaced." : "Square Terminal paired.",
      );
    } catch (cause) {
      if (stopped) return;
      // The check stops here; Cancel gives the owner a new code.
      toast.error(
        cause instanceof Error
          ? cause.message
          : "Pairing could not be checked.",
      );
    }
  }, 5_000);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

type SquareLocationOption = Readonly<{
  value: string;
  label: string;
}>;

function squareLocationOptions(
  configuration: ReadyTerminalConfiguration,
): readonly SquareLocationOption[] {
  const options: SquareLocationOption[] = [];
  for (const account of configuration.squareAccounts) {
    for (const location of account.locations) {
      options.push({
        value: squareLocationValue(
          account.integrationAccountId,
          location.providerLocationId,
        ),
        label: `${account.displayName} · ${location.displayName} · ${location.country}/${location.currency}`,
      });
    }
  }
  return options;
}

function squareLocationValue(
  integrationAccountId: string,
  providerLocationId: string,
): string {
  return `${encodeURIComponent(integrationAccountId)}|${encodeURIComponent(providerLocationId)}`;
}

type TerminalSelectItem = Readonly<{ value: string; label: string }>;

/** A form Select that starts on its first item, as a native select does. */
function TerminalSelect(
  props: Readonly<{
    name: string;
    items: readonly TerminalSelectItem[];
    disabled: boolean;
    required?: boolean;
  }>,
): React.ReactNode {
  return (
    <Select.Root
      name={props.name}
      items={props.items}
      defaultValue={props.items[0]?.value ?? null}
      disabled={props.disabled}
      required={props.required}
    >
      <Select.Trigger>
        <Select.Value />
      </Select.Trigger>
      <Select.Popup>{props.items.map(renderTerminalSelectItem)}</Select.Popup>
    </Select.Root>
  );
}

function renderTerminalSelectItem(item: TerminalSelectItem): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

function pantryLocationItem(
  location: ReadyTerminalConfiguration["satyrLocations"][number],
): TerminalSelectItem {
  return {
    value: location.satyrLocationId,
    label: `${location.satyrLocationId} · ${location.currency}`,
  };
}

function testDeviceItem(
  device: ReadyTerminalConfiguration["testDevices"][number],
): TerminalSelectItem {
  return { value: device.testDeviceId, label: device.label };
}

async function submitTerminalConfiguration(
  props: Readonly<{
    organisationId: string;
    configuration: TerminalConfiguration;
    mutate: TerminalMutationTransport;
    replace: boolean;
    setView: (view: TerminalOperationsView) => void;
  }>,
  setBusy: (busy: boolean) => void,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const selection = parseTerminalSelection(new FormData(event.currentTarget));
  if (selection === null) {
    toast.error(
      "Choose a Seams Checkout location, Square location, and Sandbox test device.",
    );
    return;
  }
  setBusy(true);
  try {
    props.setView(
      await configureSandboxTerminal(
        props.organisationId,
        selection,
        props.mutate,
      ),
    );
    toast.success(
      props.replace
        ? "Sandbox terminal replaced."
        : "Sandbox terminal activated.",
    );
  } catch (cause) {
    toast.error(
      cause instanceof Error
        ? cause.message
        : "The Sandbox terminal could not be saved.",
    );
  } finally {
    setBusy(false);
  }
}

function parseTerminalSelection(
  form: FormData,
): TerminalConfigurationRequest | null {
  const pantryLocationId = form.get("satyrLocationId");
  const squareLocation = form.get("squareLocation");
  const testDeviceId = form.get("testDeviceId");
  if (
    typeof pantryLocationId !== "string" ||
    typeof squareLocation !== "string" ||
    typeof testDeviceId !== "string"
  )
    return null;
  const separator = squareLocation.indexOf("|");
  if (separator <= 0 || separator === squareLocation.length - 1) return null;
  try {
    const integrationAccountId = decodeURIComponent(
      squareLocation.slice(0, separator),
    );
    const providerLocationId = decodeURIComponent(
      squareLocation.slice(separator + 1),
    );
    return integrationAccountId.length > 0 &&
      providerLocationId.length > 0 &&
      pantryLocationId.length > 0 &&
      testDeviceId.length > 0
      ? {
          satyrLocationId: pantryLocationId,
          integrationAccountId,
          providerLocationId,
          testDeviceId,
        }
      : null;
  } catch {
    return null;
  }
}

type CounterItemOption = Readonly<{
  value: string;
  label: string;
  maxQuantity: number;
}>;

function CounterSaleOpenForm(
  props: Readonly<{
    organisationId: string;
    configuration: TerminalConfiguration;
    counters: readonly TerminalCounterReadback[];
    mutate: TerminalMutationTransport;
    setCheckoutId: (checkoutId: string) => void;
  }>,
): React.ReactNode {
  const [busy, setBusy] = React.useState(false);
  if (props.configuration.kind !== "ready") return null;
  const items = counterItemOptions(props.configuration, props.counters);
  if (items.length === 0) return null;
  return (
    <form
      className="terminal-setup terminal-sale-form"
      onSubmit={submitCounterSale.bind(null, props, setBusy)}
    >
      <div className="terminal-setup-heading">
        <h3>Ring up a counter sale</h3>
        <p>
          Seams Checkout prices the item under the published counter policy
          before presenting payment.
        </p>
      </div>
      <div className="terminal-setup-fields">
        <label>
          <span>First item</span>
          <TerminalSelect
            name="counterItem"
            items={items}
            disabled={busy}
            required
          />
        </label>
        <label>
          <span>Quantity</span>
          <input
            name="quantity"
            type="number"
            min="1"
            defaultValue="1"
            disabled={busy}
            required
          />
        </label>
        <label>
          <span>Second item</span>
          <TerminalSelect
            name="counterItem2"
            items={[{ value: "", label: "No second item" }, ...items]}
            disabled={busy}
          />
        </label>
        <label>
          <span>Quantity</span>
          <input
            aria-label="Second item quantity"
            name="quantity2"
            type="number"
            min="1"
            defaultValue="1"
            disabled={busy}
          />
        </label>
      </div>
      <button type="submit" className="terminal-row-action" disabled={busy}>
        {busy ? "Ringing up…" : "Ring up sale"}
      </button>
    </form>
  );
}

function counterItemOptions(
  configuration: ReadyTerminalConfiguration,
  counters: readonly TerminalCounterReadback[],
): readonly CounterItemOption[] {
  const options: CounterItemOption[] = [];
  for (const location of configuration.satyrLocations) {
    if (!hasReadyCounter(counters, location.satyrLocationId)) continue;
    for (const item of location.supportedItems) {
      options.push({
        value: counterItemValue(
          location.satyrLocationId,
          item.variantId,
          item.maxQuantityPerLine,
        ),
        label: `${item.variantId} · ${location.satyrLocationId}`,
        maxQuantity: item.maxQuantityPerLine,
      });
    }
  }
  return options;
}

function hasReadyCounter(
  counters: readonly TerminalCounterReadback[],
  pantryLocationId: string,
): boolean {
  for (const counter of counters) {
    if (
      counter.satyrLocationId === pantryLocationId &&
      counter.blockedReason === null
    )
      return true;
  }
  return false;
}

function counterItemValue(
  pantryLocationId: string,
  variantId: string,
  maxQuantity: number,
): string {
  return `${encodeURIComponent(pantryLocationId)}|${encodeURIComponent(variantId)}|${maxQuantity}`;
}

async function submitCounterSale(
  props: Readonly<{
    organisationId: string;
    configuration: TerminalConfiguration;
    counters: readonly TerminalCounterReadback[];
    mutate: TerminalMutationTransport;
    setCheckoutId: (checkoutId: string) => void;
  }>,
  setBusy: (busy: boolean) => void,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const selection = parseCounterSaleSelection(
    new FormData(event.currentTarget),
  );
  if (selection === null) {
    toast.error("Choose a counter item and valid quantity.");
    return;
  }
  setBusy(true);
  try {
    const sale = await openCounterSale(
      props.organisationId,
      selection,
      props.mutate,
    );
    props.setCheckoutId(sale.checkoutId);
    toast.success("Counter sale is ready for payment.");
  } catch (cause) {
    toast.error(
      cause instanceof Error
        ? cause.message
        : "The counter sale could not be opened.",
    );
  } finally {
    setBusy(false);
  }
}

function parseCounterSaleSelection(form: FormData): Readonly<{
  satyrLocationId: string;
  lines: readonly Readonly<{ variantId: string; quantity: number }>[];
}> | null {
  const first = parseCounterSaleLine(
    form.get("counterItem"),
    form.get("quantity"),
  );
  if (first === null) return null;
  const secondItem = form.get("counterItem2");
  if (secondItem === "") {
    return { satyrLocationId: first.satyrLocationId, lines: [first.line] };
  }
  const second = parseCounterSaleLine(secondItem, form.get("quantity2"));
  if (second === null || second.satyrLocationId !== first.satyrLocationId)
    return null;
  return {
    satyrLocationId: first.satyrLocationId,
    lines: [first.line, second.line],
  };
}

function parseCounterSaleLine(
  counterItem: FormDataEntryValue | null,
  rawQuantity: FormDataEntryValue | null,
): Readonly<{
  satyrLocationId: string;
  line: Readonly<{ variantId: string; quantity: number }>;
}> | null {
  if (typeof counterItem !== "string" || typeof rawQuantity !== "string")
    return null;
  const fields = counterItem.split("|");
  const quantity = Number(rawQuantity);
  const maxQuantity = Number(fields[2]);
  if (
    fields.length !== 3 ||
    fields[0] === undefined ||
    fields[1] === undefined ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !Number.isSafeInteger(maxQuantity) ||
    quantity > maxQuantity
  )
    return null;
  try {
    const pantryLocationId = decodeURIComponent(fields[0]);
    const variantId = decodeURIComponent(fields[1]);
    return pantryLocationId.length > 0 && variantId.length > 0
      ? { satyrLocationId: pantryLocationId, line: { variantId, quantity } }
      : null;
  } catch {
    return null;
  }
}
