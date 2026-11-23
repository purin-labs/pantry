import React from "react";

import type { CheckoutProfileCollection } from "./api";
import {
  activeStorefrontIds,
  type CheckoutProfilesAction,
  type CheckoutProfilesReadyState,
} from "./model";
import { ProfileState } from "./profile-state";
import type { Variant } from "@purin-labs/type-utils";

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
    <section className="checkout-profile-list" aria-label="Checkout versions">
      <div className="checkout-profile-list-heading">
        <h2>Versions</h2>
        {props.canCreate ? (
          <button
            type="button"
            aria-expanded={creating}
            aria-controls="checkout-create-form"
            onClick={setCreating.bind(null, !creating)}
          >
            {creating ? "Cancel new draft" : "New draft"}
          </button>
        ) : null}
      </div>
      {props.canCreate ? (
        <form
          id="checkout-create-form"
          hidden={!creating}
          className="checkout-profile-create"
          onSubmit={props.onCreate}
          aria-describedby="checkout-profile-create-help"
        >
          <h3>New draft from the selected version</h3>
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
            aria-describedby="checkout-profile-create-help"
            autoComplete="off"
            required
          />
          <small id="checkout-profile-create-help">
            Use lowercase letters, numbers, underscores, and hyphens.
          </small>
          <button type="submit" disabled={props.busy}>
            Create draft
          </button>
        </form>
      ) : null}
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
    </section>
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
      <strong>{summary.profile.name}</strong>
      <small>Revision {summary.profile.revision}</small>
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
