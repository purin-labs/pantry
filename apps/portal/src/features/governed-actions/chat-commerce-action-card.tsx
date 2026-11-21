import React from "react";
import { toast } from "sonner";
import {
  parseCommerceActionExecutionResponse,
  parseCommerceActionRecordResponse,
  type CommerceActionRecord,
} from "@purin-labs/commerce-control-api/portal/commerce-actions";
import { parseCommerceApprovalResponse } from "@purin-labs/control-api/portal/portal-reads";
import { ControlApiError, controlMutation, controlRead } from "../../control-client";
import {
  clearPendingCommerceApproval,
  currentPortalPath,
  readPendingCommerceApproval,
  writePendingCommerceApproval,
} from "../../portal-commerce-approval";
import { commerceActionStateLabel, commerceActionTitle } from "./commerce";
import { commerceActionDetailSummary, renderCommerceActionChange } from "./commerce-action-status";
import { signInForApproval } from "../../approval-sign-in-popup";
import { DecisionButtons } from "../../ui";
import "./chat-commerce-action-card.css";

/**
 * A commerce change that the chat agent proposed, as a card in the chat
 * (the owner: "the approval prompts should either be in the LLM chat, 1
 * click to confirm"). The agent's answer names the action by its Operations
 * link; the card under the answer shows the same before and after as the
 * Operations card. One click approves the change and applies it, with the
 * same step-up sign-in and role checks; a person who may not approve sees
 * who can.
 */

const ACTION_LINK = /[?&]commerceAction=([A-Za-z0-9_-]{1,128})/gu;
/** Marks an action whose step-up sign-in began in a chat card, to apply it after. */
const APPLY_AFTER_SIGN_IN_KEY = "pantry:commerce-apply-after-approval";

/** The actions that an answer links to, each once, in order. */
function linkedCommerceActions(text: string): readonly string[] {
  return [...new Set([...text.matchAll(ACTION_LINK)].map((match) => match[1] ?? ""))].filter(
    (nonce) => nonce.length > 0,
  );
}

/**
 * The answer without its links to the actions, which the cards under it
 * show: a person decides in the card, not on another page.
 */
export function withoutCommerceActionLinks(text: string): string {
  return text
    .replace(/\s*\[[^\]\n]*\]\([^)\s]*[?&]commerceAction=[A-Za-z0-9_-]{1,128}[^)\s]*\)\.?/gu, "")
    .replace(/\s*\(?<?https?:\/\/\S*[?&]commerceAction=[A-Za-z0-9_-]{1,128}\S*?>?\)?(?=\s|$)/gu, "")
    .replace(/\s*\(?\/portal\/\S*[?&]commerceAction=[A-Za-z0-9_-]{1,128}\S*?\)?(?=\s|$)/gu, "");
}

/** The cards for the actions that an assistant answer links to. */
export function chatCommerceActionCards(
  text: string,
  organisationId: string,
  canManage: boolean,
): React.ReactNode {
  const nonces = linkedCommerceActions(text);
  if (nonces.length === 0) return null;
  return nonces.map((nonce) => <ChatCommerceActionCard
    key={nonce}
    organisationId={organisationId}
    nonce={nonce}
    canManage={canManage}
  />);
}

type CardState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ready"; action: CommerceActionRecord }>;

function actionPath(organisationId: string, nonce: string, step = ""): string {
  return `/v1/control/organisations/${encodeURIComponent(organisationId)}/commerce/actions/${encodeURIComponent(nonce)}${step}`;
}

