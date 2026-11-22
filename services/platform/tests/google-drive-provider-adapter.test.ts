import { describe, expect, it } from "vitest";

import {
  createGoogleDriveAuthorizationUrl,
  downloadGoogleDriveFile,
  exchangeGoogleDriveAuthorizationCode,
  listGoogleDriveChanges,
  readGoogleDriveFileMetadata,
} from "@purin-labs/agent/provider-adapters/google-drive";

const REVISION = {
  kind: "gdrive" as const,
  version: "7",
  modifiedTime: "2026-08-29T00:00:00.000Z",
  headRevisionId: "head-7",
};

describe("Google Drive provider protocol", () => {
  it("constructs an offline PKCE request with only drive.file", () => {
    const url = new URL(
      createGoogleDriveAuthorizationUrl({
        clientId: "drive-client",
        redirectUri:
          "https://portal.example/v1/control/providers/google_drive/callback",
        state: "state-1",
        pkceChallenge: "challenge-1",
      }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/drive.file",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("accepts content only inside a stable metadata window", async () => {
    const fetcher = new SequenceFetcher([
      Response.json(fileMetadata()),
      new Response("recipe", { headers: { "content-type": "text/markdown" } }),
      Response.json(fileMetadata()),
    ]);

    const result = await downloadGoogleDriveFile({
      accessToken: "token",
      providerFileId: "drive-file-1",
      expectedRevision: REVISION,
      maximumBytes: 32,
      fetcher: fetcher.fetch.bind(fetcher),
    });
    expect(result.ok && new TextDecoder().decode(result.value.bytes)).toBe(
      "recipe",
    );
    expect(fetcher.requests.map(requestPath)).toEqual([
      "/drive/v3/files/drive-file-1",
      "/drive/v3/files/drive-file-1",
      "/drive/v3/files/drive-file-1",
    ]);
    expect(fetcher.requests[1]?.url).toContain("alt=media");
  });

  it("rejects OAuth responses that broaden the requested scopes", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 3_600,
        scope: [
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/drive.readonly",
        ].join(" "),
      }),
    ]);

    await expect(
      exchangeGoogleDriveAuthorizationCode({
        configuration: { clientId: "client", clientSecret: "secret" },
        code: "code",
        redirectUri: "https://portal.example/callback",
        pkceVerifier: "verifier",
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "gdrive_response_invalid", retryable: false },
    });
  });

  it("rejects content when metadata changes after transfer", async () => {
    const fetcher = new SequenceFetcher([
      Response.json(fileMetadata()),
      new Response("recipe"),
      Response.json(fileMetadata({ version: "8" })),
    ]);

    await expect(
      downloadGoogleDriveFile({
        accessToken: "token",
        providerFileId: "drive-file-1",
        expectedRevision: REVISION,
        maximumBytes: 32,
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "gdrive_revision_changed", retryable: true },
    });
  });

  it("rejects trashed files before transferring content", async () => {
    const fetcher = new SequenceFetcher([
      Response.json(fileMetadata({ trashed: true })),
    ]);

    await expect(
      downloadGoogleDriveFile({
        accessToken: "token",
        providerFileId: "drive-file-1",
        expectedRevision: REVISION,
        maximumBytes: 32,
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "gdrive_file_unavailable", retryable: false },
    });
    expect(fetcher.requests).toHaveLength(1);
  });

  it("rejects content when the file is trashed during transfer", async () => {
    const fetcher = new SequenceFetcher([
      Response.json(fileMetadata()),
      new Response("recipe"),
      Response.json(fileMetadata({ trashed: true })),
    ]);

    await expect(
      downloadGoogleDriveFile({
        accessToken: "token",
        providerFileId: "drive-file-1",
        expectedRevision: REVISION,
        maximumBytes: 32,
        fetcher: fetcher.fetch.bind(fetcher),
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: "gdrive_file_unavailable", retryable: false },
    });
  });

  it("parses removed and current changes with a durable page token", async () => {
    const fetcher = new SequenceFetcher([
      Response.json({
        changes: [
          { fileId: "removed-file", removed: true },
          { fileId: "drive-file-1", removed: false, file: fileMetadata() },
        ],
        newStartPageToken: "page-8",
      }),
    ]);

    const result = await listGoogleDriveChanges({
      accessToken: "token",
      pageToken: "page-7",
      fetcher: fetcher.fetch.bind(fetcher),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        changes: [
          { kind: "removed", providerFileId: "removed-file" },
          {
            kind: "file",
            file: { providerFileId: "drive-file-1", revision: REVISION },
          },
        ],
        nextPageToken: null,
        newStartPageToken: "page-8",
      },
    });
  });

  it("derives deep links from the canonical file identity", async () => {
    const fetcher = new SequenceFetcher([
      Response.json(
        fileMetadata({ webViewLink: "https://attacker.example/recipe" }),
      ),
    ]);

    const result = await readGoogleDriveFileMetadata({
      accessToken: "token",
      providerFileId: "drive-file-1",
      fetcher: fetcher.fetch.bind(fetcher),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        providerFileId: "drive-file-1",
        webViewLink: "https://drive.google.com/open?id=drive-file-1",
      },
    });
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

function fileMetadata(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: "drive-file-1",
    name: "recipe.md",
    mimeType: "text/markdown",
    size: "6",
    version: REVISION.version,
    modifiedTime: REVISION.modifiedTime,
    headRevisionId: REVISION.headRevisionId,
    trashed: false,
    webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
    parents: ["folder-1"],
    ...overrides,
  };
}

function requestPath(request: Request): string {
  return new URL(request.url).pathname;
}
