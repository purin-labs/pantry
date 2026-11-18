import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  RelativeTextSelection,
  captureTextPresenceSelection,
  resolveTextPresenceSelection,
} from "../src/index";

describe("relative text selections", () => {
  it("keeps local and transmitted selections anchored across concurrent insertion", () => {
    const left = new Y.Doc();
    const text = left.getText("content");
    text.insert(0, "Ginger cookie");
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    const local = RelativeTextSelection.capture(text, 7, 13, "backward");
    const transmitted = captureTextPresenceSelection(text, 7, 13, "backward");

    right.getText("content").insert(0, "Fresh ");
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right, Y.encodeStateVector(left)));

    expect(local.resolve(left)).toEqual({ start: 13, end: 19, direction: "backward" });
    expect(resolveTextPresenceSelection(left, text, transmitted)).toEqual(local.resolve(left));
  });

  it("rejects a selection anchored to another shared text field", () => {
    const doc = new Y.Doc();
    const body = doc.getText("body");
    const subject = doc.getText("subject");
    body.insert(0, "Body");
    subject.insert(0, "Subject");
    const selection = captureTextPresenceSelection(subject, 0, 7, "forward");
    expect(resolveTextPresenceSelection(doc, body, selection)).toBeNull();
  });
});
