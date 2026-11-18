import { Select } from "../../ui/select";
import React from "react";
import { assertNever } from "@seams/std";

import type {
  DropboxResourcePage,
  FileResourceAccount,
  FileResourceSelection,
  GoogleDrivePickedFile,
} from "@seams/control-api/portal/access-models";
import type { FileResourceDiscoveryEntry } from "@seams/control-api";
export type FileResourcePickerTransport = Readonly<{
  discoverDropbox: (
    input: Readonly<{
      integrationAccountId: string;
      path: string;
      query: string;
      cursor: string | null;
    }>,
  ) => Promise<DropboxResourcePage>;
  pickGoogleDrive: (
    integrationAccountId: string,
  ) => Promise<GoogleDrivePickedFile | null>;
}>;

type DiscoveryState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading"; previous: DropboxResourcePage | null }>
  | Readonly<{ kind: "ready"; page: DropboxResourcePage }>
  | Readonly<{
      kind: "failed";
      message: string;
      previous: DropboxResourcePage | null;
    }>;

export function FileResourcePicker(
  props: Readonly<{
    accounts: readonly FileResourceAccount[];
    selection: FileResourceSelection | null;
    change: (selection: FileResourceSelection | null) => void;
    transport: FileResourcePickerTransport;
  }>,
): React.ReactNode {
  const [accountId, setAccountId] = React.useState(
    firstAccountId(props.accounts),
  );
  const account = findAccount(props.accounts, accountId);
  if (props.accounts.length === 0) {
    return (
      <p className="access35-inline-alert" role="status">
        Connect Dropbox or Google Drive before granting file access.
      </p>
    );
  }
  return (
    <div className="access35-file-picker">
      <label htmlFor="access35-file-account">Connected file account</label>
      <Select.Root
        items={props.accounts.map(accountItem)}
        value={accountId}
        onValueChange={changeAccount.bind(null, setAccountId, props.change)}
      >
        <Select.Trigger id="access35-file-account">
          <Select.Value />
        </Select.Trigger>
        <Select.Popup>{props.accounts.map(renderAccountOption)}</Select.Popup>
      </Select.Root>
      {account?.provider === "dropbox" ? (
        <DropboxResourcePicker
          key={account.integrationAccountId}
          account={account}
          change={props.change}
          transport={props.transport}
        />
      ) : account?.provider === "google_drive" ? (
        <GoogleDriveResourcePicker
          key={account.integrationAccountId}
          account={account}
          change={props.change}
          transport={props.transport}
        />
      ) : null}
      <p className="access35-picker-status" role="status">
        {selectionLabel(props.selection)}
      </p>
    </div>
  );
}

type DropboxPickerProps = Readonly<{
  account: FileResourceAccount;
  change: (selection: FileResourceSelection | null) => void;
  transport: FileResourcePickerTransport;
}>;

type DropboxPickerState = Readonly<{
  path: string;
  query: string;
  discovery: DiscoveryState;
}>;

class DropboxResourcePicker extends React.Component<
  DropboxPickerProps,
  DropboxPickerState
