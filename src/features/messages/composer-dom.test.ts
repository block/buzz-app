// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { editorSelection, setEditorSelection } from "./composer-dom";

afterEach(() => document.body.replaceChildren());

describe("selection after native token replacement", () => {
  it.each(["", "\u200B"])(
    "maps a trailing editable span with boundary %j",
    (boundary) => {
      const root = document.createElement("div");
      const text = document.createTextNode("source");
      const tail = document.createElement("span");
      tail.dataset.editorText = "";
      tail.textContent = `${boundary} `;
      root.append(text, tail);
      document.body.append(root);
      setEditorSelection(root, 7, 7);
      expect(editorSelection(root)).toEqual({
        start: 7,
        end: 7,
        backward: false,
      });
      expect(document.getSelection()?.anchorOffset).toBe(boundary.length + 1);
    },
  );

  it.each(["", "\u200B"])(
    "maps the end of a token before an editable span with boundary %j",
    (boundary) => {
      const root = document.createElement("div");
      const token = document.createElement("span");
      token.dataset.source = "source";
      token.textContent = "Chip";
      const tail = document.createElement("span");
      tail.dataset.editorText = "";
      tail.textContent = `${boundary} `;
      root.append(token, tail);
      document.body.append(root);
      setEditorSelection(root, 6, 6);
      expect(editorSelection(root)).toEqual({
        start: 6,
        end: 6,
        backward: false,
      });
      expect(document.getSelection()?.anchorOffset).toBe(boundary.length);
    },
  );
});
