import React from "react";

import type {
  AgentDocumentRevision,
  AgentOperationKind,
  AgentRevisionTarget,
} from "@purin-labs/commerce-control-api/portal/agent-operations";
import { Notice, RecoverableError } from "@purin-labs/ui/page-components";
import {
  MutationFeedback,
  type AgentOperationMutationState,
  type AgentOperationSubmitter,
} from "./agent-console-shared";
import { assertNever } from "@purin-labs/std";

export type AgentRevisionLoader = (
  target: AgentRevisionTarget,
) => Promise<readonly AgentDocumentRevision[]>;

type DiffLine = {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
};

const DIFF_LINE_CAP = 400;

/**
 * Line diff for markdown documents: common prefix and suffix are trimmed,
 * the middle is aligned with a longest-common-subsequence pass. Documents
 * whose changed middle exceeds the cap fall back to a plain replace block so
 * the view stays responsive.
 */
export function diffLines(before: string, after: string): readonly DiffLine[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix);
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix);
  const lines: DiffLine[] = beforeLines.slice(0, prefix).map(sameLine);
  if (
    beforeMiddle.length > DIFF_LINE_CAP ||
    afterMiddle.length > DIFF_LINE_CAP
  ) {
    lines.push(...beforeMiddle.map(removedLine), ...afterMiddle.map(addedLine));
  } else {
    lines.push(...alignedDiff(beforeMiddle, afterMiddle));
  }
  lines.push(...beforeLines.slice(beforeLines.length - suffix).map(sameLine));
  return lines;
}

function alignedDiff(
  before: readonly string[],
  after: readonly string[],
): readonly DiffLine[] {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Uint32Array(rows * columns);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] =
        before[i] === after[j]
          ? (table[(i + 1) * columns + j + 1] ?? 0) + 1
          : Math.max(
              table[(i + 1) * columns + j] ?? 0,
              table[i * columns + j + 1] ?? 0,
            );
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const beforeText = before[i] ?? "";
    const afterText = after[j] ?? "";
    if (beforeText === afterText) {
      lines.push(sameLine(beforeText));
      i += 1;
      j += 1;
    } else if (
      (table[(i + 1) * columns + j] ?? 0) >= (table[i * columns + j + 1] ?? 0)
    ) {
      lines.push(removedLine(beforeText));
      i += 1;
    } else {
      lines.push(addedLine(afterText));
      j += 1;
    }
  }
  lines.push(
    ...before.slice(i).map(removedLine),
    ...after.slice(j).map(addedLine),
  );
  return lines;
}

function sameLine(text: string): DiffLine {
  return { kind: "same", text };
}

function addedLine(text: string): DiffLine {
  return { kind: "added", text };
}

function removedLine(text: string): DiffLine {
  return { kind: "removed", text };
}

export function DiffView(props: {
  readonly before: string;
  readonly after: string;
  readonly label: string;
}): React.ReactNode {
  const lines = diffLines(props.before, props.after);
  if (lines.every((line) => line.kind === "same")) {
    return <p className="empty-state">No differences.</p>;
  }
  return (
    <pre className="agent-diff" aria-label={props.label}>
      {lines.map(renderDiffLine)}
    </pre>
  );
}

function renderDiffLine(line: DiffLine, index: number): React.ReactNode {
  const marker =
    line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ";
  return (
    <span className={`agent-diff-line agent-diff-${line.kind}`} key={index}>
      {marker} {line.text}
      {"\n"}
    </span>
  );
}

/**
 * Markdown document editor with a kept draft, automatic concurrency, and
 * diff-based conflict resolution (plan 30 phase 2). The draft survives
 * snapshot refreshes; hidden fields (including expectedRevision) re-render
 * from the latest snapshot, so after a conflict the operator publishes their
 * draft on top of the newest revision without retyping anything.
 */
