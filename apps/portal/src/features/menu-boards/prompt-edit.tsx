import React from "react";
import { newConversationId, type ConversationId } from "@purin-labs/control-api";
import type { CollaborationAgentActivity } from "@purin-labs/collaboration";
import {
  menuBoardElementProps,
  type MenuBoardElement,
  type MenuBoardSnapshot,
} from "@purin-labs/menu-board-crdt/board";
import { captureBakeryBrowserContext } from "../bakery-browser-context";
import { readChat } from "../chat/api";
import { sendChat } from "../chat/screen-send";
import { controlAnswer, controlRead, controlWrite } from "../../control-client";
import { controlPath } from "../../control-paths";
import type { MenuBoardClient } from "./board-client";
import "./prompt-edit.css";
import type { Variant } from "@purin-labs/type-utils";

/**
 * Prompt to edit (Plan 40B phase 5, slice 9): the person selects elements
 * and tells the agent what to change. The message goes to a new Portal chat
 * with the board page, so the agent knows what "this" is. The agent edits
 * the shared draft with its own board tools, under the person's own checks;
 * the person sees the change at once and can undo it here.
 */

type Ask =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "sending" }>
  | Readonly<{
      kind: "asked";
      conversationId: ConversationId;
      /** The selected elements as they were when the person asked. */
      before: readonly MenuBoardElement[];
      /** The words that the person sent, to ask again after a permission. */
      words: string;
      /** The chat's answers before this request; a new one is the reply. */
      answersBefore: number;
      reply: string | null;
      /**
       * A step that the platform held: this private chat's words may reach
       * the shared board only when the person allows it.
       */
      held: string | null;
      /** The agent's label showed on one of them. */
      byAgent: string | null;
      undone: boolean;
    }>
  | Readonly<{ kind: "failed"; message: string }>;

const REPLY_POLL_MS = 1_500;

