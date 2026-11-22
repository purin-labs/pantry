import type { CollaborationAgent } from "@purin-labs/collaboration";
import { resolveCanvasCollaborationAgent } from "../../actors/collaboration-agent";
import type { HarnessToolArgumentObserver } from "../../actors/embedded-harness";
import type { MenuBoardDraftEdit } from "../../actors/menu-board-agent-action";
import { requireActiveOrganisationActorAtPlacement } from "../../actors/actor-router";
import { readSessionTurnFlowBinding } from "../../actors/agent-session-information-flow";
import { sessionTurnExecution } from "../../chat/turn-access";
import { CAPABILITY_KEYS } from "../../authorization/capability-catalogue";
import { traceLog, traceWarn } from "@purin-labs/kernel/observability";
import { newRequestId } from "@purin-labs/kernel/ids";
import type { SessionToolContext } from "../context";
import {
  collaborationEditDeadline,
  collaborationMember,
  passSharedDraftExit,
} from "../session-support";
import { harnessCapabilitiesFromCapabilityKeys } from "../catalog/code-mode";
import { requireLiveMenuDraftAuthority } from "./handlers";
import { draftBoardId, draftEdit } from "./board-draft-edit";

/**
 * Plan 40B phase 7, slices 3 and 4: a board edit shows on the board while
 * the model writes its arguments. A new text shows as a box at the rect
 * that the model wrote, and then its text letter by letter; a text change
 * shows its text so far on the element; a move shows the box where the
 * element goes. All of it comes from the model's real tool arguments.
 *
 * Before the first frame of a call, the Session runs the checks of the
 * edit: the live menu draft authority, the edit capability, an editor of
 * the board, and the flow exit of a shared draft with the turn's current
 * binding, in its check form that asks nobody. If a check fails, no frame
 * reaches the room, and the edit later fails or asks on its own checks. A
 * frame is presence: the room never stores it, and the edit stays one
 * atomic change whose accepted value replaces the draft text.
 */

/** At most 10 frames a second for each call. */
const FRAME_INTERVAL_MS = 100;
/** A tool call waits at most this long for its frames before it runs. */
const SETTLE_LIMIT_MS = 1_500;

type DraftCall = {
  readonly previewId: string;
  boardId: string | null;
  latest: MenuBoardDraftEdit | null;
  checked: Promise<PreviewAuthority | null> | null;
  authority: PreviewAuthority | null;
  sent: string | null;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  chain: Promise<void>;
};

type PreviewAuthority = Readonly<{
  agent: CollaborationAgent;
  userId: import("@purin-labs/control-api/ids").UserId;
}>;

