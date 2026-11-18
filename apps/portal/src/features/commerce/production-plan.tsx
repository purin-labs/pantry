import React from "react";
import {
  parseInventoryProductionPlanResult,
  PRODUCTION_PLAN_ACCEPT_LIMIT,
  type InventoryProductionPlanOutcome,
  type InventoryProductionRequest,
} from "@seams/control-api";
import { isPlanQuantity } from "@seams/production-plan-crdt";
import type { Quantity } from "@seams/contracts";
import { assertNever } from "@seams/std";
import {
  ControlApiError,
  controlMutation,
  controlRead,
} from "../../control-client";
import type { CommerceMutationTransport } from "./entity-plane/api";
import { formatNeededBy } from "./needed-by";
import {
  ProductionPlanClient,
  type ProductionPlanView,
} from "./production-plan-client";
import "./inventory.css";
import {
  type PlanSharing,
  parseSharing,
} from "@seams/control-api/portal/production-plan-sharing";

/**
 * Plan 40D: the shared plan of one location. Each request that waits for
 * acceptance has a planned quantity that every open page sees. "Accept plan"
 * revises changed quantities and accepts each request.
 */
export type Props = Readonly<{
  organisationId: string;
  locationId: string;
  /** The location's requests that wait for acceptance. */
  requests: readonly InventoryProductionRequest[];
  /** The location's loaded requests that no longer wait for acceptance. */
  settledRequestIds: readonly string[];
  canOperate: boolean;
  /** Owners and admins choose where an agent may plan from. */
  canManage: boolean;
  mutate: CommerceMutationTransport;
  onAccepted: () => void;
}>;

export type State = Readonly<{
  view: ProductionPlanView | null;
  /** Text in the focused field, which may not be a valid quantity yet. */
  editing: Readonly<{ requestId: string; text: string }> | null;
  work:
    | Readonly<{ kind: "idle" }>
    | Readonly<{ kind: "accepting" }>
    | Readonly<{
        kind: "accepted";
        lines: readonly InventoryProductionPlanOutcome[];
        /** Product names when the plan was accepted; accepted requests leave the list. */
        names: ReadonlyMap<string, string>;
      }>
    | Readonly<{ kind: "failed"; message: string }>;
}>;

export class ProductionPlanPanel extends React.Component<Props, State> {
  state: State = { view: null, editing: null, work: { kind: "idle" } };
  readonly #surface = React.createRef<HTMLElement>();
  #client: ProductionPlanClient | null = null;

  componentDidMount(): void {
    this.#open();
  }

  componentDidUpdate(previous: Props): void {
    if (
      previous.organisationId !== this.props.organisationId ||
      previous.locationId !== this.props.locationId
    ) {
      this.#client?.dispose();
      this.#client = null;
      this.setState({ view: null, editing: null, work: { kind: "idle" } });
      this.#open();
    }
  }

  componentWillUnmount(): void {
    this.#client?.dispose();
    this.#client = null;
  }

