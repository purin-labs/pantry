import { acceptedExecutionAccountAuthority } from "../account-platform/access";
import { turnMemoryReaderWithoutSubjects } from "../memory/access";
import { ensureCaseProject } from "../projects/case-project";
import { isSlackGoalMessage } from "./goal-command";
import { deliverAndSettleCaseOutput } from "../actors/case-walking-path";
import type {
  CaseBinding,
  ConnectorIdentity,
  ConnectorIngress,
  StoredMessageAttachment,
} from "@seams/contracts";

import {
  findActiveCaseRouteAtScope,
  findActiveSessionActorAtScope,
  resolveActiveCaseSessionActorsAtScope,
  resolveActiveCaseActorAtScope,
  publishActorRegistryActivation,
  type ActorPairResolutionTiming,
  type ActorRegistryPublication,
  type SessionActorRoute,
} from "../actors/actor-router";
import {
  keepConversationResident,
  startSessionBeforeItsTurn,
} from "../actors/conversation-residency";
import {
  eraseWarmActorSlots,
  type ConnectorWarmActorSlots,
  type WarmActorSlot,
} from "../actors/warm-actor-slots";
import {
  runOngoingCaseTurn,
  admitOngoingCaseTurn,
  admittedCaseHoldsAssignment,
  type OngoingCaseWalkingConnector,
} from "../actors/case-walking-path";
import type { CaseDO } from "../actors/case";
import type { SessionDO } from "../actors/agent-session";
import { resolveActiveSlackThreadCredential } from "../credential-vault";
import {
  ensureOrganisationDefaultWorkspace,
  readOrganisationDefaultWorkspacePortalAddress,
} from "../data/organisation-workspace";
import type { Env } from "../env";
import type { SessionBudgetDimension } from "@seams/contracts";
import { budgetNoticeDeliveryId, budgetStopNoticeText } from "./budget-notice";
import type { OrganisationExecutionScope } from "../organisation-execution-scope";
import { samePlacement } from "../data/organisation-placement";
import type { SlackCaseCommand } from "../ingress-queue";
import { buildSlackUserMessage } from "./user-message";
import { slackAuthoredText } from "./events";
import { resolveSlackTurnModelRouteAtScope } from "../models/route";
import { traceLog } from "../observability";
import {
  loadOrganisationPolicyOrDefaultDeny,
  type PinnedSessionPolicy,
} from "../policy-snapshot";
import {
  acquireSlackAttachmentBatch,
  type AttachmentRejection,
} from "./attachments";
import {
  assembleTurnContext,
  prepareTurnAuthority,
} from "../context/turn-context";
import {
  parseAgentProfileSelection,
  pinCaseTurnAgentProfile,
  readCaseTurnAgentProfile,
  type PinnedAgentProfile,
} from "../data/pinned-agent-profile";
import { resolveSlackConfigurationReply } from "./configuration-reply";
import { requirePublicOrigin } from "../public-origin";
import { refreshSlackRequestAuthority } from "../request-authority";
import {
  isDeferredSlackCaseWork,
  isSlackSideCaseWork,
} from "../actors/connector-case-work";
import {
  parseControlRole,
  roleMayConfigure,
  type ControlRole,
} from "../data/control-plane";
import { parseAssignmentId, parseSessionId, type CaseId } from "../ids";
import { resolveConfiguredSlackInstallationIdentity } from "./installation-identity";
import {
  readLatestEmailReviewProjectionForCase,
  type EmailReviewProjection,
} from "../data/email-review";
import { buildSlackEmailReviewNotice } from "./email-review-notice";
import type { Variant } from "@seams/type-utils";
import { assertNever } from "@seams/std";

const WITHHELD_DELIVERY =
  "connector_delivery_rejected:connector_stream_withheld";

export type SlackCaseProcessingResult =
  | { readonly kind: "completed" }
  | {
      readonly kind: "retry";
      readonly retryAt: number;
      readonly reason: string;
    }
  | { readonly kind: "rejected"; readonly reason: string };

/**
 * Posts the outcome of a configuration reply straight back to the channel.
 *
 * A settled configuration change is its own complete answer, so it does not
 * open an agent turn. The delivery identity is derived from the message that
 * carried the confirmation, so a retried queue message reuses it and Slack
 * sees one post rather than two.
 */
async function deliverConfigurationOutcome(
  input: Readonly<{
    connector: OngoingCaseWalkingConnector;
    connectorIdentity: ConnectorIdentity;
    body: SlackCaseCommand;
    binding: CaseBinding;
    text: string;
  }>,
): Promise<SlackCaseProcessingResult> {
  return deliverPlatformText({
    connector: input.connector,
    connectorIdentity: input.connectorIdentity,
    body: input.body,
    binding: input.binding,
    deliveryId: `delivery_config_${input.body.event.eventId}`,
    text: input.text,
  });
}

const ATTEMPTS_EXHAUSTED_TEXT =
  "Sous Chef couldn’t complete this request after several attempts. Please try again. If it fails again, start a new conversation.";

/**
 * Tell a thread that its message used every attempt and gets no answer.
 *
 * The notice is fixed platform text and opens no agent turn. Its delivery
 * identity is derived from the message, so a repeated claim reuses it and
 * Slack sees one post. `completed` means the thread holds the notice.
 */
export function deliverSlackAttemptsExhaustedNotice(
  body: SlackCaseCommand,
  connectorIdentity: ConnectorIdentity,
  connector: Pick<OngoingCaseWalkingConnector, "deliver">,
): Promise<SlackCaseProcessingResult> {
  return deliverPlatformText({
    connector,
    connectorIdentity,
    body,
    binding: slackCaseBinding(body),
    deliveryId: `delivery_exhausted_${body.event.eventId}`,
    text: ATTEMPTS_EXHAUSTED_TEXT,
  });
}