export function DocumentEditor(props: {
  readonly formKey: string;
  readonly operation: AgentOperationKind;
  readonly hidden: readonly { readonly name: string; readonly value: string }[];
  readonly fieldName: "instructions" | "markdownBody";
  readonly label: string;
  readonly submitLabel: string;
  readonly currentBody: string;
  readonly currentRevision: number;
  readonly rows: number;
  readonly submit: AgentOperationSubmitter;
  readonly mutation: AgentOperationMutationState;
  readonly busy: boolean;
  readonly history: {
    readonly target: AgentRevisionTarget;
    readonly load: AgentRevisionLoader;
  } | null;
  /** The id of the form. With it, the caller renders the submit button,
   * for example in a drawer footer, and the editor renders none. */
  readonly formId?: string;
  /** Called after a publish succeeds. */
  readonly onPublished?: () => void;
}): React.ReactNode {
  const [draft, setDraft] = React.useState<string | null>(null);
  const editor = React.useRef<HTMLTextAreaElement>(null);
  const value = draft ?? props.currentBody;
  const conflicted =
    props.mutation.kind === "failed" &&
    props.mutation.formKey === props.formKey &&
    props.mutation.conflict &&
    draft !== null &&
    draft !== props.currentBody;
  return (
    <div className="agent-document-editor">
      <form
        id={props.formId}
        className="stacked-form"
        onSubmit={submitDocument.bind(
          null,
          props.formKey,
          props.operation,
          props.submit,
          setDraft,
          props.onPublished,
        )}
      >
        {props.hidden.map(renderHiddenField)}
        <label>
          <span>{props.label}</span>
          <textarea
            ref={editor}
            name={props.fieldName}
            required
            rows={props.rows}
            value={value}
            onChange={updateDraft.bind(null, setDraft)}
          />
        </label>
        {props.formId === undefined ? (
          <button type="submit" disabled={props.busy}>
            {props.submitLabel}
          </button>
        ) : null}
      </form>
      <MutationFeedback mutation={props.mutation} formKey={props.formKey} />
      {conflicted ? (
        <div className="agent-conflict" role="status">
          <p>
            Revision {props.currentRevision} was published while you were
            editing. Your draft is kept above; the differences against the
            latest published text are shown below. Publishing again applies your
            draft on top of the latest revision.
          </p>
          <DiffView
            before={props.currentBody}
            after={draft}
            label="Draft compared with the latest published text"
          />
          <button
            type="button"
            className="secondary-button"
            onClick={discardDraft.bind(null, setDraft)}
          >
            Discard my draft and use the latest text
          </button>
        </div>
      ) : null}
      {props.history === null ? null : (
        <RevisionHistory
          target={props.history.target}
          load={props.history.load}
          currentRevision={props.currentRevision}
          onRestore={restoreDocumentDraft.bind(null, setDraft, editor)}
        />
      )}
    </div>
  );
}

function renderHiddenField(field: {
  readonly name: string;
  readonly value: string;
}): React.ReactNode {
  return (
    <input
      type="hidden"
      name={field.name}
      value={field.value}
      key={`${field.name}:${field.value}`}
    />
  );
}

function submitDocument(
  formKey: string,
  operation: AgentOperationKind,
  submit: AgentOperationSubmitter,
  setDraft: React.Dispatch<React.SetStateAction<string | null>>,
  onPublished: (() => void) | undefined,
  event: React.FormEvent<HTMLFormElement>,
): void {
  void submit(formKey, operation, event).then(
    clearDraftWhenPublished.bind(null, setDraft, onPublished),
  );
}

function clearDraftWhenPublished(
  setDraft: React.Dispatch<React.SetStateAction<string | null>>,
  onPublished: (() => void) | undefined,
  published: boolean,
): void {
  if (!published) return;
  setDraft(null);
  onPublished?.();
}

function updateDraft(
  setDraft: React.Dispatch<React.SetStateAction<string | null>>,
  event: React.ChangeEvent<HTMLTextAreaElement>,
): void {
  setDraft(event.currentTarget.value);
}

