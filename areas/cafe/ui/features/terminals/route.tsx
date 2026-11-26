import { Select } from "@purin-labs/ui/select";
import { Plus } from "lucide-react";
import React from "react";
import { toast } from "sonner";
import {
  Button,
  ConfirmInPlace,
  EmptyState,
  SideDrawer,
} from "@purin-labs/ui/index";
import { PageSkeleton, RecoverableError } from "@purin-labs/ui/page-components";

import {
  activateTerminalPairing,
  assignSquarePosApp,
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
} from "@purin-labs/control-api/portal/terminals";
import { CounterSaleRoute } from "./counter-sale-route";
import "./styles.css";
import type {
  TerminalCounterReadback,
  TerminalPairingReadback,
  TerminalPairingRequest,
} from "@purin-labs/control-api";

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
 * linked for payments is labelled rather than hidden. An admin adds or
 * replaces a counter in one drawer.
 */
export function TerminalOperationsPanel(
  props: TerminalOperationsPanelProps,
): React.ReactNode {
  const [state, setState] = React.useState<TerminalState>({ kind: "loading" });
  const [readRevision, setReadRevision] = React.useState(0);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [activeCheckoutId] = React.useState<string | null>(
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
          <Button
            variant="secondary"
            onClick={setReadRevision.bind(null, incrementTerminalReadRevision)}
          >
            Try again
          </Button>
        }
      />
    );
  }
  const { operations, configuration } = state.view;
  const block = props.canManage ? addCounterBlock(configuration) : null;
  const addButton =
    props.canManage && block === null ? (
      <Button variant="primary" onClick={setAdding.bind(null, true)}>
        <Plus size={16} aria-hidden="true" />
        Add a counter
      </Button>
    ) : null;
  const empty =
    operations.counters.length === 0 && operations.unreadableAssignments === 0;

  return (
    <section className="terminal-page" aria-label="Counters">
      {empty ? (
        <EmptyState
          title="No counters"
          description={block ?? undefined}
          actions={addButton}
        />
      ) : (
        <div className="terminal-toolbar">
          <p className="terminal-panel-timestamp">
            As of {new Date(operations.generatedAt).toLocaleString()}
          </p>
          {block === null ? (
            addButton
          ) : (
            <p className="terminal-panel-warning">{block}</p>
          )}
        </div>
      )}
      {operations.unreadableAssignments > 0 ? (
        <p className="terminal-panel-warning">
          {operations.unreadableAssignments} assignment
          {operations.unreadableAssignments === 1 ? "" : "s"} could not be read.
          Those counters exist but Purin Pantry cannot describe them.
        </p>
      ) : null}
      {operations.counters.length === 0 ? null : (
        <ul className="terminal-list">
          {operations.counters.map(
            renderTerminalCounter.bind(null, {
              canManage: props.canManage,
              busy,
              retire: retireCounter.bind(null, props, state, setState, setBusy),
            }),
          )}
        </ul>
      )}
      {props.canManage && configuration.kind === "ready" ? (
        <AddCounter
          open={adding}
          close={setAdding.bind(null, false)}
          organisationId={props.organisationId}
          configuration={configuration}
          counters={operations.counters}
          mutate={props.mutate}
          setView={setTerminalView.bind(null, setState)}
        />
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
    </section>
  );
}

/** Why an admin cannot add a counter yet, or null when they can. */
function addCounterBlock(configuration: TerminalConfiguration): string | null {
  if (configuration.kind === "blocked")
    return "To add a counter, set up Purin Checkout first.";
  if (configuration.pantryLocations.length === 0)
    return "To add a counter, publish a counter policy first.";
  if (squareLocationOptions(configuration).length === 0)
    return "To add a counter, connect a Square account and refresh its locations.";
  if (
    configuration.environment === "development" &&
    configuration.testDevices.length === 0
  )
    return "To add a counter, Square Sandbox needs a test device.";
  return null;
}

function renderTerminalCounter(
  context: Readonly<{
    canManage: boolean;
    busy: string | null;
    retire: (counter: TerminalCounterReadback) => Promise<void>;
  }>,
  counter: TerminalCounterReadback,
): React.ReactNode {
  return (
    <li key={counter.pantryLocationId} className="terminal-row">
      <div className="terminal-row-identity">
        <span className="terminal-row-location">
          {counter.pantryLocationId}
        </span>
        <span className="terminal-row-device">
          {targetLabel(counter.assignment.targetKind)} · Credentials{" "}
          {credentialHealthLabel(counter.credentialHealth)}
        </span>
      </div>
      <div className="terminal-row-state">
        <span data-tone={counter.blockedReason === null ? undefined : "quiet"}>
          {statusLabel(counter)}
        </span>
        {counter.paymentsLinked ? null : (
          <span data-tone="caution">Not linked for payments</span>
        )}
        {counter.assignment.healthIsObservable ? null : (
          <span data-tone="quiet">Health not reported</span>
        )}
        {counter.assignment.capabilityCurrent ? null : (
          <span data-tone="caution">Configuration out of date</span>
        )}
      </div>
      {context.canManage && counter.blockedReason !== "assignment_retired" ? (
        <ConfirmInPlace
          label="Stop taking payments"
          question={`Stop card payments at ${counter.pantryLocationId}?`}
          consequence={
            counter.assignment.targetKind === "paired_physical"
              ? "Payments that it took stay as they are. To use it again, pair the Terminal again."
              : "Payments that it took stay as they are."
          }
          confirmLabel="Stop taking payments"
          busy={context.busy === counter.pantryLocationId}
          onConfirm={context.retire.bind(null, counter)}
        />
      ) : null}
    </li>
  );
}

async function retireCounter(
  props: TerminalOperationsPanelProps,
  state: TerminalState,
  setState: React.Dispatch<React.SetStateAction<TerminalState>>,
  setBusy: React.Dispatch<React.SetStateAction<string | null>>,
  counter: TerminalCounterReadback,
): Promise<void> {
  setBusy(counter.pantryLocationId);
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
    toast.success(`${counter.pantryLocationId} no longer takes card payments.`);
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

/** What takes the counter's card payments. */
function targetLabel(
  targetKind: TerminalCounterReadback["assignment"]["targetKind"],
): string {
  switch (targetKind) {
    case "sandbox_simulated":
      return "Square Sandbox test scenario";
    case "square_pos_app":
      return "Square app on the counter iPad";
    case "paired_physical":
      return "Square Terminal";
    case "lan_gateway_device":
      return "Terminal on the shop gateway";
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

/** What takes the payments of a new counter. */
type CounterKind = "terminal" | "ipad" | "sandbox";

const COUNTER_KINDS: readonly Readonly<{
  kind: CounterKind;
  title: string;
  detail: string;
}>[] = [
  {
    kind: "terminal",
    title: "Square Terminal",
    detail: "Pair it with a code.",
  },
  {
    kind: "ipad",
    title: "Square app on an iPad",
    detail: "With a Square Reader.",
  },
];

type AddCounterProps = Readonly<{
  open: boolean;
  close: () => void;
  organisationId: string;
  configuration: ReadyTerminalConfiguration;
  counters: readonly TerminalCounterReadback[];
  mutate: TerminalMutationTransport;
  setView: (view: TerminalOperationsView) => void;
}>;

type PairingInProgress = Readonly<{
  pairing: TerminalPairingReadback;
  request: TerminalPairingRequest;
  replacing: boolean;
}>;

type AddCounterControls = Readonly<{
  setBusy: (busy: boolean) => void;
  setFailure: (failure: string | null) => void;
  setProgress: (progress: PairingInProgress | null) => void;
  /** Closes the drawer, which starts again on a free counter next time. */
  close: () => void;
}>;

/**
 * The drawer that gives a counter its card payments, or replaces what it has.
 * Production pairs a Square Terminal or uses the Square app on an iPad;
 * development uses a Square Sandbox test device. A pairing stays open while
 * the drawer is closed: Pantry checks the code every five seconds, and once
 * Square names the device, the counter takes it.
 */
function AddCounter(props: AddCounterProps): React.ReactNode {
  const production = props.configuration.environment === "production";
  const [kind, setKind] = React.useState<CounterKind>(
    production ? "terminal" : "sandbox",
  );
  // Null until the admin chooses: then the drawer starts on the first counter
  // that takes no payments yet.
  const [counterId, setCounterId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<PairingInProgress | null>(
    null,
  );
  const close = closeAddCounter.bind(
    null,
    props.close,
    setFailure,
    setCounterId,
  );
  const controls: AddCounterControls = {
    setBusy,
    setFailure,
    setProgress,
    close,
  };
  React.useEffect(watchTerminalPairing.bind(null, props, controls, progress), [
    props.organisationId,
    progress,
  ]);
  const formId = React.useId();
  const chosenId = chooseCounter(props, counterId);
  const existing = activeCounter(props.counters, chosenId);
  const locations = squareLocationOptions(props.configuration);

  if (progress !== null) {
    const expired = progress.pairing.status === "expired";
    return (
      <SideDrawer
        open={props.open}
        title="Pair the Square Terminal"
        close={close}
        className="terminal-drawer"
        footer={
          <>
            {expired ? (
              <Button
                variant="primary"
                disabled={busy}
                onClick={requestPairingCode.bind(
                  null,
                  props,
                  controls,
                  progress.request,
                  progress.replacing,
                )}
              >
                {busy ? "Asking Square…" : "Get a new code"}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={busy}
              onClick={setProgress.bind(null, null)}
            >
              Cancel
            </Button>
          </>
        }
      >
        <div className="side-drawer-body">
          {expired ? (
            <p className="terminal-drawer-note">This code has expired.</p>
          ) : (
            <>
              <p className="terminal-drawer-note">
                On the Square Terminal, sign out, tap “Use a device code” and
                type this code
                {progress.pairing.pairBy === null
                  ? "."
                  : ` before ${new Date(progress.pairing.pairBy).toLocaleTimeString()}.`}
              </p>
              <p className="terminal-pairing-code">{progress.pairing.code}</p>
            </>
          )}
          {failure === null ? null : (
            <p className="error-text" role="alert">
              {failure}
            </p>
          )}
        </div>
      </SideDrawer>
    );
  }

  return (
    <SideDrawer
      open={props.open}
      title="Add a counter"
      close={close}
      className="terminal-drawer"
      footer={
        <Button variant="primary" type="submit" form={formId} disabled={busy}>
          {busy
            ? kind === "terminal"
              ? "Asking Square…"
              : "Saving…"
            : kind === "terminal"
              ? "Get a pairing code"
              : existing === null
                ? "Add counter"
                : "Replace"}
        </Button>
      }
    >
      <form
        id={formId}
        className="side-drawer-body terminal-drawer-form"
        onSubmit={submitAddCounter.bind(
          null,
          props,
          controls,
          kind,
          existing !== null,
        )}
      >
        {production ? (
          <fieldset className="terminal-choices">
            <legend>Takes payments with</legend>
            {COUNTER_KINDS.map(
              renderCounterKind.bind(null, kind, setKind, busy),
            )}
          </fieldset>
        ) : null}
        <label className="terminal-field">
          <span>Counter</span>
          <TerminalSelect
            name="pantryLocationId"
            items={props.configuration.pantryLocations.map(pantryLocationItem)}
            value={chosenId}
            onValueChange={setCounterId}
            disabled={busy}
          />
        </label>
        {locations.length > 1 ? (
          <label className="terminal-field">
            <span>Square location</span>
            <TerminalSelect
              name="squareLocation"
              items={locations}
              disabled={busy}
            />
          </label>
        ) : (
          <input
            type="hidden"
            name="squareLocation"
            value={locations[0]?.value ?? ""}
          />
        )}
        {kind === "terminal" ? (
          <label className="terminal-field">
            <span>Terminal name</span>
            <input
              key={chosenId}
              name="deviceName"
              defaultValue={chosenId}
              maxLength={128}
              disabled={busy}
              required
            />
          </label>
        ) : null}
        {kind === "sandbox" ? (
          <label className="terminal-field">
            <span>Test device</span>
            <TerminalSelect
              name="testDeviceId"
              items={props.configuration.testDevices.map(testDeviceItem)}
              disabled={busy}
            />
          </label>
        ) : null}
        {existing === null ? null : (
          <p className="terminal-drawer-note">
            This replaces the {targetLabel(existing.assignment.targetKind)} at{" "}
            {chosenId}.
          </p>
        )}
        {failure === null ? null : (
          <p className="error-text" role="alert">
            {failure}
          </p>
        )}
      </form>
    </SideDrawer>
  );
}

function closeAddCounter(
  close: () => void,
  setFailure: (failure: string | null) => void,
  setCounterId: (counterId: string | null) => void,
): void {
  setFailure(null);
  setCounterId(null);
  close();
}

/** The chosen counter, or the first one that takes no payments yet. */
function chooseCounter(
  props: AddCounterProps,
  counterId: string | null,
): string {
  const ids = props.configuration.pantryLocations.map(
    (location) => location.pantryLocationId,
  );
  if (counterId !== null && ids.includes(counterId)) return counterId;
  return (
    ids.find((id) => activeCounter(props.counters, id) === null) ?? ids[0] ?? ""
  );
}

function activeCounter(
  counters: readonly TerminalCounterReadback[],
  pantryLocationId: string,
): TerminalCounterReadback | null {
  return (
    counters.find(
      (counter) =>
        counter.pantryLocationId === pantryLocationId &&
        counter.blockedReason === null,
    ) ?? null
  );
}

function renderCounterKind(
  chosen: CounterKind,
  setKind: (kind: CounterKind) => void,
  busy: boolean,
  option: (typeof COUNTER_KINDS)[number],
): React.ReactNode {
  return (
    <label key={option.kind} className="terminal-choice">
      <input
        type="radio"
        name="counterKind"
        value={option.kind}
        checked={chosen === option.kind}
        disabled={busy}
        onChange={setKind.bind(null, option.kind)}
      />
      <span>
        <span className="terminal-choice-title">{option.title}</span>
        <span className="terminal-choice-detail">{option.detail}</span>
      </span>
    </label>
  );
}

async function submitAddCounter(
  props: AddCounterProps,
  controls: AddCounterControls,
  kind: CounterKind,
  replacing: boolean,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const place = parseCounterPlace(form);
  if (place === null) {
    controls.setFailure("Choose a counter and a Square location.");
    return;
  }
  if (kind === "terminal") {
    const name = form.get("deviceName");
    const deviceName = typeof name === "string" ? name.trim() : "";
    await requestPairingCode(
      props,
      controls,
      {
        ...place,
        deviceName: deviceName.length > 0 ? deviceName : place.pantryLocationId,
      },
      replacing,
    );
    return;
  }
  const testDeviceId = form.get("testDeviceId");
  if (kind === "sandbox" && typeof testDeviceId !== "string") {
    controls.setFailure("Choose a Square Sandbox test device.");
    return;
  }
  controls.setBusy(true);
  controls.setFailure(null);
  try {
    const view =
      kind === "ipad"
        ? await assignSquarePosApp(props.organisationId, place, props.mutate)
        : await configureSandboxTerminal(
            props.organisationId,
            { ...place, testDeviceId: String(testDeviceId) },
            props.mutate,
          );
    props.setView(view);
    controls.close();
    toast.success(
      kind === "ipad"
        ? `${place.pantryLocationId} now uses the Square app on the iPad.`
        : replacing
          ? "Sandbox terminal replaced."
          : "Sandbox terminal activated.",
    );
  } catch (cause) {
    controls.setFailure(
      cause instanceof Error ? cause.message : "The counter was not changed.",
    );
  } finally {
    controls.setBusy(false);
  }
}

/** Asks Square for a code that pairs a physical Terminal (production). */
async function requestPairingCode(
  props: AddCounterProps,
  controls: AddCounterControls,
  request: TerminalPairingRequest,
  replacing: boolean,
): Promise<void> {
  controls.setBusy(true);
  controls.setFailure(null);
  try {
    const pairing = await startTerminalPairing(
      props.organisationId,
      request,
      props.mutate,
    );
    controls.setProgress({ pairing, request, replacing });
  } catch (cause) {
    controls.setFailure(
      cause instanceof Error ? cause.message : "Square gave no pairing code.",
    );
  } finally {
    controls.setBusy(false);
  }
}

function watchTerminalPairing(
  props: AddCounterProps,
  controls: AddCounterControls,
  progress: PairingInProgress | null,
): (() => void) | undefined {
  if (progress === null || progress.pairing.status !== "open") return undefined;
  let stopped = false;
  const timer = setTimeout(async () => {
    try {
      const pairing = await readTerminalPairing(
        props.organisationId,
        progress.pairing.deviceCodeId,
        progress.request.integrationAccountId,
      );
      if (stopped) return;
      if (pairing.status !== "paired") {
        controls.setProgress({ ...progress, pairing });
        return;
      }
      props.setView(
        await activateTerminalPairing(
          props.organisationId,
          pairing.deviceCodeId,
          {
            pantryLocationId: progress.request.pantryLocationId,
            integrationAccountId: progress.request.integrationAccountId,
          },
          props.mutate,
        ),
      );
      controls.setProgress(null);
      controls.close();
      toast.success(
        progress.replacing
          ? "Square Terminal replaced."
          : "Square Terminal paired.",
      );
    } catch (cause) {
      if (stopped) return;
      // The check stops here; Cancel goes back to the form for a new code.
      controls.setFailure(
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

/**
 * A form Select. Without `value` it starts on its first item, as a native
 * select does.
 */
function TerminalSelect(
  props: Readonly<{
    name: string;
    items: readonly TerminalSelectItem[];
    disabled: boolean;
    value?: string;
    onValueChange?: (value: string) => void;
  }>,
): React.ReactNode {
  return (
    <Select.Root
      name={props.name}
      items={props.items}
      {...(props.value === undefined
        ? { defaultValue: props.items[0]?.value ?? null }
        : {
            value: props.value,
            onValueChange: chooseTerminalItem.bind(null, props.onValueChange),
          })}
      disabled={props.disabled}
      required
    >
      <Select.Trigger>
        <Select.Value />
      </Select.Trigger>
      <Select.Popup>{props.items.map(renderTerminalSelectItem)}</Select.Popup>
    </Select.Root>
  );
}

function chooseTerminalItem(
  choose: ((value: string) => void) | undefined,
  value: string | null,
): void {
  if (value !== null) choose?.(value);
}

function renderTerminalSelectItem(item: TerminalSelectItem): React.ReactNode {
  return (
    <Select.Item key={item.value} value={item.value}>
      {item.label}
    </Select.Item>
  );
}

function pantryLocationItem(
  location: ReadyTerminalConfiguration["pantryLocations"][number],
): TerminalSelectItem {
  return {
    value: location.pantryLocationId,
    label: `${location.pantryLocationId} · ${location.currency}`,
  };
}

function testDeviceItem(
  device: ReadyTerminalConfiguration["testDevices"][number],
): TerminalSelectItem {
  return { value: device.testDeviceId, label: device.label };
}

/** The counter and the Square location that a new assignment binds. */
function parseCounterPlace(form: FormData): Readonly<{
  pantryLocationId: string;
  integrationAccountId: string;
  providerLocationId: string;
}> | null {
  const pantryLocationId = form.get("pantryLocationId");
  const squareLocation = form.get("squareLocation");
  if (
    typeof pantryLocationId !== "string" ||
    typeof squareLocation !== "string"
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
      pantryLocationId.length > 0
      ? { pantryLocationId, integrationAccountId, providerLocationId }
      : null;
  } catch {
    return null;
  }
}
