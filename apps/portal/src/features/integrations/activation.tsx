import type { ClaudeConnectionState } from "./claude-connection";
import type {
  FirstOperationalTask,
  OnboardingActivation,
} from "@purin-labs/contracts";
import React from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { workspacePagePath } from "../../route";
import { MutationLedger } from "../../mutation-state";
import type { Variant } from "@purin-labs/type-utils";
import {
  BLOCKER_COPY,
  isActiveIntegrationAccount,
  isSlackAccount,
  mutationBlocked,
} from "./settings-support";
import type { CommerceSystem, SetupFormDefaults } from "./settings-types";
import type { IntegrationAccount, OrganisationCodexConnection, OrganisationInferenceSelection, ReadinessAssessment } from "@purin-labs/control-api/portal/settings";
import {
  accountMatchesWorkspace,
  renderActivationProjection,
  renderApprovalAuthenticationReports,
} from "./slack";

export function ActivationBand(props: {
  readonly onActivate: () => Promise<void>;
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly organisationIsActive: boolean;
  readonly readiness: ReadinessAssessment | null;
  readonly activation: OnboardingActivation;
  readonly firstTask: FirstOperationalTask | null;
  readonly supportReference: string | null;
  readonly mutations: MutationLedger;
  readonly live: SetupLiveState;
  readonly canManage: boolean;
  readonly onOpenIntegration: (integrationId: string) => void;
}): React.ReactNode {
  if (props.organisationIsActive) return null;
  const readiness = props.readiness;
  const evaluating = mutationBlocked(props.mutations, { kind: "readiness" });
  if (readiness?.kind === "ready") {
    /* "Ready to start" is earned: it only headlines the state where readiness
       actually passed, never a list of reasons it hasn't. */
    return (
      <section
        className="portal-band activation-band"
        aria-labelledby="activation-title"
      >
        <div className="setup-ready" role="status">
          <span className="setup-ready-mark" aria-hidden="true">
            ✓
          </span>
          <div>
            <h2 id="activation-title">Ready to start</h2>
            <p>
              Owner, connected services, and Slack updates all check out.
              Activate this workspace to start operating.
            </p>
          </div>
        </div>
        {evaluating ? (
          <p className="readiness-evaluating" role="status">
            Rechecking readiness…
          </p>
        ) : null}
        {props.canManage ? (
          <button
            type="button"
            onClick={props.onActivate}
            disabled={
              mutationBlocked(props.mutations, { kind: "activation" }) ||
              props.activation.kind === "running"
            }
          >
            Activate workspace
          </button>
        ) : null}
        {renderActivationProjection(
          props.activation,
          props.firstTask,
          props.supportReference,
          props.organisationHandle,
          props.workspaceHandle,
        )}
        {renderApprovalAuthenticationReports(readiness.approvalAuthentication)}
      </section>
    );
  }
  return (
    <section
      className="portal-band activation-band"
      aria-labelledby="activation-title"
    >
      <SetupChecklist
        organisationHandle={props.organisationHandle}
        workspaceHandle={props.workspaceHandle}
        readiness={readiness}
        live={props.live}
        evaluating={evaluating}
        canManage={props.canManage}
        onOpenIntegration={props.onOpenIntegration}
      />
      {renderActivationProjection(
        props.activation,
        props.firstTask,
        props.supportReference,
        props.organisationHandle,
        props.workspaceHandle,
      )}
      {readiness === null
        ? null
        : renderApprovalAuthenticationReports(readiness.approvalAuthentication)}
    </section>
  );
}

/**
 * Readiness blockers arrive as an unordered set of codes and used to be
 * narrated three times on one screen (a text list here, cards on Home, and an
 * empty attention band contradicting both). This checklist is now the single
 * narration: a fixed, dependency-ordered step list where an absent blocker
 * code means the step is done, so finished work stays visibly checked off
 * instead of vanishing from a shrinking list.
 */
