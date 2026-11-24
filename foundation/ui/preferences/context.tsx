import React from "react";
import { toast } from "sonner";
import type { PreferenceArea, UserId } from "@purin-labs/control-api";
import { UserPreferenceOwner } from "./owner";

export const UserPreferencesContext =
  React.createContext<UserPreferenceOwner | null>(null);
const AREAS: readonly PreferenceArea[] = ["appearance", "chat", "kitchen"];

export function UserPreferencesProvider(
  props: Readonly<{ userId: UserId; children: React.ReactNode }>,
): React.ReactNode {
  const [owner] = React.useState(createOwner.bind(null, props.userId));
  const feedback = React.useRef(new Map<PreferenceArea, string | number>());
  React.useEffect(startOwner.bind(null, owner, feedback.current), [owner]);
  React.useSyncExternalStore(
    owner.subscribe.bind(owner),
    owner.getVersion.bind(owner),
  );
  React.useEffect(reportFailures.bind(null, owner, feedback.current), [
    owner,
    owner.getVersion(),
  ]);
  return (
    <UserPreferencesContext.Provider value={owner}>
      {props.children}
    </UserPreferencesContext.Provider>
  );
}
function createOwner(userId: UserId): UserPreferenceOwner {
  return new UserPreferenceOwner(userId);
}
function startOwner(
  owner: UserPreferenceOwner,
  feedback: Map<PreferenceArea, string | number>,
): () => void {
  owner.start();
  return disposeOwner.bind(null, owner, feedback);
}
function disposeOwner(
  owner: UserPreferenceOwner,
  feedback: Map<PreferenceArea, string | number>,
): void {
  owner.dispose();
  for (const id of feedback.values()) toast.dismiss(id);
  feedback.clear();
}
function reportFailures(
  owner: UserPreferenceOwner,
  feedback: Map<PreferenceArea, string | number>,
): void {
  for (const area of AREAS) {
    const message = owner.failure(area);
    const existing = feedback.get(area);
    if (message === null) {
      if (existing !== undefined) {
        feedback.delete(area);
        toast.dismiss(existing);
      }
    } else if (existing === undefined) {
      const id = toast.error(message, {
        duration: Infinity,
        position: "top-center",
        closeButton: true,
        classNames: { closeButton: "preference-toast-close" },
        action: { label: "Retry", onClick: owner.retry.bind(owner, area) },
      });
      feedback.set(area, id);
    }
  }
}
const subscribeEmpty = (_listener: () => void): (() => void) =>
  unsubscribeEmpty;
function unsubscribeEmpty(): void {}
function emptyVersion(): number {
  return 0;
}
export function useUserPreferences(
  area: PreferenceArea,
): UserPreferenceOwner | null {
  const owner = React.useContext(UserPreferencesContext);
  React.useSyncExternalStore(
    owner === null ? subscribeEmpty : owner.subscribe.bind(owner),
    owner === null ? emptyVersion : owner.getVersion.bind(owner),
  );
  React.useEffect(loadArea.bind(null, owner, area), [owner, area]);
  return owner;
}
function loadArea(
  owner: UserPreferenceOwner | null,
  area: PreferenceArea,
): void {
  void owner?.load(area);
}
