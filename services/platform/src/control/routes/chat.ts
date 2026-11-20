import { isVoiceTranscriptionEnabled } from "../../voice/store";
import {
  MESSAGE_ATTACHMENT_POLICY,
  isConversationId,
  type ChatEffort,
} from "@purin-labs/control-api";
import {
  readChatSubmission,
  retainChatFiles,
  withChatAttachments,
} from "../../chat/attachments";
import { withAdmittedScreenObservation } from "../../chat/screen-observation-admission";
import { checkConversationDisclosure } from "../../chat/conversation-disclosure";
import {
  authorizeConversation,
  currentCanvasConversation,
} from "../../chat/conversation-access";
import { authorizeChatForkRead } from "../../chat/forks";
import { bindAdmittedProjectContext } from "../../chat/project-context-binding";
import { reconcileStoredContextObservations } from "../../chat/turn/context";
import { timeThreadRead } from "../../chat/thread-read-timing";
import type { OrganisationDatabase } from "../../database-handles";
import type { Env } from "../../env";
import { setAdmittedConversationGoal } from "./chat-goal";
import { buildControlAuthority } from "../../request-authority";
import { readActiveOrganisationMembershipRevision } from "../../data/control-plane";
import {
  resolveOrganisationModelRoute,
  selectOrganisationChatModel,
  organisationChatModelOptions,
  type OrganisationModelRoute,
} from "../../models/route";
import {
  authorizeOrganisationRequest,
  type AuthorizedOrganisationRequest,
} from "../authorization";
import { controlError, controlJson } from "../http";
import { isChatId, type Conversation } from "../../chat/conversation";
import {
  listConversationDirectory,
  conversationSummary,
  listPinnedConversations,
  searchConversationDirectory,
  readConversation,
  reconcileAndReadConversation,
  reconcileRevokedConversationRun,
  readConversationStatus,
  saveConversation,
  clearSubmittedConversationDraft,
  type ConversationScope,
} from "../../chat/store";
import { verifyBakerySurfaceAttachment } from "@purin-labs/bakery-model/bakery-surface";
import { readConversationSlackDrafts } from "./chat-slack-messages";
import { readConversationConfigurationDrafts } from "./chat-configuration-drafts";
import { authorizeSideCaseChatRead } from "../../chat/side-cases";
import {
  type AdmittedConversationExecution,
  scheduleConversationExecution,
  settleCancellingConversation,
} from "../../chat/application";
import {
  admitSteering,
  admitQueuedSteering,
  queuedInputAsSteering,
  steerRunningConversation,
} from "../../chat/turn/steering";
import { admitTurn, withdrawQueuedInput } from "../../chat/turn/admission";
import { reconcileFailedConversationTurn } from "../../chat/turn/failure";
import { reconcileStoredBakerySurfaceTimeline } from "../../chat/turn/timeline";
import {
  modelOptionHasId,
  selectStoredConversationModel,
  conversationUsesInferenceSource,
} from "../../chat/turn/model";
import { listPendingChatDeletions } from "../../chat/deletion";
import { readAuthorizedProjectDirectory } from "../../chat/projects";
import {
  publicConversation,
  publicConversationWork,
} from "../../chat/public-conversation";
import { readOnboardingRow } from "../../data/organisation-onboarding-row";
import {
  readConversationLinks,
  unreadConversationCount,
} from "../../chat/conversation-links";
import { readConversationEmailReviews } from "../../mail-inbox/conversation-email-reviews";
import { chatError, chatSaveError } from "./chat/errors";

export type PortalChatExecution = Pick<ExecutionContext, "waitUntil">;

export async function handlePortalChat(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  try {
    const timing = timeThreadRead(request, env);
    const response = await handlePortalChatRequest(
      request,
      timing?.env ?? env,
      organisationIdRaw,
    );
    timing?.finish(response.status);
    return response;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "project_evidence_unavailable"
    ) {
      return controlJson(
        {
          kind: "rejected",
          code: "chat_history_unavailable",
          reason: "evidence_unavailable",
        },
        409,
      );
    }
    throw error;
  }
}

