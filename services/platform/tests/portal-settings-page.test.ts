// The portal owns its browser-only React runtime; the platform test harness renders it through the app-local package.
// @ts-expect-error React runtime declarations are scoped to apps/portal.
import React from "../../../apps/portal/node_modules/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationLedger } from "@purin-labs/control/portal/mutation-state";
import { ControlApiError } from "@purin-labs/control/portal/control-client";
import { parseIntegrationRouteSelection } from "../../../apps/portal/src/features/integrations/model";
import {
  executeIntegrationsRoute,
  // @ts-expect-error The portal build type-checks this JSX module.
} from "../../../apps/portal/src/portal";

import {
  IntegrationsRouteView,
  WorkspaceSettingsRouteView,
  autoSyncCommerce,
  integrationsRouteRefreshFailure,
  readySettingsRouteContent,
  refreshingSettingsRouteContent,
  settingsRouteFailureContent,
  navigateProviderAuthorizationSurface,
  openProviderAuthorizationSurface,
  // @ts-expect-error The portal build type-checks this JSX module.
} from "../../../apps/portal/src/features/integrations/settings-routes";
import {
  INTEGRATIONS_PAGE_PROPS,
  PORTAL_ACTIONS,
  renderIntegrationsPage,
  renderPortalMarkup,
} from "./portal-integrations-page-fixture";