> {
  state: DropboxPickerState = {
    path: "",
    query: "",
    discovery: { kind: "idle" },
  };
  private disposed = false;
  private error = React.createRef<HTMLParagraphElement>();

  componentDidMount(): void {
    this.disposed = false;
  }

  componentWillUnmount(): void {
    this.disposed = true;
  }

  private setPath(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({
      path: event.currentTarget.value,
      discovery: { kind: "idle" },
    });
  }

  private setQuery(event: React.ChangeEvent<HTMLInputElement>): void {
    this.setState({
      query: event.currentTarget.value,
      discovery: { kind: "idle" },
    });
  }

  private focusError = (): void => {
    this.error.current?.focus();
  };

  private searchKey(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (this.state.discovery.kind !== "loading") void this.search(null);
  }

  private async search(previous: DropboxResourcePage | null): Promise<void> {
    this.setState({ discovery: { kind: "loading", previous } });
    try {
      const page = await this.props.transport.discoverDropbox({
        integrationAccountId: this.props.account.integrationAccountId,
        path: this.state.path,
        query: this.state.query,
        cursor: previous?.nextCursor ?? null,
      });
      if (this.disposed) return;
      this.setState({
        discovery: {
          kind: "ready",
          page: {
            provider: "dropbox",
            entries: [...(previous?.entries ?? []), ...page.entries],
            nextCursor: page.nextCursor,
          },
        },
      });
    } catch (error) {
      if (!this.disposed)
        this.setState(
          {
            discovery: {
              kind: "failed",
              message: pickerProblem(error),
              previous,
            },
          },
          this.focusError,
        );
    }
  }

  render(): React.ReactNode {
    const discovery = this.state.discovery;
    const page = visibleDiscoveryPage(discovery);
    const busy = discovery.kind === "loading";
    return (
      <div className="access35-picker-controls" aria-busy={busy}>
        <label htmlFor="access35-dropbox-path">Dropbox folder path</label>
        <input
          id="access35-dropbox-path"
          value={this.state.path}
          disabled={busy}
          maxLength={2_048}
          placeholder="/ or /Recipes"
          onChange={this.setPath.bind(this)}
          onKeyDown={this.searchKey.bind(this)}
        />
        <label htmlFor="access35-dropbox-query">Find a folder or file</label>
        <input
          id="access35-dropbox-query"
          type="search"
          value={this.state.query}
          disabled={busy}
          maxLength={256}
          onChange={this.setQuery.bind(this)}
          onKeyDown={this.searchKey.bind(this)}
        />
        <button
          type="button"
          className="secondary"
          disabled={busy}
          onClick={this.search.bind(this, null)}
        >
          {busy ? "Searching Dropbox…" : "Search Dropbox"}
        </button>
        {discovery.kind === "failed" ? (
          <p
            className="access35-inline-alert"
            role="alert"
            ref={this.error}
            tabIndex={-1}
          >
            {discovery.message}
          </p>
        ) : null}
        {page !== null ? (
          <>
            {page.entries.length === 0 ? (
              <p role="status">
                No files or folders match. Try another folder path or search.
              </p>
            ) : null}
            <ul
              className="access35-picker-results"
              aria-label="Dropbox search results"
            >
              {page.entries.map(
                renderDropboxChoice.bind(
                  null,
                  this.props.account,
                  this.props.change,
                ),
              )}
            </ul>
            {page.nextCursor === null ? null : (
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={this.search.bind(this, page)}
              >
                Load more Dropbox results
              </button>
            )}
          </>
        ) : null}
      </div>
    );
  }
}

function visibleDiscoveryPage(
  state: DiscoveryState,
): DropboxResourcePage | null {
  switch (state.kind) {
    case "idle":
      return null;
    case "ready":
      return state.page;
    case "loading":
    case "failed":
      return state.previous;
    default:
      return assertNever(state, "Unknown file discovery state");
  }
}