/**
 * Tell a thread about a permission request or its decision. The text is fixed
 * platform text with catalogue labels and a Portal link; it holds no model
 * output. The delivery identity names the request and the step, so a repeated
 * call posts once.
 */
export function deliverSlackPermissionNotice(
  body: SlackCaseCommand,
  connectorIdentity: ConnectorIdentity,
  connector: Pick<OngoingCaseWalkingConnector, "deliver">,
  deliveryId: string,
  text: string,
): Promise<SlackCaseProcessingResult> {
  return deliverPlatformText({
    connector,
    connectorIdentity,
    body,
    binding: slackCaseBinding(body),
    deliveryId,
    text,
  });
}

/** Post platform text to the thread of a message, one time for its identity. */
async function deliverPlatformText(
  input: Readonly<{
    connector: Pick<OngoingCaseWalkingConnector, "deliver">;
    connectorIdentity: ConnectorIdentity;
    body: SlackCaseCommand;
    binding: CaseBinding;
    deliveryId: string;
    text: string;
  }>,
): Promise<SlackCaseProcessingResult> {
  const delivered = await input.connector.deliver({
    identity: input.connectorIdentity,
    delivery: {
      deliveryId: input.deliveryId,
      bindingId: input.binding.bindingId,
      address: input.binding.address,
      caseId: input.body.target.caseId,
      caseRevision: 0,
      content: { kind: "text", text: input.text },
      idempotencyKey: input.deliveryId,
      addressedAt: input.body.receivedAt,
    },
    requestedAt: Date.now(),
  });
  if (!delivered.ok) {
    return retry(input.body.receivedAt, delivered.error.code);
  }
  switch (delivered.value.kind) {
    case "retry":
      return {
        kind: "retry",
        retryAt: delivered.value.retryAt,
        reason: "connector_delivery_pending",
      };
    case "rejected":
      return { kind: "rejected", reason: delivered.value.reason };
    default:
      return { kind: "completed" };
  }
}

/** The identity of the ingress that one Slack message becomes. */
export function slackCaseIngressId(body: SlackCaseCommand): string {
  return `ingress_slack_${body.event.eventId}`;
}

function slackCaseBinding(body: SlackCaseCommand): CaseBinding {
  return {
    bindingId: `binding_${body.target.caseId}`,
    caseId: body.target.caseId,
    connectorId: body.target.connectorId,
    address: {
      kind: "slack",
      workspaceId: body.event.workspaceId,
      channelId: body.event.channelId,
      threadTs: body.event.threadTs,
    },
  };
}

/**
 * Whether the membership behind this message may change configuration.
 *
 * An unparseable role is not a permission: it fails closed.
 */
/** The parsed role, or the least role when it cannot be parsed. */
function slackOperatorRole(role: string): ControlRole {
  const parsed = parseControlRole(role);
  return parsed.ok ? parsed.value : "viewer";
}

function slackOperatorMayConfigure(role: string): boolean {
  const parsed = parseControlRole(role);
  return parsed.ok && roleMayConfigure(parsed.value);
}

/** Where the operator can see the same setup in the Portal. */
function portalAgentsUrl(env: Env, organisationId: string): string {
  return `${requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)}/portal/satyr/${encodeURIComponent(organisationId)}/agents`;
}

function portalCustomConnectorUrl(env: Env, organisationId: string): string {
  return `${requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)}/portal/satyr/${encodeURIComponent(organisationId)}/chat`;
}

function portalEmailReviewUrl(
  env: Env,
  address: Readonly<{
    organisationHandle: string;
    workspaceHandle: string;
  }>,
  proposalId: string,
): string {
  const organisation = encodeURIComponent(address.organisationHandle);
  const workspace = encodeURIComponent(address.workspaceHandle);
  const proposal = encodeURIComponent(proposalId);
  return `${requirePublicOrigin(env.SATYR_PUBLIC_ORIGIN)}/portal/${organisation}/${workspace}/integrations#email-review-${proposal}`;
}

export function customConnectorSetupHandoff(input: {
  readonly text: string;
  readonly mayConfigure: boolean;
  readonly portalUrl: string;
}): string | null {
  if (
    !/\bcustom connector\b|\bconnect\b[^\n]{0,80}\bapi\b/iu.test(input.text)
  ) {
    return null;
  }
  if (!input.mayConfigure) {
    return "You can view connector setup, but an owner or admin must create and connect a custom API.";
  }
  return (
    "Continue custom connector setup in the Portal: " +
    `${input.portalUrl} Start a conversation with your connected AI. It can research the API, ask follow-up questions, and present a Connect card. Enter your API key only in its secure credential form.`
  );
}