  #open(): void {
    const surface = this.#surface.current;
    if (surface === null) return;
    this.#client = new ProductionPlanClient(
      this.props.organisationId,
      this.props.locationId,
      surface,
      this.#viewed.bind(this),
    );
  }

  #viewed(view: ProductionPlanView): void {
    this.setState({ view });
    // A line of a request that was accepted elsewhere has no effect; an
    // editor removes it so it does not count toward the plan's limit.
    if (
      !this.props.canOperate ||
      view.kind !== "synced" ||
      view.access !== "edit"
    )
      return;
    const settled = this.props.settledRequestIds.filter(
      view.lines.has.bind(view.lines),
    );
    if (settled.length > 0) this.#client?.clear(settled);
  }

  #focus(requestId: string): void {
    this.setState({
      editing: { requestId, text: this.#quantityOf(requestId) },
    });
    this.#client?.select(requestId);
  }

  #blur(): void {
    this.setState({ editing: null });
    this.#client?.select(null);
  }

  #change(
    request: InventoryProductionRequest,
    event: React.ChangeEvent<HTMLInputElement>,
  ): void {
    const text = event.currentTarget.value;
    this.setState({ editing: { requestId: request.id, text } });
    if (validQuantity(text, request.quantity.unit))
      this.#client?.setQuantity(request.id, text);
  }

  #quantityOf(requestId: string): string {
    const planned = this.state.view?.lines.get(requestId);
    if (planned !== undefined) return planned;
    const request = this.props.requests.find(
      requestIdentity.bind(null, requestId),
    );
    return request === undefined ? "" : quantityText(request.quantity);
  }

  async #accept(): Promise<void> {
    if (
      !this.props.canOperate ||
      this.state.view?.access !== "edit" ||
      !this.#client?.isSynced() ||
      this.state.work.kind === "accepting"
    )
      return;
    const lines = [];
    for (const request of this.props.requests.slice(
      0,
      PRODUCTION_PLAN_ACCEPT_LIMIT,
    ))
      lines.push({
        requestId: request.id,
        requestRevision: request.revision,
        quantity: this.#quantityOf(request.id),
      });
    if (lines.length === 0) return;
    const names = new Map(this.props.requests.map(requestName));
    this.setState({ work: { kind: "accepting" } });
    try {
      const response = await this.props.mutate(
        `/v1/control/organisations/${encodeURIComponent(this.props.organisationId)}/commerce/inventory/production-plan/${encodeURIComponent(this.props.locationId)}/accept`,
        { kind: "accept_plan", lines },
        `production_plan:${crypto.randomUUID()}`,
      );
      const result = parseInventoryProductionPlanResult(response);
      this.setState({
        work: { kind: "accepted", lines: result.lines, names },
      });
      this.props.onAccepted();
    } catch (error) {
      this.setState({
        work: {
          kind: "failed",
          message:
            error instanceof Error
              ? error.message
              : "The plan could not be accepted.",
        },
      });
    }
  }

  #retry(): void {
    this.#client?.retry();
  }

  render(): React.ReactNode {
    const { view, work } = this.state;
    const editable =
      this.props.canOperate &&
      view !== null &&
      view.access === "edit" &&
      view.kind !== "failed";
    const others = view?.participants.filter(isOtherParticipant) ?? [];
    return (
      <section
        ref={this.#surface}
        className="production-plan"
        aria-label={`Production plan for ${this.props.locationId}`}
      >
        <header className="production-plan-header">
          <h2>Plan for {this.props.locationId}</h2>
          <p role="status">{planStatus(view)}</p>
        </header>
        {others.length > 0 && (
          <p className="production-plan-people">
            Also here: {others.map(participantName).join(", ")}
          </p>
        )}
        {view?.kind === "failed" && <p role="alert">{view.message}</p>}
        {view?.kind === "failed" && view.recovery === "retry" && (
          <button type="button" onClick={this.#retry.bind(this)}>
            Retry connection
          </button>
        )}
        {this.props.requests.length === 0 ? (
          <p>No requests at this location wait for acceptance.</p>
        ) : (
          <table className="production-plan-lines">
            <thead>
              <tr>
                <th scope="col">Product</th>
                <th scope="col">Requested</th>
                <th scope="col">Planned</th>
                <th scope="col">Needed by</th>
              </tr>
            </thead>
            <tbody>
              {this.props.requests.map(this.#renderLine.bind(this, editable))}
            </tbody>
          </table>
        )}
        {this.props.requests.length > PRODUCTION_PLAN_ACCEPT_LIMIT && (
          <p>
            Accept plan takes the first {PRODUCTION_PLAN_ACCEPT_LIMIT} requests.
            Accept again for the rest.
          </p>
        )}
        {this.props.canOperate && (
          <button
            type="button"
            disabled={
              !editable ||
              view?.kind !== "synced" ||
              work.kind === "accepting" ||
              this.props.requests.length === 0
            }
            onClick={this.#accept.bind(this)}
          >
            {work.kind === "accepting" ? "Accepting plan…" : "Accept plan"}
          </button>
        )}
        {work.kind === "failed" && <p role="alert">{work.message}</p>}
        {this.props.canManage && (
          <PlanShareControl
            path={`/v1/control/organisations/${encodeURIComponent(this.props.organisationId)}/commerce/inventory/production-plan/${encodeURIComponent(this.props.locationId)}/share`}
          />
        )}
        {work.kind === "accepted" && (
          <ul className="production-plan-results" aria-label="Accept results">
            {work.lines.map(outcomeItem.bind(null, work.names))}
          </ul>
        )}
      </section>
    );
  }

  #renderLine(
    editable: boolean,
    request: InventoryProductionRequest,
  ): React.ReactNode {
    const editing =
      this.state.editing?.requestId === request.id ? this.state.editing : null;
    const value = editing?.text ?? this.#quantityOf(request.id);
    const current = quantityText(request.quantity);
    const editors = [
      ...(this.state.view?.participants
        .filter(editsLine.bind(null, request.id))
        .map(participantName) ?? []),
      ...(this.state.view?.agents
        .filter(agentEditsLine.bind(null, request.id))
        .map(agentName) ?? []),
    ];
    const invalid =
      editing !== null && !validQuantity(editing.text, request.quantity.unit);
    return (
      <tr key={request.id} data-request={request.id}>
        <th scope="row">{request.name}</th>
        <td>
          {current} {unitLabel(request.quantity.unit)}
        </td>
        <td>
          <input
            inputMode="decimal"
            aria-label={`Planned quantity for ${request.name}`}
            aria-invalid={invalid}
            readOnly={!editable}
            value={value}
            onFocus={this.#focus.bind(this, request.id)}
            onBlur={this.#blur.bind(this)}
            onChange={this.#change.bind(this, request)}
          />{" "}
          {unitLabel(request.quantity.unit)}
          {value !== current && !invalid && (
            <small className="production-plan-changed">
              Changed from {current}
            </small>
          )}
          {editors.length > 0 && (
            <small className="production-plan-editor">
              {editors.join(", ")} editing
            </small>
          )}
        </td>
        <td>{formatNeededBy(request.neededBy)}</td>
      </tr>
    );
  }
}

/** Pieces take whole numbers; weights and volumes take decimals. */
export function validQuantity(text: string, unit: Quantity["unit"]): boolean {
  return isPlanQuantity(text) && (unit !== "each" || !text.includes("."));
}

export function planStatus(view: ProductionPlanView | null): string {
  if (view === null) return "Connecting…";
  switch (view.kind) {
    case "connecting":
      return "Connecting…";
    case "reconnecting":
      return "Reconnecting…";
    case "syncing":
      return "Saving…";
    case "synced":
      return view.access === "edit" ? "Saved" : "View only";
    case "failed":
      return "Not connected";
    default:
      return assertNever(view, "Unexpected production plan branch");
  }
}

export function outcomeItem(
  names: ReadonlyMap<string, string>,
  line: InventoryProductionPlanOutcome,
): React.ReactNode {
  return (
    <li key={line.requestId} data-outcome={line.outcome}>
      <strong>{names.get(line.requestId) ?? line.requestId}</strong>:{" "}
      {outcomeText(line)}
    </li>
  );
}

export function requestName(
  request: InventoryProductionRequest,
): [string, string] {
  return [request.id, request.name];
}

export function outcomeText(line: InventoryProductionPlanOutcome): string {
  switch (line.outcome) {
    case "accepted":
      return line.revised
        ? `quantity changed to ${quantityText(line.quantity)} and accepted`
        : "accepted";
    case "refused":
      switch (line.reason) {
        case "request_changed":
          return line.revised
            ? "quantity changed, but the request changed before it was accepted. Review it again."
            : "the request changed after this page loaded. Review it again.";
        case "request_missing":
          return "the request no longer exists.";
        case "quantity_invalid":
          return "the planned quantity is not valid for this unit.";
        default:
          return assertNever(line.reason, "Unexpected production plan branch");
      }
    case "unavailable":
      return "not accepted, because the commerce engine could not be reached. Accept the plan again.";
    default:
      return assertNever(line, "Unexpected production plan branch");
  }
}

export function isOtherParticipant(
  participant: ProductionPlanView["participants"][number],
): boolean {
  return !participant.isSelf;
}

export function editsLine(
  requestId: string,
  participant: ProductionPlanView["participants"][number],
): boolean {
  return (
    !participant.isSelf &&
    participant.state === "editing" &&
    participant.selection?.requestId === requestId
  );
}

export function agentEditsLine(
  requestId: string,
  activity: ProductionPlanView["agents"][number],
): boolean {
  return activity.target === requestId;
}

export function agentName(
  activity: ProductionPlanView["agents"][number],
): string {
  return activity.agent.displayName;
}

export function participantName(
  participant: ProductionPlanView["participants"][number],
): string {
  return participant.displayName;
}

export function requestIdentity(
  id: string,
  request: InventoryProductionRequest,
): boolean {
  return request.id === id;
}

/** The exact decimal text of a quantity, without trailing zeros. */
export function quantityText(quantity: Quantity): string {
  const digits = String(quantity.amount).padStart(quantity.scale + 1, "0");
  const whole = digits.slice(0, digits.length - quantity.scale);
  const fraction = digits
    .slice(digits.length - quantity.scale)
    .replace(/0+$/u, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

export function unitLabel(unit: Quantity["unit"]): string {
  switch (unit) {
    case "each":
      return "each";
    case "gram":
      return "g";
    case "kilogram":
      return "kg";
    case "milliliter":
      return "ml";
    case "liter":
      return "L";
    default:
      return assertNever(unit, "Unexpected quantity unit");
  }
}

export type PlanShareState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready" | "saving"; sharing: PlanSharing }>
  | Readonly<{ kind: "failed"; sharing: PlanSharing; message: string }>;

/**
 * Where an agent may change this plan from: one Slack thread or one Portal
 * chat that is shared in a Project. Its context may then reach every role
 * that reads the plan.
 */
export function PlanShareControl(
  props: Readonly<{ path: string }>,
): React.ReactNode {
  const [state, setState] = React.useState<PlanShareState>({
    kind: "loading",
  });
  const id = React.useId();
  React.useEffect(loadPlanShare.bind(null, props.path, setState), [props.path]);
  if (state.kind === "loading") return null;
  return (
    <div className="production-plan-share">
      <p>{planSharingStatus(state.sharing)}</p>
      <details>
        <summary>
          {state.sharing === null
            ? "Share with a conversation"
            : "Change sharing"}
        </summary>
        <p>
          Every member who reads the plan can then see what that conversation
          holds.
        </p>
        <form
          className="stacked-form"
          onSubmit={savePlanShare.bind(
            null,
            props.path,
            state.sharing,
            setState,
          )}
        >
          <label htmlFor={id}>Slack thread link or Portal chat link</label>
          <input id={id} name="target" type="text" />
          <div className="stock-operation-actions">
            <button
              type="submit"
              name="action"
              value="share"
              disabled={state.kind === "saving"}
            >
              Share with the plan
            </button>
            {state.sharing !== null && (
              <button
                type="submit"
                name="action"
                value="stop"
                className="secondary"
                disabled={state.kind === "saving"}
              >
                Stop sharing
              </button>
            )}
          </div>
          {state.kind === "failed" && <p role="alert">{state.message}</p>}
        </form>
      </details>
    </div>
  );
}

/** Which conversation, if any, an agent may change this plan from. */
export function planSharingStatus(sharing: PlanSharing): React.ReactNode {
  if (sharing === null) return "No conversation can change this plan.";
  switch (sharing.kind) {
    case "slack_thread":
      return (
        <>
          An agent can change this plan from the{" "}
          <a href={sharing.threadUrl} target="_blank" rel="noreferrer">
            shared Slack thread
          </a>
          .
        </>
      );
    case "portal_chat":
      return "An agent can change this plan from a shared Portal chat.";
    default:
      return assertNever(sharing, "Unexpected plan sharing");
  }
}

export function loadPlanShare(
  path: string,
  setState: React.Dispatch<React.SetStateAction<PlanShareState>>,
): () => void {
  const request = { active: true };
  void controlRead(path).then(
    (raw) => {
      if (request.active)
        setState({ kind: "ready", sharing: parseSharing(raw) });
    },
    () => {
      if (request.active) setState({ kind: "ready", sharing: null });
    },
  );
  return () => {
    request.active = false;
  };
}

export async function savePlanShare(
  path: string,
  sharing: PlanSharing,
  setState: React.Dispatch<React.SetStateAction<PlanShareState>>,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const submitter =
    event.nativeEvent instanceof SubmitEvent
      ? event.nativeEvent.submitter
      : null;
  const stop =
    submitter instanceof HTMLButtonElement && submitter.value === "stop";
  const text = new FormData(event.currentTarget).get("target");
  const value = typeof text === "string" ? text.trim() : "";
  const chat = /conv_[0-9a-f-]{36}/u.exec(value)?.[0] ?? null;
  if (!stop && value.length === 0) {
    setState({
      kind: "failed",
      sharing,
      message: "Paste the link to a Slack thread or a Portal chat.",
    });
    return;
  }
  setState({ kind: "saving", sharing });
  try {
    const saved = await controlMutation(
      path,
      stop ? "DELETE" : "PUT",
      stop
        ? null
        : chat === null
          ? { threadUrl: value }
          : { conversationId: chat },
    );
    setState({ kind: "ready", sharing: parseSharing(saved) });
  } catch (error) {
    setState({
      kind: "failed",
      sharing,
      message:
        error instanceof ControlApiError &&
        error.kind === "production_plan_chat_private"
          ? "This chat is private. Share it in a Project first, then share it with the plan."
          : "Could not save. Use a thread of this workspace's connected Slack channel or a chat that you can open, and sign in as an owner or admin.",
    });
  }
}
