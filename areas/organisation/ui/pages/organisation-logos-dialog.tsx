import React from "react";

import { ControlApiError } from "@purin-labs/control/portal/control-client";
import { logoPath } from "@purin-labs/control/portal/control-paths";
import { IdentityTile } from "@purin-labs/ui/index";
import { AgentModal } from "./agent-modal";

/** The image types and the size that Pantry keeps as a logo. */
const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";
const LOGO_MAX_BYTES = 1024 * 1024;

/** The organisation or one of its workspaces, as the dialog shows it. */
export type LogoSubjectItem = Readonly<{
  /** Null for the organisation itself. */
  workspaceId: string | null;
  /** The tile's gradient comes from this id when there is no logo. */
  seed: string;
  name: string;
  logo: string | null;
}>;

export type LogoActions = Readonly<{
  set: (
    organisationId: string,
    workspaceId: string | null,
    file: File,
  ) => Promise<void>;
  remove: (organisationId: string, workspaceId: string | null) => Promise<void>;
}>;

type RowState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * The logos of one organisation and of each of its workspaces. A subject
 * with no logo shows its gradient tile; "Choose image…" uploads a logo and
 * "Remove" brings the gradient back.
 */
export function OrganisationLogosDialog(props: {
  readonly organisationId: string;
  readonly organisationName: string;
  readonly subjects: readonly LogoSubjectItem[];
  readonly actions: LogoActions;
  readonly refresh: () => void;
  readonly close: () => void;
}): React.ReactNode {
  return (
    <AgentModal
      title="Logos"
      description="PNG, JPEG or WebP, up to 1 MB. Square images look best."
      close={props.close}
      footer={
        <button
          type="button"
          className="modal-secondary-button"
          onClick={props.close}
        >
          Done
        </button>
      }
    >
      <ul
        className="organisation-logo-list"
        aria-label={`Logos of ${props.organisationName}`}
      >
        {props.subjects.map((subject) => (
          <LogoRow
            key={subject.workspaceId ?? "organisation"}
            organisationId={props.organisationId}
            subject={subject}
            actions={props.actions}
            refresh={props.refresh}
          />
        ))}
      </ul>
    </AgentModal>
  );
}

function LogoRow(props: {
  readonly organisationId: string;
  readonly subject: LogoSubjectItem;
  readonly actions: LogoActions;
  readonly refresh: () => void;
}): React.ReactNode {
  const [state, setState] = React.useState<RowState>({ kind: "idle" });
  const input = React.useRef<HTMLInputElement>(null);
  const busy = state.kind === "busy";
  const run = async (change: () => Promise<void>): Promise<void> => {
    setState({ kind: "busy" });
    try {
      await change();
      setState({ kind: "idle" });
      props.refresh();
    } catch (error) {
      setState({ kind: "failed", message: logoErrorMessage(error) });
    }
  };
  const choose = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) return;
    if (
      !LOGO_ACCEPT.split(",").includes(file.type) ||
      file.size > LOGO_MAX_BYTES
    ) {
      setState({
        kind: "failed",
        message: "Use a PNG, JPEG or WebP image of 1 MB or less.",
      });
      return;
    }
    void run(() =>
      props.actions.set(props.organisationId, props.subject.workspaceId, file),
    );
  };
  const errorId = `logo-error-${props.subject.seed}`;
  return (
    <li className="organisation-logo-row">
      <IdentityTile
        seed={props.subject.seed}
        name={props.subject.name}
        logoUrl={
          props.subject.logo === null
            ? null
            : logoPath(
                props.organisationId,
                props.subject.workspaceId,
                props.subject.logo,
              )
        }
      />
      <span className="organisation-logo-name">
        <strong>{props.subject.name}</strong>
        <small>
          {props.subject.workspaceId === null ? "Organisation" : "Workspace"}
        </small>
      </span>
      <span className="organisation-logo-actions">
        {props.subject.logo === null ? null : (
          <button
            type="button"
            className="modal-secondary-button"
            disabled={busy}
            onClick={() =>
              void run(() =>
                props.actions.remove(
                  props.organisationId,
                  props.subject.workspaceId,
                ),
              )
            }
          >
            Remove
          </button>
        )}
        <button
          type="button"
          className="modal-secondary-button"
          disabled={busy}
          aria-describedby={state.kind === "failed" ? errorId : undefined}
          onClick={() => input.current?.click()}
        >
          {busy ? "Saving…" : "Choose image…"}
        </button>
        <input
          ref={input}
          type="file"
          accept={LOGO_ACCEPT}
          hidden
          aria-label={`Logo of ${props.subject.name}`}
          onChange={choose}
        />
      </span>
      {state.kind === "failed" ? (
        <p
          id={errorId}
          className="error-text organisation-logo-error"
          role="alert"
        >
          {state.message}
        </p>
      ) : null}
    </li>
  );
}

function logoErrorMessage(error: unknown): string {
  const status = error instanceof ControlApiError ? error.status : null;
  // The owner check answers 404, so a role that changed reads as 404.
  if (status === 403 || status === 404)
    return "Only an owner can change logos.";
  if (status === 422) return "Use a PNG, JPEG or WebP image of 1 MB or less.";
  return "Pantry could not save the logo. Try again.";
}
