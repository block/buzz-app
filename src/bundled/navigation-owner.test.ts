import { expect, it } from "vitest";
import { bundledPlugins } from ".";
import { navigationOwner } from "../app/shell/presentation";
import type { Page, RegisteredPage } from "../features/pages/service";

// Each bundled page exactly as its plugin's `apply` registers it, keyed as the
// registry keys it. The other services a page plugin injects are inert stubs.
async function bundledPages() {
  const inert: object = new Proxy(() => {}, {
    get: (_, key) =>
      key === "then" || typeof key === "symbol" ? undefined : inert,
    apply: () => inert,
  });
  const pages: RegisteredPage[] = [];
  for (const { manifest, module } of bundledPlugins) {
    if (!Array.isArray(module.inject) || !module.inject.includes("pages"))
      continue;
    const registry = {
      register: (registered: Page) =>
        pages.push({
          ...registered,
          key: `${manifest.id}/${registered.id}`,
          pluginId: manifest.id,
          revision: "bundled",
        }),
      registerOverlay: () => {},
    };
    const ctx = new Proxy(
      {},
      { get: (_, key) => (key === "pages" ? registry : inert) },
    );
    await module.apply(ctx as Parameters<typeof module.apply>[0]);
  }
  return pages;
}

it("gives every bundled page to the app whose navigation lists it", async () => {
  const pages = await bundledPages();
  const messages = "buzz.channels/channels";
  const owners = Object.fromEntries(
    pages.map(({ key }) => [key, navigationOwner(pages, key)]),
  );
  // Contract rows only, so adding or removing an unrelated bundled page
  // leaves this test alone.
  expect(owners).toMatchObject({
    // Channels, DMs, threads and Solo chats all open the Messages page.
    [messages]: messages,
    // Pages listed in the Messages sidebar keep Messages selected.
    "buzz.drafts-and-sent/drafts-sent": messages,
    "buzz.inbox/inbox": messages,
    // Apps are rows in the Messages sidebar, so Messages stays selected and
    // its sidebar stays visible.
    "buzz.bestie/bestie": messages,
    "buzz.reminders/reminders": messages,
    "buzz.agents/agents": messages,
    "buzz.workflows/workflows": messages,
    // An unlisted destination still owns itself.
    "buzz.repos/repos": "buzz.repos/repos",
  });
});
