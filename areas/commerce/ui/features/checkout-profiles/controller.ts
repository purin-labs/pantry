import React from "react";
import { toast } from "sonner";

import {
  activateCheckoutProfile,
  createCheckoutProfileDraft,
  publishCheckoutProfile,
  readCheckoutProfiles,
  replaceCheckoutProfileDraft,
  retireCheckoutProfile,
  type CheckoutProfileMutationTransport,
  type DraftCheckoutProfileSummary,
  type PublishedCheckoutProfileSummary,
} from "./api";
import {
  initialCheckoutProfilesState,
  profileReadiness,
  reduceCheckoutProfilesState,
  type CheckoutProfileAppliedMutation,
  type CheckoutProfilesAction,
  type CheckoutProfilesState,
  type ProfileDraft,
  type ReviewAction,
} from "./model";
import { assertNever, errorMessage } from "@purin-labs/std";

type CheckoutProfilesDispatch = React.Dispatch<CheckoutProfilesAction>;

type FormSubmissionEvent = Readonly<{ preventDefault: () => void }>;

type CheckoutProfilesCommandScope = {
  readonly organisationId: string;
  readonly currentOrganisation: Readonly<{ current: string }>;
  active: boolean;
};

export type CheckoutProfilesCommandContext = Readonly<{
  organisationId: string;
  mutate: CheckoutProfileMutationTransport;
  dispatch: CheckoutProfilesDispatch;
  scope: CheckoutProfilesCommandScope;
}>;

export type CreateDraftCommand = Readonly<{
  source: PublishedCheckoutProfileSummary;
  checkoutProfileId: string;
  name: string;
}>;

export type SaveDraftCommand = Readonly<{
  source: DraftCheckoutProfileSummary;
  draft: ProfileDraft;
}>;

type CheckoutProfilesController = Readonly<{
  state: CheckoutProfilesState;
  context: CheckoutProfilesCommandContext;
  reload: () => void;
}>;

export function useCheckoutProfilesController(input: {
  readonly organisationId: string;
  readonly mutate: CheckoutProfileMutationTransport;
}): CheckoutProfilesController {
  const [readRevision, setReadRevision] = React.useState(0);
  const [storedState, dispatch] = React.useReducer(
    reduceCheckoutProfilesState,
    input.organisationId,
    initialCheckoutProfilesState,
  );
  const currentOrganisation = React.useRef(input.organisationId);
  currentOrganisation.current = input.organisationId;
  const scope = React.useMemo(
    createCommandScope.bind(null, input.organisationId, currentOrganisation),
    [input.organisationId],
  );
  React.useEffect(commandScopeEffect.bind(null, scope), [scope]);
  React.useEffect(
    loadProfilesEffect.bind(null, input.organisationId, dispatch),
    [input.organisationId, readRevision],
  );
  const state =
    storedState.organisationId === input.organisationId
      ? storedState
      : initialCheckoutProfilesState(input.organisationId);
  return {
    state,
    reload: setReadRevision.bind(null, incrementReadRevision),
    context: {
      organisationId: input.organisationId,
      mutate: input.mutate,
      dispatch,
      scope,
    },
  };
}

function incrementReadRevision(revision: number): number {
  return revision + 1;
}

export async function handleCreateSubmit(
  context: CheckoutProfilesCommandContext,
  command: CreateDraftCommand,
  event: FormSubmissionEvent,
): Promise<void> {
  event.preventDefault();
  context.dispatch({ kind: "startMutation", action: "create" });
  try {
    const created = await createCheckoutProfileDraft(
      context.organisationId,
      command.source,
      {
        checkoutProfileId: command.checkoutProfileId,
        name: command.name,
      },
      context.mutate,
    );
    if (!commandIsCurrent(context)) {
      return;
    }
    context.dispatch({
      kind: "mutationSucceeded",
      organisationId: context.organisationId,
      mutation: {
        kind: "profileChanged",
        selected: created,
        clearCreateForm: true,
      },
    });
    toast.success("Draft created. Configure it, then review publication.");
  } catch (error) {
    failCurrentCommand(context, error);
  }
}

export async function handleSaveSubmit(
  context: CheckoutProfilesCommandContext,
  command: SaveDraftCommand,
  event: FormSubmissionEvent,
): Promise<void> {
  event.preventDefault();
  if (!saveCommandMatchesSource(command)) {
    context.dispatch({
      kind: "operationFailed",
      organisationId: context.organisationId,
      message: "The selected draft changed. Review it before saving.",
    });
    return;
  }
  const readiness = profileReadiness(command.draft);
  if (readiness.blockers.length > 0) {
    context.dispatch({
      kind: "operationFailed",
      organisationId: context.organisationId,
      message: readiness.blockers[0] ?? "The checkout profile is not ready.",
    });
    return;
  }
  context.dispatch({ kind: "startMutation", action: "save" });
  try {
    const updated = await replaceCheckoutProfileDraft(
      context.organisationId,
      command.source,
      {
        name: command.draft.name,
        configuration: command.draft.configuration,
      },
      context.mutate,
    );
    if (!commandIsCurrent(context)) {
      return;
    }
    context.dispatch({
      kind: "mutationSucceeded",
      organisationId: context.organisationId,
      mutation: {
        kind: "profileChanged",
        selected: updated,
        clearCreateForm: false,
      },
    });
    toast.success(`Revision ${updated.profile.revision} saved.`);
  } catch (error) {
    failCurrentCommand(context, error);
  }
}

