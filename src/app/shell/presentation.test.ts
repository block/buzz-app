import { expect, test } from "vitest";
import type { RegisteredPage } from "../../features/pages/service";
import { orderPages } from "./presentation";

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