async function processAcceptedSlackCaseMessage(
  env: Env,
  body: SlackCaseCommand,
  attempt: number,
  connectorIdentity: ConnectorIdentity,
  connector: OngoingCaseWalkingConnector,
  scope: OrganisationExecutionScope,
): Promise<SlackCaseProcessingResult> {
  if (
    connectorIdentity.organisationId !== body.organisationId ||
    connectorIdentity.connectorId !== body.target.connectorId
  ) {
    return { kind: "rejected", reason: "slack_case_target_mismatch" };
  }
  // The Connector admitted this scope against the directory for this item.
  if (
    scope.organisationId !== body.organisationId ||
    !samePlacement(scope.placement, body.target.placement)
  ) {
    return { kind: "rejected", reason: "organisation_placement_conflict" };
  }
  const preparationStartedAt = Date.now();
  // These steps read the organisation's records and need only the scope, so
  // they share one wait. Each keeps its own result and its own place in the
  // order of refusals below. The authority's reads start beside the policy
  // load, and the compile then compares the loaded version with the current
  // one. The Case lookup creates nothing. A thread's first message has no
  // Case to find, so it skips the lookup.
  const repliesToCase = body.event.messageTs !== body.event.threadTs;
  const policyLoad = loadOrganisationPolicyOrDefaultDeny({
    bindings: { db: scope.database, kv: env.POLICY_KV },
    organisationId: body.organisationId,
    now: body.receivedAt,
  });
  const [
    attachments,
    workspace,
    loadedPolicy,
    turnAuthority,
    activeCase,
    modelRoute,
  ] = await Promise.all([
    ingestCaseAttachments(env, body),
    timed(
      ensureOrganisationDefaultWorkspace({
        scope,
        archive: env.ARCHIVE,
        now: body.receivedAt,
      }),
    ),
    policyLoad,
    timed(prepareSlackTurnAuthority(scope, body, policyLoad)),
    timed(
      repliesToCase
        ? findActiveCaseRouteAtScope({
            scope,
            namespace: env.CASE,
            caseId: body.target.caseId,
          })
        : Promise.resolve(null),
    ),
    timed(
      resolveSlackTurnModelRouteAtScope({
        env,
        scope,
        now: body.receivedAt,
      }),
    ),
  ]);
  const recordsReadAt = Date.now();
  if (attachments.kind === "retry" || attachments.kind === "rejected") {
    return attachments;
  }
  if (!workspace.value.ok) {
    return retry(body.receivedAt, workspace.value.error.code);
  }
  // One canonical message owns every part. Its views replace the four text
  // fields the Actor path used to derive separately, so the prompt, purpose,
  // context query, and accepted digest cannot disagree.
  const canonical = buildSlackUserMessage(body.event, attachments.value);
  if (!canonical.ok) {
    return {
      kind: "rejected",
      reason: `slack_message_invalid:${canonical.error.code}`,
    };
  }
  const { message, views } = canonical.value;
  if (!turnAuthority.value.ok) {
    return retry(body.receivedAt, turnAuthority.value.error.code);
  }
  const authority = turnAuthority.value.value;
  const ingress: ConnectorIngress = {
    ingressId: slackCaseIngressId(body),
    connectorId: body.target.connectorId,
    nativeEventId: body.event.eventId,
    nativeCursor: body.event.messageTs,
    caseId: body.target.caseId,
    content: { kind: "user_message", message },
    receivedAt: body.receivedAt,
  };
  const binding = slackCaseBinding(body);
  // The first work of a side Case is the agent's brief, not a person's words,
  // so it is never read as a goal, a configuration answer or a setup request.
  const agentBrief = isSlackSideCaseWork(String(body.event.eventId));
  const goalMessage =
    !agentBrief && isSlackGoalMessage(slackAuthoredText(body.event.authored));
  const partitionTarget = partitionSlackTarget(
    body,
    authority.authorityPartition.digest,
  );
  // A Case that is not active yet is reserved under the scope the Connector
  // admitted for this item. The reservation is guarded by the regional fence,
  // and each new Actor checks the directory itself before it activates.
  //
  // A message that will open an agent turn needs a Session too. Its Case and
  // Session are then created together, so the two new Durable Objects start
  // at the same time, and their activation is published before the Case is
  // asked to admit the message. The Session is only an empty Actor until the
  // Case admits the message: it is initialised after that, and a refused
  // message is retried with the same Session. A goal message and a message
  // with no model route open no agent turn and create the Case alone.
  //
  // A new pair takes the Connector's warm slots where it has them: a Case and
  // a Session object that are in memory already (Plan 55F).
  const caseResolutionStartedAt = Date.now();
  let caseActor: DurableObjectStub<CaseDO>;
  let createdPair: CreatedCaseActors | null = null;
  if (activeCase.value !== null) {
    caseActor = activeCase.value.actor;
  } else if (!goalMessage && partitionTarget !== null && modelRoute.value.ok) {
    const pair = await createCaseActors(
      env,
      scope,
      { ...body, target: partitionTarget },
      body.receivedAt,
      connector.warmActorSlots,
    );
    if (pair.kind !== "ready") return pair;
    createdPair = pair;
    caseActor = pair.caseActor;
  } else {
    const created = await resolveActiveCaseActorAtScope({
      scope,
      namespace: env.CASE,
      caseId: body.target.caseId,
      now: body.receivedAt,
    });
    if (!created.ok) return retry(body.receivedAt, created.error.code);
    caseActor = created.value;
  }
  const caseResolutionMs =
    activeCase.elapsedMs +
    (activeCase.value === null ? Date.now() - caseResolutionStartedAt : 0);
  // Filing the Case under its Project and the Session lookup wait beside
  // admission. The lookup creates nothing, and it runs only for a Case that
  // was already active. A goal message opens no Session turn and looks
  // nothing up. A Session that the lookup finds is called at once, so a
  // Session that left memory starts while its Case admits the message.
  const [admitted, placed, activeSession] = await Promise.all([
    timed(
      admitOngoingCaseTurn({
        connector,
        connectorIdentity,
        caseActor,
        organisationId: body.organisationId,
        ingress,
        binding,
        purpose: views.casePurpose,
        workspaceRevisionReceipt: workspace.value.value,
        requestAuthority: authority.requestAuthority,
        receivedAt: body.receivedAt,
      }),
    ),
    ensureCaseProject({
      scope,
      caseId: body.target.caseId,
      origin: "slack",
      now: body.receivedAt,
    }),
    activeCase.value === null ||
    goalMessage ||
    partitionTarget === null ||
    !modelRoute.value.ok
      ? null
      : timed(
          findActiveSessionActorAtScope({
            scope,
            namespace: env.SESSION,
            sessionId: partitionTarget.sessionId,
          }).then((found) => {
            // Nothing waits for this call, and it never rejects.
            if (found !== null)
              void startSessionBeforeItsTurn({
                env,
                organisationId: body.organisationId,
                route: found.route,
              });
            return found;
          }),
        ),
  ]);
  if (!placed.ok) return retry(body.receivedAt, placed.error.code);
  if (!admitted.value.ok)
    return retry(body.receivedAt, admitted.value.error.code);
  if (goalMessage) {
    if (body.userId === null)
      return { kind: "rejected", reason: "goal_operator_identity_missing" };
    const support = modelRoute.value.ok ? "pi" : "unavailable";
    const output = await caseActor.acceptGoalMessage({
      organisationId: body.organisationId,
      caseId: body.target.caseId,
      commandId: `slack_${body.event.eventId}`,
      text: slackAuthoredText(body.event.authored),
      requestAuthority: authority.requestAuthority,
      authorityPartition: authority.authorityPartition,
      support,
      acceptedAt: body.receivedAt,
    });
    if (!output.ok) return retry(body.receivedAt, output.error.code);
    const delivery = await deliverAndSettleCaseOutput(
      {
        env,
        connector,
        connectorIdentity,
        caseActor,
        ingress,
        turnAuthority: authority,
        revalidateTurnAuthority: prepareTurnAuthority.bind(null, {
          db: scope.database,
          accountAccess: scope.accountAccess,
          userAuthority: acceptedExecutionAccountAuthority(body.target.sessionId, body.requestId),
          action: "execute",
          organisationId: body.organisationId,
          requestAuthority: body.requestAuthority,
          policy: { version: loadedPolicy.snapshot.version },
        }),
      },
      output.value,
    );
    if (!delivery.ok) return retry(body.receivedAt, delivery.error.code);
    if (delivery.value.kind === "delivery_pending") {
      return {
        kind: "retry",
        retryAt: delivery.value.retryAt,
        reason: "connector_delivery_pending",
      };
    }
    return { kind: "completed" };
  }

  if (!modelRoute.value.ok) {
    return { kind: "rejected", reason: modelRoute.value.error.code };
  }
  const policy: PinnedSessionPolicy = {
    version: loadedPolicy.snapshot.version,
    egress: loadedPolicy.snapshot.egress,
    authz: loadedPolicy.snapshot.authz,
    conversationRisk: loadedPolicy.snapshot.conversationRisk,
    modelRoute: modelRoute.value.value.route,
  };
  if (partitionTarget === null) {
    return { kind: "rejected", reason: "slack_case_identity_invalid" };
  }
  // The Case is admitted. A new thread already has its Session. An active
  // Case whose Session is not active yet has it created and published now,
  // which starts a new Durable Object. The turn's last reads do not depend on
  // it, so they share its wait: whether the message settles a change awaiting
  // confirmation, the turn's context, and the agent profile. A message
  // admitted before the identity was carried has none, so it cannot settle a
  // change.
  const lastReadsStartedAt = Date.now();
  const authoredText = slackAuthoredText(body.event.authored);
  const [served, configuration, context, profile] = await Promise.all([
    timed(
      createdPair !== null
        ? Promise.resolve(createdPair)
        : activeCase.value !== null &&
            activeSession !== null &&
            activeSession.value !== null
          ? // Both Actors are already active, so there is nothing to publish.
            Promise.resolve<CreatedCaseActors>({
              kind: "ready",
              caseActor,
              caseRoute: activeCase.value.route,
              session: activeSession.value.actor,
              sessionRoute: activeSession.value.route,
              creation: null,
            })
          : createCaseActors(
              env,
              scope,
              { ...body, target: partitionTarget },
              body.receivedAt,
              connector.warmActorSlots,
            ),
    ),
    timed(
      body.userId === null || agentBrief
        ? Promise.resolve({ kind: "not_a_configuration_reply" as const })
        : resolveSlackConfigurationReply({
            db: scope.database,
            env,
            organisationId: body.organisationId,
            caseId: body.target.caseId,
            operator: {
              userId: body.userId,
              personId: body.principalId,
              // Ingress admits operators, but changing configuration takes admin —
              // the same question the Portal's configuration route asks, asked of
              // the same rank table so the two surfaces cannot drift apart.
              commandPermitted: slackOperatorMayConfigure(
                body.requestAuthority.role,
              ),
              role: slackOperatorRole(body.requestAuthority.role),
            },
            text: authoredText,
            portalUrl: portalAgentsUrl(env, body.organisationId),
            now: body.receivedAt,
          }),
    ),
    timed(
      assembleTurnContext({
        db: scope.database,
        organisationId: body.organisationId,
        caseId: partitionTarget.caseId,
        assignmentId: partitionTarget.assignmentId,
        sessionId: partitionTarget.sessionId,
        turnAuthority: authority,
        policy,
        query: views.contextQuery,
        now: body.receivedAt,
        tailReader: caseActor,
        // No verified subject is in scope, so no Memory scope can match.
        memoryReader: turnMemoryReaderWithoutSubjects(),
      }),
    ),
    timed(
      readCaseTurnAgentProfile(scope, {
        caseId: String(partitionTarget.caseId),
        assignmentId: String(partitionTarget.assignmentId),
        assignment: admittedCaseHoldsAssignment(
          admitted.value.value,
          partitionTarget.assignmentId,
        )
          ? "existing"
          : "new",
        selection: parseAgentProfileSelection(authoredText),
        now: body.receivedAt,
      }),
    ),
  ]);
  // A settled change or a setup handoff answers the message. It opens no
  // agent turn, so its context and profile are dropped and nothing is pinned.
  if (configuration.value.kind !== "not_a_configuration_reply") {
    const delivered = await deliverConfigurationOutcome({
      connector,
      connectorIdentity,
      body,
      binding,
      text: configuration.value.message.text,
    });
    return delivered;
  }
  const customConnectorHandoff = agentBrief
    ? null
    : customConnectorSetupHandoff({
        text: authoredText,
        mayConfigure: slackOperatorMayConfigure(body.requestAuthority.role),
        portalUrl: portalCustomConnectorUrl(env, body.organisationId),
      });
  if (customConnectorHandoff !== null) {
    return deliverConfigurationOutcome({
      connector,
      connectorIdentity,
      body,
      binding,
      text: customConnectorHandoff,
    });
  }
  if (served.value.kind !== "ready") return served.value;
  const actors = served.value;
  const actorResolutionMs =
    caseResolutionMs +
    (activeSession?.elapsedMs ?? 0) +
    (createdPair !== null || activeSession?.value ? 0 : served.elapsedMs);
  if (!context.value.ok) {
    return retry(body.receivedAt, context.value.error.code);
  }
  // The message opens an agent turn, so a first agent selection is pinned now.
  const pinStartedAt = Date.now();
  const profileResolution = await pinCaseTurnAgentProfile(scope, profile.value);
  traceLog("slack.case_turn_prepared", {
    requestId: body.requestId,
    organisation_id: body.organisationId,
    connector_id: body.target.connectorId,
    case_id: body.target.caseId,
    session_id: partitionTarget.sessionId,
    turn_id: `turn_${ingress.ingressId}`,
    elapsed_ms: Date.now() - body.receivedAt,
    // The record reads overlap each other, and the actor lookups overlap
    // admission. Each figure is that step's own duration, so they do not add
    // up to the elapsed time.
    workspace_load_ms: workspace.elapsedMs,
    authority_prepare_ms: turnAuthority.elapsedMs,
    case_admission_ms: admitted.elapsedMs,
    model_route_ms: modelRoute.elapsedMs,
    actor_resolution_ms: actorResolutionMs,
    context_assembly_ms: context.elapsedMs,
    overlapped_wait_ms: recordsReadAt - preparationStartedAt,
    // Set when this turn created an Actor. An activation is the call as this
    // Connector saw it, so a new Actor's figure includes its start.
    actor_reservation_ms: actors.creation?.reservationMs ?? null,
    case_activation_ms: actors.creation?.caseActivationMs ?? null,
    session_activation_ms: actors.creation?.sessionActivationMs ?? null,
    actor_publication_ms: actors.creation?.publicationMs ?? null,
    // Whether the new Actors ran on the Connector's warm slots.
    actor_slots: actors.creation?.actorSlots ?? null,
  });
  traceLog("slack.case_agent_setup_timing", {
    requestId: body.requestId,
    organisation_id: body.organisationId,
    case_id: body.target.caseId,
    session_id: partitionTarget.sessionId,
    turn_id: `turn_${ingress.ingressId}`,
    started_at: lastReadsStartedAt,
    duration_ms: Date.now() - lastReadsStartedAt,
    configuration_reply_ms: configuration.elapsedMs,
    agent_profile_ms: profile.elapsedMs + (Date.now() - pinStartedAt),
    profile_outcome: profileResolution.kind,
  });
  let pinnedAgent: PinnedAgentProfile | null;
  switch (profileResolution.kind) {
    case "resolved":
      pinnedAgent = profileResolution.profile;
      break;
    case "unselected":
      pinnedAgent = null;
      break;
    case "unavailable":
      return deliverConfigurationOutcome({
        connector,
        connectorIdentity,
        body,
        binding,
        text:
          profileResolution.error.code === "pinned_agent_selection_changed"
            ? "This conversation keeps the instructions it started with. To use the agent you addressed, start a new conversation."
            : "I couldn’t load the requested agent’s active instructions and skills. Check its name and assignment, then start a new conversation.",
      });
    default:
      return assertNever(profileResolution);
  }
  // The three Actors of this conversation stay in memory for a reply that
  // follows soon, and the Connector's warm slots for its next new thread. A
  // slot that the Connector no longer keeps is emptied after the residency
  // Actor drops it. The call runs beside the turn, so the turn waits for
  // nothing more. It never rejects.
  const slots = connector.warmActorSlots.refresh();
  const residency = keepConversationResident({
    env,
    organisationId: body.organisationId,
    placement: scope.placement,
    connectorId: body.target.connectorId,
    casePhysicalObjectName: actors.caseRoute.physicalObjectName,
    sessionPhysicalObjectName: actors.sessionRoute.physicalObjectName,
    warmSlots: slots.current,
  }).then(eraseWarmActorSlots.bind(null, env, slots.stale));
  const result = await runOngoingCaseTurn({
    env,
    attempt,
    projectContext: null,
    admittedCase: admitted.value.value,
    pinnedAgent,
    connector,
    caseActor: actors.caseActor,
    session: actors.session,
    sessionRoute: actors.sessionRoute,
    organisationId: body.organisationId,
    requestId: body.requestId,
    sessionId: partitionTarget.sessionId,
    connectorIdentity,
    ingress,
    binding,
    assignmentId: partitionTarget.assignmentId,
    purpose: views.casePurpose,
    principalId: body.principalId,
    policy,
    workspaceRevisionReceipt: workspace.value.value,
    receivedAt: body.receivedAt,
    turnAuthority: authority,
    revalidateTurnAuthority: prepareTurnAuthority.bind(null, {
      db: scope.database,
      accountAccess: scope.accountAccess,
      userAuthority: acceptedExecutionAccountAuthority(body.target.sessionId, body.requestId),
      action: "execute",
      organisationId: body.organisationId,
      requestAuthority: body.requestAuthority,
      policy,
    }),
    context: context.value.value,
    thinkingLevel: modelRoute.value.value.thinkingLevel,
    output: { kind: "slack_stream", recipientUserId: body.event.author },
  });
  await residency;
  if (!result.ok) {
    switch (result.error.kind) {
      case "usage_pending":
        return { kind: "rejected", reason: "session_usage_pending" };
      case "budget_exhausted":
        return deliverBudgetStopNotice({
          connector,
          connectorIdentity,
          body,
          dimension: result.error.exhaustion.dimension,
        });
      case "history_corruption":
        return {
          kind: "rejected",
          reason: `${result.error.source}:${result.error.code}`,
        };
      case "operational": {
        // A withheld answer is final: part of it is in the thread with its
        // notice, and the rest may never go there.
        if (result.error.code === WITHHELD_DELIVERY)
          return { kind: "rejected", reason: WITHHELD_DELIVERY };
        const goal = await actors.caseActor.readGoal({
          organisationId: body.organisationId,
          caseId: body.target.caseId,
        });
        if (!goal.ok) return retry(body.receivedAt, goal.error.code);
        if (goal.value.kind === "present") {
          if (goal.value.goal.unknownOperations > 0) {
            return { kind: "rejected", reason: "goal_usage_pending" };
          }
          if (goal.value.goal.state.kind !== "active") {
            return { kind: "rejected", reason: "goal_not_active" };
          }
        }
        return retry(body.receivedAt, result.error.code);
      }
      default:
        return assertNever(result.error);
    }
  }
  switch (result.value.kind) {
    case "completed":
      return deliverEmailReviewNotice({
        env,
        scope,
        connector,
        connectorIdentity,
        body,
        binding,
        caseId: partitionTarget.caseId,
        caseRevision: result.value.caseRevision,
      });
    case "duplicate_ingress":
      return deliverEmailReviewNotice({
        env,
        scope,
        connector,
        connectorIdentity,
        body,
        binding,
        caseId: partitionTarget.caseId,
        caseRevision: 0,
      });
    case "delivery_pending":
      return {
        kind: "retry",
        retryAt: result.value.retryAt,
        reason: "connector_delivery_pending",
      };
    case "delivery_held":
      return { kind: "completed" };
    default:
      return assertNever(result.value);
  }
}