type SetupStep = {
  readonly id: "inference" | "commerce" | "slack" | "channel" | "updates";
  readonly title: string;
  readonly detail: string;
  /** Codes that keep this step open; none of them present means done. */
  readonly codes: readonly string[];
  /**
   * Fact on this very page that proves the step done. The readiness
   * assessment lags behind configuration changes, so a step the page can see
   * is finished (a chosen commerce system, a connected Slack account) never
   * waits for the assessment to catch up: live evidence outranks codes.
   */
  readonly live: keyof SetupLiveFacts | null;
  /**
   * Whether the live fact alone proves the step done. A visible connection
   * does; a mere selection (an inference source whose credential the server
   * still has to verify) only proves the step open when absent; the blocker
   * code keeps the final word on done.
   */
  readonly liveSufficient: boolean;
  /** Tile whose panel completes the step. */
  readonly integrationId: string;
  readonly actionLabel: string;
  /** Earlier step that must finish first; open steps behind it wait quietly. */
  readonly waitsFor: {
    readonly step: SetupStep["id"];
    readonly note: string;
  } | null;
};

type SetupLiveFacts = {
  readonly inferenceChosen: boolean;
  readonly commerceChosen: boolean;
  readonly slackConnected: boolean;
  readonly channelChosen: boolean;
};

type SetupLiveState = SetupLiveFacts & {
  readonly inferenceLabel: string | null;
  readonly commerceLabel: string | null;
  readonly slackLabel: string | null;
};

const SETUP_STEPS: readonly SetupStep[] = [
  {
    id: "inference",
    title: "Choose your AI account",
    detail: "Your Claude or ChatGPT plan, an API key, or Purin AI.",
    codes: ["runtime_admission_unavailable"],
    live: "inferenceChosen",
    /* A selection is not proof the credential resolves server-side, so the
       readiness code keeps the final word on this step being done. */
    liveSufficient: false,
    integrationId: "codex",
    actionLabel: "Choose AI account",
    waitsFor: null,
  },
  {
    id: "commerce",
    title: "Choose your commerce system",
    detail: "Products, stock, and orders come from here.",
    codes: ["commerce_system_missing"],
    live: "commerceChosen",
    liveSufficient: true,
    integrationId: "commerce",
    actionLabel: "Choose commerce system",
    waitsFor: null,
  },
  {
    id: "slack",
    title: "Connect Slack",
    detail: "Purin Pantry sends approval requests and team updates through Slack.",
    codes: ["communication_connection_missing"],
    live: "slackConnected",
    liveSufficient: true,
    integrationId: "slack",
    actionLabel: "Connect Slack",
    waitsFor: null,
  },
  {
    id: "channel",
    title: "Choose a Slack channel",
    detail: "Where updates and approval requests go.",
    codes: ["communication_destination_missing"],
    live: "channelChosen",
    liveSufficient: true,
    integrationId: "slack",
    actionLabel: "Choose a channel",
    waitsFor: { step: "slack", note: "Needs Slack" },
  },
  {
    id: "updates",
    title: "Save your Slack update settings",
    detail: "Confirms what Purin Pantry posts, and where.",
    codes: ["policy_snapshot_missing", "cue_snapshot_missing"],
    live: null,
    liveSufficient: false,
    integrationId: "slack",
    actionLabel: "Save settings",
    waitsFor: { step: "channel", note: "Needs a channel" },
  },
];

/** Codes the guided steps claim; anything else renders as its own issue row. */
const SETUP_STEP_CODES: ReadonlySet<string> = new Set(
  SETUP_STEPS.flatMap(setupStepCodeList),
);

function setupStepCodeList(step: SetupStep): readonly string[] {
  return step.codes;
}

function SetupChecklist(props: {
  readonly organisationHandle: string;
  readonly workspaceHandle: string;
  readonly readiness: Variant<ReadinessAssessment, "blocked"> | null;
  readonly live: SetupLiveState;
  readonly evaluating: boolean;
  readonly canManage: boolean;
  readonly onOpenIntegration: (integrationId: string) => void;
}): React.ReactNode {
  const codes =
    props.readiness === null
      ? null
      : new Set(props.readiness.blockers.map(readinessBlockerCode));
  const doneCount = SETUP_STEPS.filter(
    setupStepIsDone.bind(null, codes, props.live),
  ).length;
  const unknownCodes =
    codes === null
      ? ""
      : Array.from(codes)
          .filter(setupCodeIsUnclaimed)
          .filter(setupCodeIsUnknown)
          .join(", ");
  React.useEffect(announceUnknownBlockers.bind(null, unknownCodes), [
    unknownCodes,
  ]);
  return (
    <>
      <div className="setup-head">
        <div>
          <h2 id="activation-title">Set up your workspace</h2>
          <p>
            Purin Pantry checks that an owner is assigned, connected services
            work, and a Slack channel is ready for team updates.
          </p>
        </div>
        <p className="setup-progress" role="status">
          {doneCount} of {SETUP_STEPS.length} done
        </p>
      </div>
      <div className="setup-track" aria-hidden="true">
        <span style={setupTrackFillStyle(doneCount)} />
      </div>
      <ol className="setup-steps">
        {SETUP_STEPS.map(
          renderSetupStep.bind(
            null,
            codes,
            props.live,
            props.canManage,
            props.onOpenIntegration,
          ),
        )}
        {renderSetupVerifyRow(props.evaluating || codes === null)}
      </ol>
      {codes === null
        ? null
        : renderSetupIssues(
            codes,
            props.organisationHandle,
            props.workspaceHandle,
          )}
      {props.canManage ? null : (
        <p className="setup-manage-note">
          An owner or admin completes these steps.
        </p>
      )}
    </>
  );
}

