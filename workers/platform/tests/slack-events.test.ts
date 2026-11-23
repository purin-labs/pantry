import { describe, expect, it } from "vitest";

import {
  parseSlackEnvelope,
  type SlackEnvelope,
} from "@purin-labs/surface-slack/server/events";
import type { Variant } from "@purin-labs/type-utils";

describe("Slack event boundary", function slackEventBoundarySuite() {
  it("parses app uninstall and bot-token revocation as installation events", function parsesInstallationRevocation() {
    const common = {
      type: "event_callback",
      event_id: "Ev0BGREVOKE",
      team_id: "T0BGQSSG45N",
      api_app_id: "A0BGAPP",
      event_time: 1_789_300_000,
    };
    expect(
      parseSlackEnvelope(
        JSON.stringify({ ...common, event: { type: "app_uninstalled" } }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        kind: "installation_revoked",
        event: { reason: "app_uninstalled", occurredAt: 1_789_300_000_000 },
      },
    });
    expect(
      parseSlackEnvelope(
        JSON.stringify({
          ...common,
          event_id: "Ev0BGTOKEN",
          event: {
            type: "tokens_revoked",
            tokens: { bot: ["U0BGBOT"], oauth: [] },
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      value: {
        kind: "installation_revoked",
        event: { reason: "bot_token_revoked" },
      },
    });
  });

  it("ignores direct app-authored messages before requiring user fields", function ignoresDirectBotMessage() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "message",
          channel: "C0BG0P4JF25",
          bot_id: "B0BOT",
          app_id: "A0APP",
          text: "M66 EDGE PONG",
          ts: "1780000000.000001",
          event_ts: "1780000000.000001",
        }),
      ),
    );

    expect(parsed).toEqual({
      ok: true,
      value: { kind: "ignored", reason: "bot_message" },
    });
  });

  it("ignores app-authored message changes without inner event identity", function ignoresChangedBotMessage() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "message",
          subtype: "message_changed",
          channel: "C0BG0P4JF25",
          event_ts: "1780000000.000002",
          message: {
            type: "message",
            bot_id: "B0BOT",
            app_id: "A0APP",
            text: "M66 EDGE PONG",
            ts: "1780000000.000001",
          },
        }),
      ),
    );

    expect(parsed).toEqual({
      ok: true,
      value: { kind: "ignored", reason: "bot_message" },
    });
  });

  it("rejects malformed Slack user identity at ingress", function rejectsMalformedUser() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "app_mention",
          channel: "C0BG0P4JF25",
          user: "not a slack user",
          text: "run a command",
          ts: "1780000000.000003",
          event_ts: "1780000000.000003",
        }),
      ),
    );

    expect(parsed).toEqual({
      ok: false,
      error: { code: "invalid_field", field: "user" },
    });
  });

  it("binds Slack Connect messages to the host install workspace", function bindsSharedChannelToHost() {
    const parsed = parseSlackEnvelope(
      JSON.stringify({
        type: "event_callback",
        api_app_id: "A0BGAPP",
        event_id: "Ev0BGCONNECT",
        team_id: "T0BGHOST",
        event: {
          type: "app_mention",
          channel: "C0BGSHARED",
          user: "U0BGEXTERNAL",
          user_team: "T0BGEXTERNAL",
          text: "<@U0BGPANTRY> inspect this shared channel",
          ts: "1780000000.000004",
          event_ts: "1780000000.000004",
        },
      }),
    );

    expect(parsed.ok).toBe(true);

    if (!parsed.ok || parsed.value.kind !== "message") {
      throw new Error("expected a parsed Slack Connect message");
    }

    expect(parsed.value.event.workspaceId).toBe("T0BGHOST");
    expect(parsed.value.event.threadKey).toBe(
      "slack:T0BGHOST:C0BGSHARED:1780000000.000004",
    );
    expect(parsed.value.event.threadKey).not.toContain("T0BGEXTERNAL");
  });

  it("keeps only inert Slack file metadata at the webhook boundary", function stripsPrivateFileUrls() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "app_mention",
          channel: "C0BG0P4JF25",
          user: "U0BGUSER",
          text: "<@U0BGPANTRY> inspect this image",
          ts: "1780000000.000005",
          event_ts: "1780000000.000005",
          files: [
            {
              id: "F0BGIMAGE",
              name: "diagram.png",
              mimetype: "image/png",
              size: 67,
              timestamp: 1_780_000_000,
              url_private: "https://files.slack.com/files-pri/private",
              url_private_download:
                "https://files.slack.com/files-pri/private/download",
            },
          ],
        }),
      ),
    );

    expect(parsed.ok).toBe(true);

    if (!parsed.ok || parsed.value.kind !== "message") {
      throw new Error("expected a parsed Slack message");
    }

    expect(parsed.value.event.files).toEqual([
      {
        kind: "hosted",
        file: {
          fileId: "F0BGIMAGE",
          displayName: "diagram.png",
          declaredMediaType: "image/png",
          declaredByteLength: 67,
          revision: "1780000000",
        },
      },
    ]);
    expect(JSON.stringify(parsed.value.event.files)).not.toContain(
      "url_private",
    );
  });

  it("accepts a file-only file_share message with no authored text", function acceptsFileOnly() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "message",
          subtype: "file_share",
          channel: "C0BG0P4JF25",
          user: "U0BGUSER",
          text: "",
          ts: "1780000000.000006",
          event_ts: "1780000000.000006",
          files: [
            {
              id: "F0BGQUOTE",
              name: "quote.pdf",
              mimetype: "application/pdf",
              size: 4096,
              timestamp: 1_780_000_001,
            },
          ],
        }),
      ),
    );

    const event = expectMessage(parsed);

    expect(event.authored).toEqual([]);
    expect(event.files).toEqual([
      {
        kind: "hosted",
        file: {
          fileId: "F0BGQUOTE",
          displayName: "quote.pdf",
          declaredMediaType: "application/pdf",
          declaredByteLength: 4096,
          revision: "1780000001",
        },
      },
    ]);
  });

  it("refuses a delivery carrying neither authored content nor files", function refusesEmpty() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "message",
          channel: "C0BG0P4JF25",
          user: "U0BGUSER",
          text: "   ",
          ts: "1780000000.000007",
          event_ts: "1780000000.000007",
        }),
      ),
    );

    expect(parsed).toEqual({
      ok: true,
      value: { kind: "ignored", reason: "empty_message" },
    });
  });

  it("prefers rich_text over the duplicated top-level text fallback", function prefersRichText() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "app_mention",
          channel: "C0BG0P4JF25",
          user: "U0BGUSER",
          // Slack sends the same content twice; concatenating them would duplicate it.
          text: "see <https://example.com/spec|the spec> now",
          ts: "1780000000.000008",
          event_ts: "1780000000.000008",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "text", text: "see " },
                    {
                      type: "link",
                      url: "https://example.com/spec",
                      text: "the spec",
                    },
                    { type: "text", text: " now" },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    const event = expectMessage(parsed);

    expect(event.authored).toEqual([
      { kind: "text", text: "see" },
      { kind: "link", url: "https://example.com/spec", label: "the spec" },
      { kind: "text", text: "now" },
    ]);
  });

  it("falls back to mrkdwn text when a block element is unsupported", function fallsBackToText() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "app_mention",
          channel: "C0BG0P4JF25",
          user: "U0BGUSER",
          text: "price <https://example.com/a> and <@U0BGOTHER> &amp; friends",
          ts: "1780000000.000009",
          event_ts: "1780000000.000009",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "future_element_pantry_cannot_render", text: "?" },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    const event = expectMessage(parsed);

    expect(event.authored).toEqual([
      { kind: "text", text: "price" },
      { kind: "link", url: "https://example.com/a", label: null },
      // A user mention is not a link, and the entity is unescaped for the model.
      { kind: "text", text: "and <@U0BGOTHER> & friends" },
    ]);
  });

  it("refuses a message whose only representation cannot be rendered", function refusesUnsupported() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "app_mention",
          channel: "C0BG0P4JF25",
          user: "U0BGUSER",
          ts: "1780000000.000010",
          event_ts: "1780000000.000010",
          blocks: [
            {
              type: "rich_text",
              elements: [
                {
                  type: "rich_text_section",
                  elements: [
                    { type: "future_element_pantry_cannot_render", text: "?" },
                  ],
                },
              ],
            },
          ],
        }),
      ),
    );

    expect(parsed).toEqual({
      ok: true,
      value: { kind: "ignored", reason: "unsupported_message_content" },
    });
  });

  it("keeps a Slack Connect placeholder instead of failing the delivery", function keepsPlaceholder() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "message",
          subtype: "file_share",
          channel: "C0BGSHARED",
          user: "U0BGEXTERNAL",
          text: "have a look",
          ts: "1780000000.000011",
          event_ts: "1780000000.000011",
          files: [{ id: "F0BGHIDDEN", file_access: "check_file_info" }],
        }),
      ),
    );

    const event = expectMessage(parsed);

    expect(event.files).toEqual([{ kind: "needs_info", fileId: "F0BGHIDDEN" }]);
  });

  it("treats an externally hosted file as a link, not admitted bytes", function externalIsLink() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "message",
          subtype: "file_share",
          channel: "C0BG0P4JF25",
          user: "U0BGUSER",
          text: "the drawing",
          ts: "1780000000.000012",
          event_ts: "1780000000.000012",
          files: [
            {
              id: "F0BGREMOTE",
              mode: "external",
              name: "assembly.dwg",
              url_private: "https://drive.example.com/assembly.dwg",
            },
          ],
        }),
      ),
    );

    const event = expectMessage(parsed);

    expect(event.files).toEqual([
      {
        kind: "remote_link",
        fileId: "F0BGREMOTE",
        url: "https://drive.example.com/assembly.dwg",
        label: "assembly.dwg",
      },
    ]);
  });

  it("still routes message_changed as an edit rather than a new turn", function keepsEditTrigger() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "message",
          subtype: "message_changed",
          channel: "C0BG0P4JF25",
          event_ts: "1780000000.000013",
          message: {
            type: "message",
            user: "U0BGUSER",
            text: "revised text",
            ts: "1780000000.000001",
          },
        }),
      ),
    );

    const event = expectMessage(parsed);

    expect(event.trigger).toBe("edit");
    expect(event.authored).toEqual([{ kind: "text", text: "revised text" }]);
  });

  it("ignores subtypes other than file_share", function ignoresOtherSubtypes() {
    const parsed = parseSlackEnvelope(
      JSON.stringify(
        eventEnvelope({
          type: "message",
          subtype: "channel_join",
          channel: "C0BG0P4JF25",
          user: "U0BGUSER",
          text: "has joined the channel",
          ts: "1780000000.000014",
          event_ts: "1780000000.000014",
        }),
      ),
    );

    expect(parsed).toEqual({
      ok: true,
      value: { kind: "ignored", reason: "message_subtype" },
    });
  });
  it("derives one identity across inline, placeholder, and file_share deliveries", function stableIdentity() {
    const base = {
      channel: "C0BG0P4JF25",
      user: "U0BGUSER",
      ts: "1780000000.000020",
      event_ts: "1780000000.000020",
    };

    const inline = expectMessage(
      parseSlackEnvelope(
        JSON.stringify(
          eventEnvelope({
            ...base,
            type: "app_mention",
            text: "<@U0BGPANTRY> look",
            files: [
              {
                id: "F0BGA",
                name: "a.pdf",
                mimetype: "application/pdf",
                size: 10,
              },
            ],
          }),
        ),
      ),
    );

    const placeholder = expectMessage(
      parseSlackEnvelope(
        JSON.stringify(
          eventEnvelope({
            ...base,
            type: "app_mention",
            text: "<@U0BGPANTRY> look",
            files: [{ id: "F0BGA", file_access: "check_file_info" }],
          }),
        ),
      ),
    );

    const fileShare = expectMessage(
      parseSlackEnvelope(
        JSON.stringify(
          eventEnvelope({
            ...base,
            type: "message",
            subtype: "file_share",
            files: [
              {
                id: "F0BGA",
                name: "a.pdf",
                mimetype: "application/pdf",
                size: 10,
              },
            ],
          }),
        ),
      ),
    );

    // Delivery shape changes what is known about the file, never who the
    // message belongs to.
    for (const event of [placeholder, fileShare]) {
      expect(event.sessionId).toBe(inline.sessionId);
      expect(event.threadKey).toBe(inline.threadKey);
      expect(event.messageTs).toBe(inline.messageTs);
      expect(event.threadTs).toBe(inline.threadTs);
      expect(event.eventId).toBe(inline.eventId);
    }

    // A file-only root still opens the same thread a text root would.
    expect(fileShare.authored).toEqual([]);
    expect(fileShare.files).toEqual(inline.files);
  });
});

function expectMessage(
  parsed: ReturnType<typeof parseSlackEnvelope>,
): Variant<SlackEnvelope, "message">["event"] {
  if (!parsed.ok || parsed.value.kind !== "message") {
    throw new Error(
      `expected a parsed Slack message, got ${JSON.stringify(parsed)}`,
    );
  }

  return parsed.value.event;
}

function eventEnvelope(
  event: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "event_callback",
    api_app_id: "A0BGAPP",
    event_id: "Ev0BGTEST",
    team_id: "T0BGQSSG45N",
    event,
  };
}