/**
 * Tell the thread why the request stopped and where an owner raises the
 * budget. The stream posts no generic failure text for a budget stop.
 */
async function deliverBudgetStopNotice(
  input: Readonly<{
    connector: OngoingCaseWalkingConnector;
    connectorIdentity: ConnectorIdentity;
    body: SlackCaseCommand;
    dimension: SessionBudgetDimension;
  }>,
): Promise<SlackCaseProcessingResult> {
  const rejected: SlackCaseProcessingResult = {
    kind: "rejected",
    reason: `session_budget_exhausted:${input.dimension}`,
  };
  const delivered = await deliverPlatformText({
    connector: input.connector,
    connectorIdentity: input.connectorIdentity,
    body: input.body,
    binding: slackCaseBinding(input.body),
    deliveryId: budgetNoticeDeliveryId(slackCaseIngressId(input.body)),
    text: budgetStopNoticeText(input.dimension),
  });
  return delivered.kind === "retry" ? delivered : rejected;
}

async function deliverEmailReviewNotice(
  input: Readonly<{
    env: Env;
    scope: OrganisationExecutionScope;
    connector: OngoingCaseWalkingConnector;
    connectorIdentity: ConnectorIdentity;
    body: SlackCaseCommand;
    binding: CaseBinding;
    caseId: CaseId;
    caseRevision: number;
  }>,
): Promise<SlackCaseProcessingResult> {
  let review: EmailReviewProjection | null;
  try {
    review = await readLatestEmailReviewProjectionForCase({
      db: input.scope.database,
      organisationId: input.body.organisationId,
      caseId: input.caseId,
    });
  } catch {
    return retry(input.body.receivedAt, "email_review_projection_unavailable");
  }
  if (review === null || review.updatedAt < input.body.receivedAt) {
    return { kind: "completed" };
  }
  const address = await readOrganisationDefaultWorkspacePortalAddress({
    db: input.scope.database,
    organisationId: input.body.organisationId,
  });
  if (!address.ok) {
    return retry(input.body.receivedAt, address.error.code);
  }
  const notice = buildSlackEmailReviewNotice({
    review,
    portalUrl: portalEmailReviewUrl(
      input.env,
      address.value,
      review.proposalId,
    ),
  });
  if (notice === null) return { kind: "completed" };
  const delivered = await input.connector.deliver({
    identity: input.connectorIdentity,
    delivery: {
      deliveryId: notice.deliveryId,
      bindingId: input.binding.bindingId,
      address: input.binding.address,
      caseId: input.caseId,
      caseRevision: input.caseRevision,
      content: { kind: "text", text: notice.text },
      idempotencyKey: notice.deliveryId,
      addressedAt: review.updatedAt,
    },
    requestedAt: Date.now(),
  });
  if (!delivered.ok) {
    return retry(input.body.receivedAt, delivered.error.code);
  }
  switch (delivered.value.kind) {
    case "delivered":
    case "already_delivered":
      return { kind: "completed" };
    case "retry":
      return {
        kind: "retry",
        retryAt: delivered.value.retryAt,
        reason: "email_review_notice_delivery_pending",
      };
    case "rejected":
      return { kind: "rejected", reason: delivered.value.reason };
    default:
      return assertNever(delivered.value);
  }
}