function readinessBlockerCode(blocker: {
  readonly code: string;
  readonly integrationAccountId: string | null;
}): string {
  return blocker.code;
}

function setupTrackFillStyle(doneCount: number): React.CSSProperties {
  return { width: `${(doneCount / SETUP_STEPS.length) * 100}%` };
}

/**
 * Live page facts outrank the readiness assessment in both directions: a step
 * the page can see is finished never renders open because the assessment is
 * stale, and one it can see is unfinished never shows done because an old
 * assessment predates a disconnection. Codes decide only what the page
 * cannot observe directly.
 */
function setupStepIsDone(
  codes: ReadonlySet<string> | null,
  live: SetupLiveState,
  step: SetupStep,
): boolean {
  if (step.live !== null) {
    const observed = live[step.live];
    if (!observed) return false;
    if (step.liveSufficient) return true;
  }
  return codes !== null && step.codes.every(setupCodeAbsent.bind(null, codes));
}

function setupCodeAbsent(codes: ReadonlySet<string>, code: string): boolean {
  return !codes.has(code);
}

type SetupStepState = "done" | "actionable" | "waiting";

function setupStepState(
  codes: ReadonlySet<string> | null,
  live: SetupLiveState,
  step: SetupStep,
): SetupStepState {
  if (setupStepIsDone(codes, live, step)) return "done";
  const dependency =
    step.waitsFor === null
      ? null
      : SETUP_STEPS.find(matchesSetupStep.bind(null, step.waitsFor.step));
  if (
    dependency !== null &&
    dependency !== undefined &&
    !setupStepIsDone(codes, live, dependency)
  )
    return "waiting";
  return "actionable";
}

function matchesSetupStep(id: SetupStep["id"], step: SetupStep): boolean {
  return step.id === id;
}

function renderSetupStep(
  codes: ReadonlySet<string> | null,
  live: SetupLiveState,
  canManage: boolean,
  onOpenIntegration: (integrationId: string) => void,
  step: SetupStep,
  index: number,
): React.ReactNode {
  const state = setupStepState(codes, live, step);
  return (
    <li key={step.id} className={`setup-step setup-step-${state}`}>
      <span className="setup-step-glyph" aria-hidden="true">
        {state === "done" ? "✓" : index + 1}
      </span>
      <div className="setup-step-main">
        <span className="setup-step-title">{step.title}</span>
        <span className="setup-step-detail">{step.detail}</span>
      </div>
      {renderSetupStepEnd(state, step, live, canManage, onOpenIntegration)}
    </li>
  );
}

/** Done steps name what was chosen when the page knows it. */
function setupStepDoneLabel(live: SetupLiveState, step: SetupStep): string {
  if (step.id === "inference" && live.inferenceLabel !== null)
    return live.inferenceLabel;
  if (step.id === "commerce" && live.commerceLabel !== null)
    return live.commerceLabel;
  if (step.id === "slack" && live.slackLabel !== null) return live.slackLabel;
  return "Done";
}

function renderSetupStepEnd(
  state: SetupStepState,
  step: SetupStep,
  live: SetupLiveState,
  canManage: boolean,
  onOpenIntegration: (integrationId: string) => void,
): React.ReactNode {
  if (state === "done")
    return (
      <span className="setup-step-meta setup-step-meta-done">
        {setupStepDoneLabel(live, step)}
      </span>
    );
  if (state === "waiting")
    return <span className="setup-step-meta">{step.waitsFor?.note}</span>;
  if (!canManage) return null;
  return (
    <button
      type="button"
      className="setup-step-action"
      onClick={openSetupStepIntegration.bind(
        null,
        onOpenIntegration,
        step.integrationId,
      )}
    >
      {step.actionLabel}
    </button>
  );
}

