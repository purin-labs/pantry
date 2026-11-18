import type { RunSnapshotPage } from "@seams/bakery-model/bakery-run-snapshot";
import React from "react";
import { controlRead } from "../../control-client";
import type {
  BakeryWorkspaceAction,
  SimulatorConnection,
  WorkspaceRunSaveStatus,
  AgentRunSaveProposal,
} from "./simulator-state";
import type { RunSnapshotSummary } from "@seams/bakery-model/bakery-run-snapshot";
import {
  prepareProductionWorkspaceRun,
  prepareRehearsalRunWorkspace,
  readWorkspaceRuns,
  savePreparedWorkspaceRun,
  savePreparedAgentWorkspaceRun,
  verifyStoredWorkspaceRun,
  type PreparedWorkspaceRun,
} from "./workspace-runs-api";
import type { ProductionWorkcells } from "@seams/production-simulation/recipes/bakery/production-workcells";
import type { RunSnapshotKind } from "@seams/bakery-model/bakery-run-snapshot";
import { readProductionScenario } from "./production-scenario-api";
import type { StrictUnion, Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

export type PersistentSaveSource = Readonly<{
  identity: string;
  prepare(name: string): Promise<PreparedWorkspaceRun>;
}>;

export type WorkspaceRunSaveChanged = (
  action: Variant<
    BakeryWorkspaceAction,
    | "workspaceRunSaveStarted"
    | "workspaceRunSaveSettled"
    | "workspaceRunSaveRecovered"
    | "workspaceRunSaveMissing"
    | "workspaceRunSaveAbandoned"
    | "workspaceRunSaveProposalCleared"
  >,
) => void;

type Props = Readonly<{
  connection: Variant<SimulatorConnection, "workspace">;
  saveStatus: WorkspaceRunSaveStatus;
  saveChanged: WorkspaceRunSaveChanged;
}> &
  StrictUnion<
    | Readonly<{
        kind: "rehearsal-run" | "production";
        proposal: AgentRunSaveProposal | null;
        source: ProductionWorkcells | null;
        open(id: string): Promise<void>;
      }>
    | Readonly<{
        kind: "persistent-production";
        proposal: null;
        source: PersistentSaveSource | null;
        open: ((id: string) => Promise<void>) | null;
      }>
  >;

type Activity =
  | Readonly<{ kind: "idle"; message: string }>
  | Readonly<{
      kind: "preparing" | "saving" | "listing" | "opening" | "checking";
    }>
  | Readonly<{ kind: "failed"; message: string }>;
type PageCursors = readonly [null, ...string[]];
type SavedRunPage = RunSnapshotPage & Readonly<{ cursors: PageCursors }>;
type State = Readonly<{
  name: string;
  prepared: PreparedWorkspaceRun | null;
  page: SavedRunPage | null;
  activity: Activity;
}>;

export class WorkspaceRunsPanel extends React.Component<Props, State> {
  state: State = {
    name:
      this.props.kind !== "rehearsal-run"
        ? "Bakery production"
        : "Multi-tray rehearsal",
    prepared: null,
    page: null,
    activity: { kind: "idle", message: "" },
  };
  private mounted = false;
  private generation = 0;
  private readbacks = new AbortController();
  private readonly nameInput = React.createRef<HTMLInputElement>();
  private readonly reviewHeading = React.createRef<HTMLHeadingElement>();
  private readonly errorMessage = React.createRef<HTMLParagraphElement>();
  private readonly pageHeading = React.createRef<HTMLHeadingElement>();

  componentDidMount(): void {
    this.mounted = true;
    this.readbacks = new AbortController();
    this.setState(
      { activity: { kind: "idle", message: "" } },
      this.refresh.bind(this),
    );
    if (this.props.proposal !== null) this.focusReview();
  }
  componentDidUpdate(previous: Props): void {
    if (
      this.props.proposal !== null &&
      previous.proposal?.effectId !== this.props.proposal.effectId
    )
      this.focusReview();
    if (
      previous.connection.organisationId !==
      this.props.connection.organisationId
    ) {
      this.generation++;
      this.setState(
        {
          prepared: null,
          page: null,
          activity: { kind: "idle", message: "" },
        },
        this.refresh.bind(this),
      );
    } else if (
      this.state.activity.kind !== "saving" &&
      (this.state.prepared !== null ||
        this.state.activity.kind === "preparing") &&
      (sourceIdentity(previous) !== sourceIdentity(this.props) ||
        !this.props.connection.canManage)
    ) {
      this.generation++;
      this.setState(
        {
          prepared: null,
          activity: {
            kind: "idle",
            message: "The run changed. Review a new copy before saving.",
          },
        },
        this.focusName.bind(this),
      );
    } else if (
      this.state.activity.kind === "opening" &&
      sourceIdentity(previous) !== sourceIdentity(this.props)
    ) {
      this.generation++;
      this.setState({
        activity: {
          kind: "failed",
          message:
            "A run was opened while loading. Your current run is kept. Open the saved copy again to review it.",
        },
      });
    }
  }
  componentWillUnmount(): void {
    this.mounted = false;
    this.generation++;
    this.readbacks.abort();
  }

  // A save check is an exact readback: it reads storage itself and never
  // waits on a read that another caller, such as the agent, started.
  private readback(path: string): Promise<unknown> {
    return controlRead(path, this.readbacks.signal);
  }

  private busy(): boolean {
    return (
      this.visibleSaveStatus().kind === "saving" ||
      (this.state.activity.kind !== "idle" &&
        this.state.activity.kind !== "failed")
    );
  }

  private visibleSaveStatus(): WorkspaceRunSaveStatus {
    const status = this.props.saveStatus;
    return status.kind !== "idle" &&
      status.organisationId === this.props.connection.organisationId
      ? status
      : { kind: "idle" };
  }

  private saveReviewBlocked(): boolean {
    const status = this.visibleSaveStatus();
    return (
      status.kind === "outcome-unknown" ||
      status.kind === "saved-readback-failed"
    );
  }

  private changeName(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({ name: event.target.value, prepared: null });
  }

  private cancelReview(): void {
    const proposal = this.props.proposal ?? null;
    const status = this.visibleSaveStatus();
    if (
      proposal !== null &&
      status.kind === "not-found" &&
      status.agentEffectId === proposal.effectId &&
      status.id === proposal.prepared.id
    )
      this.props.saveChanged({
        kind: "workspaceRunSaveAbandoned",
        organisationId: status.organisationId,
        requestId: status.requestId,
        id: status.id,
        effectId: proposal.effectId,
      });
    else if (proposal !== null)
      this.props.saveChanged({
        kind: "workspaceRunSaveProposalCleared",
        id: proposal.prepared.id,
        effectId: proposal.effectId,
      });
    this.setState(
      {
        prepared: null,
        activity: { kind: "idle", message: "Save review cancelled." },
      },
      this.focusName.bind(this),
    );
  }

  private focusName(): void {
    this.nameInput.current?.focus();
  }

  focusReview(): void {
    this.reviewHeading.current?.focus();
  }

  private async prepare(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const props = this.props;
    if (
      this.busy() ||
      this.saveReviewBlocked() ||
      !props.connection.canManage ||
      props.source === null
    )
      return;
    if (this.state.name.trim() === "") {
      this.nameInput.current?.focus();
      return;
    }
    const generation = ++this.generation;
    this.setState({ activity: { kind: "preparing" }, prepared: null });
    try {
      const prepared = await prepareSource(props, this.state.name);
      if (!this.current(generation)) return;
      const saveStatus = this.visibleSaveStatus();
      if (
        saveStatus.kind === "not-found" &&
        (prepared.id !== saveStatus.id ||
          prepared.snapshot.name !== saveStatus.name ||
          saveStatus.agentEffectId !== null)
      ) {
        this.setState(
          {
            activity: {
              kind: "failed",
              message:
                "This run differs from the missing copy. Restore the original run and name before retrying its save.",
            },
          },
          this.focusError.bind(this),
        );
        return;
      }
      this.setState(
        {
          prepared,
          activity: {
            kind: "idle",
            message: "Review the frozen copy below before saving it.",
          },
        },
        this.focusReview.bind(this),
      );
    } catch (error) {
      this.fail(generation, error);
    }
  }

  private async save(): Promise<void> {
    const props = this.props;
    const proposal = props.proposal ?? null;
    const prepared = proposal?.prepared ?? this.state.prepared;
    if (
      this.busy() ||
      this.saveReviewBlocked() ||
      prepared === null ||
      !props.connection.canManage ||
      (proposal === null && props.source === null)
    )
      return;
    const generation = ++this.generation;
    this.setState({ activity: { kind: "saving" } });
    let requestId: string | null = null;
    try {
      let current = prepared;
      if (proposal === null) {
        if (props.source === null) return;
        current = await prepareSource(props, this.state.name);
      }
      if (!this.current(generation)) return;
      if (current.id !== prepared.id) {
        this.setState({
          prepared: null,
          activity: {
            kind: "failed",
            message:
              "The run changed after review. Review the new copy before saving.",
          },
        });
        return;
      }
      const saveStatus = this.visibleSaveStatus();
      if (
        saveStatus.kind === "saving" ||
        saveStatus.kind === "outcome-unknown" ||
        saveStatus.kind === "saved-readback-failed"
      ) {
        this.setState({
          prepared: null,
          activity: {
            kind: "idle",
            message: "Resolve the earlier save before submitting another copy.",
          },
        });
        return;
      }
      if (
        saveStatus.kind === "not-found" &&
        (current.id !== saveStatus.id ||
          current.snapshot.name !== saveStatus.name ||
          (proposal?.effectId ?? null) !== saveStatus.agentEffectId)
      ) {
        this.setState(
          {
            prepared: null,
            activity: {
              kind: "failed",
              message:
                "This run differs from the missing copy. Restore the original run and name before retrying its save.",
            },
          },
          this.focusError.bind(this),
        );
        return;
      }
      requestId = crypto.randomUUID();
      props.saveChanged({
        kind: "workspaceRunSaveStarted",
        runKind: prepared.snapshot.kind,
        organisationId: props.connection.organisationId,
        requestId,
        id: prepared.id,
        name: prepared.snapshot.name,
        agentEffectId: proposal?.effectId ?? null,
      });
      const saved =
        proposal === null
          ? await savePreparedWorkspaceRun(
              props.connection.organisationId,
              props.connection.mutate,
              prepared,
              this.readback.bind(this),
            )
          : await savePreparedAgentWorkspaceRun(
              props.connection.organisationId,
              props.connection.mutate,
              prepared,
              proposal.effectId,
              this.readback.bind(this),
            );
      props.saveChanged({
        kind: "workspaceRunSaveSettled",
        runKind: prepared.snapshot.kind,
        organisationId: props.connection.organisationId,
        requestId,
        outcome: saved,
      });
      if (!this.current(generation)) return;
      this.setState({
        prepared: null,
        page: null,
        activity: { kind: "idle", message: "" },
      });
    } catch (error) {
      if (requestId !== null) {
        props.saveChanged({
          kind: "workspaceRunSaveSettled",
          runKind: prepared.snapshot.kind,
          organisationId: props.connection.organisationId,
          requestId,
          outcome: {
            kind: "outcome-unknown",
            id: prepared.id,
            message: `The save outcome for ${prepared.id} is uncertain. Check that run before another save.`,
          },
        });
      }
      this.fail(generation, error);
    }
  }

  private refresh(): void {
    void this.list([null]);
  }
  private async checkSavedRun(): Promise<void> {
    const props = this.props;
    const status = this.visibleSaveStatus();
    if (
      this.busy() ||
      (status.kind !== "outcome-unknown" &&
        status.kind !== "saved-readback-failed" &&
        status.kind !== "not-found")
    )
      return;
    const id =
      status.kind === "saved-readback-failed" ? status.snapshot.id : status.id;
    const name =
      status.kind === "saved-readback-failed"
        ? status.snapshot.name
        : status.name;
    const generation = ++this.generation;
    this.setState({ activity: { kind: "checking" } });
    try {
      const result = await verifyStoredWorkspaceRun(
        props.connection.organisationId,
        snapshotKind(props),
        id,
        name,
        this.readback.bind(this),
      );
      if (result.kind === "verified" && status.agentEffectId !== null) {
        const proposal = props.proposal;
        if (
          proposal === null ||
          proposal.effectId !== status.agentEffectId ||
          proposal.prepared.id !== id ||
          proposal.prepared.snapshot.name !== name
        )
          throw new Error(
            "The original agent-prepared copy is unavailable. Reopen this workspace before trying another save.",
          );
        const replayed = await savePreparedAgentWorkspaceRun(
          props.connection.organisationId,
          props.connection.mutate,
          proposal.prepared,
          proposal.effectId,
          this.readback.bind(this),
        );
        if (replayed.kind !== "verified" || replayed.snapshot.id !== id)
          throw new Error(
            "The saved copy is present, but its agent receipt is still uncertain. Check it again before another save.",
          );
      }
      props.saveChanged({
        kind:
          result.kind === "verified"
            ? "workspaceRunSaveRecovered"
            : "workspaceRunSaveMissing",
        runKind: snapshotKind(props),
        organisationId: props.connection.organisationId,
        requestId: status.requestId,
        id,
        name,
      });
      if (!this.current(generation)) return;
      this.setState({ activity: { kind: "idle", message: "" } });
    } catch (error) {
      this.fail(generation, error);
    }
  }
  private next(): void {
    const page = this.state.page;
    if (page === null || page.nextCursor === null) return;
    void this.list([...page.cursors, page.nextCursor]);
  }
  private previous(): void {
    const page = this.state.page;
    if (page === null || page.cursors.length <= 1) return;
    const [, ...following] = page.cursors;
    void this.list([null, ...following.slice(0, -1)]);
  }
  private focusPage(focus: boolean): void {
    if (focus) this.pageHeading.current?.focus();
  }
  private focusError(): void {
    this.errorMessage.current?.focus();
  }
  private async list(cursors: PageCursors): Promise<void> {
    if (this.busy()) return;
    const generation = ++this.generation;
    const focus = this.state.page !== null;
    this.setState({ activity: { kind: "listing" } });
    try {
      const page = await readWorkspaceRuns(
        this.props.connection.organisationId,
        snapshotKind(this.props),
        cursors.at(-1) ?? null,
        controlRead,
      );
      if (!this.current(generation)) return;
      let message: string;
      if (page.snapshots.length === 0) {
        message =
          page.nextCursor === null
            ? `No saved ${snapshotKind(this.props)} runs on this page.`
            : `No saved ${snapshotKind(this.props)} runs on this page. Continue to the next page.`;
      } else {
        message = `Page ${cursors.length} · ${page.snapshots.length} saved ${page.snapshots.length === 1 ? "run" : "runs"}.`;
      }
      this.setState(
        {
          page: {
            snapshots: page.snapshots,
            nextCursor: page.nextCursor,
            cursors,
          },
          activity: {
            kind: "idle",
            message,
          },
        },
        this.focusPage.bind(this, focus),
      );
    } catch (error) {
      this.fail(generation, error);
    }
  }

  private async open(id: string): Promise<void> {
    if (this.busy() || this.props.open === null) return;
    const generation = ++this.generation;
    this.setState({ activity: { kind: "opening" } });
    try {
      await this.props.open(id);
      if (!this.current(generation)) return;
      this.setState({
        activity: {
          kind: "idle",
          message:
            "Saved run ready for review. Confirm Use saved run to restore its setup and recorded results.",
        },
      });
    } catch (error) {
      this.fail(generation, error);
    }
  }

  private current(generation: number): boolean {
    return this.mounted && this.generation === generation;
  }
  private fail(generation: number, error: unknown): void {
    if (this.current(generation))
      this.setState(
        {
          activity: {
            kind: "failed",
            message:
              error instanceof Error
                ? error.message
                : "Unable to access saved runs. Check your connection and retry.",
          },
        },
        this.focusError.bind(this),
      );
  }

  private renderSavedRun(saved: RunSnapshotSummary): React.ReactNode {
    return (
      <li key={saved.id}>
        <button
          type="button"
          disabled={this.busy() || this.props.open === null}
          onClick={this.open.bind(this, saved.id)}
        >
          Open {saved.name}
        </button>
        <small> · {new Date(saved.savedAt).toLocaleString()}</small>
      </li>
    );
  }

  render(): React.ReactNode {
    const busy = this.busy();
    const prepared = this.props.proposal?.prepared ?? this.state.prepared;
    const saveReviewBlocked = this.saveReviewBlocked();
    const activity = this.state.activity;
    const saveStatus = this.visibleSaveStatus();
    const recoveryId = saveRecoveryId(saveStatus);
    return (
      <section
        className="workcell-save-run"
        aria-label="Workspace saved runs"
        aria-busy={busy}
      >
        <h4>
          {this.props.kind !== "rehearsal-run"
            ? "Workspace production runs"
            : "Workspace saved runs"}
        </h4>
        <p>
          Named copies are shared with this workspace. Saving keeps the setup
          and connected evidence; it never starts equipment.
        </p>
        {this.props.connection.canManage && this.props.source !== null ? (
          <form onSubmit={this.prepare.bind(this)}>
            <label htmlFor="workcell-snapshot-name">Run name (required)</label>
            <input
              ref={this.nameInput}
              id="workcell-snapshot-name"
              name="runName"
              required
              pattern=".*\S.*"
              maxLength={80}
              value={this.state.name}
              onChange={this.changeName.bind(this)}
              disabled={busy || saveReviewBlocked}
            />
            <button type="submit" disabled={busy || saveReviewBlocked}>
              Review save
            </button>
          </form>
        ) : (
          <p>
            {this.props.connection.canManage
              ? "Prepare a run to save a shared copy."
              : "A workspace admin can save shared copies. You can open existing copies."}
          </p>
        )}
        {prepared !== null && (
          <div className="workcell-save-review">
            <h5 ref={this.reviewHeading} tabIndex={-1}>
              Review shared run save
            </h5>
            {this.props.proposal !== null && (
              <p>
                Chat prepared this copy for review. Confirming saves these
                frozen bytes and leaves your current run unchanged.
              </p>
            )}
            <p>
              Save “{prepared.snapshot.name}” as a shared{" "}
              {prepared.snapshot.kind} copy? The frozen document is{" "}
              {prepared.bytes.toLocaleString()} bytes. Run ID:{" "}
              <code>{prepared.id}</code>
            </p>
            {prepared.kind === "artifacts" && (
              <p>
                This save also retains {prepared.files.length} verified
                artifacts. Publication completes after every referenced file is
                stored.
              </p>
            )}
            <button
              type="button"
              disabled={busy || saveReviewBlocked}
              onClick={this.save.bind(this)}
            >
              Confirm save
            </button>
            <button
              type="button"
              disabled={busy || agentSaveRecoveryPending(saveStatus)}
              onClick={this.cancelReview.bind(this)}
            >
              Cancel
            </button>
          </div>
        )}
        {recoveryId !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={this.checkSavedRun.bind(this)}
          >
            Check saved run {recoveryId.slice(0, 12)}
          </button>
        )}
        {this.props.open === null && (
          <p>Close this run to open another saved copy.</p>
        )}
        <button type="button" onClick={this.refresh.bind(this)} disabled={busy}>
          Refresh saved runs
        </button>
        {this.state.page !== null && (
          <>
            <h5 ref={this.pageHeading} tabIndex={-1}>
              Saved runs · Page {this.state.page.cursors.length}
            </h5>
            <ul>
              {this.state.page.snapshots.map(this.renderSavedRun.bind(this))}
            </ul>
            <nav aria-label="Saved run pages">
              <button
                type="button"
                disabled={busy || this.state.page.cursors.length <= 1}
                onClick={this.previous.bind(this)}
              >
                Previous saved runs
              </button>
              <button
                type="button"
                disabled={busy || this.state.page.nextCursor === null}
                onClick={this.next.bind(this)}
              >
                Next saved runs
              </button>
            </nav>
          </>
        )}
        <p role="status">{panelStatusMessage(saveStatus, activity)}</p>
        <p ref={this.errorMessage} role="alert" tabIndex={-1}>
          {activity.kind === "failed" ? activity.message : ""}
        </p>
      </section>
    );
  }
}

