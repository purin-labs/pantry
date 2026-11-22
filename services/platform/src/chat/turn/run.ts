import {
  listOrganisationMembers,
  readActiveOrganisationMembershipRevision,
} from "@purin-labs/tenancy/data/control-plane";
import { readPendingSessionPermissionRequest } from "@purin-labs/authority/data/agent-permission-request";
import { decideChatFlowSink } from "@purin-labs/conversation/chat/information-flow";
import type { OrganisationExecutionScope } from "@purin-labs/tenancy/organisation-execution-scope";
import { chatUserMessage } from "@purin-labs/conversation/chat/attachments";
import { screenObservationReachesModel } from "../screen-observation-admission";
import {
  checkConversationDisclosure,
  conversationAudienceMayReceive,
} from "@purin-labs/conversation/chat/conversation-disclosure";
import { createTurnMemoryReader } from "../../memory/access";
import { listProjectMembers } from "@purin-labs/conversation/projects/access";
import { bindConversationTurnAccess } from "@purin-labs/conversation/chat/turn-access";
import { authorizeConversation } from "@purin-labs/conversation/chat/conversation-access";
import type {
  ChatPermissionRequest,
  ChatReceiptReference,
} from "@purin-labs/control-api";
import { bindCompletedChatHistory } from "@purin-labs/conversation/chat/forks";
import { currentProjectSnapshot } from "@purin-labs/conversation/chat/project-context-binding";
import { resolveCustomConnectorDetail } from "../../custom-connectors/projection";
import { FlowBinding } from "@purin-labs/authority/policy/information-flow/index";
import type { Env } from "@purin-labs/kernel/env";
import { readOrganisationCodexConnection } from "@purin-labs/agent/models/codex-connection";
import {
  deriveDirectCaseIdentities,
  deriveConversationTurnStream,
  processConversationCaseCommand,
  type ConversationCaseActor,
} from "@purin-labs/conversation/actors/case-direct-processing";
import {
  parseRequestId,
  type ControlSessionId,
  type RequestId,
} from "@purin-labs/kernel/ids";
import { traceLog } from "@purin-labs/kernel/observability";
import {
  ConversationGenerationFailure,
  conversationCommandFailure,
  traceConversationFailure,
} from "../generation-failure";
import { buildControlAuthority } from "@purin-labs/authority/request-authority/index";
import type { OrganisationModelRoute } from "@purin-labs/agent/models/route";
import { createWorkerMessageLinkEgress } from "@purin-labs/agent/messages/link-egress";
import {
  readConnectorDocumentation,
  parseConnectorAuthoringOutput,
} from "../../custom-connectors/authoring";
import { readChatConnectorStatus } from "../connector-status";
import {
  conversationTimeline,
  timelineVisibleMessages,
  normalizeConversationTimeline,
  type Conversation,
  type ConnectorCardTarget,
} from "@purin-labs/conversation/chat/conversation";
import { buildAssistantTimelineEvent } from "@purin-labs/conversation/chat/timeline";
import {
  readConversation,
  saveConversation,
  type ConversationScope,
} from "@purin-labs/conversation/chat/store";
import { conversationPrompt, workspaceCanvasPrompt } from "../prompt";
import { readLatestBakerySurfaceOfRequests } from "../../actors/bakery-surface-effect";
import type { Variant } from "@purin-labs/type-utils";
import {
  type ConversationExecutionFailure,
  type RunningConversation,
  authorizeConversationExecution,
  nextRunningWork,
} from "../application";
import { timelineEventCancelsRequest } from "./admission";
import {
  appendConfirmedSourceContexts,
  conversationRequestIds,
  currentUserBrowserContext,
  currentUserMessage,
  currentUserSurfaceContext,
  documentHasUrl,
  newerSurface,
  sharedMemberUserId,
} from "./context";
import { interruptConversation, settleConversationFailure } from "./failure";
import { defaultChatEffort } from "@purin-labs/conversation/chat/turn/model";
import {
  agentChatPermission,
  chatFlowDenialMessage,
  chatPermissionRequest,
  settleConversationPermission,
} from "./permission";
import { requestWasSteered } from "./steering";
import {
  addConversationModelUsage,
  appendBakerySurfaceTimelineEvents,
  appendMessageTimelineEvents,
  appendModelUsageToLatestAssistant,
  appendToolSettledTimelineEvent,
  appendToolStartedTimelineEvent,
  chatActionFlowSink,
  completedChatAction,
  documentationTool,
  emptyConversationModelUsage,
  nextTimelineSequence,
  writtenDocumentationAction,
} from "./timeline";