/**
 * Run one accepted Slack message. The Connector passes the execution scope it
 * admitted against the directory for this item, and no other.
 */
/**
 * Run one claimed Slack message. `attempt` is the number of this claim of
 * the message, from 1.
 */
export async function processScheduledSlackCaseMessage(
  env: Env,
  body: SlackCaseCommand,
  attempt: number,
  connectorIdentity: ConnectorIdentity,
  connector: OngoingCaseWalkingConnector,
  scope: OrganisationExecutionScope,
): Promise<SlackCaseProcessingResult> {
  if (!isDeferredSlackCaseWork(String(body.event.eventId)))
    return processAcceptedSlackCaseMessage(
      env,
      body,
      attempt,
      connectorIdentity,
      connector,
      scope,
    );
  // Deferred work keeps its requester's authority from when it was queued.
  // An Access change since then advances the configuration version, which
  // supersedes that authority, so it is read again for the same person. A
  // requester who has left gets no turn.
  let authority: Awaited<ReturnType<typeof refreshSlackRequestAuthority>>;
  try {
    authority = await refreshSlackRequestAuthority(
      scope.database,
      body.requestAuthority,
    );
  } catch {
    return retry(body.receivedAt, "slack_case_authority_unavailable");
  }
  if (authority === null)
    return { kind: "rejected", reason: "slack_deferred_requester_inactive" };
  return processAcceptedSlackCaseMessage(
    env,
    { ...body, requestAuthority: authority },
    attempt,
    connectorIdentity,
    connector,
    scope,
  );
}

