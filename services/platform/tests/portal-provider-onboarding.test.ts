import { afterEach, describe, expect, it, vi } from "vitest";
import { MutationLedger } from "../../../apps/portal/src/mutation-state";
import {
  beginProviderAuthorizationWatch,
  beginProviderCompletionListener,
  providerAuthorizationInterruptedMessage,
  providerAuthorizationOutcome,
  providerConnectionState,
  // @ts-expect-error The portal build type-checks this JSX module.
} from "../../../apps/portal/src/features/integrations/settings-routes";
// @ts-expect-error The portal's JSX module is type-checked by its app-local build.
import { providerAttemptFailureCopy } from "../../../apps/portal/src/provider-onboarding";
// @ts-expect-error The portal's JSX module is type-checked by its app-local build.
import { whatsappAttemptFailureCopy } from "../../../apps/portal/src/pages/whatsapp";
import {
  INTEGRATIONS_PAGE_PROPS,
  renderIntegrationsPage,
} from "./portal-integrations-page-fixture";

const nothing = (): void => {};
const PORTAL_ORIGIN = "https://portal.example";

const DROPBOX_ACCOUNT = {
  integrationAccountId: "intacc_dropbox",
  provider: "dropbox",
  environment: "development",
  providerAccountId: "dbid:nuki",
  accountKind: "account",
  displayName: "Nuki Cafe",
  lifecycle: { kind: "reauth_required", reasonCode: "oauth_scope_revoked" },
  isDefaultForProvider: true,
  capabilities: [],
  scopes: ["files.metadata.read", "files.content.read"],
  selectedResources: [],
  credentialHealth: { kind: "degraded" },
  webhookHealth: { kind: "missing" },
  eventRecency: { kind: "unavailable" },
};

const SQUARE_ACCOUNT = {
  integrationAccountId: "intacc_square",
  provider: "square",
  environment: "development",
  providerAccountId: "MLJRX6QNWVMY2",
  accountKind: "merchant",
  displayName: "Seams KK",
  lifecycle: { kind: "active" },
  isDefaultForProvider: true,
  capabilities: ["payment_terminal"],
  scopes: ["DEVICES_READ", "PAYMENTS_READ", "PAYMENTS_WRITE"],
  selectedResources: [],
  credentialHealth: { kind: "healthy" },
  webhookHealth: { kind: "missing" },
  eventRecency: { kind: "unavailable" },
};
const FAILED_WHATSAPP_ATTEMPT = {
  supportReference: "SATYR-ref-1",
  provider: "whatsapp",
  displayAccount: null,
  reasonCode: "provider_asset_missing",
  occurredAt: Date.now() - 60_000,
  retryStatus: "terminal",
  lastSuccessfulPhase: null,
  webhookHealth: { live: 0, degraded: 0, disabled: 0, revoked: 0 },
  projectionRevision: 3,
};

