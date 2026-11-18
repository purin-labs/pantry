import type { CheckoutProfile } from "@seams/contracts";
import React from "react";
import { Link } from "react-router";
import { PageSkeleton, RecoverableError } from "../../page-components";

import type { CheckoutProfileMutationTransport } from "./api";
import type { CheckoutProfileSummary } from "@seams/control-api/portal/checkout-profiles";
import {
  confirmReview,
  handleCreateSubmit,
  handleSaveSubmit,
  useCheckoutProfilesController,
  type CheckoutProfilesCommandContext,
} from "./controller";
import {
  activeStorefrontIds,
  activeReview,
  busyAction,
  isDraftProfileSummary,
  isPublishedProfileSummary,
  operationError,
  profileReadiness,
  profileDraftChanged,
  selectedProfile,
  type CheckoutProfilesAction,
} from "./model";
import { ProfileEditor } from "./profile-editor";
import { BuyingExperience } from "./buying-experience";
import { ProfileList } from "./profile-list";
import { ProfileLifecycle } from "./profile-lifecycle";
import { ProfileState } from "./profile-state";
import { ReviewPanel } from "./review-panel";
import "./styles.css";
import type { Variant } from "@seams/type-utils";

export function CheckoutProfilesRoute(props: {
  readonly organisationId: string;
  readonly canManage: boolean;
  readonly integrationsPath?: string | null;
  readonly mutate: CheckoutProfileMutationTransport;
}): React.ReactNode {
  const [settingsProfileId, setSettingsProfileId] = React.useState<
    string | null
  >(null);
  const controller = useCheckoutProfilesController({
    organisationId: props.organisationId,
    mutate: props.mutate,
  });
  const state = controller.state;
  const error =
    state.kind === "loading" ||
    state.kind === "loadFailed" ||
    state.kind === "empty"
      ? null
      : operationError(state);
  const errorNotice = React.useRef<HTMLParagraphElement>(null);
  React.useLayoutEffect(focusCheckoutError.bind(null, errorNotice, error), [
    error,
  ]);

  if (state.kind === "loading") {
    return <PageSkeleton label="Loading checkout settings" />;
  }
  if (state.kind === "loadFailed") {
    return (
      <RecoverableError
        message={state.message}
        action={
          <button type="button" onClick={controller.reload}>
            Try again
          </button>
        }
      />
    );
  }
  if (state.kind === "empty") {
    return (
      <section className="checkout-profile-empty">
        <h2>Set up how customers buy</h2>
        <p>
          Connect your commerce system to configure customer details, payment,
          pickup, and shipping. Seams support helps activate your storefront and
          installs the starting checkout settings for you to review.
        </p>
        {props.integrationsPath == null ? null : (
          <Link
            className="checkout-profile-empty-action"
            to={props.integrationsPath}
          >
            Open integrations
          </Link>
        )}
      </section>
    );
  }

  const selected = selectedProfile(state);
  const activeStorefronts = activeStorefrontIds(state.collection, selected);
  const editorDraft = state.draft;
  const readiness = profileReadiness(editorDraft);
  const review = activeReview(state);
  const busy = busyAction(state);
  const settingsOpen = settingsProfileId === selected.profile.checkoutProfileId;

  return (
    <section
      className="checkout-profile-workspace"
      aria-label="Checkout profiles"
    >
      <BuyingExperience
        configuration={editorDraft.configuration}
        activeCount={activeStorefronts.length}
        isDraft={selected.profile.lifecycle.state === "draft"}
        unsaved={profileDraftChanged(editorDraft, selected.profile)}
      />

      <div className="checkout-profile-detail">
        <header className="checkout-profile-detail-header">
          <div>
            <div className="checkout-profile-title-line">
              <h2>{selected.profile.name}</h2>
              <ProfileState state={selected.profile.lifecycle.state} />
            </div>
            <p>{activeStorefrontSummary(activeStorefronts)}</p>
          </div>
        </header>

        {error === null ? null : (
          <p
            ref={errorNotice}
            className="checkout-profile-error"
            role="alert"
            tabIndex={-1}
          >
            {error}
          </p>
        )}
        {selected.profile.lifecycle.state === "draft" ? null : (
          <p className="checkout-profile-locked-note">
            {lockedProfileNote(selected.profile.lifecycle.state)}
          </p>
        )}

        <div className="checkout-profile-grid">
          <div className="checkout-settings">
            <div className="checkout-settings-heading">
              <div>
                <h3>Checkout settings</h3>
                <p>
                  Control customer details, order limits, fulfillment, and
                  payment rules.
                </p>
              </div>
              <button
                type="button"
                aria-expanded={settingsOpen}
                aria-controls="checkout-settings-form"
                onClick={setSettingsProfileId.bind(
                  null,
                  settingsOpen ? null : selected.profile.checkoutProfileId,
                )}
              >
                {settingsOpen
                  ? "Hide settings"
                  : selected.profile.lifecycle.state === "draft" &&
                      props.canManage
                    ? "Edit settings"
                    : "View settings"}
              </button>
            </div>
            <ol className="checkout-settings-guide">
              <li>
                <strong>Configure</strong>
                <span>
                  Create a draft to make changes without affecting customers.
                </span>
              </li>
              <li>
                <strong>Save and publish</strong>
                <span>Review the settings and publish the saved version.</span>
              </li>
              <li>
                <strong>Activate</strong>
                <span>
                  Choose the storefront that should use this checkout.
                </span>
              </li>
            </ol>
            <div id="checkout-settings-form" hidden={!settingsOpen}>
              <ProfileEditor
                profile={selected}
                draft={editorDraft}
                readiness={readiness}
                canManage={props.canManage}
                busy={busy}
                dispatch={controller.context.dispatch}
                onSave={submitSave.bind(
                  null,
                  controller.context,
                  selected,
                  editorDraft,
                )}
              />
            </div>
          </div>

          <ProfileLifecycle
            collection={state.collection}
            profile={selected}
            draft={editorDraft}
            readiness={readiness}
            activationStorefrontId={state.activationStorefrontId}
            canManage={props.canManage}
            busy={busy !== null}
            dispatch={controller.context.dispatch}
          />
        </div>

        {review === null ? null : (
          <ReviewPanel
            review={review}
            busy={busy !== null}
            onClose={closeReview.bind(null, controller.context.dispatch)}
            onConfirm={confirmReview.bind(null, controller.context, review)}
          />
        )}
      </div>
      <ProfileList
        collection={state.collection}
        selectedProfileId={selected.profile.checkoutProfileId}
        createForm={state.createForm}
        canCreate={
          props.canManage && selected.profile.lifecycle.state === "published"
        }
        busy={busy !== null}
        dispatch={controller.context.dispatch}
        onCreate={submitCreate.bind(
          null,
          controller.context,
          selected,
          state.createForm,
        )}
      />
    </section>
  );
}