function GoogleDriveResourcePicker(
  props: Readonly<{
    account: FileResourceAccount;
    change: (selection: FileResourceSelection | null) => void;
    transport: FileResourcePickerTransport;
  }>,
): React.ReactNode {
  const [problem, setProblem] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const container = React.useRef<HTMLDivElement>(null);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const wasBusy = React.useRef(false);
  React.useEffect(restoreGooglePickerFocus.bind(null, trigger, wasBusy, busy), [
    busy,
  ]);
  return (
    <div className="access35-picker-controls" ref={container}>
      <p>
        Choose a file in Google Drive. Sign in to the connected account if
        Google asks.
      </p>
      <button
        type="button"
        ref={trigger}
        className="secondary"
        disabled={busy}
        onClick={startGoogleDrivePicker.bind(
          null,
          props.account,
          props.transport,
          props.change,
          setProblem,
          setBusy,
          container,
        )}
      >
        {busy ? "Opening Google Drive…" : "Choose a Google Drive file"}
      </button>
      {problem === null ? null : (
        <p className="access35-inline-alert" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

async function startGoogleDrivePicker(
  account: FileResourceAccount,
  transport: FileResourcePickerTransport,
  change: (selection: FileResourceSelection | null) => void,
  setProblem: React.Dispatch<React.SetStateAction<string | null>>,
  setBusy: React.Dispatch<React.SetStateAction<boolean>>,
  container: React.RefObject<HTMLDivElement | null>,
  event: React.MouseEvent<HTMLButtonElement>,
): Promise<void> {
  const dialog = event.currentTarget.closest("dialog");
  dialog?.close();
  setBusy(true);
  setProblem(null);
  try {
    const file = await transport.pickGoogleDrive(account.integrationAccountId);
    if (file !== null && container.current?.isConnected === true) {
      change({
        integrationRef: integrationReference(account.integrationAccountId),
        scope: {
          kind: "gdrive_file",
          providerFileId: file.providerFileId,
          name: file.name,
        },
      });
    }
  } catch (error) {
    if (container.current?.isConnected === true)
      setProblem(pickerProblem(error));
  } finally {
    if (container.current?.isConnected === true) {
      setBusy(false);
      if (dialog?.isConnected === true && !dialog.open) dialog.showModal();
    }
  }
}

function restoreGooglePickerFocus(
  trigger: React.RefObject<HTMLButtonElement | null>,
  previous: React.RefObject<boolean>,
  busy: boolean,
): void {
  if (previous.current && !busy) trigger.current?.focus();
  previous.current = busy;
}

function accountItem(
  account: FileResourceAccount,
): Readonly<{ value: string; label: string }> {
  return {
    value: account.integrationAccountId,
    label: `${account.displayName} · ${
      account.provider === "dropbox" ? "Dropbox" : "Google Drive"
    }`,
  };
}

function renderAccountOption(account: FileResourceAccount): React.ReactNode {
  return (
    <Select.Item
      key={account.integrationAccountId}
      value={account.integrationAccountId}
    >
      {account.displayName} ·{" "}
      {account.provider === "dropbox" ? "Dropbox" : "Google Drive"}
    </Select.Item>
  );
}

function renderDropboxChoice(
  account: FileResourceAccount,
  change: (selection: FileResourceSelection | null) => void,
  resource: FileResourceDiscoveryEntry,
): React.ReactNode {
  return (
    <li key={dropboxResourceId(resource)}>
      <button
        type="button"
        className="secondary"
        onClick={chooseDropboxResource.bind(null, change, account, resource)}
      >
        {resource.pathDisplay}
      </button>
    </li>
  );
}

function chooseDropboxResource(
  change: (selection: FileResourceSelection | null) => void,
  account: FileResourceAccount,
  resource: FileResourceDiscoveryEntry,
): void {
  const integrationRef = integrationReference(account.integrationAccountId);
  switch (resource.kind) {
    case "dropbox_folder":
      change({
        integrationRef,
        scope: {
          kind: resource.kind,
          providerFolderId: resource.providerFolderId,
          pathDisplay: resource.pathDisplay,
        },
      });
      return;
    case "dropbox_file":
      change({
        integrationRef,
        scope: {
          kind: resource.kind,
          providerFileId: resource.providerFileId,
          pathDisplay: resource.pathDisplay,
        },
      });
      return;
  }
}

function changeAccount(
  setAccountId: React.Dispatch<React.SetStateAction<string>>,
  change: (selection: FileResourceSelection | null) => void,
  value: string | null,
): void {
  if (value === null) return;
  setAccountId(value);
  change(null);
}

function firstAccountId(accounts: readonly FileResourceAccount[]): string {
  return accounts[0]?.integrationAccountId ?? "";
}

function findAccount(
  accounts: readonly FileResourceAccount[],
  integrationAccountId: string,
): FileResourceAccount | null {
  for (const account of accounts) {
    if (account.integrationAccountId === integrationAccountId) return account;
  }
  return null;
}

function dropboxResourceId(resource: FileResourceDiscoveryEntry): string {
  switch (resource.kind) {
    case "dropbox_folder":
      return resource.providerFolderId;
    case "dropbox_file":
      return resource.providerFileId;
  }
}

function selectionLabel(selection: FileResourceSelection | null): string {
  if (selection === null) return "No file resource selected.";
  switch (selection.scope.kind) {
    case "dropbox_folder":
      return `Selected folder: ${selection.scope.pathDisplay}`;
    case "dropbox_file":
      return `Selected file: ${selection.scope.pathDisplay}`;
    case "gdrive_file":
      return `Selected file: ${selection.scope.name}`;
  }
}

function integrationReference(integrationAccountId: string): string {
  return `integration:${integrationAccountId}`;
}

function pickerProblem(error: unknown): string {
  // A network failure surfaces as a bare TypeError ("Failed to fetch"),
  // which is not operator copy; state the problem and the recovery instead.
  if (error instanceof TypeError) {
    return "The file provider could not be reached. Try again.";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "File selection failed. Try again.";
}
