import React from "react";
import { controlRead, controlWrite } from "../../control-client";
import { parseSharedThreadResponse } from "@seams/control-api/portal/slack-thread";

type SharedThreadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "ready"; threadUrl: string | null }>
  | Readonly<{ kind: "saving"; threadUrl: string | null }>
  | Readonly<{ kind: "failed"; threadUrl: string | null; message: string }>;

export function SlackThreadControl(props: Readonly<{
  path: string;
  description: string;
}>): React.ReactNode {
  const [state, setState] = React.useState<SharedThreadState>({ kind: "loading" });
  const id = React.useId();
  React.useEffect(loadSharedThread.bind(null, props.path, setState), [props.path]);
  if (state.kind === "loading") return <p>Loading Slack authoring…</p>;
  return <section className="description-draft-reference collaboration-slack-thread" aria-label="Slack authoring">
    {state.threadUrl !== null
      ? <p><a href={state.threadUrl} target="_blank" rel="noreferrer">Connected Slack thread</a></p>
      : null}
    <details>
      <summary>{state.threadUrl === null ? "Connect a Slack thread" : "Change the Slack thread"}</summary>
      <p>{props.description}</p>
      <form className="stacked-form" onSubmit={saveSharedThread.bind(null, props.path, state.threadUrl, setState)}>
        <label htmlFor={id}>Slack thread link</label>
        <input
          id={id}
          name="threadUrl"
          type="url"
          defaultValue={state.threadUrl ?? ""}
          placeholder="https://your-workspace.slack.com/archives/…"
        />
        <div className="description-draft-editor-footer">
          <button type="submit" name="action" value="connect" disabled={state.kind === "saving"}>
            Connect and share with collaborators
          </button>
          {state.threadUrl !== null
            ? <button type="submit" name="action" value="disconnect" className="secondary" disabled={state.kind === "saving"}>
                Disconnect thread
              </button>
            : null}
        </div>
        {state.kind === "failed" ? <p>{state.message}</p> : null}
      </form>
    </details>
  </section>;
}

function loadSharedThread(
  path: string,
  setState: React.Dispatch<React.SetStateAction<SharedThreadState>>,
): () => void {
  const request = { active: true, setState };
  void readSharedThread(path, request);
  return cancelSharedThreadRead.bind(null, request);
}

function cancelSharedThreadRead(request: { active: boolean }): void {
  request.active = false;
}

async function readSharedThread(
  path: string,
  request: { active: boolean; setState: React.Dispatch<React.SetStateAction<SharedThreadState>> },
): Promise<void> {
  try {
    const threadUrl = parseSharedThreadResponse(await controlRead(path));
    if (request.active) request.setState({ kind: "ready", threadUrl });
  } catch {
    if (request.active) {
      request.setState({
        kind: "failed",
        threadUrl: null,
        message: "Slack authoring setup requires an owner or admin. Refresh to retry.",
      });
    }
  }
}

async function saveSharedThread(
  path: string,
  threadUrl: string | null,
  setState: React.Dispatch<React.SetStateAction<SharedThreadState>>,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const submitter = event.nativeEvent instanceof SubmitEvent ? event.nativeEvent.submitter : null;
  const disconnect = submitter instanceof HTMLButtonElement && submitter.value === "disconnect";
  const link = form.get("threadUrl");
  if (!disconnect && (typeof link !== "string" || link.trim().length === 0)) {
    setState({
      kind: "failed",
      threadUrl,
      message: "Paste the link to a Slack thread where Sous Chef has already replied.",
    });
    return;
  }
  setState({ kind: "saving", threadUrl });
  try {
    const saved = parseSharedThreadResponse(
      await controlWrite(
        path,
        disconnect ? "DELETE" : "PUT",
        disconnect ? undefined : { threadUrl: typeof link === "string" ? link.trim() : "" },
      ),
    );
    setState({ kind: "ready", threadUrl: saved });
  } catch {
    setState({
      kind: "failed",
      threadUrl,
      message: "Could not save. Use a thread from this workspace’s connected Slack channel, and sign in as an owner or admin.",
    });
  }
}