async function handlePortalChatRequest(
  request: Request,
  env: Env,
  organisationIdRaw: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const canvasDocumentId = new URL(request.url).searchParams.get("canvas");
  if (canvasDocumentId !== null && request.method !== "POST")
    return controlError("method_not_allowed", 405);
  const authorized = await authorizeOrganisationRequest(
    request,
    env,
    organisationIdRaw,
    canvasDocumentId === null ? "admin" : "operator",
    request.method === "POST",
  );
  if (!authorized.ok) return authorized.response;
  const scope: ConversationScope = {
    organisationId: authorized.organisationId,
    userId: authorized.authenticated.session.userId,
  };
  const placement = authorized.executionScope;

  const observation = new URL(request.url).searchParams;
  if (request.method === "GET" && observation.get("view") === "state") {
    const id = observation.get("conversation");
    if (!isConversationId(id)) return controlError("chat_request_invalid", 422);
    const status = await readConversationStatus(
      authorized.executionScope.database,
      scope,
      id,
    );
    if (status === null) return controlError("chat_not_found", 404);
    return controlJson({
      revision: status.revision,
      work: publicConversationWork(status.work),
    });
  }
  if (request.method === "GET") {
    const searchParams = new URL(request.url).searchParams;
    const id = searchParams.get("conversation");
    const search = searchParams.get("search") ?? "";
    if (id !== null && !isConversationId(id))
      return controlError("chat_request_invalid", 422);
    if (search.length > 120) return controlError("chat_search_invalid", 422);
    const cursors = chatDirectoryCursors(new URL(request.url));
    if (cursors === null)
      return controlError("chat_directory_cursor_invalid", 422);
    // One thread read asks the account each question one time. A write in this
    // branch keeps `placement`, which asks each time.
    const readPlacement = placement.ofOneRead();
    const [model, firstStored, access] = await Promise.all([
      resolveOrganisationModelRoute({
        env,
        organisationId: authorized.organisationId,
        now: Date.now(),
      }),
      id === null ? null : reconcileAndReadConversation(placement, scope, id),
      id === null ? null : authorizeConversation(placement.database, scope, id),
    ]);
    let stored = firstStored;
    if (stored !== null) {
      const denied = await authorizeStoredFork(
        env,
        scope,
        stored.conversation,
        { ...authorized, executionScope: readPlacement },
        access,
      );
      if (denied !== null) return denied;
    }
    if (
      observation.get("observe") !== "true" &&
      stored !== null &&
      stored.conversation.work.kind !== "ready" &&
      stored.conversation.work.kind !== "failed"
    )
      await scheduleConversationExecution(env, {
        placement,
        scope,
        conversation: stored.conversation,
        controlSessionId: authorized.authenticated.session.controlSessionId,
      });
    if (stored !== null && observation.get("observe") !== "true")
      stored = await reconcileFailedConversationTurn(
        env,
        placement,
        scope.userId,
        stored,
      );
    if (stored !== null)
      stored = await reconcileStoredBakerySurfaceTimeline(
        placement,
        scope.userId,
        stored,
      );
    if (stored !== null)
      stored = await reconcileStoredContextObservations(
        env,
        placement,
        scope.userId,
        stored,
      );
    // Nothing below depends on another read, so they all share one wait.
    const readActiveRevision = readActiveOrganisationMembershipRevision({
      db: placement.database,
      organisationId: scope.organisationId,
    });
    const [
      emailReviews,
      slackDrafts,
      configurationDrafts,
      configuration,
      activeRevision,
      directory,
      projects,
      pendingDeletions,
      pinnedConversations,
      [derivedThreads, sideCases, sideCaseSource],
    ] = await Promise.all([
      stored === null
        ? { ok: true as const, value: [] }
        : readConversationEmailReviews(
            readPlacement,
            scope,
            stored.conversation,
          ),
      stored === null
        ? []
        : readConversationSlackDrafts(
            env.DB,
            readPlacement,
            scope,
            stored.conversation.id,
          ),
      stored === null
        ? []
        : readConversationConfigurationDrafts(
            env,
            readPlacement,
            scope,
            stored.conversation.id,
          ),
      readOnboardingRow(placement.database, scope.organisationId),
      readActiveRevision,
      search.length === 0
        ? listConversationDirectory(placement.database, scope, cursors)
        : searchConversationDirectory(
            placement.database,
            scope,
            search,
            cursors,
          ),
      readAuthorizedProjectDirectory(env, readPlacement, scope),
      listPendingChatDeletions(readPlacement, scope),
      listPinnedConversations(placement.database, scope),
      readConversationLinks(
        env,
        readPlacement,
        scope,
        authorized,
        stored,
        readActiveRevision,
      ),
    ]);
    if (!emailReviews.ok) {
      return controlError("chat_email_reviews_unavailable", 500);
    }
    if (slackDrafts === null) {
      return controlError("chat_slack_drafts_unavailable", 500);
    }
    if (configurationDrafts === null) {
      return controlError("chat_configuration_drafts_unavailable", 500);
    }
    const selectedModel =
      model.ok && stored !== null
        ? selectStoredConversationModel(model.value, stored.conversation)
        : model;
    let active = directory.active;
    let archived = directory.archived;
    if (search.length === 0 && stored !== null) {
      const selected = conversationSummary(stored);
      if (
        selected.lifecycle === "active" &&
        !active.some(summaryHasId.bind(null, selected.id))
      )
        active = [selected, ...active];
      if (
        selected.lifecycle === "archived" &&
        !archived.some(summaryHasId.bind(null, selected.id))
      )
        archived = [selected, ...archived];
    }
    return controlJson({
      projectDirectory: projects,
      configurationVersion:
        (configuration?.configurationVersion as number | undefined) ?? 0,
      model:
        model.ok && selectedModel.ok && activeRevision !== null
          ? publicChatModel(selectedModel.value, model.value)
          : {
              kind: "unavailable",
              message:
                activeRevision === null
                  ? "Activate the workspace in Integrations before starting its AI."
                  : "Connect the workspace's selected AI provider in Integrations before chatting.",
            },
      nextActiveCursor: directory.nextActiveCursor,
      nextArchivedCursor: directory.nextArchivedCursor,
      conversations: active,
      archivedConversations: archived,
      pendingDeletions,
      pinnedConversations,
      conversation:
        stored === null
          ? null
          : {
              ...publicConversation(
                stored.conversation,
                stored.metadata,
                stored.revision,
              ),
              sharing: stored.sharing,
              placement: stored.placement,
            },
      derivedThreads,
      emailReviews: emailReviews.value,
      slackDrafts,
      configurationDrafts,
      sideCases,
      sideCaseSource,
      unreadCount: unreadConversationCount(directory),
    });
  }
  const model = await resolveOrganisationModelRoute({
    env,
    organisationId: authorized.organisationId,
    now: Date.now(),
  });
  if (!model.ok)
    return chatError(
      "chat_model_unavailable",
      "Connect your selected AI provider in Integrations before chatting.",
      409,
    );
  const submission = await readChatSubmission(request);
  if (!submission.ok)
    return chatError(
      submission.error,
      submission.error === "chat_use_secure_credential_entry"
        ? "Use the Connect card to enter your API key securely. Remove the key from this message."
        : submission.error === "chat_attachment_limit"
          ? `Attach up to ${MESSAGE_ATTACHMENT_POLICY.maxFilesPerMessage} files, with each file up to ${MESSAGE_ATTACHMENT_POLICY.maxFileBytes / (1024 * 1024)} MiB and the message total up to ${MESSAGE_ATTACHMENT_POLICY.maxBatchBytes / (1024 * 1024)} MiB.`
          : "Enter a message of up to 8,000 characters.",
      422,
    );
  const command = submission.value.command;
  if (canvasDocumentId !== null) {
    const canvasAccess = await authorizeConversation(
      placement.database,
      scope,
      command.conversationId,
    );
    if (
      canvasAccess?.access.kind !== "workspace_canvas" ||
      canvasAccess.access.documentId !== canvasDocumentId
    )
      return controlError("chat_not_found", 404);
  }
  if (
    (command.kind === "message" ||
      command.kind === "next" ||
      command.kind === "steer") &&
    command.surfaceContext !== null &&
    !(await verifyBakerySurfaceAttachment(command.surfaceContext))
  )
    return chatError(
      "chat_surface_context_invalid",
      "The attached Kitchen context changed before it was accepted. Send the message again.",
      422,
    );
  await reconcileRevokedConversationRun(
    placement,
    scope.userId,
    command.conversationId,
  );
  const stored = await readConversation(
    authorized.executionScope.database,
    scope,
    command.conversationId,
  );
  if (stored !== null) {
    const denied = await authorizeStoredFork(
      env,
      scope,
      stored.conversation,
      authorized,
    );
    if (denied !== null) return denied;
  }
  if (stored !== null) {
    const access = await authorizeConversation(
      authorized.executionScope.database,
      scope,
      stored.conversation.id,
    );
    if (access === null) return controlError("chat_not_found", 404);
    if (
      access.access.kind === "workspace_canvas" &&
      (await currentCanvasConversation(
        placement.database,
        scope,
        access.access.documentId,
      )) !== stored.conversation.id
    )
      return chatError(
        "chat_read_only",
        "Open the current canvas conversation to continue.",
        409,
      );
    if (access.access.kind !== "private" && access.role === "viewer")
      return chatError(
        "chat_read_only",
        "Your project role allows viewing this chat. Start a private chat to work with its context.",
        403,
      );
    if (
      access.execution.kind === "active" &&
      access.execution.userId !== scope.userId
    )
      return chatError(
        "chat_running",
        "A teammate is using this chat. Try again when their turn finishes.",
        409,
      );
  }
  if (stored?.metadata.lifecycle === "archived")
    return chatError(
      "chat_archived",
      "Restore this chat before sending another message.",
      409,
    );
  if (
    stored !== null &&
    !conversationUsesInferenceSource(stored.conversation, model.value)
  )
    return chatError(
      "chat_model_changed",
      "This conversation's AI connection has changed. Restore its connection or start a new chat.",
      409,
    );
  if (command.kind === "withdraw") {
    const withdrawal = withdrawQueuedInput(stored, command.inputId);
    if (!withdrawal.ok)
      return chatError(withdrawal.code, withdrawal.message, 409);
    if (withdrawal.kind === "replay")
      return controlJson({
        conversation: publicConversation(
          withdrawal.conversation,
          stored?.metadata ?? { lifecycle: "active", pinnedAt: null },
          stored?.revision ?? 1,
        ),
      });
    const saved = await saveConversation(
      placement,
      scope.userId,
      withdrawal.conversation,
      stored?.revision ?? 0,
    );
    if (saved.kind !== "saved") return chatSaveError(saved);
    return controlJson({
      conversation: publicConversation(
        withdrawal.conversation,
        stored?.metadata ?? { lifecycle: "active", pinnedAt: null },
        (stored?.revision ?? 0) + 1,
      ),
    });
  }
  const selectedModel = selectOrganisationChatModel(model.value, command.model);
  if (!selectedModel.ok)
    return chatError(
      selectedModel.error.code,
      "Choose one of the models available for this workspace.",
      422,
    );
  const effort = validateChatEffort(selectedModel.value, command.effort);
  if (!effort.ok)
    return chatError(
      "chat_effort_invalid",
      "Choose a reasoning effort supported by the selected AI model.",
      422,
    );
  if (command.kind === "steer_queued") {
    const metadata = stored?.metadata ?? {
      lifecycle: "active" as const,
      pinnedAt: null,
    };
    // The message joins the running turn when the turn can take it (Plan 71).
    const joining = queuedInputAsSteering(stored, command);
    const joined =
      joining === null
        ? null
        : await steerRunningConversation({
            env,
            placement,
            scope,
            stored: joining.stored,
            command: joining.command,
            model: selectedModel.value,
            keepsDraft: true,
          });
    if (joined !== null)
      return controlJson({
        conversation: publicConversation(
          joined.conversation,
          metadata,
          joined.revision,
        ),
      });
    const steering = admitQueuedSteering(stored, command, selectedModel.value);
    if (!steering.ok) return chatError(steering.code, steering.message, 409);
    if (steering.kind === "current")
      return controlJson({
        conversation: publicConversation(
          steering.conversation,
          metadata,
          stored?.revision ?? 1,
        ),
      });
    if (steering.kind === "admitted") {
      const saved = await saveConversation(
        placement,
        scope.userId,
        steering.conversation,
        stored?.revision ?? 0,
      );
      if (saved.kind !== "saved") return chatSaveError(saved);
    }
    const steeringExecution = {
      placement,
      controlSessionId: authorized.authenticated.session.controlSessionId,
      env,
      scope,
      conversation: steering.conversation,
      revision:
        (stored?.revision ?? 0) + (steering.kind === "admitted" ? 1 : 0),
      model: selectedModel.value,
    } satisfies AdmittedConversationExecution;
    await settleCancellingConversation(steeringExecution);
    await scheduleConversationExecution(env, {
      placement,
      scope,
      conversation: steering.conversation,
      controlSessionId: steeringExecution.controlSessionId,
    });
    return controlJson({
      conversation: publicConversation(
        steering.conversation,
        metadata,
        steeringExecution.revision,
      ),
    });
  }
  // The off switch also stops a spoken command while a Mac grant is valid.
  if (
    command.kind !== "retry" &&
    command.inputMode !== undefined &&
    !(await isVoiceTranscriptionEnabled(
      authorized.executionScope.database,
      authorized.organisationId,
    ))
  )
    return chatError(
      "voice_disabled",
      "Voice control is off for this organisation.",
      403,
    );
  const retained = await retainChatFiles(
    env.ARCHIVE,
    scope,
    command.conversationId,
    submission.value.files,
  );
  if (!retained.ok)
    return chatError(
      retained.error,
      "These files could not be attached. Check the file size and format, then try again.",
      422,
    );
  // A page that the chat's readers may not receive leaves the message (Plan 87).
  const admittedCommand = withAdmittedScreenObservation(
    stored,
    command.kind === "retry"
      ? command
      : withChatAttachments(command, retained.value),
  );
  if (admittedCommand.kind === "steer") {
    // The message joins the running turn when the turn can take it (Plan 71).
    const steered = await steerIntoRunningTurn(
      {
        env,
        placement,
        scope,
        stored,
        command: admittedCommand,
        model: selectedModel.value,
      },
      authorized.executionScope.database,
    );
    if (steered !== null) return steered;
    const admittedSteering = admitSteering(
      stored,
      admittedCommand,
      selectedModel.value,
    );
    const steering =
      admittedSteering.ok && admittedSteering.kind !== "replay"
        ? {
            ...admittedSteering,
            conversation: await bindAdmittedProjectContext(
              env,
              placement,
              scope,
              stored,
              admittedSteering.conversation,
              admittedCommand.requestId,
            ),
          }
        : admittedSteering;
    if (!steering.ok) return chatError(steering.code, steering.message, 409);
    if (steering.kind !== "replay") {
      const saved = await saveConversation(
        placement,
        scope.userId,
        steering.conversation,
        stored?.revision ?? 0,
      );
      if (saved.kind !== "saved") return chatSaveError(saved);
      await clearSubmittedConversationDraft(
        authorized.executionScope.database,
        scope,
        stored,
        admittedCommand.text,
      );
    }
    if (
      steering.kind === "replay" &&
      (steering.conversation.work.kind !== "cancelling" ||
        steering.conversation.work.cancellationId !==
          admittedCommand.cancellationId)
    )
      return controlJson({
        conversation: publicConversation(
          steering.conversation,
          stored?.metadata ?? { lifecycle: "active", pinnedAt: null },
          stored?.revision ?? 1,
        ),
      });
    const steeringExecution = {
      placement,
      controlSessionId: authorized.authenticated.session.controlSessionId,
      env,
      scope,
      conversation: steering.conversation,
      revision: (stored?.revision ?? 0) + (steering.kind === "replay" ? 0 : 1),
      model: selectedModel.value,
    } satisfies AdmittedConversationExecution;
    await settleCancellingConversation(steeringExecution);
    await scheduleConversationExecution(env, {
      placement,
      scope,
      conversation: steering.conversation,
      controlSessionId: steeringExecution.controlSessionId,
    });
    return controlJson({
      conversation: publicConversation(
        steering.conversation,
        stored?.metadata ?? { lifecycle: "active", pinnedAt: null },
        steeringExecution.revision,
      ),
    });
  }
  if (admittedCommand.kind === "next") {
    // A message sent while a turn runs joins that turn when the turn can
    // take it (Plan 71). Otherwise it waits as the next turn, as before.
    const steered = await steerIntoRunningTurn(
      {
        env,
        placement,
        scope,
        stored,
        command: admittedCommand,
        model: selectedModel.value,
      },
      authorized.executionScope.database,
    );
    if (steered !== null) return steered;
  }
  const unboundAdmission = await admitTurn(
    stored,
    admittedCommand,
    selectedModel.value,
    scope,
  );
  const admitted =
    unboundAdmission.ok && unboundAdmission.kind !== "replay"
      ? {
          ...unboundAdmission,
          conversation: await bindAdmittedProjectContext(
            env,
            placement,
            scope,
            stored,
            unboundAdmission.conversation,
            admittedCommand.requestId,
          ),
        }
      : unboundAdmission;
  if (!admitted.ok) return chatError(admitted.code, admitted.message, 409);
  const goalDatabase = authorized.executionScope.database;
  async function applyInitialGoal(): Promise<Response | null> {
    if (
      admitted.ok !== true ||
      admittedCommand.kind !== "message" ||
      admittedCommand.goalTokenBudget === undefined
    )
      return null;
    const failure = await setAdmittedConversationGoal(
      env,
      goalDatabase,
      scope,
      admitted.conversation,
      `goal-${admittedCommand.requestId}`,
      admittedCommand.text,
      admittedCommand.goalTokenBudget,
    );
    return failure === null
      ? null
      : chatError(
          "chat_goal_unavailable",
          "The goal could not be set. Send the message again.",
          409,
        );
  }
  if (admitted.kind === "queued") {
    const saved = await saveConversation(
      placement,
      scope.userId,
      admitted.conversation,
      stored?.revision ?? 0,
    );
    if (saved.kind !== "saved") return chatSaveError(saved);
    if (admittedCommand.kind === "message" || admittedCommand.kind === "next")
      await clearSubmittedConversationDraft(
        authorized.executionScope.database,
        scope,
        stored,
        admittedCommand.text,
      );
    await scheduleConversationExecution(env, {
      placement,
      scope,
      conversation: admitted.conversation,
      controlSessionId: authorized.authenticated.session.controlSessionId,
    });
    return controlJson({
      kind: "accepted",
      conversation: publicConversation(
        admitted.conversation,
        stored?.metadata ?? { lifecycle: "active", pinnedAt: null },
        (stored?.revision ?? 0) + 1,
      ),
    });
  }
  if (admitted.kind === "replay") {
    const goalFailure = await applyInitialGoal();
    if (goalFailure !== null) return goalFailure;
    await scheduleConversationExecution(env, {
      placement,
      scope,
      conversation: admitted.conversation,
      controlSessionId: authorized.authenticated.session.controlSessionId,
    });
    return controlJson({
      conversation: publicConversation(
        admitted.conversation,
        stored?.metadata ?? { lifecycle: "active", pinnedAt: null },
        stored?.revision ?? 1,
      ),
    });
  }
  const saved = await saveConversation(
    placement,
    scope.userId,
    admitted.conversation,
    stored?.revision ?? 0,
  );
  if (saved.kind !== "saved") return chatSaveError(saved);
  const goalFailure = await applyInitialGoal();
  if (goalFailure !== null) return goalFailure;
  if (admittedCommand.kind !== "retry")
    await clearSubmittedConversationDraft(
      authorized.executionScope.database,
      scope,
      stored,
      admittedCommand.text,
    );
  await scheduleConversationExecution(env, {
    placement,
    scope,
    conversation: admitted.conversation,
    controlSessionId: authorized.authenticated.session.controlSessionId,
  });
  return controlJson({
    kind: "accepted",
    conversation: publicConversation(
      admitted.conversation,
      stored?.metadata ?? { lifecycle: "active", pinnedAt: null },
      (stored?.revision ?? 0) + 1,
    ),
  });
}

