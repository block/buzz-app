// @vitest-environment jsdom
import { Context } from "@deepseek-ai/cordis";
import { afterEach, expect, it, vi } from "vitest";
import { provideNavigation } from "../navigation/service";
import type { OpenTarget } from "../navigation/targets";
import { readView, writeView } from "../../shared/view-state";
import { applyLinkDraft } from "./link-draft";

const viewer = "a".repeat(64);
const origin = "https://community.example";
const scope = `${origin}:${viewer}`;
const message = "b".repeat(64);
const root = "c".repeat(64);
const key = `draft:general:thread:${root}`;
const link = {
  version: 1,
  kind: "conversation",
  scope: { viewer, communityOrigin: origin },
  channelId: "general",
  messageId: message,
  draft: "Ship it?",
} as const satisfies OpenTarget;
const elsewhere = {
  version: 1,
  kind: "page",
  pluginId: "test.page",
  pageId: "elsewhere",
} as const;

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  localStorage.clear();
});
/** The real navigation service: history, visit positions and resolution. */
function navigation() {
  const ctx = new Context();
  contexts.push(ctx);
  const host = provideNavigation(ctx);
  host.attach();
  const owner = { valid: () => true, subscribe: () => () => {} };
  return {
    nav: host.navigation,
    visit: () =>
      host.request(host.navigation.snapshot().attempt, owner).request,
  };
}

it("saves the draft once, retires it from the visit, and never refills on Back", async () => {
  const { nav, visit } = navigation();
  void nav.open(link);
  const opened = visit();
  applyLinkDraft(opened, scope, "general", message, root);
  expect(readView(scope, key, "")).toBe("Ship it?");
  // The history entry no longer holds the text.
  const entry = nav.snapshot().entry;
  expect(entry.target).not.toHaveProperty("draft");
  expect(entry.target).toMatchObject({
    channelId: "general",
    messageId: message,
  });
  // Resolving hands the page a fresh visit to the address without the draft.
  expect(opened.signal.aborted).toBe(true);
  const resolved = visit();
  expect(resolved.target).not.toHaveProperty("draft");
  applyLinkDraft(resolved, scope, "general", message, root);
  expect(resolved.complete({ status: "opened" })).toBe(true);
  // The person sends it, leaves, and comes Back.
  writeView(scope, key, null);
  void nav.open(elsewhere);
  visit().complete({ status: "opened" });
  nav.back();
  await vi.waitFor(() =>
    expect(nav.snapshot().entry.id).toBe(resolved.entryId),
  );
  const returned = visit();
  applyLinkDraft(returned, scope, "general", message, root);
  expect(readView(scope, key, null)).toBeNull();
});

it("keeps the visit's applied mark when the visit can no longer resolve", async () => {
  const { nav, visit } = navigation();
  void nav.open(link);
  const opened = visit();
  // The thread finished opening before its root was known.
  expect(opened.complete({ status: "opened" })).toBe(true);
  applyLinkDraft(opened, scope, "general", message, root);
  expect(readView(scope, key, "")).toBe("Ship it?");
  expect(nav.snapshot().entry.target).toMatchObject({ draft: "Ship it?" });
  writeView(scope, key, null);
  void nav.open(elsewhere);
  visit().complete({ status: "opened" });
  nav.back();
  await vi.waitFor(() => expect(nav.snapshot().entry.id).toBe(opened.entryId));
  const returned = visit();
  applyLinkDraft(returned, scope, "general", message, root);
  expect(readView(scope, key, null)).toBeNull();
});

it("keeps a draft someone already wrote", () => {
  const { nav, visit } = navigation();
  writeView(scope, key, "Mine");
  void nav.open(link);
  applyLinkDraft(visit(), scope, "general", message, root);
  expect(readView(scope, key, "")).toBe("Mine");
  expect(nav.snapshot().entry.target).not.toHaveProperty("draft");
});

it.each([
  ["another channel", [scope, "random", message]],
  ["another message", [scope, "general", "d".repeat(64)]],
  ["another viewer", [`${origin}:${"e".repeat(64)}`, "general", message]],
  [
    "another community",
    [`https://other.example:${viewer}`, "general", message],
  ],
] as const)("ignores a panel for %s", (_name, [where, channel, opened]) => {
  const { nav, visit } = navigation();
  void nav.open(link);
  applyLinkDraft(visit(), where, channel, opened, root);
  expect(readView(where, `draft:${channel}:thread:${root}`, null)).toBeNull();
  expect(nav.snapshot().entry.target).toMatchObject({ draft: "Ship it?" });
});