function prepareSlackTurnAuthority(
  scope: OrganisationExecutionScope,
  body: SlackCaseCommand,
  loading: ReturnType<typeof loadOrganisationPolicyOrDefaultDeny>,
) {
  return prepareTurnAuthority({
    db: scope.database,
    accountAccess: scope.accountAccess,
    userAuthority: acceptedExecutionAccountAuthority(body.target.sessionId, body.requestId),
    action: "execute",
    organisationId: body.organisationId,
    requestAuthority: body.requestAuthority,
    policy: loading.then(loadedPolicySnapshot),
  });
}

function loadedPolicySnapshot(
  loaded: Awaited<ReturnType<typeof loadOrganisationPolicyOrDefaultDeny>>,
) {
  return loaded.snapshot;
}

async function ingestCaseAttachments(
  env: Env,
  body: SlackCaseCommand,
): Promise<
  | {
      readonly kind: "ready";
      readonly value: readonly StoredMessageAttachment[];
    }
  | Variant<SlackCaseProcessingResult, "retry" | "rejected">
> {
  if (body.event.files.length === 0) {
    return { kind: "ready", value: [] };
  }
  const installationIdentity = resolveConfiguredSlackInstallationIdentity({
    deploymentProfile: env.SATYR_DEPLOYMENT_PROFILE,
    appId: env.SLACK_APP_ID,
  });
  if (!installationIdentity.ok) {
    return retry(body.receivedAt, "slack_case_install_unavailable");
  }
  const token = await resolveActiveSlackThreadCredential({
    env,
    keys: env,
    installationIdentity: installationIdentity.value,
    organisationId: body.organisationId,
    workspaceId: body.event.workspaceId,
    channelId: body.event.channelId,
    rootMessageTs: body.event.threadTs,
  });
  if (!token.ok || token.value.kind !== "bearer") {
    return retry(body.receivedAt, "slack_attachment_credential_unavailable");
  }
  const batch = await acquireSlackAttachmentBatch({
    bucket: env.ARCHIVE,
    organisationId: body.organisationId,
    integrationAccountId: body.integrationAccountId,
    event: body.event,
    token: token.value.value,
    now: body.receivedAt,
  });

  switch (batch.state) {
    case "committed":
      // Batch-atomic: the agent sees every file or none of them.
      return { kind: "ready", value: batch.attachments };
    case "retryable_failure":
      return retry(body.receivedAt, `slack_attachment_${batch.failure.code}`);
    case "rejected":
      return {
        kind: "rejected",
        reason: describeAttachmentRejection(batch.rejection),
      };
    default:
      return assertNever(batch);
  }
}