/**
 * The step was denied only because a workspace capability is off. The run
 * pauses with a permission request instead of failing; a resume runs the step
 * again under a new lease, so the denied completion is never delivered.
 */
class ConversationPermissionRequired extends Error {
  constructor(
    readonly step: number,
    readonly permission: ChatPermissionRequest,
  ) {
    super("conversation_permission_required");
  }
}

const MAX_CONVERSATION_STEPS = 8;

export async function runConversation(
  controlSessionId: ControlSessionId,
  env: Env,
  placement: OrganisationExecutionScope,
  scope: ConversationScope,
  initial: RunningConversation,
  initialRevision: number,
  model: OrganisationModelRoute,
  caseActor: ConversationCaseActor,
  actorIdentity: string,
): Promise<
  | { ok: true; conversation: Conversation }
  | { ok: false; error: ConversationExecutionFailure }
> {
  let conversation: Conversation = initial;
  let revision = initialRevision;
  const work = initial.work;
  let turnUsage = emptyConversationModelUsage();
  try {
    for (
      let step = work.stream.step;
      step < MAX_CONVERSATION_STEPS;
      step += 1
    ) {
      const requestId = parseRequestId(work.requestId);
      if (!requestId.ok) throw new Error("chat_identity_invalid");
      const authorityStartedAt = Date.now();
      // These reads share the captured scope and have no dependency on each
      // other. No prompt or Actor work is admitted until authorization succeeds.
      const [current, membershipRevision, connectors] = await Promise.all([
        authorizeConversationExecution(
          env,
          placement,
          scope,
          controlSessionId,
          conversation.id,
        ),
        readActiveOrganisationMembershipRevision({
          db: placement.database,
          organisationId: scope.organisationId,
        }),
        readChatConnectorStatus(placement, scope),
      ]);
      traceConversationPreparation(
        requestId.value,
        scope,
        "authorization_and_setup",
        authorityStartedAt,
      );
      if (!current.ok) {
        await interruptConversation(
          env,
          placement,
          scope,
          conversation.id,
          work.requestId,
          work.lease,
        );
        return current;
      }
      if (membershipRevision === null)
        throw new ConversationGenerationFailure(
          "The workspace must be active before its AI can run.",
        );
      const authority = buildControlAuthority({
        organisationId: scope.organisationId,
        requesterPersonId: current.membership.personId,
        userId: scope.userId,
        membershipRevision,
        role: current.membership.role,
      }).requestAuthority;
      const stableIdentity = conversationStepIdentity(
        actorIdentity,
        work.lease,
        step,
      );
      const turnIdentity = await deriveDirectCaseIdentities(stableIdentity);
      if (!turnIdentity.ok) throw new Error(turnIdentity.error.code);
      // The message's capture is old once an earlier step of this request,
      // or an earlier request of this chat that ran while the message waited
      // in the queue, has acted on the page. The observation then follows
      // the newest receipt.
      const capture = currentUserSurfaceContext(conversation);
      const latestSurface =
        capture === null
          ? null
          : newerSurface(
              capture,
              await readLatestBakerySurfaceOfRequests({
                db: placement.database,
                organisationId: scope.organisationId,
                userId: scope.userId,
                requestIds: conversationRequestIds(
                  conversation,
                  work.requestId,
                ),
                currentSessionId: turnIdentity.value.sessionId,
              }),
            );
      const prompt =
        current.access.access.kind === "workspace_canvas"
          ? workspaceCanvasPrompt(
              conversation,
              current.access.access.documentId,
            )
          : conversationPrompt(conversation, connectors, latestSurface, {
              surfaceObservation: screenObservationReachesModel(
                current.access.access,
                conversation,
              ),
            });
      if (
        !(await bindConversationTurnAccess(
          placement.database,
          scope,
          conversation.id,
          turnIdentity.value.sessionId,
          `turn_trigger_${turnIdentity.value.digest}`,
          controlSessionId,
        ))
      )
        return { ok: false, error: { kind: "conflict" } };
      const userMessage = currentUserMessage(conversation);
      const result = await processConversationCaseCommand(
        env,
        {
          scope: placement,
          organisationId: scope.organisationId,
          requestId: requestId.value,
          stableIdentity,
          triggerSource: {
            kind: "api",
            commandId: `request_chat_${work.lease}_${step}`,
          },
          content: {
            kind: "user_message",
            message: await chatUserMessage(
              env.ARCHIVE,
              scope.organisationId,
              userMessage.text,
              userMessage.attachments,
            ),
          },
          purpose: conversation.title,
          principal: {
            kind: "human",
            principalId: current.membership.personId,
          },
          requestAuthority: authority,
          receivedAt: Date.now(),
          role: "coordinator",
          objective: prompt,
          projectContext: currentProjectSnapshot(conversation),
          delivery: { kind: "none" },
          requiredModelRoute: model,
          thinkingLevel: conversation.effort ?? defaultChatEffort(model),
          browserContext: currentUserBrowserContext(conversation),
          surfaceContext: currentUserSurfaceContext(conversation),
          // A turn of a Portal conversation is offered the accepted Memory
          // that applies to Portal chats. The reply reaches each reader of
          // the conversation, so that whole audience must be able to
          // receive what the turn is shown.
          memoryReader: createTurnMemoryReader({
            env,
            execution: placement,
            organisationId: scope.organisationId,
            subjects: { applicability: [{ kind: "portal_chat" }] },
            destinationMayReceive: (label) =>
              conversationAudienceMayReceive(
                placement.database,
                placement.accountAccess,
                scope,
                conversation.id,
                label,
              ),
            now: Date.now(),
          }),
        },
        actorIdentity,
        caseActor,
      );
      if (!result.ok && result.error.code === "conversation_turn_running")
        return { ok: false, error: { kind: "turn_pending" } };
      if (!result.ok) throw conversationCommandFailure(result.error);
      if (result.value.kind !== "completed")
        throw new ConversationGenerationFailure(
          "The selected AI could not finish this response. Check its connection and budget, then retry.",
          `case_path:${result.value.kind}`,
        );
      turnUsage = addConversationModelUsage(
        turnUsage,
        result.value.completion.modelUsage,
      );
      const latest = await readConversation(
        placement.database,
        scope,
        conversation.id,
      );
      if (latest === null) return { ok: false, error: { kind: "conflict" } };
      if (
        latest.conversation.work.kind !== "running" ||
        latest.conversation.work.lease !== work.lease
      )
        return conversationTimeline(latest.conversation).some(
          timelineEventCancelsRequest.bind(null, work.requestId),
        )
          ? { ok: true, conversation: latest.conversation }
          : { ok: false, error: { kind: "conflict" } };
      if (latest.revision !== revision) {
        if (latest.conversation.work.stream.step !== step)
          return {
            ok: false,
            error: { kind: "conflict" },
          };
        conversation = latest.conversation;
        revision = latest.revision;
      }
      const reauthorized = await authorizeConversationExecution(
        env,
        placement,
        scope,
        controlSessionId,
        conversation.id,
      );
      if (!reauthorized.ok) {
        await interruptConversation(
          env,
          placement,
          scope,
          conversation.id,
          work.requestId,
          work.lease,
        );
        return reauthorized;
      }
      // The agent asked a person for what this step lacked. The step's
      // answer is not delivered; it runs again after an owner or admin
      // allows the request.
      const asked = await readPendingSessionPermissionRequest(
        placement.database,
        scope.organisationId,
        result.value.sessionId,
      );
      if (asked !== null)
        throw new ConversationPermissionRequired(
          step,
          agentChatPermission(asked),
        );
      const action = writtenDocumentationAction(
        completedChatAction(
          result.value.completion,
          requestWasSteered(conversation, work.requestId),
        ),
        timelineVisibleMessages(conversation),
      );
      const binding = await FlowBinding.restore(
        result.value.completion.flowBinding,
      );
      if (!binding.ok)
        throw new ConversationGenerationFailure(
          "The AI response is missing its data-flow receipt. Retry the response.",
        );
      const actionSink = chatActionFlowSink(
        action.ok ? action.value : { kind: "reply", text: action.error },
        authority,
        conversation.id,
      );
      if (
        actionSink.kind !== "conversation_delivery" &&
        actionSink.kind !== "tool_effect"
      )
        throw new Error("chat_action_sink_invalid");
      const sink = await decideChatFlowSink(
        placement.database,
        placement.accountAccess,
        binding.value,
        authority,
        actionSink,
      );
      if (sink.kind === "deny" || sink.kind === "approval_required") {
        const permission = await chatPermissionRequest(
          placement.database,
          scope,
          action,
          actionSink,
          work.requestId,
          step,
        );
        if (permission !== null)
          throw new ConversationPermissionRequired(step, permission);
      }
      if (sink.kind !== "allow")
        throw new ConversationGenerationFailure(
          sink.kind === "deny" || sink.kind === "approval_required"
            ? chatFlowDenialMessage(action, sink)
            : "The response’s source access could not be verified. Keep this chat private.",
        );
      const messages = [...timelineVisibleMessages(conversation)];
      const documents = [...conversation.documents];
      let timeline = conversationTimeline(conversation);
      const surfaceTimeline = await appendBakerySurfaceTimelineEvents({
        db: placement.database,
        scope,
        conversation,
        timeline,
      });
      timeline = await appendConfirmedSourceContexts(
        env,
        placement,
        scope,
        conversation,
        surfaceTimeline.timeline,
      );
      let finished = false;
      if (!action.ok) {
        messages.push({
          kind: "context",
          id: crypto.randomUUID(),
          text: action.error,
        });
      } else {
        switch (action.value.kind) {
          case "question": {
            const id = crypto.randomUUID();
            const question = action.value.question;
            const text = [question.title, question.description]
              .filter(Boolean)
              .join("\n\n");
            messages.push({ kind: "assistant", id, text });
            timeline = [
              ...timeline,
              buildAssistantTimelineEvent({
                eventId: id,
                sequence: nextTimelineSequence(timeline),
                requestId: work.requestId,
                createdAt: Date.now(),
                text,
                question,
              }),
            ];
            finished = true;
            break;
          }
          case "reply":
            messages.push({
              kind: "assistant",
              id: crypto.randomUUID(),
              text: action.value.text,
            });
            finished = true;
            break;
          case "read_documentation": {
            const tool = documentationTool(
              action.value.url,
              work.requestId,
              step,
            );
            timeline = appendToolStartedTimelineEvent(
              timeline,
              work.requestId,
              tool,
            );
            const fetched = await readConnectorDocumentation(
              [action.value.url],
              createWorkerMessageLinkEgress(
                env.MESSAGE_LINK_FETCH,
                placement.placement,
              ),
            );
            const receipt: ChatReceiptReference = fetched.ok
              ? {
                  receiptId: `receipt_${work.requestId}_${step}`,
                  state: "succeeded",
                  summary: `Read ${action.value.url}`,
                }
              : {
                  receiptId: `receipt_${work.requestId}_${step}`,
                  state: "failed",
                  summary: `Could not read ${action.value.url}`,
                };
            timeline = appendToolSettledTimelineEvent(
              timeline,
              work.requestId,
              tool,
              fetched.ok ? "succeeded" : "failed",
              receipt.summary,
              receipt,
            );
            messages.push({
              kind: "activity",
              id: crypto.randomUUID(),
              text: fetched.ok
                ? `Read ${action.value.url}`
                : `Could not read ${action.value.url}`,
            });
            if (!fetched.ok)
              messages.push({
                kind: "context",
                id: crypto.randomUUID(),
                text: fetched.error.reason,
              });
            else {
              for (const document of fetched.value) {
                const existing = documents.findIndex(
                  documentHasUrl.bind(null, document.url),
                );
                if (existing >= 0) documents.splice(existing, 1);
                documents.push(document);
              }
              while (documents.length > 8) documents.shift();
            }
            break;
          }
          case "revise":
          case "definition": {
            let target: ConnectorCardTarget = { kind: "new" };
            if (action.value.kind === "revise") {
              const detail = await resolveCustomConnectorDetail({
                db: placement.database,
                organisationId: scope.organisationId,
                connectorId: action.value.connectorId,
              });
              if (!detail.ok) {
                messages.push({
                  kind: "context",
                  id: crypto.randomUUID(),
                  text: "That connector is unavailable. Use a connector ID from the current server status.",
                });
                break;
              }
              target = {
                kind: "revision",
                connectorId: action.value.connectorId,
                expectedHeadRevision: detail.value.summary.headRevision,
              };
            }
            const validated = await parseConnectorAuthoringOutput(
              JSON.stringify({
                kind: "definition",
                document: action.value.document,
              }),
              documents,
            );
            if (validated.ok) {
              messages.push({
                kind: "connector",
                id: crypto.randomUUID(),
                text: "Review this connector, then add your key securely. Once connected, continue here with your first request.",
                document: validated.value,
                target,
              });
              finished = true;
            } else {
              messages.push({
                kind: "context",
                id: crypto.randomUUID(),
                text: validated.error.reason,
              });
              messages.push({
                kind: "activity",
                id: crypto.randomUUID(),
                text: "Revising the connector after validation.",
              });
            }
            break;
          }
        }
      }
      if (step === 7 && !finished) {
        messages.push({
          kind: "assistant",
          id: crypto.randomUUID(),
          text: "I’ve saved the documentation and checks so far. Send a more specific API reference or ask me to continue researching.",
        });
        finished = true;
      }
      const nextWork = finished
        ? ({ kind: "ready" } as const)
        : await nextRunningWork(actorIdentity, work, step + 1);
      conversation = normalizeConversationTimeline({
        lineage: conversation.lineage,
        historyBindings: conversation.historyBindings,
        id: conversation.id,
        title: conversation.title,
        modelRoute: conversation.modelRoute,

        documents,
        completedRequests: finished
          ? [...conversation.completedRequests, work.requestId]
          : conversation.completedRequests,
        work: nextWork,
        timeline: finished
          ? appendModelUsageToLatestAssistant(
              appendMessageTimelineEvents(
                conversation,
                messages,
                timeline,
                work.requestId,
              ),
              work.requestId,
              turnUsage,
            )
          : appendMessageTimelineEvents(
              conversation,
              messages,
              timeline,
              work.requestId,
            ),
        pendingInputs: conversation.pendingInputs,
        latestSequence: conversation.latestSequence,
        lastReadSequence: conversation.lastReadSequence,
        surfaceEventCursor: surfaceTimeline.cursor,
        draftText: conversation.draftText,
        draftUpdatedAt: conversation.draftUpdatedAt,
        effort: conversation.effort,
      });
      const completedStream = await deriveConversationTurnStream(
        stableIdentity,
        step,
      );
      if (!completedStream.ok) throw new Error(completedStream.error.code);
      conversation = await bindCompletedChatHistory(
        env,
        scope,
        conversation,
        work.requestId,
        result.value.sessionId,
        completedStream.value.turnId,
        finished,
      );
      const sharedAccess = await authorizeConversation(
        placement.database,
        scope,
        conversation.id,
      );
      if (sharedAccess !== null && sharedAccess.access.kind !== "private") {
        const members =
          sharedAccess.access.kind === "workspace_canvas"
            ? await listOrganisationMembers({
                db: placement.database,
                organisationId: scope.organisationId,
              })
            : await listProjectMembers(
                placement.database,
                scope,
                sharedAccess.access.sharedProjectId,
              );
        if (members === null)
          throw new ConversationGenerationFailure(
            "Project access changed before the response could be delivered.",
          );
        const disclosure = await checkConversationDisclosure(
          env,
          placement,
          scope,
          conversation,
          members.map(sharedMemberUserId),
          "completed_step",
        );
        if (disclosure.kind === "rejected")
          throw new ConversationGenerationFailure(
            "This response includes context that cannot be shared with every project member. Continue in a private chat.",
          );
      }
      const persisted = await persistCompletedConversationStep({
        env,
        placement,
        scope,
        conversation,
        revision,
        lease: work.lease,
        completedStep: step,
      });
      if (persisted === null) return { ok: false, error: { kind: "conflict" } };
      conversation = persisted.conversation;
      revision = persisted.revision;
      if (finished || conversation.work.kind === "failed")
        return { ok: true, conversation };
    }
  } catch (error) {
    if (error instanceof ConversationPermissionRequired) {
      const paused = await settleConversationPermission({
        placement,
        scope,
        conversationId: conversation.id,
        requestId: work.requestId,
        lease: work.lease,
        step: error.step,
        permission: error.permission,
      });
      if (paused === null) return { ok: false, error: { kind: "conflict" } };
      return { ok: true, conversation: paused };
    }
    // Transport/storage failures leave the durable obligation pending. A retry
    // reads the canonical completed turn and never repeats its model/tools.
    if (!(error instanceof ConversationGenerationFailure)) throw error;
    const failedRequest = parseRequestId(work.requestId);
    if (failedRequest.ok)
      traceConversationFailure(
        failedRequest.value,
        scope,
        conversation.id,
        error,
      );
    let message = error.message;
    if (model.keySource === "organisation_subscription") {
      const connection = await readOrganisationCodexConnection({
        env,
        organisationId: scope.organisationId,
        now: Date.now(),
        reconcile: false,
      });
      if (
        connection.ok &&
        connection.value.kind === "action_required" &&
        (connection.value.reason === "account_unavailable" ||
          connection.value.reason === "authorization_expired")
      )
        message =
          "Your ChatGPT connection needs to be reconnected. Open Integrations → AI account, reconnect ChatGPT, then retry.";
    }
    const failed = await settleConversationFailure({
      env,
      placement,
      scope,
      conversationId: conversation.id,
      requestId: work.requestId,
      lease: work.lease,
      message,
    });
    if (failed === null) return { ok: false, error: { kind: "conflict" } };
    return { ok: true, conversation: failed };
  }
  throw new Error("chat_turn_unsettled");
}

