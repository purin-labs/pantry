import {
  settleGoogleDrivePicker,
  type GooglePickerCallbackRuntime,
} from "./file-resource-boundary";
import type { GoogleDrivePickedFile, GoogleDrivePickerConfig } from "@purin-labs/control-api/portal/access-models";
import { isRecord } from "@purin-labs/std";

const GOOGLE_IDENTITY_SCRIPT = "https://accounts.google.com/gsi/client";
const GOOGLE_API_SCRIPT = "https://apis.google.com/js/api.js";

type GoogleTokenResponse = Readonly<{
  access_token?: string;
  error?: string;
}>;

type GoogleTokenClient = Readonly<{
  requestAccessToken: (override: Readonly<{ prompt: string }>) => void;
}>;

type GooglePicker = Readonly<{ setVisible: (visible: boolean) => void }>;

type GooglePickerRuntime = GooglePickerCallbackRuntime &
  Readonly<{
    DocsView: new () => Readonly<{
      setIncludeFolders: (include: boolean) => unknown;
      setSelectFolderEnabled: (enabled: boolean) => unknown;
    }>;
    PickerBuilder: new () => GooglePickerBuilder;
  }>;

type GooglePickerBuilder = {
  setOAuthToken: (token: string) => GooglePickerBuilder;
  setDeveloperKey: (key: string) => GooglePickerBuilder;
  setAppId: (appId: string) => GooglePickerBuilder;
  addView: (view: unknown) => GooglePickerBuilder;
  setCallback: (callback: (data: unknown) => void) => GooglePickerBuilder;
  build: () => GooglePicker;
};

type ScriptElement = {
  readonly dataset: { loaded?: string };
  src: string;
  async: boolean;
  addEventListener: (
    type: "load" | "error",
    listener: () => void,
    options: Readonly<{ once: boolean }>,
  ) => void;
};

type PortalDocument = Readonly<{
  querySelector: (selector: string) => ScriptElement | null;
  createElement: (tagName: "script") => ScriptElement;
  head: Readonly<{ append: (script: ScriptElement) => void }>;
}>;

type PortalWindow = Readonly<{
  google?: Readonly<{
    accounts: Readonly<{
      oauth2: Readonly<{
        initTokenClient: (
          input: Readonly<{
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
          }>,
        ) => GoogleTokenClient;
      }>;
    }>;
    picker?: GooglePickerRuntime;
  }>;
  gapi?: Readonly<{ load: (module: string, callback: () => void) => void }>;
}>;

declare const document: PortalDocument;
declare const window: PortalWindow;

export async function pickGoogleDriveFile(
  config: GoogleDrivePickerConfig,
): Promise<GoogleDrivePickedFile | null> {
  await Promise.all([
    loadExternalScript(GOOGLE_IDENTITY_SCRIPT),
    loadExternalScript(GOOGLE_API_SCRIPT),
  ]);
  await loadPickerApi();
  const token = await requestPickerToken(config);
  await verifyPickerIdentity(token, config.expectedPermissionId);
  return showPicker(config, token);
}

function loadExternalScript(source: string): Promise<void> {
  const existing = document.querySelector(`script[src="${source}"]`);
  if (existing?.dataset.loaded === "true") return Promise.resolve();
  return new Promise<void>(startScriptLoad.bind(null, source, existing));
}

function startScriptLoad(
  source: string,
  existing: ScriptElement | null,
  resolve: () => void,
  reject: (reason: Error) => void,
): void {
  const script = existing ?? document.createElement("script");
  script.addEventListener(
    "load",
    finishScriptLoad.bind(null, script, resolve),
    { once: true },
  );
  script.addEventListener("error", failScriptLoad.bind(null, reject), {
    once: true,
  });
  if (existing !== null) return;
  script.src = source;
  script.async = true;
  document.head.append(script);
}

function finishScriptLoad(script: ScriptElement, resolve: () => void): void {
  script.dataset.loaded = "true";
  resolve();
}

function failScriptLoad(reject: (reason: Error) => void): void {
  reject(new Error("Google Drive Picker could not load."));
}

function loadPickerApi(): Promise<void> {
  return new Promise<void>(startPickerApiLoad);
}

function startPickerApiLoad(
  resolve: () => void,
  reject: (reason: Error) => void,
): void {
  if (window.gapi === undefined) {
    reject(new Error("Google API runtime is unavailable."));
    return;
  }
  window.gapi.load("picker", resolve);
}

function requestPickerToken(config: GoogleDrivePickerConfig): Promise<string> {
  return new Promise<string>(startPickerTokenRequest.bind(null, config));
}

function startPickerTokenRequest(
  config: GoogleDrivePickerConfig,
  resolve: (token: string) => void,
  reject: (reason: Error) => void,
): void {
  const oauth = window.google?.accounts.oauth2;
  if (oauth === undefined) {
    reject(new Error("Google authorization is unavailable."));
    return;
  }
  const client = oauth.initTokenClient({
    client_id: config.clientId,
    scope: config.scope,
    callback: settlePickerToken.bind(null, resolve, reject),
  });
  client.requestAccessToken({ prompt: "consent" });
}

function settlePickerToken(
  resolve: (token: string) => void,
  reject: (reason: Error) => void,
  response: GoogleTokenResponse,
): void {
  if (
    typeof response.access_token === "string" &&
    response.access_token.length > 0
  ) {
    resolve(response.access_token);
    return;
  }
  reject(
    new Error(response.error ?? "Google Drive authorization was cancelled."),
  );
}

async function verifyPickerIdentity(
  token: string,
  expectedPermissionId: string,
): Promise<void> {
  const response = await fetch(
    "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)",
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok)
    throw new Error("Google Drive identity verification failed.");
  const body = record(await response.json(), "Google Drive identity");
  const user = record(body.user, "Google Drive user");
  if (user.permissionId !== expectedPermissionId) {
    throw new Error(
      "Choose files with the Google account that owns this connection.",
    );
  }
}

function showPicker(
  config: GoogleDrivePickerConfig,
  token: string,
): Promise<GoogleDrivePickedFile | null> {
  return new Promise<GoogleDrivePickedFile | null>(
    startPicker.bind(null, config, token),
  );
}

function startPicker(
  config: GoogleDrivePickerConfig,
  token: string,
  resolve: (file: GoogleDrivePickedFile | null) => void,
  reject: (reason: Error) => void,
): void {
  const picker = window.google?.picker;
  if (picker === undefined) {
    reject(new Error("Google Drive Picker is unavailable."));
    return;
  }
  const view = new picker.DocsView();
  view.setIncludeFolders(false);
  view.setSelectFolderEnabled(false);
  new picker.PickerBuilder()
    .setOAuthToken(token)
    .setDeveloperKey(config.apiKey)
    .setAppId(config.appId)
    .addView(view)
    .setCallback(settleGoogleDrivePicker.bind(null, picker, resolve, reject))
    .build()
    .setVisible(true);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  return value;
}