/**
 * Joins the message to the running turn when the turn can take it, and
 * answers the conversation; null when the turn cannot take it.
 */
async function steerIntoRunningTurn(
  input: Parameters<typeof steerRunningConversation>[0],
  database: OrganisationDatabase,
): Promise<Response | null> {
  const steered = await steerRunningConversation(input);
  if (steered === null) return null;
  await clearSubmittedConversationDraft(
    database,
    input.scope,
    input.stored,
    input.command.text,
  );
  return controlJson({
    conversation: publicConversation(
      steered.conversation,
      input.stored?.metadata ?? { lifecycle: "active", pinnedAt: null },
      steered.revision,
    ),
  });
}

function publicChatModel(
  selected: OrganisationModelRoute,
  workspace: OrganisationModelRoute,
): unknown {
  const options = organisationChatModelOptions(workspace);
  const selectedOption = options.find(
    modelOptionHasId.bind(null, selected.model),
  );
  if (selectedOption === undefined) throw new Error("chat_model_invalid");
  return {
    kind: "ready",
    selected: selectedOption.id,
    agent: selected.provider === "anthropic" ? "Claude" : "Pi",
    name: selectedOption.name,
    options,
  };
}

function validateChatEffort(
  route: OrganisationModelRoute,
  effort: ChatEffort | undefined,
): { readonly ok: true } | { readonly ok: false } {
  if (effort === undefined) return { ok: true };
  const option = organisationChatModelOptions(route).find(
    modelOptionHasId.bind(null, route.model),
  );
  return option?.capabilities.effortOptions.includes(effort)
    ? { ok: true }
    : { ok: false };
}