/**
 * Renders a permanent refusal for the Connector's user-visible notice.
 *
 * The applied limit travels with the reason so the message can say what the
 * rule was, not just that a rule was broken.
 */
function describeAttachmentRejection(rejection: AttachmentRejection): string {
  switch (rejection.code) {
    case "file_count_exceeded":
      return `slack_attachment_rejected:file_count_exceeded:limit=${rejection.limit}:observed=${rejection.observed}`;
    case "file_too_large":
      return `slack_attachment_rejected:file_too_large:limit=${rejection.limitBytes}:observed=${rejection.observedBytes}`;
    case "batch_too_large":
      return `slack_attachment_rejected:batch_too_large:limit=${rejection.limitBytes}:observed=${rejection.observedBytes}`;
    case "declared_size_invalid":
      return "slack_attachment_rejected:declared_size_invalid";
    case "byte_length_mismatch":
      return `slack_attachment_rejected:byte_length_mismatch:declared=${rejection.declared}:observed=${rejection.observed}`;
    case "contract_rejected":
      return `slack_attachment_rejected:contract_rejected:${rejection.reason}`;
    case "download_rejected":
      return "slack_attachment_rejected:download_rejected";
    default:
      return assertNever(rejection);
  }
}

function partitionSlackTarget(
  body: SlackCaseCommand,
  authorityPartitionDigest: string,
): SlackCaseCommand["target"] | null {
  const suffix = authorityPartitionDigest.slice(0, 24);
  const sessionId = parseSessionId(
    `${body.target.sessionId}_authority_${suffix}`,
  );
  const assignmentId = parseAssignmentId(
    `${body.target.assignmentId}_authority_${suffix}`,
  );
  if (!sessionId.ok || !assignmentId.ok) {
    return null;
  }
  return {
    ...body.target,
    sessionId: sessionId.value,
    assignmentId: assignmentId.value,
  };
}