function focusCheckoutError(
  notice: React.RefObject<HTMLParagraphElement | null>,
  message: string | null,
): void {
  if (message === null) return;
  notice.current?.focus({ preventScroll: true });
  notice.current?.scrollIntoView({ block: "center", behavior: "auto" });
}

function activeStorefrontSummary(activeStorefronts: readonly string[]): string {
  if (activeStorefronts.length === 0) {
    return "This version is not active on a storefront.";
  }
  return `Used by ${activeStorefronts.length} ${activeStorefronts.length === 1 ? "storefront" : "storefronts"}.`;
}

function lockedProfileNote(
  state: Exclude<CheckoutProfile["lifecycle"]["state"], "draft">,
): string {
  return state === "published"
    ? "Published configuration · Create a draft to change these settings."
    : "Retired profiles are locked and cannot be activated again. In-flight checkouts stay valid.";
}

function closeReview(dispatch: React.Dispatch<CheckoutProfilesAction>): void {
  dispatch({ kind: "closeReview" });
}

function submitCreate(
  context: CheckoutProfilesCommandContext,
  profile: CheckoutProfileSummary,
  form: Variant<import("./model").CheckoutProfilesState, "ready">["createForm"],
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  if (!isPublishedProfileSummary(profile)) {
    event.preventDefault();
    return Promise.resolve();
  }
  return handleCreateSubmit(
    context,
    {
      source: profile,
      checkoutProfileId: form.checkoutProfileId,
      name: form.name,
    },
    event,
  );
}

function submitSave(
  context: CheckoutProfilesCommandContext,
  profile: CheckoutProfileSummary,
  draft: import("./model").ProfileDraft,
  event: React.FormEvent<HTMLFormElement>,
): Promise<void> {
  if (!isDraftProfileSummary(profile)) {
    event.preventDefault();
    return Promise.resolve();
  }
  return handleSaveSubmit(context, { source: profile, draft }, event);
}