function chatDirectoryCursors(
  url: URL,
): import("../../chat/store").ChatDirectoryCursors | null {
  const activeRaw = url.searchParams.get("activeAfter");
  const archivedRaw = url.searchParams.get("archivedAfter");
  const active = activeRaw === null ? null : timedCursor(activeRaw);
  const archived = archivedRaw === null ? null : timedCursor(archivedRaw);
  if (
    (activeRaw !== null && (active === null || !isChatId(active.id))) ||
    (archivedRaw !== null && archived === null)
  )
    return null;
  return {
    active:
      active === null ? null : { lastActivityAt: active.at, id: active.id },
    archived:
      archived === null ? null : { archivedAt: archived.at, id: archived.id },
  };
}

/** A `<time>.<chat id>` cursor of the chat list. */
function timedCursor(raw: string): { at: number; id: string } | null {
  const match = /^(\d{1,16})\.([a-zA-Z0-9_-]{8,100})$/u.exec(raw);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const at = Number(match[1]);
  return Number.isSafeInteger(at) ? { at, id: match[2] } : null;
}

function summaryHasId(id: string, summary: { readonly id: string }): boolean {
  return summary.id === id;
}

export async function authorizeStoredFork(
  env: Env,
  scope: ConversationScope,
  conversation: Conversation,
  authorized: AuthorizedOrganisationRequest,
  readAccess?: Awaited<ReturnType<typeof authorizeConversation>>,
): Promise<Response | null> {
  const access =
    readAccess !== undefined
      ? readAccess
      : await authorizeConversation(
          authorized.executionScope.database,
          scope,
          conversation.id,
        );
  if (access === null) return controlError("chat_not_found", 404);
  if (
    access.access.kind !== "private" ||
    conversation.historyBindings.length > 0
  ) {
    const disclosure = await checkConversationDisclosure(
      env,
      authorized.executionScope,
      scope,
      conversation,
      [scope.userId],
      "viewing",
    );
    if (disclosure.kind === "rejected")
      return controlJson(
        disclosure,
        disclosure.code === "chat_history_forbidden" ? 403 : 409,
      );
  }
  if (conversation.lineage.kind === "original") return null;
  const membershipRevision = await readActiveOrganisationMembershipRevision({
    db: authorized.executionScope.database,
    organisationId: scope.organisationId,
  });
  if (membershipRevision === null)
    return controlError("chat_fork_history_forbidden", 403);
  const authority = buildControlAuthority({
    organisationId: scope.organisationId,
    requesterPersonId: authorized.membership.personId,
    userId: scope.userId,
    membershipRevision,
    role: authorized.membership.role,
  }).requestAuthority;
  try {
    if (conversation.lineage.kind === "side_case")
      await authorizeSideCaseChatRead(
        authorized.executionScope,
        scope,
        conversation,
        authority,
      );
    else
      await authorizeChatForkRead(
        env,
        authorized.executionScope,
        scope,
        conversation,
        authority,
      );
    return null;
  } catch {
    return controlError("chat_fork_history_forbidden", 403);
  }
}