describe("file storage onboarding", () => {
  it("keeps the account overview when one provider detail fails", () => {
    const failedDetail = renderIntegrationsPage({
      initialIntegrationId: "gmail",
      accounts: [DROPBOX_ACCOUNT],
      detailContent: {
        kind: "failed",
        integrationId: "gmail",
        problem: "Gmail details are temporarily unavailable.",
      },
      retryDetail: nothing,
    });
    const overview = renderIntegrationsPage({ accounts: [DROPBOX_ACCOUNT] });

    expect(failedDetail).toContain(
      "Gmail details are temporarily unavailable.",
    );
    expect(failedDetail).toContain("Close gmail");
    expect(failedDetail).toContain("Nuki Cafe");
    expect(failedDetail).not.toContain("Connect a Gmail mailbox");
    expect(overview).toContain("Nuki Cafe");
    expect(overview).toContain("Reconnect");
  });

  it("shows every saved account once and keeps one provider tile", () => {
    const markup = renderIntegrationsPage({
      accounts: [
        DROPBOX_ACCOUNT,
        {
          integrationAccountId: "intacc_dropbox_archive",
          provider: "dropbox",
          environment: "development",
          providerAccountId: "dbid:archive",
          accountKind: "account",
          displayName: "Archive files",
          lifecycle: { kind: "active" },
          isDefaultForProvider: false,
          capabilities: [],
          scopes: ["files.metadata.read", "files.content.read"],
          selectedResources: [],
          credentialHealth: { kind: "healthy" },
          webhookHealth: { kind: "missing" },
          eventRecency: { kind: "unavailable" },
        },
      ],
    });

    expect(markup).toContain("Connected");
    expect(markup).toContain("Nuki Cafe");
    expect(markup).toContain("Archive files");
    expect(markup).toContain("integration=dropbox&amp;account=intacc_dropbox");
    expect(markup).toContain(
      "integration=dropbox&amp;account=intacc_dropbox_archive",
    );
    expect(markup.indexOf("Reconnect")).toBeLessThan(
      markup.indexOf("Archive files"),
    );
  });

  it("opens separate provider tiles with their own connection actions", () => {
    const dropbox = renderIntegrationsPage({ initialIntegrationId: "dropbox" });
    expect(dropbox).toContain("Close dropbox");
    expect(dropbox).toContain('id="integration-panel-dropbox"');
    expect(dropbox).toContain(">Continue with Dropbox</button>");
    expect(dropbox).not.toContain("Continue with Google Drive");
    const drive = renderIntegrationsPage({
      initialIntegrationId: "google_drive",
      accounts: [DROPBOX_ACCOUNT],
    });
    expect(drive).toContain('id="integration-panel-google_drive"');
    expect(drive).toContain(">Continue with Google Drive</button>");
    expect(drive).toContain("Reconnect Dropbox");
    expect(
      drive.slice(drive.indexOf('id="integration-panel-google_drive"')),
    ).not.toContain("Reconnect Dropbox");
  });

  it("narrates a sign-in in progress and blocks a second one", () => {
    const markup = renderIntegrationsPage({
      initialIntegrationId: "google_drive",
      pendingAuthorization: { kind: "connect", provider: "google_drive" },
    });
    expect(markup).toContain("Waiting for Google Drive…");
    expect(markup).toContain(
      "Finish signing in to Google Drive in the window that opened.",
    );
    expect(markup).toContain(">Cancel</button>");
    expect(markup).not.toContain("Continue with Dropbox");
  });

  it("derives one connection state from the route's pieces", () => {
    const opening = MutationLedger.empty().add({
      kind: "connect_provider",
      provider: "dropbox",
    });
    expect(opening.kind).toBe("added");
    if (opening.kind !== "added") return;
    expect(
      providerConnectionState(opening.ledger, null, null, "dropbox"),
    ).toEqual({ kind: "opening" });
    expect(
      providerConnectionState(
        MutationLedger.empty(),
        { kind: "connect", provider: "dropbox" },
        null,
        "dropbox",
      ),
    ).toEqual({ kind: "waiting" });
    expect(
      providerConnectionState(
        MutationLedger.empty(),
        { kind: "connect", provider: "dropbox" },
        null,
        "google_drive",
      ),
    ).toEqual({ kind: "idle" });
    expect(
      providerConnectionState(
        MutationLedger.empty(),
        null,
        {
          mutation: { kind: "connect_provider", provider: "dropbox" },
          message: "Nope.",
        },
        "dropbox",
      ),
    ).toEqual({ kind: "failed", message: "Nope." });
  });

  it("explains a failed sign-in beside the action", () => {
    const markup = renderIntegrationsPage({
      initialIntegrationId: "dropbox",
      feedback: {
        mutation: { kind: "connect_provider", provider: "dropbox" },
        message:
          "This integration is unavailable. Ask your Satyr administrator to configure it, then try again.",
      },
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      'aria-describedby="file-storage-setup-help file-storage-setup-error"',
    );
  });

  it("leads a broken storage connection with its reconnect and hides raw scopes", () => {
    const markup = renderIntegrationsPage({
      initialIntegrationId: "dropbox",
      accounts: [DROPBOX_ACCOUNT],
    });
    expect(markup).toContain("Reconnect Dropbox");
    expect(markup).toContain("Dropbox removed a permission Seams Pantry was given.");
    expect(markup).not.toContain("oauth_scope_revoked");
    expect(markup).not.toContain("files.metadata.read");
    expect(markup).toContain("Read the folders and files you share.");
    expect(markup).toContain("Connect another Dropbox account");
    // The rotation copy points every provider-authorized connection at Reconnect,
    // so the records providers get the same repair action.
    const airtable = renderIntegrationsPage({
      initialIntegrationId: "airtable",
      accounts: [
        {
          ...DROPBOX_ACCOUNT,
          integrationAccountId: "intacc_airtable",
          provider: "airtable",
          displayName: "Nuki base",
        },
      ],
    });
    expect(airtable).toContain("Reconnect Airtable");
  });

  it("reads the consent popup without the provider's help", () => {
    const location = (href: string) => ({ closed: false, location: { href } });
    expect(
      providerAuthorizationOutcome(
        { closed: true, location: { href: "about:blank" } },
        PORTAL_ORIGIN,
      ),
    ).toBe("closed");
    expect(
      providerAuthorizationOutcome(location("about:blank"), PORTAL_ORIGIN),
    ).toBe("waiting");
    expect(
      providerAuthorizationOutcome(
        {
          closed: false,
          get location(): never {
            throw new DOMException("cross-origin", "SecurityError");
          },
        },
        PORTAL_ORIGIN,
      ),
    ).toBe("waiting");
    expect(
      providerAuthorizationOutcome(
        location(
          `${PORTAL_ORIGIN}/v1/control/providers/dropbox/callback?code=x`,
        ),
        PORTAL_ORIGIN,
      ),
    ).toBe("waiting");
    expect(
      providerAuthorizationOutcome(
        location(`${PORTAL_ORIGIN}/portal/cafe/central/integrations`),
        PORTAL_ORIGIN,
      ),
    ).toBe("returned");
    expect(
      providerAuthorizationInterruptedMessage(
        { kind: "connect", provider: "dropbox" },
        "closed",
      ),
    ).toContain("The Dropbox window closed before sign-in finished.");
    expect(
      providerAuthorizationInterruptedMessage(
        { kind: "connect", provider: "whatsapp" },
        "returned",
      ),
    ).toContain("Meta sent you back without finishing the connection.");
  });
});

describe("Square onboarding", () => {
  it("offers the shared OAuth flow and existing-account lifecycle controls", () => {
    const disconnected = renderIntegrationsPage({
      initialIntegrationId: "square",
    });
    expect(disconnected).toContain('aria-label="Connect Square in a popup"');

    const connected = renderIntegrationsPage({
      initialIntegrationId: "square",
      accounts: [SQUARE_ACCOUNT],
    });
    expect(connected).toContain("Seams KK");
    expect(connected).toContain("Connect another Square account");
    expect(connected).toContain('aria-label="Reconnect Square in a popup"');
    expect(connected).toContain(">Refresh locations and devices</button>");
    expect(connected).toContain(">Disconnect</button>");

    const waiting = renderIntegrationsPage({
      initialIntegrationId: "square",
      accounts: [SQUARE_ACCOUNT],
      pendingAuthorization: {
        kind: "existing_account",
        integrationAccountId: SQUARE_ACCOUNT.integrationAccountId,
        provider: "square",
      },
    });
    expect(waiting).toContain("Waiting for Square…");
    expect(waiting).toContain(">Cancel</button>");
  });
});

describe("WhatsApp onboarding", () => {
  it("keeps discovery honest while deployment availability is unknown", () => {
    const markup = renderIntegrationsPage({
      whatsappConfigurationKnown: false,
      whatsapp: {
        applicationConfigured: false,
        accounts: [],
        replies: [],
      },
    });

    expect(markup).toContain("WhatsApp");
    expect(markup).toContain("Unable to check");
  });

  it("holds the action while Meta is open and lets the operator cancel", () => {
    const markup = renderIntegrationsPage({
      initialIntegrationId: "whatsapp",
      pendingAuthorization: { kind: "connect", provider: "whatsapp" },
    });
    expect(markup).toContain("Waiting for Meta…");
    expect(markup).toContain("Finish in the Meta window");
    expect(markup).toContain(">Cancel</button>");
    expect(markup).not.toContain(">Connect WhatsApp</button>");
  });

  it("records the last failed attempt with its reference and next step", () => {
    const markup = renderIntegrationsPage({
      initialIntegrationId: "whatsapp",
      supportDiagnostics: FAILED_WHATSAPP_ATTEMPT,
    });
    expect(markup).toContain("SATYR-ref-1");
    expect(markup).toContain(
      "without sharing a Business Portfolio and WhatsApp Business Account",
    );
    expect(markup).toContain("pending approval on the Seams side");
    expect(markup).not.toContain("provider_asset_missing");
    expect(
      whatsappAttemptFailureCopy("provider_account_ineligible").summary,
    ).toContain("no phone number");
    expect(
      whatsappAttemptFailureCopy("authorization_cancelled").summary,
    ).toContain("closed or declined");
    expect(
      providerAttemptFailureCopy("Dropbox", "authorization_expired").summary,
    ).toContain("expired");
  });
});

const ROUTE_DATA = {
  commerceSystem: null,
  commerceSyncProblem: null,
  codexConnection: { kind: "disconnected", revision: 0 },
  inferenceSelection: { kind: "satyr_platform" },
  accounts: [],
  supportReference: null,
  whatsappApplicationConfigured: true,
  setupDefaults: INTEGRATIONS_PAGE_PROPS.setupDefaults,
  readiness: null,
  activation: { kind: "idle", organisation_id: "organisation_onboarding" },
  firstTask: null,
  organisationIsActive: true,
  configurationVersion: 1,
};

function routeProps(read: () => Promise<unknown>) {
  return {
    organisationId: "organisation_onboarding",
    organisationHandle: "cafe",
    workspaceHandle: "central",
    refreshKey: "1",
    canManage: true,
    canConnectCodex: true,
    transport: {
      readOverview: read,
      readDetail: async () => {
        throw new Error("detail read is not used by this test");
      },
      execute: async () => ({ kind: "completed" }),
      readEmailReply: async () => ({ kind: "expired" }),
      whatsapp: {},
    },
  };
}

function stubWindow(extra: Record<string, unknown>): void {
  vi.stubGlobal("window", {
    setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
    setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { origin: PORTAL_ORIGIN, assign: vi.fn() },
    ...extra,
  });
}

describe("consent window watch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a closed window after the handshake grace and reloads the route", async () => {
    vi.useFakeTimers();
    stubWindow({});
    const popup = {
      closed: false,
      location: { href: "about:blank" },
      close: vi.fn(),
    };
    const setAuthorization = vi.fn();
    const setFeedback = vi.fn();
    const read = vi.fn(async () => ROUTE_DATA);
    const cleanup = beginProviderAuthorizationWatch(
      { pending: { kind: "connect", provider: "dropbox" }, popup },
      setAuthorization,
      setFeedback,
      routeProps(read),
      { current: 0 },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_200);
    expect(setFeedback).not.toHaveBeenCalled();
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(500);
    // Seen closed, but the completion message may still be in flight.
    expect(setFeedback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(750);
    expect(setAuthorization).toHaveBeenCalledWith(null);
    expect(setFeedback).toHaveBeenCalledWith({
      mutation: { kind: "connect_provider", provider: "dropbox" },
      message: expect.stringContaining(
        "The Dropbox window closed before sign-in finished.",
      ),
    });
    expect(read).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("closes a window that came back through a portal path and names the service", async () => {
    vi.useFakeTimers();
    stubWindow({});
    const popup = {
      closed: false,
      location: { href: `${PORTAL_ORIGIN}/portal/cafe/central/integrations` },
      close: vi.fn(),
    };
    const setAuthorization = vi.fn();
    const setFeedback = vi.fn();
    const cleanup = beginProviderAuthorizationWatch(
      {
        pending: {
          kind: "existing_account",
          integrationAccountId: "intacc_wa",
          provider: "whatsapp",
        },
        popup,
      },
      setAuthorization,
      setFeedback,
      routeProps(async () => ROUTE_DATA),
      { current: 0 },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(1_300);
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(setFeedback).toHaveBeenCalledWith({
      mutation: {
        kind: "integration_account",
        integrationAccountId: "intacc_wa",
      },
      message: expect.stringContaining(
        "Meta sent you back without finishing the connection.",
      ),
    });
    cleanup();
  });

  it("keeps waiting while the provider's own page is open and stops with the cleanup", async () => {
    vi.useFakeTimers();
    stubWindow({});
    const popup = {
      closed: false,
      get location(): never {
        throw new DOMException("cross-origin", "SecurityError");
      },
      close: vi.fn(),
    };
    const setFeedback = vi.fn();
    const cleanup = beginProviderAuthorizationWatch(
      { pending: { kind: "connect", provider: "gmail" }, popup },
      () => {},
      setFeedback,
      routeProps(async () => ROUTE_DATA),
      { current: 0 },
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setFeedback).not.toHaveBeenCalled();
    cleanup();
    Object.defineProperty(popup, "closed", { value: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setFeedback).not.toHaveBeenCalled();
  });
});

describe("completion handshake", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function deliver(message: Record<string, unknown>): Promise<void> {
    const channel = new BroadcastChannel("satyr-provider-attempt");
    channel.postMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 30));
    channel.close();
  }

  it("ends the wait and sends a new file connection on to choosing files", async () => {
    const assign = vi.fn();
    stubWindow({ location: { origin: PORTAL_ORIGIN, assign } });
    const authorization = {
      current: { pending: { kind: "connect", provider: "dropbox" }, popup: {} },
    };
    const setAuthorization = vi.fn();
    const read = vi.fn(async () => ROUTE_DATA);
    const cleanup = beginProviderCompletionListener(
      routeProps(read),
      { current: 0 },
      () => {},
      () => {},
      authorization,
      setAuthorization,
      new Set(),
    );
    await deliver({
      type: "satyr.provider-attempt.completed",
      attempt_id: "attempt_1",
      terminal_state: "connected",
      failure_reason_code: null,
      provider: "dropbox",
    });
    expect(setAuthorization).toHaveBeenCalledWith(null);
    expect(assign).toHaveBeenCalledWith(
      "/portal/cafe/central/access?setup=files&provider=dropbox",
    );
    expect(read).not.toHaveBeenCalled();
    cleanup();
  });

  it("keeps a reconnect on the page and leaves another provider's wait alone", async () => {
    const assign = vi.fn();
    stubWindow({ location: { origin: PORTAL_ORIGIN, assign } });
    const authorization = {
      current: {
        pending: {
          kind: "existing_account",
          integrationAccountId: "intacc_dropbox",
          provider: "dropbox",
        },
        popup: {},
      },
    };
    const setAuthorization = vi.fn();
    const read = vi.fn(async () => ROUTE_DATA);
    const cleanup = beginProviderCompletionListener(
      routeProps(read),
      { current: 0 },
      () => {},
      () => {},
      authorization,
      setAuthorization,
      new Set(),
    );
    await deliver({
      type: "satyr.provider-attempt.completed",
      attempt_id: "attempt_2",
      terminal_state: "connected",
      failure_reason_code: null,
      provider: "dropbox",
    });
    expect(setAuthorization).toHaveBeenCalledWith(null);
    expect(assign).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);

    setAuthorization.mockClear();
    const gmailAuthorization = {
      current: { pending: { kind: "connect", provider: "gmail" }, popup: {} },
    };
    cleanup();
    const gmailCleanup = beginProviderCompletionListener(
      routeProps(read),
      { current: 0 },
      () => {},
      () => {},
      gmailAuthorization,
      setAuthorization,
      new Set(),
    );
    await deliver({
      type: "satyr.provider-attempt.completed",
      attempt_id: "attempt_3",
      terminal_state: "connected",
      failure_reason_code: null,
      provider: "whatsapp",
    });
    expect(setAuthorization).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(2);
    gmailCleanup();
  });
});