function openSetupStepIntegration(
  onOpenIntegration: (integrationId: string) => void,
  integrationId: string,
): void {
  onOpenIntegration(integrationId);
}

function renderSetupVerifyRow(checking: boolean): React.ReactNode {
  return (
    <li className="setup-step setup-step-auto">
      <span className="setup-step-glyph" aria-hidden="true">
        ·
      </span>
      <div className="setup-step-main">
        <span className="setup-step-title">Purin Pantry checks everything</span>
        <span className="setup-step-detail">
          {checking
            ? "Checking now…"
            : "Runs on its own once the steps above are done."}
        </span>
      </div>
      <span className="setup-step-meta">Automatic</span>
    </li>
  );
}

/** Blocker codes outside the guided steps still surface, each exactly once. */
function renderSetupIssues(
  codes: ReadonlySet<string>,
  organisationHandle: string,
  workspaceHandle: string,
): React.ReactNode {
  const known = Array.from(codes)
    .filter(setupCodeIsUnclaimed)
    .filter(setupCodeHasCopy);
  if (known.length === 0) return null;
  return (
    <ul className="setup-issues" role="status">
      {known.map(
        renderSetupIssue.bind(null, organisationHandle, workspaceHandle),
      )}
    </ul>
  );
}

function setupCodeIsUnclaimed(code: string): boolean {
  return !SETUP_STEP_CODES.has(code);
}

function setupCodeHasCopy(code: string): boolean {
  return BLOCKER_COPY[code] !== undefined;
}

function setupCodeIsUnknown(code: string): boolean {
  return BLOCKER_COPY[code] === undefined;
}

function announceUnknownBlockers(codes: string): void {
  if (codes.length === 0) return;
  console.warn(`[readiness] Unmapped blocker code(s): ${codes}`);
  toast.warning(
    "A readiness check reported a problem Purin Pantry cannot name. It usually clears on the next recheck — contact support if it persists.",
  );
}

function renderSetupIssue(
  organisationHandle: string,
  workspaceHandle: string,
  code: string,
): React.ReactNode {
  return (
    <li key={code}>
      {BLOCKER_COPY[code]}
      {code === "owner_missing" ? (
        <>
          {" "}
          <Link
            to={workspacePagePath(
              organisationHandle,
              workspaceHandle,
              "settings",
            )}
          >
            Open workspace settings
          </Link>
        </>
      ) : null}
    </li>
  );
}

/** The live facts this page can prove without waiting for readiness. */
export function setupLiveState(
  commerceSystem: CommerceSystem | null,
  accounts: readonly IntegrationAccount[],
  setupDefaults: SetupFormDefaults,
  inferenceSelection: OrganisationInferenceSelection,
  codexConnection: OrganisationCodexConnection,
  claudeState: ClaudeConnectionState,
): SetupLiveState {
  const slack = accounts
    .filter(isSlackAccount)
    .filter(isActiveIntegrationAccount);
  const selectedSlack = slack.find(
    accountMatchesWorkspace.bind(null, setupDefaults.workspaceId),
  );
  const inferenceChosen =
    inferenceSelection.kind === "claude_oauth"
      ? claudeState.kind === "ready" &&
        claudeState.view.connection.kind === "connected"
      : inferenceSelection.kind !== "codex_subscription" ||
        codexConnection.kind === "connected";
  return {
    inferenceChosen,
    inferenceLabel: !inferenceChosen
      ? null
      : inferenceSelection.kind === "codex_subscription"
        ? "ChatGPT"
        : inferenceSelection.kind === "organisation_openai_api_key"
          ? "OpenAI API key"
          : inferenceSelection.kind === "organisation_anthropic_api_key"
            ? "Anthropic API key"
            : inferenceSelection.kind === "organisation_google_api_key"
              ? "Gemini API key"
              : inferenceSelection.kind === "claude_oauth"
              ? "Claude"
              : "Purin AI",
    commerceChosen: commerceSystem !== null,
    commerceLabel:
      commerceSystem === null
        ? null
        : commerceSystem.kind === "shopify"
          ? "Shopify"
          : "Purin Checkout",
    slackConnected: slack.length > 0,
    slackLabel: selectedSlack?.displayName ?? slack[0]?.displayName ?? null,
    channelChosen:
      selectedSlack !== undefined && setupDefaults.channelId !== "",
  };
}