function sourceIdentity(props: Props): unknown {
  return props.kind === "persistent-production"
    ? (props.source?.identity ?? null)
    : props.source;
}

function snapshotKind(props: Props): RunSnapshotKind {
  return props.kind === "rehearsal-run" ? "rehearsal" : props.kind;
}

function saveRecoveryId(status: WorkspaceRunSaveStatus): string | null {
  switch (status.kind) {
    case "saved-readback-failed":
      return status.snapshot.id;
    case "outcome-unknown":
    case "not-found":
      return status.id;
    case "idle":
    case "saving":
    case "verified":
    case "readback-confirmed":
      return null;
    default:
      return assertNever(status);
  }
}

function agentSaveRecoveryPending(status: WorkspaceRunSaveStatus): boolean {
  return (
    status.kind !== "idle" &&
    status.agentEffectId !== null &&
    (status.kind === "saving" ||
      status.kind === "outcome-unknown" ||
      status.kind === "saved-readback-failed")
  );
}

function saveStatusMessage(status: WorkspaceRunSaveStatus): string {
  switch (status.kind) {
    case "idle":
      return "";
    case "saving":
      return `Saving “${status.name}” as run ${status.id}…`;
    case "verified":
      return `Saved and verified “${status.snapshot.name}”. Run ID: ${status.snapshot.id}.`;
    case "saved-readback-failed":
      return `Saved “${status.snapshot.name}”, but readback could not be verified. Check that exact copy before any new save. ${status.message}`;
    case "outcome-unknown":
      return status.message;
    case "readback-confirmed":
      return `Saved copy “${status.name}” was verified by exact readback. Run ID: ${status.id}.`;
    case "not-found":
      return `Saved run ${status.id} was not found. Review and retry only the same run and name. You can check this ID again before retrying.`;
    default:
      return assertNever(status);
  }
}

function panelStatusMessage(
  status: WorkspaceRunSaveStatus,
  activity: Activity,
): string {
  if (activity.kind === "checking") return "Checking the exact saved run…";
  const saveMessage = saveStatusMessage(status);
  if (saveMessage !== "") return saveMessage;
  if (activity.kind === "idle") return activity.message;
  if (activity.kind === "failed") return "";
  return "Working on workspace saved runs…";
}

async function prepareSource(
  props: Props,
  name: string,
): Promise<PreparedWorkspaceRun> {
  if (props.source === null)
    throw new Error("Prepare or pause a run before saving it.");
  switch (props.kind) {
    case "persistent-production":
      return props.source.prepare(name);
    case "production":
      return prepareProductionWorkspaceRun(
        props.connection.organisationId,
        name,
        props.source,
        readProductionScenario,
      );
    case "rehearsal-run":
      return prepareRehearsalRunWorkspace(name, props.source);
    default:
      return assertNever(props);
  }
}
