import { expect, test } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { navigationDestinations, orderPages } from "./presentation";

function page(key: string, title: string): RegisteredPage {
  const separator = key.indexOf("/");
  const pluginId = key.slice(0, separator);
  const id = key.slice(separator + 1);
  return {
    key,
    pluginId,
    id,
    title,
    revision: "bundled",
    component: () => null,
  };
}

const messages = page("buzz.channels/channels", "Channels");
const projects = page("buzz.projects/projects", "Projects");

test("bundled page order ignores activation order without mutating the registry", () => {
  const input = Object.freeze([projects, messages]);
  expect(orderPages(input)).toEqual([messages, projects]);
  expect(input).toEqual([projects, messages]);
  expect(orderPages([messages, projects])).toEqual([messages, projects]);
  expect(orderPages([projects])).toEqual([projects]);
  expect(orderPages([])).toEqual([]);
});

test("other pages sort by label then full key and cannot claim bundled slots", () => {
  const alpha = page("example.alpha/page", "Alpha");
  const alpha2 = page("example.other/page", "Alpha");
  const sameId = page("example.custom/projects", "Projects");
  const zulu = page("example.zulu/page", "Zulu");
  const expected = [messages, projects, alpha, alpha2, sameId, zulu];
  expect(orderPages([...expected].reverse())).toEqual(expected);
  expect(orderPages([sameId, projects, alpha2, zulu, messages, alpha])).toEqual(
    expected,
  );
});

test("sidebar destinations list bundled pages first, then external, in declared entry order", () => {
  const icon = () => null;
  const channels = {
    ...messages,
    navigation: [
      { title: "Inbox", icon, params: "Inbox" },
      { title: "Bestie", icon, params: "Bestie" },
    ],
  };
  const agents = {
    ...page("buzz.agents/agents", "Agents"),
    navigation: [{ title: "Agents", icon }],
  };
  // An external page titled to sort first still follows every bundled page.
  const external = {
    ...page("example.threads/threads", "Active threads"),
    revision: "0123abcd",
    navigation: [{ title: "Active threads", icon: "/threads.svg" }],
  };
  const titles = (pages: RegisteredPage[]) =>
    navigationDestinations(pages).map(({ entry }) => entry.title);
  const expected = ["Inbox", "Bestie", "Agents", "Active threads"];
  expect(titles([external, agents, projects, channels])).toEqual(expected);
  expect(titles([channels, external, agents])).toEqual(expected);
  expect(navigationDestinations([external])[0]).toMatchObject({
    key: "example.threads/threads#0",
    pluginId: "example.threads",
    pageId: "threads",
  });
});