/** The Case and Session a turn runs on, with the cost of creating them. */
type CreatedCaseActors = {
  readonly kind: "ready";
  readonly caseActor: DurableObjectStub<CaseDO>;
  readonly caseRoute: SessionActorRoute;
  readonly session: DurableObjectStub<SessionDO>;
  readonly sessionRoute: SessionActorRoute;
  /** Null when both Actors were found active and nothing was created. */
  readonly creation:
    | (ActorPairResolutionTiming & {
        readonly publicationMs: number;
        readonly actorSlots: "warm" | "partial" | "cold";
      })
    | null;
};

/**
 * Create the Case and its Session where either is missing, and publish the
 * activation. The publication keeps its own directory check.
 *
 * A new Actor takes a warm slot of the Connector when it has one. An Actor
 * whose registry row exists keeps its own name, and its slot goes back to the
 * store. A slot goes back only when the reservation shows that no row took
 * it: after a failure the Connector does not know, so it uses the slot no
 * more.
 */
async function createCaseActors(
  env: Env,
  scope: OrganisationExecutionScope,
  body: SlackCaseCommand,
  now: number,
  slotStore: ConnectorWarmActorSlots,
): Promise<
  CreatedCaseActors | Variant<SlackCaseProcessingResult, "retry" | "rejected">
> {
  const slots = slotStore.take();
  const resolved = await resolveCaseActors(env, scope, body, now, slots);
  if (resolved.kind !== "ready") return resolved;
  const used = slots === null ? [] : usedWarmSlots(slots, resolved);
  if (slots !== null)
    slotStore.giveBack(
      [slots.case, slots.session].filter((slot) => !used.includes(slot)),
    );
  const publicationStartedAt = Date.now();
  const published = await publishActorRegistryActivation({
    env: env,
    publication: resolved.registryActivation,
  });
  if (!published.ok) return retry(now, published.error.code);
  return {
    kind: "ready",
    caseActor: resolved.caseActor,
    caseRoute: resolved.caseRoute,
    session: resolved.session,
    sessionRoute: resolved.sessionRoute,
    creation: {
      ...resolved.timing,
      publicationMs: Date.now() - publicationStartedAt,
      actorSlots:
        used.length === 2 ? "warm" : used.length === 1 ? "partial" : "cold",
    },
  };
}

/** The slots that the pair's registry rows name. */
function usedWarmSlots(
  slots: { readonly case: WarmActorSlot; readonly session: WarmActorSlot },
  routes: {
    readonly caseRoute: SessionActorRoute;
    readonly sessionRoute: SessionActorRoute;
  },
): WarmActorSlot[] {
  const used: WarmActorSlot[] = [];
  if (slots.case.physicalObjectName === routes.caseRoute.physicalObjectName)
    used.push(slots.case);
  if (
    slots.session.physicalObjectName === routes.sessionRoute.physicalObjectName
  )
    used.push(slots.session);
  return used;
}

/**
 * Reserve and activate the Case and its Session under the scope the Connector
 * admitted for this item. Each new Actor checks the directory itself before
 * it activates, and the caller publishes the activations afterwards.
 */
async function resolveCaseActors(
  env: Env,
  scope: OrganisationExecutionScope,
  body: SlackCaseCommand,
  now: number,
  slots: {
    readonly case: WarmActorSlot;
    readonly session: WarmActorSlot;
  } | null,
): Promise<
  | {
      readonly kind: "ready";
      readonly caseActor: DurableObjectStub<CaseDO>;
      readonly caseRoute: SessionActorRoute;
      readonly session: DurableObjectStub<SessionDO>;
      readonly sessionRoute: SessionActorRoute;
      readonly registryActivation: ActorRegistryPublication;
      readonly timing: ActorPairResolutionTiming;
    }
  | Variant<SlackCaseProcessingResult, "retry" | "rejected">
> {
  const actors = await resolveActiveCaseSessionActorsAtScope({
    scope,
    caseNamespace: env.CASE,
    sessionNamespace: env.SESSION,
    caseId: body.target.caseId,
    sessionId: body.target.sessionId,
    now,
    ...(slots === null
      ? {}
      : {
          warmSlots: {
            case: slots.case.physicalObjectName,
            session: slots.session.physicalObjectName,
          },
        }),
  });
  return actors.ok
    ? {
        kind: "ready",
        caseActor: actors.value.caseActor,
        caseRoute: actors.value.caseRoute,
        session: actors.value.sessionActor,
        sessionRoute: actors.value.sessionRoute,
        registryActivation: actors.value.registryActivation,
        timing: actors.value.timing,
      }
    : retry(now, actors.error.code);
}

/** A step's result with the time that step alone took. */
async function timed<T>(
  step: Promise<T>,
): Promise<{ readonly value: T; readonly elapsedMs: number }> {
  const startedAt = Date.now();
  const value = await step;
  return { value, elapsedMs: Date.now() - startedAt };
}

function retry(
  now: number,
  reason: string,
): Variant<SlackCaseProcessingResult, "retry"> {
  return { kind: "retry", retryAt: Math.max(now, Date.now()) + 5_000, reason };
}
