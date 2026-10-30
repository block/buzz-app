import { expect, it } from "vitest";
import { parsePluginInstallLink } from "./install-link";

const commit = "0123456789abcdef0123456789abcdef01234567";
const repository = "https://example.com/team/plugins.git";
const link = (query: string, prefix = "buzz://plugin-install?") =>
  parsePluginInstallLink(`${prefix}${query}`);
const query = (values: Record<string, string>) =>
  new URLSearchParams(values).toString();

it("parses a repository, reference, optional folder and optional commit", () => {
  expect(link(query({ repository, ref: "v1" }))).toEqual({
    source: { repository, reference: "v1" },
  });
  expect(
    link(query({ repository, ref: "release/1.2", path: "dist/a", commit })),
  ).toEqual({
    source: { repository, reference: "release/1.2", path: "dist/a", commit },
  });
  expect(
    link(query({ repository: "git@example.com:team/plugins.git", ref: "v1" })),
  ).toMatchObject({
    source: { repository: "git@example.com:team/plugins.git" },
  });
});

it("accepts a Windows root slash and ignores unknown parameters", () => {
  expect(
    link(
      query({ repository, ref: "v1", other: "x" }),
      "buzz://plugin-install/?",
    ),
  ).toEqual({ source: { repository, reference: "v1" } });
});

it.each([
  ["a missing repository", query({ ref: "v1" })],
  ["a missing reference", query({ repository })],
  ["an empty reference", query({ repository, ref: "" })],
  [
    "an http repository",
    query({ repository: "http://example.com/a.git", ref: "v1" }),
  ],
  ["a traversing path", query({ repository, ref: "v1", path: "../x" })],
  ["a short commit", query({ repository, ref: "v1", commit: "abc1234" })],
  [
    "a repeated repository",
    `${query({ repository, ref: "v1" })}&repository=${encodeURIComponent(repository)}`,
  ],
  ["a repeated reference", `${query({ repository, ref: "v1" })}&ref=v2`],
  [
    "a repeated commit",
    `${query({ repository, ref: "v1", commit })}&commit=${commit}`,
  ],
  ["a repeated path", `${query({ repository, ref: "v1", path: "a" })}&path=b`],
])("rejects %s", (_name, value) => {
  expect(link(value)).toBeNull();
});

it("rejects other hosts, paths, fragments, credentials and oversize links", () => {
  const good = query({ repository, ref: "v1" });
  expect(link(good, "buzz://plugin?")).toBeNull();
  expect(link(good, "buzz://plugin-installer?")).toBeNull();
  expect(link(good, "buzz://plugin-install/extra?")).toBeNull();
  expect(link(good, "buzz://user@plugin-install?")).toBeNull();
  expect(link(good, "https://plugin-install?")).toBeNull();
  expect(parsePluginInstallLink(`buzz://plugin-install?${good}#x`)).toBeNull();
  expect(
    link(query({ repository, ref: "v1", path: "a".repeat(4096) })),
  ).toBeNull();
  expect(parsePluginInstallLink("buzz://plugin-install")).toBeNull();
});
