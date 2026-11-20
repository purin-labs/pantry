import React from "react";
import {
  parseMenuBoardCommentThreads,
  type MenuBoardCommentThread,
} from "@purin-labs/control-api";
import type { MenuBoardElement } from "@purin-labs/menu-board-crdt/board";
import { isRecord } from "@purin-labs/std";
import { controlAnswer, controlRead, controlWrite } from "../../control-client";
import { controlPath } from "../../control-paths";
import "./board-comments.css";

/**
 * Comments pinned to a board's elements (Plan 40B phase 5, slice 6). Every
 * member reads them; staff and above write them. A pin on an element shows
 * its open threads; the element's drawer shows its threads, and the board
 * list shows every open thread. Comments never reach a screen.
 */

/** Other people's comments appear within this time. */
const COMMENT_POLL_MS = 5_000;
const COMMENT_TEXT_LIMIT = 1000;

export type BoardComments = Readonly<{
  threads: readonly MenuBoardCommentThread[];
  error: string | null;
  add: (target: Readonly<{ elementId: string } | { threadId: string }>, body: string) => Promise<boolean>;
  resolve: (threadId: string, resolved: boolean) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
}>;

export function useBoardComments(organisationId: string, boardId: string): BoardComments {
  const [threads, setThreads] = React.useState<readonly MenuBoardCommentThread[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const path = controlPath(organisationId, `menu-boards/${encodeURIComponent(boardId)}/comments`);
  // A read that began before a change of this person's is older than the
  // change's answer, so it is dropped.
  const generation = React.useRef(0);
  React.useEffect(() => {
    let current = true;
    const load = async (): Promise<void> => {
      const started = generation.current;
      const read = await commentRequest(path, "GET");
      if (current && read.ok && started === generation.current) setThreads(read.threads);
    };
    void load();
    const timer = setInterval(() => void load(), COMMENT_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [path]);
  const apply = async (result: Promise<CommentResponse>): Promise<boolean> => {
    generation.current += 1;
    const answered = await result;
    generation.current += 1;
    if (answered.ok) {
      setThreads(answered.threads);
      setError(null);
      return true;
    }
    setError(answered.message);
    return false;
  };
  return {
    threads,
    error,
    add: (target, body) => apply(commentRequest(path, "POST", {
      elementId: "elementId" in target ? target.elementId : null,
      threadId: "threadId" in target ? target.threadId : null,
      body,
      operationId: crypto.randomUUID().replaceAll("-", ""),
    })),
    resolve: async (threadId, resolved) => {
      await apply(commentRequest(`${path}/${encodeURIComponent(threadId)}`, "PATCH", { resolved }));
    },
    remove: async (commentId) => {
      await apply(commentRequest(`${path}/${encodeURIComponent(commentId)}`, "DELETE"));
    },
  };
}

type CommentResponse =
  | Readonly<{ ok: true; threads: readonly MenuBoardCommentThread[] }>
  | Readonly<{ ok: false; message: string }>;

async function commentRequest(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  body?: unknown,
): Promise<CommentResponse> {
  const answer = await controlAnswer(method === "GET" ? controlRead(path) : controlWrite(path, method, body));
  const raw = answer.body;
  const threads = answer.ok && isRecord(raw) ? parseMenuBoardCommentThreads(raw.threads) : null;
  if (threads !== null) return { ok: true, threads };
  return { ok: false, message: commentFailure(isRecord(raw) ? raw.error : undefined) };
}

function commentFailure(code: unknown): string {
  switch (code) {
    case "organisation_role_insufficient":
      return "Only staff, admins and owners can comment on a board.";
    case "menu_board_comment_not_author":
      return "Only the person who wrote a comment can delete it.";
    case "menu_board_comment_limit":
      return "This board has 300 comments. Delete old ones before you add another.";
    case "menu_board_element_missing":
      return "That element is not on the board now.";
    case "menu_board_comment_missing":
      return "That comment was deleted.";
    case "menu_board_comment_invalid":
      return "A comment needs 1 to 1000 characters.";
    default:
      return "The comment could not be saved. Try again.";
  }
}

/** The open threads on each element. */
function openThreadsByElement(threads: readonly MenuBoardCommentThread[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const thread of threads)
    if (thread.resolvedAt === null) counts.set(thread.elementId, (counts.get(thread.elementId) ?? 0) + 1);
  return counts;
}

/**
 * A pin at the top right corner of each element with open threads, over the
 * board that the browser drew. The pins follow the drawn boxes, so they fit
 * a fixed layout and the free canvas alike.
 */
export function CommentPins(props: Readonly<{
  area: React.RefObject<HTMLElement | null>;
  threads: readonly MenuBoardCommentThread[];
  /** Changes whenever the board may have moved, so the pins measure again. */
  revision: unknown;
  onOpen: (elementId: string) => void;
}>): React.ReactNode {
  const [pins, setPins] = React.useState<readonly Readonly<{ elementId: string; left: number; top: number; count: number }>[]>([]);
  const counts = React.useMemo(() => openThreadsByElement(props.threads), [props.threads]);
  React.useLayoutEffect(() => {
    const area = props.area.current;
    if (area === null) return;
    const measure = (): void => {
      const box = area.getBoundingClientRect();
      const next = [];
      for (const node of area.querySelectorAll<HTMLElement>(".menu-board [data-element-id]")) {
        const elementId = node.dataset.elementId;
        const count = elementId === undefined ? 0 : (counts.get(elementId) ?? 0);
        if (elementId === undefined || count === 0) continue;
        const rect = node.getBoundingClientRect();
        next.push({ elementId, left: rect.right - box.left, top: rect.top - box.top, count });
      }
      setPins(next);
    };
    // The board draws its new scale one frame after the area resizes, as
    // when a person zooms the canvas, so each change measures twice.
    let frame = 0;
    const remeasure = (): void => {
      measure();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    remeasure();
    const observer = new ResizeObserver(remeasure);
    observer.observe(area);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [props.area, counts, props.revision]);
  return pins.map((pin) => <button
    key={pin.elementId}
    type="button"
    className="menu-board-comment-pin"
    data-element-id={pin.elementId}
    style={{ left: pin.left, top: pin.top }}
    aria-label={pin.count === 1 ? "1 open comment" : `${pin.count} open comments`}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      props.onOpen(pin.elementId);
    }}
  >
    {pin.count}
  </button>);
}

/** The threads of one element, in its drawer, with a box for a new one. */
export function ElementComments(props: Readonly<{
  elementId: string;
  comments: BoardComments;
  editable: boolean;
}>): React.ReactNode {
  const threads = props.comments.threads.filter((thread) => thread.elementId === props.elementId);
  const open = threads.filter((thread) => thread.resolvedAt === null);
  const resolved = threads.filter((thread) => thread.resolvedAt !== null);
  return <section className="menu-board-comments" aria-label="Comments">
    <h4>Comments</h4>
    {open.length === 0 && resolved.length === 0 ? <p className="menu-boards-drawer-note">No comments on this element.</p> : null}
    {open.map((thread) => <CommentThread key={thread.threadId} thread={thread} comments={props.comments} editable={props.editable} />)}
    {props.editable ? <CommentComposer
      label="New comment"
      action="Comment"
      onSubmit={(body) => props.comments.add({ elementId: props.elementId }, body)}
    /> : null}
    {resolved.length > 0 ? <>
      <h4>Resolved</h4>
      {resolved.map((thread) => <CommentThread key={thread.threadId} thread={thread} comments={props.comments} editable={props.editable} />)}
    </> : null}
    {props.comments.error === null ? null : <p className="description-draft-error" role="alert">{props.comments.error}</p>}
  </section>;
}

/** Every open thread of the board, for when no element is selected. */
export function BoardCommentList(props: Readonly<{
  comments: BoardComments;
  elements: readonly MenuBoardElement[];
  names: Readonly<Record<MenuBoardElement["kind"], string>>;
  onOpen: (elementId: string) => void;
  editable: boolean;
}>): React.ReactNode {
  const open = props.comments.threads.filter((thread) => thread.resolvedAt === null);
  if (open.length === 0) return null;
  return <aside className="menu-board-comment-list" aria-label="Open comments">
    <h3>Open comments</h3>
    <ul>
      {open.map((thread) => {
        const element = props.elements.find((candidate) => candidate.id === thread.elementId);
        const first = thread.comments[0];
        return <li key={thread.threadId}>
          {thread.onBoard && element !== undefined
            ? <button type="button" className="secondary" onClick={() => props.onOpen(thread.elementId)}>
              {props.names[element.kind]}
            </button>
            : <span className="menu-board-comment-off">Not on the board now</span>}
          <span className="menu-board-comment-preview">{first?.author.name}: {first?.body}</span>
          {!thread.onBoard && props.editable
            ? <button type="button" className="secondary" onClick={() => void props.comments.resolve(thread.threadId, true)}>Resolve</button>
            : null}
        </li>;
      })}
    </ul>
  </aside>;
}

function CommentThread(props: Readonly<{
  thread: MenuBoardCommentThread;
  comments: BoardComments;
  editable: boolean;
}>): React.ReactNode {
  const { thread } = props;
  const resolved = thread.resolvedAt !== null;
  return <article className="menu-board-comment-thread" data-thread-id={thread.threadId} data-resolved={resolved ? "true" : undefined}>
    <ol>
      {thread.comments.map((comment) => <li key={comment.commentId}>
        <header>
          <strong>{comment.author.name}</strong>
          {comment.author.kind === "agent" ? <span className="menu-board-comment-agent">Agent</span> : null}
          <time dateTime={new Date(comment.createdAt).toISOString()}>{formatTime(comment.createdAt)}</time>
        </header>
        <p>{comment.body}</p>
        {comment.mine && props.editable
          ? <button type="button" className="menu-board-comment-link" onClick={() => void props.comments.remove(comment.commentId)}>
            Delete
          </button>
          : null}
      </li>)}
    </ol>
    {resolved ? <p className="menu-boards-drawer-note">Resolved by {thread.resolvedBy ?? "someone"}.</p> : null}
    {props.editable ? <div className="menu-board-comment-actions">
      {resolved ? null : <CommentComposer
        label="Reply"
        action="Reply"
        onSubmit={(body) => props.comments.add({ threadId: thread.threadId }, body)}
      />}
      <button type="button" className="secondary" onClick={() => void props.comments.resolve(thread.threadId, !resolved)}>
        {resolved ? "Reopen" : "Resolve"}
      </button>
    </div> : null}
  </article>;
}

function CommentComposer(props: Readonly<{
  label: string;
  action: string;
  onSubmit: (body: string) => Promise<boolean>;
}>): React.ReactNode {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (text.trim().length === 0) return;
    setBusy(true);
    const saved = await props.onSubmit(text);
    setBusy(false);
    if (saved) setText("");
  };
  return <form className="menu-board-comment-composer" onSubmit={(event) => void submit(event)}>
    <label>
      <span>{props.label}</span>
      <textarea
        value={text}
        rows={2}
        maxLength={COMMENT_TEXT_LIMIT}
        onChange={(event) => setText(event.target.value)}
      />
    </label>
    <button type="submit" className="secondary" disabled={busy || text.trim().length === 0}>
      {busy ? "Saving…" : props.action}
    </button>
  </form>;
}

function formatTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