function restoreDocumentDraft(
  setDraft: React.Dispatch<React.SetStateAction<string | null>>,
  editor: React.RefObject<HTMLTextAreaElement | null>,
  body: string,
): void {
  setDraft(body);
  editor.current?.focus();
}

function discardDraft(
  setDraft: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  setDraft(null);
}

type RevisionHistoryState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly revisions: readonly AgentDocumentRevision[];
    }
  | { readonly kind: "failed" };

function RevisionHistory(props: {
  readonly target: AgentRevisionTarget;
  readonly load: AgentRevisionLoader;
  readonly currentRevision: number;
  readonly onRestore: ((body: string) => void) | null;
}): React.ReactNode {
  const [state, setState] = React.useState<RevisionHistoryState>({
    kind: "idle",
  });
  return (
    <details
      className="agent-revision-history"
      onToggle={loadOnOpen.bind(null, props, state, setState)}
    >
      <summary>Revision history</summary>
      {renderRevisionHistory(props, state, setState)}
    </details>
  );
}

function loadOnOpen(
  props: Parameters<typeof RevisionHistory>[0],
  state: RevisionHistoryState,
  setState: React.Dispatch<React.SetStateAction<RevisionHistoryState>>,
  event: React.SyntheticEvent<HTMLDetailsElement>,
): void {
  if (!event.currentTarget.open || state.kind !== "idle") return;
  void loadRevisionHistory(props, setState);
}

async function loadRevisionHistory(
  props: Parameters<typeof RevisionHistory>[0],
  setState: React.Dispatch<React.SetStateAction<RevisionHistoryState>>,
): Promise<void> {
  setState({ kind: "loading" });
  try {
    const revisions = await props.load(props.target);
    setState({ kind: "ready", revisions });
  } catch {
    setState({ kind: "failed" });
  }
}

function renderRevisionHistory(
  props: Parameters<typeof RevisionHistory>[0],
  state: RevisionHistoryState,
  setState: React.Dispatch<React.SetStateAction<RevisionHistoryState>>,
): React.ReactNode {
  switch (state.kind) {
    case "idle":
      return null;
    case "loading":
      return (
        <Notice tone="neutral" announcement="polite">
          Loading revision history…
        </Notice>
      );
    case "failed":
      return (
        <RecoverableError
          message="Revision history could not be loaded."
          action={
            <button
              type="button"
              onClick={runAsyncLoad.bind(null, props, setState)}
            >
              Try again
            </button>
          }
        />
      );
    case "ready":
      return (
        <div className="agent-revision-list">
          {state.revisions.map(renderRevision.bind(null, props))}
        </div>
      );
    default:
      return assertNever(state, "Unhandled revision history state");
  }
}

function runAsyncLoad(
  props: Parameters<typeof RevisionHistory>[0],
  setState: React.Dispatch<React.SetStateAction<RevisionHistoryState>>,
): void {
  void loadRevisionHistory(props, setState);
}

function renderRevision(
  props: Parameters<typeof RevisionHistory>[0],
  revision: AgentDocumentRevision,
): React.ReactNode {
  return (
    <article className="agent-revision" key={revision.revision}>
      <div className="agent-revision-heading">
        <h5>
          Revision {revision.revision}
          {revision.revision === props.currentRevision ? " · current" : ""}
        </h5>
        <span>{new Date(revision.createdAt).toLocaleString()}</span>
      </div>
      <details>
        <summary>Show text</summary>
        <pre className="agent-document-preview">{revision.body}</pre>
      </details>
      {props.onRestore === null ||
      revision.revision === props.currentRevision ? null : (
        <button
          type="button"
          className="secondary-button"
          aria-label={`Load into editor: revision ${revision.revision}`}
          onClick={restoreRevision.bind(null, props.onRestore, revision.body)}
        >
          Load into editor
        </button>
      )}
    </article>
  );
}

function restoreRevision(
  onRestore: (body: string) => void,
  body: string,
): void {
  onRestore(body);
}