export function PromptEdit(props: Readonly<{
  organisationId: string;
  board: MenuBoardSnapshot;
  selection: readonly MenuBoardElement[];
  agents: readonly CollaborationAgentActivity[];
  editable: boolean;
  client: React.RefObject<MenuBoardClient | null>;
  names: Readonly<Record<MenuBoardElement["kind"], string>>;
}>): React.ReactNode {
  const [text, setText] = React.useState("");
  const [ask, setAsk] = React.useState<Ask>({ kind: "idle" });
  const conversationId = ask.kind === "asked" ? ask.conversationId : null;
  const waiting = ask.kind === "asked" && ask.reply === null;
  const answersBefore = ask.kind === "asked" ? ask.answersBefore : 0;
  // The agent's reply, read from the chat until the turn ends.
  React.useEffect(() => {
    if (conversationId === null || !waiting) return;
    let current = true;
    const timer = setInterval(() => {
      void readChat(props.organisationId, conversationId, "", "observe").then((data) => {
        const chat = data.conversation;
        if (!current || chat === null || chat.work.kind !== "ready") return;
        const answers = chat.messages.filter((message) => message.kind === "assistant");
        if (answers.length <= answersBefore) return;
        const answer = answers.at(-1);
        void heldStep(props.organisationId, conversationId).then((held) => {
          if (!current) return;
          setAsk((state) => state.kind === "asked" && state.conversationId === conversationId
            ? { ...state, reply: answer?.text ?? "Sous Chef did not answer. Open the chat for details.", held }
            : state);
        });
      }).catch(() => undefined);
    }, REPLY_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [props.organisationId, conversationId, waiting, answersBefore]);
  // The agent's label on a selected element names it as the author.
  const asked = ask.kind === "asked" ? ask : null;
  const agentOnSelection = asked === null ? undefined : props.agents.find((activity) =>
    asked.before.some((element) => element.id === activity.target));
  React.useEffect(() => {
    if (agentOnSelection === undefined) return;
    setAsk((state) => state.kind === "asked" && state.byAgent === null
      ? { ...state, byAgent: agentOnSelection.agent.displayName }
      : state);
  }, [agentOnSelection]);
  const changed = asked === null ? [] : changedSince(asked.before, props.board);
  /** Sends the words in a new chat, or again in the same chat. */
  const sendWords = async (words: string, previous: Variant<Ask, "asked"> | null): Promise<void> => {
    setAsk({ kind: "sending" });
    try {
      const data = await readChat(props.organisationId, previous?.conversationId ?? null, "", "observe");
      const model = data.conversation?.model ?? (data.model.kind === "ready" ? data.model.selected : null);
      if (model === null) throw new Error("Connect an AI before you ask the agent.");
      const id = previous?.conversationId ?? newConversationId();
      await sendChat(props.organisationId, {
        kind: "message",
        conversationId: id,
        requestId: crypto.randomUUID(),
        model,
        text: words,
        browserContext: await captureBakeryBrowserContext(props.organisationId, id),
      });
      setAsk({
        kind: "asked",
        conversationId: id,
        before: previous?.before ?? props.selection,
        words,
        answersBefore: data.conversation?.messages.filter((message) => message.kind === "assistant").length ?? 0,
        reply: null,
        held: null,
        byAgent: null,
        undone: false,
      });
    } catch (error) {
      setAsk({ kind: "failed", message: error instanceof Error ? error.message : "The request could not be sent. Try again." });
    }
  };
  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const instruction = text.trim();
    if (instruction.length === 0 || props.selection.length === 0) return;
    const names = props.selection.map((element) => props.names[element.kind].toLowerCase()).join(", ");
    setText("");
    await sendWords(`${instruction}\n\n(About the selected ${names} on the board “${props.board.title}”.)`, null);
  };
  /** The person allows the held step and asks again with the same words. */
  const allow = async (held: string, previous: Variant<Ask, "asked">): Promise<void> => {
    const answer = await controlAnswer(controlWrite(
      controlPath(props.organisationId, `access-control/held-outputs/${encodeURIComponent(held)}/decision`),
      "POST",
      { decision: "allow" },
    ));
    if (!answer.ok) {
      setAsk({ kind: "failed", message: "The permission could not be saved. Allow it under Permission requests in the account menu." });
      return;
    }
    await sendWords(previous.words, previous);
  };
  if (!props.editable) return null;
  return <section className="menu-board-prompt" aria-label="Ask the agent">
    <form onSubmit={(event) => void submit(event)}>
      <label>
        <span>Ask Sous Chef to change {props.selection.length === 1 ? "this element" : `these ${props.selection.length} elements`}</span>
        <textarea
          value={text}
          rows={2}
          maxLength={2000}
          placeholder="Say that the soup changes every day"
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <button type="submit" className="secondary" disabled={ask.kind === "sending" || waiting || text.trim().length === 0}>
        {ask.kind === "sending" ? "Sending…" : "Ask Sous Chef"}
      </button>
    </form>
    {ask.kind === "failed" ? <p className="description-draft-error" role="alert">{ask.message}</p> : null}
    {asked === null ? null : <div className="menu-board-prompt-result" role="status">
      <p>{asked.reply === null ? "Sous Chef is working on it…" : asked.reply}</p>
      {asked.held === null ? null : <>
        <p>Sous Chef needs your permission to put the words of this chat on the shared board.</p>
        <button type="button" className="secondary" onClick={() => void allow(asked.held ?? "", asked)}>
          Allow and ask again
        </button>
      </>}
      {changed.length > 0 && !asked.undone ? <>
        <p>
          {asked.byAgent === null ? "Changed since you asked" : `${asked.byAgent} changed`}:{" "}
          {changed.map((element) => props.names[element.kind]).join(", ")}.
        </p>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            props.client.current?.restoreElements(changed);
            setAsk({ ...asked, undone: true });
          }}
        >
          {asked.byAgent === null ? "Undo these changes" : `Undo ${asked.byAgent}’s change`}
        </button>
      </> : null}
      {asked.undone ? <>
        <p>Undone. Your board has the words again.</p>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            // The undo was this person's own edit, so their Undo takes it back.
            props.client.current?.undo();
            setAsk({ ...asked, undone: false });
          }}
        >
          Bring the change back
        </button>
      </> : null}
      {chatLink(asked.conversationId)}
    </div>}
  </section>;
}

/** The held step of this chat, if the platform holds one, or null. */
async function heldStep(organisationId: string, conversationId: ConversationId): Promise<string | null> {
  const answer = await controlAnswer(controlRead(controlPath(organisationId, "access-control/permission-requests")));
  const raw = answer.body;
  if (!answer.ok || typeof raw !== "object" || raw === null) return null;
  const held = Reflect.get(raw, "heldOutputs");
  if (!Array.isArray(held)) return null;
  for (const entry of held as unknown[])
    if (typeof entry === "object" && entry !== null && Reflect.get(entry, "conversationId") === conversationId) {
      const id = Reflect.get(entry, "requestId");
      if (typeof id === "string" && /^[0-9a-f]{32}$/u.test(id)) return id;
    }
  return null;
}

/** The asked elements, as they were, that differ from the board now. */
function changedSince(before: readonly MenuBoardElement[], board: MenuBoardSnapshot): MenuBoardElement[] {
  const now = new Map([...board.elements, ...board.unplaced].map((element) => [element.id, element]));
  return before.filter((element) => {
    const current = now.get(element.id);
    return current === undefined || signature(current) !== signature(element);
  });
}

function signature(element: MenuBoardElement): string {
  return JSON.stringify([menuBoardElementProps(element), element.placement]);
}

/** A link to the chat, beside the Portal's own pages. */
function chatLink(conversationId: ConversationId): React.ReactNode {
  const path = window.location.pathname;
  if (!path.startsWith("/portal/")) return null;
  const href = `${path.replace(/\/[^/]*$/u, "/chat")}?conversation=${encodeURIComponent(conversationId)}`;
  return <a href={href}>Open the chat</a>;
}
