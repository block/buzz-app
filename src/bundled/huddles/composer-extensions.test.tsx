import { expect, it } from "vitest";
import { huddleComposerExtensions } from "./composer-extensions";

const keys = (extensions: ReturnType<typeof huddleComposerExtensions>) =>
  extensions.tools.snapshot().map((tool) => tool.key);

it("offers the voice recorder only to a window that may capture, and only while main enables it", () => {
  const enabled = ["buzz.emoji/picker", "buzz.voice-notes/recorder"];
  expect(
    keys(huddleComposerExtensions({ tools: enabled, completions: [] })),
  ).toEqual(["buzz.emoji/picker"]);
  expect(
    keys(
      huddleComposerExtensions({
        tools: enabled,
        completions: [],
        capture: true,
      }),
    ),
  ).toEqual(enabled);
  expect(
    keys(
      huddleComposerExtensions({
        tools: ["buzz.emoji/picker"],
        completions: [],
        capture: true,
      }),
    ),
  ).toEqual(["buzz.emoji/picker"]);
});

it("reuses the bundled link renderer only while main enables it; none by default", () => {
  const links = (extensions: ReturnType<typeof huddleComposerExtensions>) =>
    extensions.links?.snapshot().map((link) => link.key);
  expect(
    links(huddleComposerExtensions({ tools: [], completions: [] })),
  ).toEqual([]);
  expect(
    links(
      huddleComposerExtensions({
        tools: [],
        completions: [],
        links: ["buzz.links/links", "buzz.github/pull"],
      }),
    ),
  ).toEqual(["buzz.links/links"]);
});
