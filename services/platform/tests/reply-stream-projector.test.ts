import { describe, expect, it } from "vitest";
import { projectReplyStreamText } from "../src/chat/reply-stream-projector";

describe("portal reply stream projector", function replyProjectorSuite() {
  it("releases only the decoded reply text", function projectsReply() {
    expect(projectReplyStreamText('{"kind":"reply","text":"Hel')).toEqual({
      ok: true,
      value: { kind: "reply", text: "Hel" },
    });
    expect(
      projectReplyStreamText(
        '{"kind":"reply","text":"Hello\\nTokyo \\u65e5","extra":true}',
      ),
    ).toEqual({
      ok: true,
      value: { kind: "reply", text: "Hello\nTokyo 日" },
    });
  });

  it("waits for a complete escape before releasing it", function splitEscape() {
    expect(projectReplyStreamText('{"kind":"reply","text":"Hello\\')).toEqual({
      ok: true,
      value: { kind: "reply", text: "Hello" },
    });
    expect(
      projectReplyStreamText('{"kind":"reply","text":"Hello\\u65'),
    ).toEqual({
      ok: true,
      value: { kind: "reply", text: "Hello" },
    });
  });

  it("buffers non-reply actions", function buffersActions() {
    expect(
      projectReplyStreamText(
        '{"kind":"definition","document":{"secret":"hidden"}}',
      ),
    ).toEqual({ ok: true, value: { kind: "buffered_action" } });
    expect(
      projectReplyStreamText(
        '{"kind":"read_documentation","url":"https://example.com"}',
      ),
    ).toEqual({ ok: true, value: { kind: "buffered_action" } });
  });
});