function ChatCommerceActionCard(props: Readonly<{
  organisationId: string;
  nonce: string;
  canManage: boolean;
}>): React.ReactNode {
  const [state, setState] = React.useState<CardState>({ kind: "loading" });
  const [busy, setBusy] = React.useState<"approve" | "reject" | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const read = React.useCallback(async (): Promise<CommerceActionRecord | null> => {
    try {
      const action = parseCommerceActionRecordResponse(await controlRead(actionPath(props.organisationId, props.nonce)));
      setState({ kind: "ready", action });
      return action;
    } catch (failure) {
      // A person who may not read the action sees no card; any other
      // failure keeps the card with a way to read it again.
      setState(failure instanceof ControlApiError && (failure.status === 403 || failure.status === 404)
        ? { kind: "missing" }
        : { kind: "unavailable" });
      return null;
    }
  }, [props.organisationId, props.nonce]);

  const apply = React.useCallback(async (): Promise<void> => {
    const raw = await controlMutation(
      actionPath(props.organisationId, props.nonce, "/execute"),
      "POST",
      {},
      undefined,
      `commerce-action-execute:${props.nonce}`,
    );
    const status = parseCommerceActionExecutionResponse(raw);
    await read();
    if (status.state === "confirmed") toast.success("The change is live.");
    else if (status.state === "failed") toast.error("The change failed. Check the card for the recorded outcome.");
    else toast.info("The shop has not confirmed the change yet. Check this card again later.");
  }, [props.organisationId, props.nonce, read]);

  const approveThenApply = React.useCallback(async (): Promise<void> => {
    // The approval key is the action's own, so a second approval after the
    // step-up sign-in replays the first one.
    const approval = await controlMutation(
      actionPath(props.organisationId, props.nonce, "/approval"),
      "POST",
      {},
      undefined,
      `commerce-action-approval:${props.nonce}`,
    );
    parseCommerceApprovalResponse(approval);
    await apply();
  }, [props.organisationId, props.nonce, apply]);

  // Back from the step-up sign-in that this card began: approve (a replay
  // when the Portal approved it already) and apply, so one click is enough.
  React.useEffect(() => {
    let current = true;
    void read().then(async (action) => {
      if (!current || action === null || !takeApplyAfterSignIn(props.nonce)) return;
      if (action.state !== "proposed" && action.state !== "approval_requested" && action.state !== "signed") return;
      setBusy("approve");
      try {
        if (action.state === "signed") await apply();
        else await approveThenApply();
      } catch {
        setError("The change could not be approved and applied. Try again.");
        await read();
      } finally {
        setBusy(null);
      }
    });
    return () => {
      current = false;
    };
  }, [read, apply, approveThenApply, props.nonce]);

  if (state.kind === "loading") return <section className="chat-commerce-action" aria-busy="true" aria-label="Proposed change">Loading the proposed change…</section>;
  if (state.kind === "missing") return null;
  if (state.kind === "unavailable") return <section className="chat-commerce-action" aria-label="Proposed change">
    <p className="chat-commerce-action-summary">Seams Pantry cannot read this proposed change now, so it cannot be approved yet.</p>
    <div className="chat-commerce-action-buttons">
      <button type="button" className="secondary-button" onClick={() => { setState({ kind: "loading" }); void read(); }}>Try again</button>
    </div>
  </section>;
  const action = state.action;
  const waiting = action.state === "proposed" || action.state === "approval_requested";
  const signed = action.state === "signed";

  const approve = async (): Promise<void> => {
    setBusy("approve");
    setError(null);
    try {
      try {
        await approveThenApply();
      } catch (first) {
        if (!(first instanceof ControlApiError && first.kind === "approval_step_up_required")) throw first;
        // The sign-in opens in a small window; this page stays.
        const signIn = await signInForApproval(props.organisationId, props.nonce);
        if (signIn === "blocked") throw first;
        try {
          await approveThenApply();
        } catch (second) {
          if (second instanceof ControlApiError && second.kind === "approval_step_up_required") {
            setError("The sign-in did not finish, so nothing changed. Try again.");
            await read();
            return;
          }
          throw second;
        }
      }
    } catch (failure) {
      // A browser that blocks the window signs in on this page instead.
      if (failure instanceof ControlApiError && failure.kind === "approval_step_up_required") {
        markApplyAfterSignIn(props.nonce);
        const returnPath = currentPortalPath();
        writePendingCommerceApproval({ organisationId: props.organisationId, actionNonce: props.nonce, returnPath, createdAt: Date.now() });
        const query = new URLSearchParams({ purpose: "approval", organisation: props.organisationId, action: props.nonce, returnTo: returnPath });
        window.location.assign(`/v1/control/auth/google/start?${query.toString()}`);
        return;
      }
      setError(failure instanceof Error ? failure.message : "The change could not be approved. Try again.");
      await read();
    } finally {
      setBusy(null);
    }
  };

  const reject = async (): Promise<void> => {
    setBusy("reject");
    setError(null);
    try {
      await controlMutation(
        actionPath(props.organisationId, props.nonce, "/rejection"),
        "POST",
        { reason: "merchant_declined" },
        undefined,
        `commerce-action-rejection:${props.nonce}`,
      );
      const pending = readPendingCommerceApproval();
      if (pending?.actionNonce === props.nonce) clearPendingCommerceApproval(pending);
      toast.info("Change rejected. Nothing changed in the shop.");
      await read();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The change could not be rejected. Try again.");
    } finally {
      setBusy(null);
    }
  };

  return <section className="chat-commerce-action" aria-label={commerceActionTitle(action.verb)}>
    <header>
      <h3>{commerceActionTitle(action.verb)}</h3>
      <span className={`action-state action-state-${action.state}`}>{commerceActionStateLabel(action.state)}</span>
    </header>
    <p className="chat-commerce-action-summary">{commerceActionDetailSummary(action.details)}</p>
    <div className="chat-commerce-action-change">{renderCommerceActionChange(action, null)}</div>
    {(waiting || signed) && !props.canManage ? <p className="notice-text">An owner or admin can approve this change.</p> : null}
    {(waiting || signed) && props.canManage ? <DecisionButtons
      className="chat-commerce-action-buttons"
      groupLabel="Decide on this change"
      disabled={busy !== null}
      allow={{
        label: busy === "approve" ? "Applying…" : signed ? "Apply change" : "Approve and apply",
        className: "primary-button",
        onSelect: signed ? applyNow : approve,
      }}
      refuse={waiting ? {
        label: "Reject",
        className: "secondary-button",
        onSelect: reject,
        confirm: {
          label: "Reject change",
          className: "danger-button",
          keepLabel: "Keep proposal",
          keepClassName: "secondary-button",
          resetWhenDone: true,
        },
      } : null}
    /> : null}
    {error === null ? null : <p className="description-draft-error" role="alert">{error}</p>}
  </section>;

  async function applyNow(): Promise<void> {
    setBusy("approve");
    setError(null);
    try {
      await apply();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The change could not be applied. Try again.");
    } finally {
      setBusy(null);
    }
  }
}

function markApplyAfterSignIn(nonce: string): void {
  try {
    sessionStorage.setItem(APPLY_AFTER_SIGN_IN_KEY, nonce);
  } catch {
    return;
  }
}

function takeApplyAfterSignIn(nonce: string): boolean {
  try {
    if (sessionStorage.getItem(APPLY_AFTER_SIGN_IN_KEY) !== nonce) return false;
    sessionStorage.removeItem(APPLY_AFTER_SIGN_IN_KEY);
    return true;
  } catch {
    return false;
  }
}
