// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginManager } from "../../plugins/manager";
import { ConversationService } from "../../features/conversation/service";
import { MessageRow } from "../../features/messages/MessageRow";
import { foldMessages } from "../../features/relay/fold";
import { keypair, signed } from "../../features/relay/testing";
import * as diffs from "./index";
import manifest from "./manifest.json";

const author = keypair();
const content =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+![code](https://example.com/no.png) <script>alert(1)</script>\n";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0)) await dispose();
  localStorage.removeItem("buzzodz.plugins.v1");
  vi.restoreAllMocks();
});
function mount(
  module = diffs,
  patch = content,
  repo = "https://example.com/repo",
) {
  const ctx = new Context();
  const plugins = createPluginManager(ctx, {
    bundled: [{ manifest: { ...manifest, apiVersion: 1 }, module }],
  });
  const service = new ConversationService(ctx);
  cleanups.push(async () => {
    await plugins.dispose();
    await ctx.fiber.dispose();
  });
  const event = signed(author, {
    kind: 40008,
    content: patch,
    tags: [
      ["h", "a"],
      ["repo", repo],
      ["commit", "abcdef0"],
      ["file", "a.ts"],
      ["truncated", "true"],
    ],
  });
  const row = foldMessages("a", author.pubkey, [event])[0];
  if (!row) throw new Error("Missing diff message");
  const result = render(
    <MessageRow
      row={row}
      extensions={service}
      day={false}
      retry={undefined}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
    />,
  );
  return { ...result, plugins, service };
}
it("renders a signed patch, removes its renderer on disable and restores it on re-enable", async () => {
  const h = mount();
  await screen.findByRole("button", { name: "Expand diff" });
  expect(h.container.querySelector(".diff-unified")).not.toBeNull();
  expect(h.container.querySelector("img, script")).toBeNull();
  expect(
    screen.getByRole("link", { name: "abcdef0" }).getAttribute("href"),
  ).toBe("https://example.com/repo/commit/abcdef0");
  await act(() => h.plugins.change("disable", "buzz.diffs"));
  expect(h.container.querySelector("pre")?.textContent).toBe(content);
  expect(screen.queryByRole("button", { name: "Expand diff" })).toBeNull();
  await act(() => h.plugins.change("enable", "buzz.diffs"));
  await screen.findByRole("button", { name: "Expand diff" });
  expect(h.container.querySelector(".diff-unified")).not.toBeNull();
});
it.each([
  ["new file", "/dev/null", "b/a.ts", "-0,0 +1", "+new", "insert"],
  ["deleted file", "a/a.ts", "/dev/null", "-1 +0,0", "-old", "delete"],
  ["zero-context insertion", "a/a.ts", "b/a.ts", "-3,0 +4", "+new", "insert"],
  ["zero-context deletion", "a/a.ts", "b/a.ts", "-4 +3,0", "-old", "delete"],
])(
  "renders %s as a rich diff rather than raw fallback",
  async (_name, oldPath, newPath, range, line, type) => {
    const patch = `diff --git a/a.ts b/a.ts\n--- ${oldPath}\n+++ ${newPath}\n@@ ${range} @@\n${line}\n`;
    const h = mount(diffs, patch);
    await screen.findByRole("button", { name: "Expand diff" });
    expect(h.container.querySelector("table.diff-unified")).not.toBeNull();
    expect(h.container.querySelector(`.diff-code-${type}`)?.textContent).toBe(
      line.slice(1),
    );
    expect(h.container.querySelector("pre")).toBeNull();
  },
);
it("retains raw malformed content and rejects unsafe repository URLs", async () => {
  const patch =
    "<script>alert(1)</script> ![image](https://example.com/no.png)\n";
  const h = mount(diffs, patch, "javascript:alert(1)");
  await screen.findByRole("button", { name: "Expand diff" });
  expect(h.container.querySelector("pre")?.textContent).toBe(patch);
  expect(h.container.querySelector("a, img, script")).toBeNull();
  expect(h.container.textContent).toContain("Diff truncated.");
});
it("keeps the host raw patch fallback after renderer failure, and removal", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const h = mount({
    inject: ["conversation"],
    apply(ctx: Context) {
      ctx.conversation.registerMessage({
        id: "broken",
        title: "Broken",
        matches: () => true,
        component() {
          throw new Error("renderer failed");
        },
      });
    },
  });
  await vi.waitFor(() => expect(h.service.messages.snapshot()).toHaveLength(1));
  expect(h.container.querySelector("pre")?.textContent).toBe(content);
  expect(h.container.querySelector("img, script")).toBeNull();
  await act(() => h.plugins.change("disable", "buzz.diffs"));
  expect(h.container.querySelector("pre")?.textContent).toBe(content);
});

it("preserves unparsed trailing content as escaped raw text inline and expanded", async () => {
  const patch = `${content}UNPARSED_TRAILER <img src=x onerror=alert(1)>\n`;
  const h = mount(diffs, patch);
  const expand = await screen.findByRole("button", { name: "Expand diff" });
  expect(screen.getByRole("region", { name: "Raw diff" }).textContent).toBe(
    patch,
  );
  expect(h.container.querySelector("table, img, script")).toBeNull();
  await userEvent.setup().click(expand);
  const dialog = await screen.findByRole("dialog");
  expect(
    within(dialog).getByRole("region", { name: "Raw diff" }).textContent,
  ).toBe(patch);
  expect(dialog.querySelector("table, img, script")).toBeNull();
});