const SLACK_ACCOUNT = {
  integrationAccountId: "slack_account",
  provider: "slack",
  environment: "development",
  providerAccountId: "workspace_1",
  accountKind: "workspace",
  displayName: "Cafe workspace",
  lifecycle: { kind: "active" },
  isDefaultForProvider: true,
  capabilities: [],
  scopes: [],
  selectedResources: [],
  credentialHealth: { kind: "healthy" },
  webhookHealth: { kind: "healthy" },
  eventRecency: { kind: "unavailable" },
};
const SLACK_WORKSPACE_SETUP_DEFAULTS = {
  ...INTEGRATIONS_PAGE_PROPS.setupDefaults,
  key: "read_and_propose:commerce_operator:workspace_1:",
  workspaceId: "workspace_1",
};
const SLACK_SAVE_FAILURE = {
  kind: "error",
  field: "form",
  message: "Slack destination could not be saved.",
};
const SLACK_CONNECT_FAILURE = {
  mutation: { kind: "connect_provider", provider: "slack" },
  message: "Slack could not be connected. Try again.",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Café settings page ownership", () => {
  it("falls back to current-window authorization when popups are blocked", () => {
    const open = vi.fn(() => null);
    const assign = vi.fn();
    vi.stubGlobal("window", {
      open,
      location: { assign },
      screenX: 0,
      screenY: 0,
      outerWidth: 1280,
      outerHeight: 800,
    });

    const opened = openProviderAuthorizationSurface();
    expect(opened).toEqual({ kind: "current_window" });
    navigateProviderAuthorizationSurface(
      opened,
      "https://connect.example/authorize",
    );
    expect(assign).toHaveBeenCalledWith("https://connect.example/authorize");
  });

  it("publishes export coordination through the versioned control boundary", async () => {
    const storage = new Map<string, string>();
    const requests: Array<{
      readonly input: string;
      readonly init: RequestInit | undefined;
    }> = [];
    const fetchMock = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        requests.push({ input: String(input), init });
        return new Response(
          JSON.stringify({
            ok: true,
            publication: { kind: "export_preset_published" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    vi.stubGlobal("document", { cookie: "pantry_csrf=csrf" });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    vi.stubGlobal("crypto", { randomUUID: () => "mutation-id" });
    vi.stubGlobal("fetch", fetchMock);

    await executeIntegrationsRoute("organisation_cafe", "cafe", "central", 7, {
      kind: "publish_export_coordination",
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request).toBeDefined();
    if (request === undefined)
      throw new Error("export coordination request was not sent");
    expect(request.input).toBe(
      "/v1/control/organisations/organisation_cafe/commerce/export-preset",
    );
    expect(request.init?.method).toBe("POST");
    expect(request.init?.body).toBe(
      JSON.stringify({ presetId: "export_coordination", version: 1 }),
    );
    expect(
      new Headers(request.init?.headers).get("x-pantry-configuration-version"),
    ).toBe("7");
  });

  it("removes a connected Slack workspace through the disable and erase lifecycle", async () => {
    slackRemovalRequests = [];
    slackRemovalMutationStorage = new Map();
    vi.stubGlobal("document", { cookie: "pantry_csrf=csrf" });
    vi.stubGlobal("sessionStorage", {
      getItem: readSlackRemovalMutation,
      setItem: writeSlackRemovalMutation,
      removeItem: deleteSlackRemovalMutation,
    });
    vi.stubGlobal("crypto", { randomUUID: slackRemovalMutationId });
    vi.stubGlobal("fetch", vi.fn(slackRemovalFetcher));

    await executeIntegrationsRoute("organisation_cafe", "cafe", "central", 7, {
      kind: "remove_connected_account",
      integrationAccountId: "slack_account",
    });

    expect(slackRemovalRequests).toHaveLength(2);
    expect(slackRemovalRequests.map(readSlackRemovalRequest)).toEqual([
      {
        path: "/v1/control/organisations/organisation_cafe/accounts/slack_account/disable",
        method: "POST",
        configurationVersion: "7",
      },
      {
        path: "/v1/control/organisations/organisation_cafe/accounts/slack_account",
        method: "DELETE",
        configurationVersion: "8",
      },
    ]);
  });

  it("sends organisation OpenAI keys without storing them and preserves non-secret inference payloads", async () => {
    const storage = new Map<string, string>();
    const storedMutationValues: string[] = [];
    const requests: Array<{
      readonly input: string;
      readonly init: RequestInit | undefined;
    }> = [];
    const organisationApiKey = "sk-organisation-secret-1234567890";
    const fetchMock = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        requests.push({ input: String(input), init });
        return new Response(
          JSON.stringify({
            ok: true,
            selection: { kind: "organisation_openai_api_key" },
            configurationVersion: 8,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("document", { cookie: "pantry_csrf=csrf" });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storedMutationValues.push(value);
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        storage.delete(key);
      },
    });
    vi.stubGlobal("crypto", { randomUUID: () => "mutation-id" });
    vi.stubGlobal("fetch", fetchMock);

    await executeIntegrationsRoute("organisation_cafe", "cafe", "central", 7, {
      kind: "select_inference",
      selection: { kind: "organisation_openai_api_key" },
      apiKey: organisationApiKey,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const organisationRequest = requests[0];
    expect(organisationRequest).toBeDefined();
    if (organisationRequest === undefined)
      throw new Error("organisation inference selection request was not sent");
    expect(organisationRequest.input).toBe(
      "/v1/control/organisations/organisation_cafe/inference",
    );
    expect(organisationRequest.init?.method).toBe("PUT");
    expect(organisationRequest.init?.body).toBe(
      JSON.stringify({
        selection: { kind: "organisation_openai_api_key" },
        apiKey: organisationApiKey,
      }),
    );
    expect(
      new Headers(organisationRequest.init?.headers).get(
        "x-pantry-configuration-version",
      ),
    ).toBe("7");
    expect(storedMutationValues).toEqual([]);

    await executeIntegrationsRoute("organisation_cafe", "cafe", "central", 8, {
      kind: "select_inference",
      selection: { kind: "pantry_platform" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const pantryRequest = requests[1];
    expect(pantryRequest).toBeDefined();
    if (pantryRequest === undefined)
      throw new Error("Pantry inference selection request was not sent");
    expect(pantryRequest.init?.method).toBe("PUT");
    expect(pantryRequest.init?.body).toBe(
      JSON.stringify({ selection: { kind: "pantry_platform" } }),
    );
    expect(
      new Headers(pantryRequest.init?.headers).get(
        "x-pantry-configuration-version",
      ),
    ).toBe("8");
    expect(storedMutationValues.join("\n")).not.toContain(organisationApiKey);
    expect(storage.size).toBe(0);
  });

  it("keeps route refreshes typed and separates forbidden access from recoverable failures", () => {
    const snapshot = { members: [], invitations: [] };
    const ready = readySettingsRouteContent(snapshot);
    expect(ready).toEqual({
      kind: "ready",
      data: snapshot,
      freshness: { kind: "current" },
      updating: false,
    });
    expect(refreshingSettingsRouteContent(ready)).toMatchObject({
      kind: "ready",
      updating: true,
      data: snapshot,
    });
    expect(
      settingsRouteFailureContent(
        new ControlApiError("forbidden", "forbidden"),
        "You cannot view workspace settings.",
      ),
    ).toEqual({
      kind: "unauthorized",
      reason: "You cannot view workspace settings.",
    });
    expect(
      settingsRouteFailureContent(
        new Error("network"),
        "You cannot view workspace settings.",
      ),
    ).toMatchObject({
      kind: "failed",
      problem: "Settings could not be loaded. Try again.",
      recovery: { label: "Try again" },
    });
    expect(
      integrationsRouteRefreshFailure(
        new Error("network"),
        "You cannot view connected systems.",
        refreshingSettingsRouteContent(ready),
      ),
    ).toMatchObject({
      kind: "ready",
      data: snapshot,
      updating: false,
      freshness: {
        kind: "delayed",
        explanation: expect.stringContaining(
          "Connected systems could not be refreshed.",
        ),
      },
    });
    expect(
      integrationsRouteRefreshFailure(
        new ControlApiError("forbidden", "forbidden"),
        "You cannot view connected systems.",
        ready,
      ),
    ).toEqual({
      kind: "unauthorized",
      reason: "You cannot view connected systems.",
    });
  });

  it("narrates setup as one ordered checklist with done, actionable, and waiting steps", () => {
    const markup = renderIntegrationsPage({
      commerceSystem: {
        kind: "builtin_commerce",
        bindingId: "binding_cafe",
        merchantId: "merchant_cafe",
        revision: 1,
        sync: {
          kind: "ready",
          acceptedResourceCount: 2,
          lastSyncedAt: Date.now(),
        },
      },
      readiness: {
        kind: "blocked",
        blockers: [
          // Stale assessment: it still lists the commerce blocker even
          // though the page can see a chosen commerce system above.
          { code: "commerce_system_missing", integrationAccountId: null },
          {
            code: "communication_connection_missing",
            integrationAccountId: null,
          },
          {
            code: "communication_destination_missing",
            integrationAccountId: null,
          },
          { code: "policy_snapshot_missing", integrationAccountId: null },
          { code: "owner_missing", integrationAccountId: null },
        ],
        approvalAuthentication: [],
      },
      // A ChatGPT plan without a connection leaves the AI step open.
      inferenceSelection: { kind: "codex_subscription" },
      organisationIsActive: false,
    });

    // The page can see the chosen commerce system, so live evidence outranks
    // the stale blocker code and the step stays visibly done, with its label.
    expect(markup).toContain("1 of 5 done");
    expect(markup).toContain("Choose your commerce system");
    expect(markup).toContain("Purin Checkout");
    // Slack is the first open step and carries the only enabled action.
    expect(markup).toContain(">Connect Slack</button>");
    // Steps behind an unmet dependency wait instead of competing for a click.
    expect(markup).toContain("Needs Slack");
    expect(markup).toContain("Needs a channel");
    // Codes outside the guided steps surface once as their own issue row.
    expect(markup).toContain("Assign an active workspace owner.");
  });

  it("keeps the commerce card honest about sync state and syncs itself", () => {
    const markup = renderIntegrationsPage({
      commerceSystem: {
        kind: "builtin_commerce",
        bindingId: "binding_cafe",
        merchantId: "merchant_cafe",
        revision: 4,
        sync: {
          kind: "delayed",
          acceptedResourceCount: 3,
          lastSyncedAt: Date.now() - 3 * 60 * 60 * 1000,
        },
      },
      initialIntegrationId: "commerce",
    });

    // A genuinely stuck sync still says so, but no longer instructs a manual
    // click (the page syncs itself) and no longer exposes internals.
    expect(markup).toContain("Behind");
    expect(markup).toContain("Sync now");
    expect(markup).not.toContain("Select Sync now");
    expect(markup).not.toContain("merchant_cafe");

    // The auto-sync fires once per visit, and only while actually behind.
    const started = { current: false };
    const sync = vi.fn(async () => {});
    autoSyncCommerce(started, false, sync);
    expect(sync).not.toHaveBeenCalled();
    autoSyncCommerce(started, true, sync);
    autoSyncCommerce(started, true, sync);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("parses only supported integration detail routes", () => {
    expect(
      parseIntegrationRouteSelection(
        "?integration=google_drive&account=drive-1&q=files",
      ),
    ).toEqual({
      kind: "detail",
      integrationId: "google_drive",
      accountId: "drive-1",
      query: "files",
    });
    expect(
      parseIntegrationRouteSelection(
        "?integration=linear&account=foreign&focus=account%3Aforeign",
      ),
    ).toEqual({
      kind: "overview",
      query: "",
      focusId: "account:foreign",
    });
  });

  it("keeps settings route transport and mutation state inside the route", () => {
    const integrationsMarkup = renderPortalMarkup(
      React.createElement(IntegrationsRouteView, {
        requestedIntegration: {
          kind: "detail",
          integrationId: "codex",
          accountId: null,
          query: "",
        },
        props: {
          organisationId: "organisation_settings",
          organisationHandle: "cafe",
          workspaceHandle: "shibuya",
          refreshKey: "1",
          canManage: true,
          canConnectCodex: true,
          transport: {
            readOverview: async () => {
              throw new Error("route read is not used by this view test");
            },
            readDetail: async () => {
              throw new Error("detail read is not used by this view test");
            },
            execute: async () => ({ kind: "completed" as const }),
          },
        },
        content: readySettingsRouteContent({
          commerceSystem: null,
          commerceSyncProblem: null,
          codexConnection: { kind: "disconnected", revision: 0 },
          inferenceSelection: { kind: "organisation_openai_api_key" },
          accounts: [],
          supportReference: null,
          whatsappApplicationConfigured: false,
          setupDefaults: INTEGRATIONS_PAGE_PROPS.setupDefaults,
          readiness: null,
          activation: {
            kind: "idle",
            organisation_id: "organisation_settings",
          },
          firstTask: null,
          organisationIsActive: false,
          configurationVersion: 1,
        }),
        detailContent: {
          kind: "ready",
          integrationId: "codex",
          data: {
            destinations: [],
            supportDiagnostics: null,
            credentialInventory: null,
            agentMailboxes: [],
            emailReplies: [],
            mailboxInstallations: [],
            whatsapp: {
              applicationConfigured: false,
              accounts: [],
              replies: [],
            },
          },
        },
        mutations: MutationLedger.empty(),
        pendingConfirm: null,
        pendingAuthorization: null,
        setupFeedback: { kind: "idle" },
        feedback: null,
        requestConfirm: ignoreConfirm,
        actions: PORTAL_ACTIONS,
        whatsappActions: PORTAL_ACTIONS,
        retry: ignoreRetry,
        retryDetail: ignoreRetry,
      }),
    );
    const workspaceMarkup = renderPortalMarkup(
      React.createElement(WorkspaceSettingsRouteView, {
        props: {
          organisationId: "organisation_settings",
          refreshKey: "1",
          organisation: { name: "Shibuya", lifecycle: "draft", role: "owner" },
          canManage: true,
          transport: {
            read: async () => {
              throw new Error("route read is not used by this view test");
            },
            execute: async () => ({ kind: "applied" as const }),
          },
        },
        content: readySettingsRouteContent({
          members: [],
          invitations: [],
          lifecycle: "draft",
          configurationVersion: 1,
        }),
        mutations: MutationLedger.empty(),
        pendingConfirm: null,
        feedback: null,
        requestConfirm: ignoreConfirm,
        actions: PORTAL_ACTIONS,
        retry: ignoreRetry,
      }),
    );
    expect(integrationsMarkup).toContain("Connected systems");
    expect(integrationsMarkup).toContain('type="password"');
    expect(integrationsMarkup).toContain('name="openAiApiKey"');
    expect(integrationsMarkup).toContain("OpenAI bills usage to your account.");
    expect(integrationsMarkup).not.toContain("sk-organisation-secret");
    expect(workspaceMarkup).toContain("Members and roles");
  });

  it("associates Slack setup errors with the affected field", () => {
    const markup = renderIntegrationsPage({
      accounts: [SLACK_ACCOUNT],
      setupDefaults: SLACK_WORKSPACE_SETUP_DEFAULTS,
      setupFeedback: {
        kind: "error",
        field: "channel",
        message: "Select a destination channel.",
      },
      initialIntegrationId: "slack",
    });

    expect(markup).toContain('name="channelId"');
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('aria-describedby="setup-channel-error"');
    expect(markup).toContain('id="setup-channel-error"');
    expect(markup).not.toContain(">Connect Slack</button>");
  });

  it("offers Slack installation when the workspace is not connected", () => {
    const markup = renderIntegrationsPage({ initialIntegrationId: "slack" });

    expect(markup).toContain(">Connect Slack</button>");
    expect(markup).toContain(
      "Connect Slack first, then choose the channel Purin Pantry should post to.",
    );
    expect(markup).not.toContain('name="channelId"');
    expect(markup).toContain("Close slack");
    expect(markup).not.toContain("Back to apps</a>");
    expect(markup).not.toContain(">Sign in with Airtable</button>");
    expect(markup).not.toContain('name="airtableBaseId"');
    expect(markup).not.toContain('type="password"');
  });

  it("associates mutation failures with the action that produced them", () => {
    const markup = renderIntegrationsPage({
      commerceSystem: {
        kind: "builtin_commerce",
        bindingId: "binding_1",
        merchantId: "merchant_1",
        revision: 1,
        sync: { kind: "delayed", acceptedResourceCount: 0, lastSyncedAt: 1 },
      },
      commerceSyncProblem: "Commerce sync could not be completed. Try again.",
      setupFeedback: SLACK_SAVE_FAILURE,
      feedback: SLACK_CONNECT_FAILURE,
      initialIntegrationId: "commerce",
    });

    expect(markup).toContain('id="commerce-sync-error"');
    expect(markup).toContain('aria-describedby="commerce-sync-error"');
    expect(markup).toContain('role="alert"');
    // Slack's own feedback belongs to the Slack panel, asserted separately.
    expect(markup).not.toContain("Slack could not be connected. Try again.");
  });

  it("reports Slack connection and save failures in the Slack detail", () => {
    const markup = renderIntegrationsPage({
      setupFeedback: SLACK_SAVE_FAILURE,
      feedback: SLACK_CONNECT_FAILURE,
      initialIntegrationId: "slack",
    });

    expect(markup).toContain("Slack could not be connected. Try again.");
    // No workspace means no channel form to bind the save error to, so it
    // still has to announce itself on its own.
    expect(markup).toContain('id="setup-form-error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Slack destination could not be saved.");
  });

  it("associates a Slack save failure with the form that produced it", () => {
    const markup = renderIntegrationsPage({
      accounts: [SLACK_ACCOUNT],
      setupDefaults: SLACK_WORKSPACE_SETUP_DEFAULTS,
      setupFeedback: SLACK_SAVE_FAILURE,
      initialIntegrationId: "slack",
    });

    expect(markup).toContain('id="setup-form-error"');
    expect(markup).toContain('aria-describedby="setup-form-error"');
    expect(markup).toMatch(
      /<button(?=[^>]*data-account-id="slack_account")(?![^>]*disabled)[^>]*>Remove this Slack workspace<\/button>/u,
    );
  });

  it("offers a fresh Slack connection after the sole workspace is disconnected", () => {
    const markup = renderIntegrationsPage({
      accounts: [
        {
          ...SLACK_ACCOUNT,
          displayName: "Previous workspace",
          lifecycle: { kind: "disabled" },
          isDefaultForProvider: false,
          credentialHealth: { kind: "missing" },
          webhookHealth: { kind: "disabled" },
        },
      ],
      initialIntegrationId: "slack",
    });

    expect(markup).toContain(
      'aria-label="Connect another Slack workspace in a popup"',
    );
    expect(markup).toContain("Previous workspace");
    expect(markup).toContain("Remove this Slack workspace");
  });
});

let slackRemovalRequests: Array<{
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}> = [];
let slackRemovalMutationStorage = new Map<string, string>();

async function slackRemovalFetcher(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  slackRemovalRequests.push({ input, init });
  const configurationVersion = slackRemovalRequests.length === 1 ? 8 : 9;
  return Response.json({
    kind: "success",
    projection: { configuration_version: configurationVersion },
  });
}

function readSlackRemovalMutation(key: string): string | null {
  return slackRemovalMutationStorage.get(key) ?? null;
}

function writeSlackRemovalMutation(key: string, value: string): void {
  slackRemovalMutationStorage.set(key, value);
}

function deleteSlackRemovalMutation(key: string): void {
  slackRemovalMutationStorage.delete(key);
}

function slackRemovalMutationId(): string {
  return "slack-removal-mutation";
}

function readSlackRemovalRequest(request: {
  readonly input: RequestInfo | URL;
  readonly init: RequestInit | undefined;
}): {
  readonly path: string;
  readonly method: string | undefined;
  readonly configurationVersion: string | null;
} {
  return {
    path: String(request.input),
    method: request.init?.method,
    configurationVersion: new Headers(request.init?.headers).get(
      "x-pantry-configuration-version",
    ),
  };
}

function ignoreConfirm(_key: string): void {}
function ignoreRetry(): void {}