function traceConversationPreparation(
  requestId: RequestId,
  scope: ConversationScope,
  phase: "authorization_and_setup",
  startedAt: number,
): void {
  traceLog("chat.preparation_timing", {
    requestId,
    organisation_id: scope.organisationId,
    phase,
    started_at: startedAt,
    duration_ms: Date.now() - startedAt,
  });
}

type PersistedConversationStep = {
  readonly conversation: Conversation;
  readonly revision: number;
};

async function persistCompletedConversationStep(input: {
  readonly placement: OrganisationExecutionScope;
  readonly env: Env;
  readonly scope: ConversationScope;
  readonly conversation: Conversation;
  readonly revision: number;
  readonly lease: string;
  readonly completedStep: number;
}): Promise<PersistedConversationStep | null> {
  let conversation = input.conversation;
  let revision = input.revision;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const saved = await saveConversation(
      input.placement,
      input.scope.userId,
      conversation,
      revision,
    );
    if (saved.kind === "saved") return { conversation, revision: revision + 1 };
    const latest = await readConversation(
      input.placement.database,
      input.scope,
      conversation.id,
    );
    if (
      latest === null ||
      latest.conversation.work.kind !== "running" ||
      latest.conversation.work.lease !== input.lease ||
      latest.conversation.work.stream.step !== input.completedStep
    )
      return null;
    if (saved.kind === "capacity") {
      const active = latest.conversation.work;
      const blocked: Conversation = {
        ...latest.conversation,
        work: {
          kind: "failed",
          requestId: active.requestId,
          error:
            "This chat has reached its storage limit. Your saved response is available to download. Start a new chat to continue.",
          recovery: {
            kind: "projection_capacity",
            lease: active.lease,
            stream: active.stream,
          },
        },
      };
      const terminal = await saveConversation(
        input.placement,
        input.scope.userId,
        blocked,
        latest.revision,
      );
      if (terminal.kind === "saved")
        return { conversation: blocked, revision: latest.revision + 1 };
      if (terminal.kind === "capacity")
        throw new Error("conversation_terminal_headroom_exhausted");
      revision = latest.revision;
      continue;
    }
    conversation = normalizeConversationTimeline({
      ...conversation,
      title: latest.conversation.title,
      pendingInputs: latest.conversation.pendingInputs,
      lastReadSequence: Math.max(
        conversation.lastReadSequence,
        latest.conversation.lastReadSequence,
      ),
      draftText: latest.conversation.draftText,
      draftUpdatedAt: latest.conversation.draftUpdatedAt,
    });
    revision = latest.revision;
  }
  return null;
}

export async function conversationStreamIdentity(
  actorIdentity: string,
  lease: string,
  step: number,
): Promise<
  | {
      readonly ok: true;
      readonly value: Variant<Conversation["work"], "running">["stream"];
    }
  | { readonly ok: false; readonly error: string }
> {
  const derived = await deriveConversationTurnStream(
    conversationStepIdentity(actorIdentity, lease, step),
    step,
  );
  return derived.ok
    ? { ok: true, value: derived.value }
    : { ok: false, error: derived.error.code };
}

function conversationStepIdentity(
  actorIdentity: string,
  lease: string,
  step: number,
): string {
  return `${actorIdentity}:${lease}:${step}`;
}
