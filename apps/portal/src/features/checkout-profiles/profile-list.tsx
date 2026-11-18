import React from "react";

import type { CheckoutProfileCollection } from "./api";
import {
  activeStorefrontIds,
  type CheckoutProfilesAction,
  type CheckoutProfilesReadyState,
} from "./model";
import { ProfileState } from "./profile-state";
import type { Variant } from "@seams/type-utils";

type ProfileListAction = Variant<
  CheckoutProfilesAction,
  "selectProfile" | "changeCreateId" | "changeCreateName"
>;

type ProfileListDispatch = React.Dispatch<ProfileListAction>;

export function ProfileList(props: {
  readonly collection: CheckoutProfileCollection;
  readonly selectedProfileId: string;
  readonly createForm: CheckoutProfilesReadyState["createForm"];
  readonly canCreate: boolean;
  readonly busy: boolean;
  readonly dispatch: ProfileListDispatch;
  readonly onCreate: React.FormEventHandler<HTMLFormElement>;
}): React.ReactNode {
  const [creating, setCreating] = React.useState(false);
  return (
    <aside className="checkout-profile-list" aria-label="Profile list">
      <div className="checkout-profile-list-heading">
        <div>
          <p className="checkout-profile-eyebrow">Manage changes</p>
          <h2>Checkout versions</h2>
        </div>
        <span>{props.collection.profiles.length}</span>
      </div>
      <div className="checkout-profile-list-items">
        {props.collection.profiles.map(
          renderProfileButton.bind(
            null,
            props.selectedProfileId,
            props.collection,
            props.dispatch,
          ),
        )}
      </div>
      {props.canCreate ? (
        <div
          className="checkout-profile-create-disclosure"
          data-open={creating}
        >
          <button
            type="button"
            aria-expanded={creating}
            aria-controls="checkout-create-form"
            onClick={setCreating.bind(null, !creating)}
          >
            {creating ? "Cancel new draft" : "Create a draft"}
          </button>
          <form
            id="checkout-create-form"
            hidden={!creating}
            className="checkout-profile-create"
            onSubmit={props.onCreate}
            aria-describedby="checkout-profile-create-help"
          >
            <h3>Create a draft from these settings</h3>
            <p id="checkout-profile-create-help">
              Start with this profile’s settings and edit a new draft.
            </p>
            <label htmlFor="checkout-profile-create-name">Profile name</label>
            <input
              id="checkout-profile-create-name"
              value={props.createForm.name}
              onChange={changeCreateName.bind(null, props.dispatch)}
              autoComplete="off"
              required
            />
            <label htmlFor="checkout-profile-create-id">Profile ID</label>
            <input
              id="checkout-profile-create-id"
              value={props.createForm.checkoutProfileId}
              onChange={changeCreateId.bind(null, props.dispatch)}
              pattern="[a-z0-9_-]+"
              aria-describedby="checkout-profile-create-id-help"
              autoComplete="off"
              required
            />
            <small id="checkout-profile-create-id-help">
              Use lowercase letters, numbers, underscores, and hyphens.
            </small>
            <button type="submit" disabled={props.busy}>
              Create draft
            </button>
          </form>
        </div>
      ) : null}
    </aside>
  );
}

function renderProfileButton(
  selectedProfileId: string,
  collection: CheckoutProfileCollection,
  dispatch: ProfileListDispatch,
  summary: CheckoutProfileCollection["profiles"][number],
): React.ReactNode {
  const activeCount = activeStorefrontIds(collection, summary).length;
  const selected = summary.profile.checkoutProfileId === selectedProfileId;
  return (
    <button
      type="button"
      className={
        selected
          ? "checkout-profile-list-button checkout-profile-list-button-current"
          : "checkout-profile-list-button"
      }
      aria-current={selected ? "page" : undefined}
      onClick={selectProfile.bind(null, summary, dispatch)}
      key={summary.profile.checkoutProfileId}
    >
      <span>
        <strong>{summary.profile.name}</strong>
        <small>Revision {summary.profile.revision}</small>
      </span>
      <span>
        <ProfileState state={summary.profile.lifecycle.state} />
        {activeCount > 0 ? <small>{activeCount} active</small> : null}
      </span>
    </button>
  );
}

function selectProfile(
  profile: CheckoutProfileCollection["profiles"][number],
  dispatch: ProfileListDispatch,
): void {
  dispatch({ kind: "selectProfile", profile });
}

function changeCreateName(
  dispatch: ProfileListDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  dispatch({ kind: "changeCreateName", value: event.currentTarget.value });
}

function changeCreateId(
  dispatch: ProfileListDispatch,
  event: React.ChangeEvent<HTMLInputElement>,
): void {
  dispatch({ kind: "changeCreateId", value: event.currentTarget.value });
}
