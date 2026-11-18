/**
 * Dev-only stand-in for the Claude connection route on the Integrations
 * preview. `?claude=disconnected | authorizing | connected` sets the first
 * read. Connect starts a sign-in whose window opens the real Claude page;
 * any pasted `code#state` value then connects. Paste `expired#…` or
 * `refused#…` to see the sign-in end. Nothing is saved.
 */
import { isRecord } from "@seams/std";

type PreviewConnection =
  | Readonly<{ kind: "disconnected" }>
  | Readonly<{ kind: "connected"; connectionId: string }>;

type PreviewAttempt = Readonly<{
  attemptId: string;
  authorizationUrl: string;
  expiresAt: number;
}>;

type PreviewAuthorization =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "authorizing"; authorization: PreviewAttempt }>;

const ROUTE = "/v1/control/organisations/organisation_preview/inference/claude";
const CONNECTED: PreviewConnection = {
  kind: "connected",
  connectionId: "claude_connection_preview",
};

export function installClaudeConnectionPreview(): void {
  const scenario = new URLSearchParams(window.location.search).get("claude");
  // The control client sends this token with every change. The path keeps
  // it away from a real local session on the same origin.
  document.cookie = `satyr_control_csrf=preview; path=${window.location.pathname}; SameSite=Strict`;
  const state: {
    connection: PreviewConnection;
    authorization: PreviewAuthorization;
  } = {
    connection: scenario === "connected" ? CONNECTED : { kind: "disconnected" },
    authorization:
      scenario === "authorizing"
        ? { kind: "authorizing", authorization: previewAttempt() }
        : { kind: "idle" },
  };
  window.fetch = previewFetch.bind(null, window.fetch.bind(window), state);
}

function previewAttempt(): PreviewAttempt {
  return {
    attemptId: "claude_attempt_preview",
    authorizationUrl:
      "https://claude.ai/oauth/authorize?code=true&client_id=preview",
    expiresAt: Date.now() + 10 * 60_000,
  };
}

async function previewFetch(
  fetchOriginal: typeof fetch,
  state: { connection: PreviewConnection; authorization: PreviewAuthorization },
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin,
  );
  if (url.pathname !== ROUTE) return fetchOriginal(input, init);
  // A short wait, so the busy states show.
  await new Promise((resolve) => window.setTimeout(resolve, 400));
  const method = init?.method ?? "GET";
  if (method === "GET") return Response.json({ ok: true, ...state });
  if (method === "DELETE") {
    state.connection = { kind: "disconnected" };
    state.authorization = { kind: "idle" };
    return Response.json({ ok: true, connection: state.connection });
  }
  const body: unknown = JSON.parse(String(init?.body ?? "null"));
  const kind = isRecord(body) ? body.kind : null;
  const code = isRecord(body) ? body.code : null;
  if (kind === "start") {
    const authorization = previewAttempt();
    state.authorization = { kind: "authorizing", authorization };
    return Response.json({ ok: true, authorization });
  }
  const ended =
    typeof code === "string" && code.startsWith("expired#")
      ? "claude_authorization_expired"
      : typeof code === "string" && code.startsWith("refused#")
        ? "claude_oauth_provider_unavailable"
        : null;
  if (kind === "complete" && ended !== null) {
    state.authorization = { kind: "idle" };
    return Response.json({ ok: false, error: ended }, { status: 409 });
  }
  if (
    kind === "complete" &&
    typeof code === "string" &&
    /^[^#\s]+#[^#\s]+$/.test(code)
  ) {
    state.connection = CONNECTED;
    state.authorization = { kind: "idle" };
    return Response.json({ ok: true, connection: state.connection });
  }
  return Response.json(
    { ok: false, error: "claude_oauth_code_invalid" },
    { status: 422 },
  );
}