export function createMenuBoardDraftPreview(
  context: SessionToolContext,
): HarnessToolArgumentObserver {
  const calls = new Map<string, DraftCall>();
  const startedAt = Date.now();

  const send = (call: DraftCall, draft: MenuBoardDraftEdit | null): void => {
    call.chain = call.chain.then(async () => {
      const authority = call.authority;
      if (authority === null || call.boardId === null) return;
      const key = JSON.stringify(draft);
      if (key === call.sent) return;
      call.sent = key;
      call.sentAt = Date.now();
      try {
        const organisation = await requireActiveOrganisationActorAtPlacement({
          env: context.env,
          organisationId: context.execution.scope.organisationId,
          placement: context.execution.scope.placement,
          now: Date.now(),
        });
        const result = await organisation.previewMenuBoardEdit({
          agent: authority.agent,
          execution: sessionTurnExecution(context.lease),
          organisationId: context.execution.scope.organisationId,
          boardId: call.boardId,
          previewId: call.previewId,
          draft,
          userId: authority.userId,
          deadlineAt: collaborationEditDeadline(
            context.storage,
            context.lease,
            { kind: "direct" },
            startedAt,
          ),
        });
        // A refused frame stops the preview: the edit has its own checks.
        if (!result.ok) call.authority = null;
      } catch (error) {
        call.authority = null;
        traceWarn("menu_board.draft_preview_failed", {
          requestId: newRequestId(),
          session_id: String(context.lease.session.sessionId),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

  const schedule = (call: DraftCall, now: boolean): void => {
    if (call.authority === null) return;
    if (now) {
      if (call.timer !== null) clearTimeout(call.timer);
      call.timer = null;
      send(call, call.latest);
      return;
    }
    if (call.timer !== null) return;
    call.timer = setTimeout(
      () => {
        call.timer = null;
        send(call, call.latest);
      },
      Math.max(0, FRAME_INTERVAL_MS - (Date.now() - call.sentAt)),
    );
  };

  return {
    observe(input) {
      if (input.name !== "menu_board_edit") return;
      const draft = draftEdit(input.arguments);
      const boardId = draftBoardId(input.arguments, input.complete);
      if (draft === null || boardId === null) return;
      let call = calls.get(input.callId);
      if (call === undefined) {
        call = {
          previewId: `draft:${input.callId.slice(0, 200)}`,
          boardId,
          latest: null,
          checked: null,
          authority: null,
          sent: null,
          sentAt: 0,
          timer: null,
          chain: Promise.resolve(),
        };
        calls.set(input.callId, call);
      }
      if (call.boardId !== boardId) return;
      call.latest = draft;
      if (call.checked === null) {
        const pending = call;
        pending.checked = previewAuthority(context, boardId);
        pending.chain = pending.chain.then(async () => {
          pending.authority = (await pending.checked) ?? null;
        });
        pending.chain.then(
          () => schedule(pending, input.complete),
          () => undefined,
        );
        return;
      }
      schedule(call, input.complete);
    },
    abandon() {
      for (const call of calls.values()) {
        if (call.timer !== null) clearTimeout(call.timer);
        call.timer = null;
        if (call.sent !== null) send(call, null);
      }
      calls.clear();
    },
    async settle() {
      const waits = [...calls.values()].map((call) => {
        if (call.timer !== null) schedule(call, true);
        return call.chain;
      });
      calls.clear();
      if (waits.length === 0) return;
      await Promise.race([
        Promise.all(waits),
        new Promise((resolve) => setTimeout(resolve, SETTLE_LIMIT_MS)),
      ]);
    },
  };
}

/** The checks of a board edit, in the form that asks nobody. */
async function previewAuthority(
  context: SessionToolContext,
  boardId: string,
): Promise<PreviewAuthority | null> {
  const { env, storage, execution, lease, assignment } = context;
  try {
    const capabilities = harnessCapabilitiesFromCapabilityKeys(
      assignment.authorityPartition.capabilityKeys,
    );
    if (
      !capabilities.ok ||
      !capabilities.value.some(
        (capability) => capability === CAPABILITY_KEYS.commerceMenuDraftEdit,
      )
    )
      throw new Error("The turn has no menu draft edit capability");
    await requireLiveMenuDraftAuthority(execution, storage, lease);
    const organisationId = execution.scope.organisationId;
    const member = await collaborationMember(
      execution.scope.database,
      organisationId,
      lease,
      "edit",
    );
    const current = await readSessionTurnFlowBinding(storage.sql, {
      organisationId,
      sessionId: lease.session.sessionId,
      turnId: lease.turn.turnId,
    });
    if (
      !current.ok ||
      current.value === null ||
      current.value.authorityPartitionDigest !== lease.authorityPartitionDigest
    )
      throw new Error("The turn's flow binding is unavailable");
    await passSharedDraftExit(
      env,
      execution,
      lease,
      member,
      {
        draft: "Menu board",
        capabilityId: CAPABILITY_KEYS.commerceMenuDraftEdit,
        integrationAccountId: "platform",
        resourceScope: `menu-board:${boardId}`,
      },
      current.value.binding.flowLabel,
      [],
      "check",
    );
    return {
      agent: await resolveCanvasCollaborationAgent(execution.scope, assignment),
      userId: member.userId,
    };
  } catch (error) {
    // A failed check shows nothing; the edit reports its own failure.
    traceLog("menu_board.draft_preview_refused", {
      requestId: newRequestId(),
      session_id: String(lease.session.sessionId),
      reason: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
