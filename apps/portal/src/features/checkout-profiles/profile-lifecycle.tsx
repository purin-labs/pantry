import { Select } from "../../ui/select";
import React from "react";

import type { CheckoutProfileCollection } from "./api";
import type { CheckoutProfileSummary } from "@purin-labs/control-api/portal/checkout-profiles";
import {
  activeStorefrontIds,
  isDraftProfileSummary,
  isPublishedProfileSummary,
  profileDraftChanged,
  selectedActivationStorefront,
  storefrontIds,
  type CheckoutProfilesAction,
  type ProfileDraft,
  type Readiness,
} from "./model";
import type { Variant } from "@purin-labs/type-utils";

type ProfileLifecycleAction = Variant<
  CheckoutProfilesAction,
  "changeActivationStorefront" | "openReview"
>;

type ProfileLifecycleDispatch = React.Dispatch<ProfileLifecycleAction>;

export function ProfileLifecycle(props: {
  readonly collection: CheckoutProfileCollection;
  readonly profile: CheckoutProfileSummary;
  readonly draft: ProfileDraft;
  readonly readiness: Readiness;
  readonly activationStorefrontId: string;
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly dispatch: ProfileLifecycleDispatch;
}): React.ReactNode {
  const activeStorefronts = activeStorefrontIds(
    props.collection,
    props.profile,
  );
  const availableStorefronts = storefrontIds(props.collection);
  const selectedStorefrontId = selectedActivationStorefront(
    props.activationStorefrontId,
    availableStorefronts,
  );
  const unsaved = profileDraftChanged(props.draft, props.profile.profile);
  const publicationBlockerCount =
    props.readiness.blockers.length + (unsaved ? 1 : 0);
  const activeOnSelectedStorefront =
    selectedStorefrontId !== null &&
    activeStorefronts.includes(selectedStorefrontId);

  return (
    <aside className="checkout-profile-preview" aria-label="Profile readiness">
      <div className="checkout-profile-preview-heading">
        <h3>Publish & activate</h3>
        <span
          className={
            publicationBlockerCount === 0
              ? "checkout-ready"
              : "checkout-blocked"
          }
        >
          {publicationBlockerCount === 0
            ? "Checks passed"
            : `${publicationBlockerCount} to resolve`}
        </span>
      </div>
      <ul>
        {props.readiness.items.map(renderReadinessItem)}
        {props.profile.profile.lifecycle.state === "draft"
          ? renderSavedRevisionReadiness(unsaved)
          : null}
      </ul>

      {props.canManage ? (
        <LifecycleActions
          profile={props.profile}
          activeStorefronts={activeStorefronts}
          availableStorefronts={availableStorefronts}
          selectedStorefrontId={selectedStorefrontId}
          activeOnSelectedStorefront={activeOnSelectedStorefront}
          publicationBlockerCount={publicationBlockerCount}
          busy={props.busy}
          dispatch={props.dispatch}
        />
      ) : null}
    </aside>
  );
}

function LifecycleActions(props: {
  readonly profile: CheckoutProfileSummary;
  readonly activeStorefronts: readonly string[];
  readonly availableStorefronts: readonly string[];
  readonly selectedStorefrontId: string | null;
  readonly activeOnSelectedStorefront: boolean;
  readonly publicationBlockerCount: number;
  readonly busy: boolean;
  readonly dispatch: ProfileLifecycleDispatch;
}): React.ReactNode {
  return (
    <div className="checkout-profile-lifecycle-actions">
      {props.profile.profile.lifecycle.state === "draft" ? (
        <button
          type="button"
          disabled={props.busy || props.publicationBlockerCount > 0}
          onClick={openPublishReview.bind(null, props.profile, props.dispatch)}
        >
          Review publication
        </button>
      ) : null}
      {props.profile.profile.lifecycle.state === "published" &&
      props.availableStorefronts.length > 0 ? (
        <>
          <label htmlFor="checkout-profile-storefront">Storefront</label>
          <Select.Root
            items={props.availableStorefronts.map(storefrontItem)}
            value={props.selectedStorefrontId}
            onValueChange={changeActivationStorefront.bind(
              null,
              props.dispatch,
            )}
          >
            <Select.Trigger id="checkout-profile-storefront">
              <Select.Value />
            </Select.Trigger>
            <Select.Popup>
              {props.availableStorefronts.map(renderStorefrontOption)}
            </Select.Popup>
          </Select.Root>
          {props.activeOnSelectedStorefront ? (
            <p className="checkout-profile-active-status">
              <span aria-hidden="true">✓</span> Active on this storefront
            </p>
          ) : (
            <button
              type="button"
              disabled={props.busy || props.selectedStorefrontId === null}
              onClick={openActivationReview.bind(
                null,
                props.profile,
                props.selectedStorefrontId,
                props.dispatch,
              )}
            >
              Review activation
            </button>
          )}
        </>
      ) : null}
      {props.profile.profile.lifecycle.state === "published" &&
      props.activeStorefronts.length === 0 ? (
        <button
          className="checkout-profile-danger"
          type="button"
          disabled={props.busy}
          onClick={openRetirementReview.bind(
            null,
            props.profile,
            props.dispatch,
          )}
        >
          Review retirement
        </button>
      ) : null}
    </div>
  );
}

function openPublishReview(
  profile: CheckoutProfileSummary,
  dispatch: ProfileLifecycleDispatch,
): void {
  if (!isDraftProfileSummary(profile)) {
    return;
  }
  dispatch({ kind: "openReview", review: { kind: "publish", profile } });
}

function openActivationReview(
  profile: CheckoutProfileSummary,
  storefrontId: string | null,
  dispatch: ProfileLifecycleDispatch,
): void {
  if (storefrontId === null || !isPublishedProfileSummary(profile)) {
    return;
  }
  dispatch({
    kind: "openReview",
    review: { kind: "activate", profile, storefrontId },
  });
}

function openRetirementReview(
  profile: CheckoutProfileSummary,
  dispatch: ProfileLifecycleDispatch,
): void {
  if (!isPublishedProfileSummary(profile)) {
    return;
  }
  dispatch({ kind: "openReview", review: { kind: "retire", profile } });
}

function changeActivationStorefront(
  dispatch: ProfileLifecycleDispatch,
  value: string | null,
): void {
  if (value === null) return;
  dispatch({
    kind: "changeActivationStorefront",
    value,
  });
}

function renderReadinessItem(
  item: Readiness["items"][number],
): React.ReactNode {
  return (
    <li key={item.label} data-ready={item.ready}>
      <span aria-hidden="true">{item.ready ? "✓" : "!"}</span>
      <div>
        <strong>{item.label}</strong>
        <p>{item.detail}</p>
      </div>
    </li>
  );
}

function renderSavedRevisionReadiness(unsaved: boolean): React.ReactNode {
  return renderReadinessItem({
    label: "Saved revision",
    ready: !unsaved,
    detail: unsaved
      ? "Save these changes before reviewing publication."
      : "These settings match the saved draft.",
  });
}

function storefrontItem(
  storefrontId: string,
): Readonly<{ value: string; label: string }> {
  return { value: storefrontId, label: storefrontId };
}

function renderStorefrontOption(storefrontId: string): React.ReactNode {
  return (
    <Select.Item value={storefrontId} key={storefrontId}>
      {storefrontId}
    </Select.Item>
  );
}
