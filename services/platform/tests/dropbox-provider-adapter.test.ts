import { describe, expect, it } from "vitest";

import {
  createDropboxAuthorizationUrl,
  downloadDropboxFile,
  exchangeDropboxAuthorizationCode,
  exportDropboxFile,
  listDropboxFolder,
  refreshDropboxAccessToken,
  verifyDropboxWebhookSignature,
} from "@purin-labs/agent/provider-adapters/dropbox";

describe("Dropbox provider protocol", () => {
  it("constructs an offline PKCE authorization request with exact scopes", () => {
    const url = new URL(
      createDropboxAuthorizationUrl({
        clientId: "dropbox-client",
        redirectUri:
          "https://portal.example/v1/control/providers/dropbox/callback",
        state: "state-1",
        pkceChallenge: "challenge-1",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://www.dropbox.com/oauth2/authorize",
    );
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toBe(
      "account_info.read files.metadata.read files.content.read",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("maps a reset response to a typed cursor reset", async () => {
    const fetcher = new SequenceFetcher([
      Response.json(
        { error_summary: "reset/", error: { ".tag": "reset" } },
        { status: 409 },
      ),
    ]);

    await expect(
      listDropboxFolder({
        accessToken: "token",
        path: "/Recipes",
        cursor: "cursor-old",
        recursive: true,
        limit: 100,
        pathRootNamespaceId: "ns-home",
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "dropbox_cursor_reset", retryable: false },
    });
  });

  it("rejects OAuth responses that broaden the requested scopes", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 14_400,
        account_id: "dbid:account",
        scope:
          "account_info.read files.metadata.read files.content.read sharing.read",
      }),
    ]);

    await expect(
      exchangeDropboxAuthorizationCode({
        configuration: { clientId: "client", clientSecret: "secret" },
        code: "code",
        redirectUri: "https://portal.example/callback",
        pkceVerifier: "verifier",
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "dropbox_response_invalid", retryable: false },
    });
  });

  it("accepts refresh responses that omit unchanged scopes", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({
        access_token: "refreshed-access-token",
        expires_in: 14_400,
        token_type: "bearer",
      }),
    ]);

    await expect(
      refreshDropboxAccessToken({
        configuration: { clientId: "client", clientSecret: "secret" },
        refreshToken: "refresh-token",
        accountId: "dbid:account",
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        accessToken: "refreshed-access-token",
        refreshToken: "refresh-token",
        expiresInSeconds: 14_400,
        accountId: "dbid:account",
        scopes: [
          "account_info.read",
          "files.metadata.read",
          "files.content.read",
        ],
      },
    });
  });

  it("rejects refresh responses that explicitly broaden scopes", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({
        access_token: "refreshed-access-token",
        expires_in: 14_400,
        scope:
          "account_info.read files.metadata.read files.content.read sharing.read",
      }),
    ]);

    await expect(
      refreshDropboxAccessToken({
        configuration: { clientId: "client", clientSecret: "secret" },
        refreshToken: "refresh-token",
        accountId: "dbid:account",
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "dropbox_response_invalid", retryable: false },
    });
  });

  it("pins downloads to the observed revision and enforces the byte cap", async () => {
    const metadata = {
      id: "id:recipe",
      name: "recipe.md",
      path_display: "/Recipes/recipe.md",
      rev: "015",
      server_modified: "2026-08-29T00:00:00Z",
      size: 6,
      is_downloadable: true,
      content_hash: "hash",
    };
    const fetcher = new SequenceFetcher([
      new Response("recipe", {
        headers: {
          "content-type": "text/markdown",
          "dropbox-api-result": JSON.stringify(metadata),
        },
      }),
      new Response("recipe", {
        headers: {
          "content-type": "text/markdown",
          "dropbox-api-result": JSON.stringify(metadata),
        },
      }),
    ]);

    const downloaded = await downloadDropboxFile({
      accessToken: "token",
      providerFileId: "id:recipe",
      expectedRevision: "015",
      pathRootNamespaceId: "ns-home",
      maximumBytes: 10,
      fetcher: fetcher.fetch.bind(fetcher),
    });
    expect(
      downloaded.ok && new TextDecoder().decode(downloaded.value.bytes),
    ).toBe("recipe");
    expect(
      JSON.parse(fetcher.requests[0]?.headers.get("dropbox-api-arg") ?? "null"),
    ).toEqual({
      path: "rev:015",
    });

    await expect(
      downloadDropboxFile({
        accessToken: "token",
        providerFileId: "id:recipe",
        expectedRevision: "015",
        pathRootNamespaceId: "ns-home",
        maximumBytes: 3,
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "dropbox_content_too_large",
        maximumBytes: 3,
        retryable: false,
      },
    });
  });

  it("reads original file metadata from an export response", async () => {
    const fileMetadata = {
      id: "id:paper",
      name: "paper.paper",
      path_display: "/Recipes/paper.paper",
      rev: "016",
      server_modified: "2026-08-29T00:00:00Z",
      size: 6,
      is_downloadable: false,
    };
    const fetcher = new SequenceFetcher([
      new Response("recipe", {
        headers: {
          "content-type": "text/plain",
          "dropbox-api-result": JSON.stringify({
            export_metadata: { name: "paper.txt", size: 6 },
            file_metadata: fileMetadata,
          }),
        },
      }),
    ]);

    const exported = await exportDropboxFile({
      accessToken: "token",
      providerFileId: "id:paper",
      exportFormat: "txt",
      pathRootNamespaceId: "ns-home",
      maximumBytes: 10,
      fetcher: fetcher.fetch.bind(fetcher),
    });

    expect(exported.ok && exported.value.metadata.revision.rev).toBe("016");
    expect(exported.ok && new TextDecoder().decode(exported.value.bytes)).toBe(
      "recipe",
    );
  });

  it("verifies the exact webhook body HMAC", async () => {
    const rawBody = '{"list_folder":{"accounts":["dbid:1"]}}';
    const signatureHex = await hmacHex("app-secret", rawBody);
    await expect(
      verifyDropboxWebhookSignature({
        appSecret: "app-secret",
        rawBody,
        signatureHex,
      }),
    ).resolves.toBe(true);
    await expect(
      verifyDropboxWebhookSignature({
        appSecret: "app-secret",
        rawBody: `${rawBody} `,
        signatureHex,
      }),
    ).resolves.toBe(false);
  });
});

class SequenceFetcher {
  readonly requests: Request[] = [];

  constructor(private readonly responses: Response[]) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    this.requests.push(new Request(input, init));
    const response = this.responses.shift();
    if (response === undefined) throw new Error("missing fixture response");
    return response;
  }
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
  let encoded = "";
  for (const byte of signature) encoded += byte.toString(16).padStart(2, "0");
  return encoded;
}