export async function confirmReview(
  context: CheckoutProfilesCommandContext,
  review: ReviewAction,
): Promise<void> {
  context.dispatch({ kind: "startReview" });
  try {
    const mutation = await executeReview(review, context);
    if (!commandIsCurrent(context)) {
      return;
    }
    context.dispatch({
      kind: "mutationSucceeded",
      organisationId: context.organisationId,
      mutation,
    });
    toast.success(reviewSuccessMessage(review));
  } catch (error) {
    failCurrentCommand(context, error);
  }
}

function createCommandScope(
  organisationId: string,
  currentOrganisation: Readonly<{ current: string }>,
): CheckoutProfilesCommandScope {
  return { organisationId, currentOrganisation, active: true };
}

function commandScopeEffect(scope: CheckoutProfilesCommandScope): () => void {
  return deactivateCommandScope.bind(null, scope);
}

function deactivateCommandScope(scope: CheckoutProfilesCommandScope): void {
  scope.active = false;
}

function commandIsCurrent(context: CheckoutProfilesCommandContext): boolean {
  return (
    context.scope.active &&
    context.scope.organisationId === context.organisationId &&
    context.scope.currentOrganisation.current === context.organisationId
  );
}

function failCurrentCommand(
  context: CheckoutProfilesCommandContext,
  error: unknown,
): void {
  if (!commandIsCurrent(context)) {
    return;
  }
  context.dispatch({
    kind: "operationFailed",
    organisationId: context.organisationId,
    message: errorMessage(error, "Checkout profile operation failed."),
  });
}

function loadProfilesEffect(
  organisationId: string,
  dispatch: CheckoutProfilesDispatch,
): () => void {
  const gate = { active: true };
  dispatch({ kind: "loadStarted", organisationId });
  void loadProfiles(organisationId, dispatch, gate);
  return deactivate.bind(null, gate);
}

async function loadProfiles(
  organisationId: string,
  dispatch: CheckoutProfilesDispatch,
  gate: { active: boolean },
): Promise<void> {
  try {
    const collection = await readCheckoutProfiles(organisationId);
    if (gate.active) {
      dispatch({ kind: "loadSucceeded", organisationId, collection });
    }
  } catch (error) {
    if (gate.active) {
      dispatch({
        kind: "loadFailed",
        organisationId,
        message: errorMessage(error, "Checkout profile operation failed."),
      });
    }
  }
}

function deactivate(gate: { active: boolean }): void {
  gate.active = false;
}

function executeReview(
  review: ReviewAction,
  context: CheckoutProfilesCommandContext,
): Promise<CheckoutProfileAppliedMutation> {
  switch (review.kind) {
    case "publish":
      return executePublication(review.profile, context);
    case "activate":
      return executeActivation(review.profile, review.storefrontId, context);
    case "retire":
      return executeRetirement(review.profile, context);
    default:
      return assertNever(review, "Unexpected checkout profile command");
  }
}

async function executePublication(
  profile: DraftCheckoutProfileSummary,
  context: CheckoutProfilesCommandContext,
): Promise<CheckoutProfileAppliedMutation> {
  const selected = await publishCheckoutProfile(
    context.organisationId,
    profile,
    context.mutate,
  );
  return { kind: "profileChanged", selected, clearCreateForm: false };
}

async function executeActivation(
  profile: PublishedCheckoutProfileSummary,
  storefrontId: string,
  context: CheckoutProfilesCommandContext,
): Promise<CheckoutProfileAppliedMutation> {
  const result = await activateCheckoutProfile(
    context.organisationId,
    storefrontId,
    profile,
    context.mutate,
  );
  return {
    kind: "activationChanged",
    selected: result.profile,
    activation: result.activation,
  };
}

async function executeRetirement(
  profile: PublishedCheckoutProfileSummary,
  context: CheckoutProfilesCommandContext,
): Promise<CheckoutProfileAppliedMutation> {
  const selected = await retireCheckoutProfile(
    context.organisationId,
    profile,
    context.mutate,
  );
  return { kind: "profileChanged", selected, clearCreateForm: false };
}

function saveCommandMatchesSource(command: SaveDraftCommand): boolean {
  return (
    command.source.profile.checkoutProfileId ===
      command.draft.checkoutProfileId &&
    command.source.profile.revision === command.draft.sourceRevision
  );
}

function reviewSuccessMessage(review: ReviewAction): string {
  switch (review.kind) {
    case "publish":
      return "Profile published. Review a storefront before activation.";
    case "activate":
      return "Profile activated for new buyer sessions.";
    case "retire":
      return "Profile retired.";
    default:
      return assertNever(review, "Unexpected checkout profile command");
  }
}
