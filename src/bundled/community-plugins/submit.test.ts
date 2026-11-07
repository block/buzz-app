import { expect, it, vi } from "vitest";
import {
  checkSource,
  describeSource,
  listingLinks,
  parseSourceInput,
  sourceKey,
  sourceLine,
} from "./submit";

const api = "https://api.github.com/repos/octo/notes";
type Answer = { status: number; body?: string };

const encoded = (value: unknown) =>
  JSON.stringify({
    type: "file",
    encoding: "base64",
    content: btoa(JSON.stringify(value)),
  });

function fakeHost(answers: Record<string, Answer>) {
  const request = vi.fn(async ({ url }: { url: string }) => {
    const answer = answers[url] ?? { status: 404 };
    return { status: answer.status, headers: {}, body: answer.body ?? "" };
  });
  return { request };
}

const publicRepo = {
  status: 200,
  body: '{"private":false,"default_branch":"main"}',
};
const manifest = {
  status: 200,
  body: encoded({
    id: "octo.notes",
    name: " Octo notes ",
    description: "Notes.",
  }),
};

it("parses repository names, folders, links and refs", () => {
  expect(parseSourceInput("octo/notes")).toEqual({
    owner: "octo",
    repo: "notes",
    path: "",
  });
  expect(
    parseSourceInput("https://github.com/octo/notes.git/tree/v1/plugins/a/"),
  ).toEqual({ owner: "octo", repo: "notes", ref: "v1", path: "plugins/a" });
  expect(parseSourceInput("octo/notes/plugins", " dev ")).toEqual({
    owner: "octo",
    repo: "notes",
    ref: "dev",
    path: "plugins",
  });
  expect(parseSourceInput("octo")).toBeNull();
  expect(parseSourceInput("octo/notes/../x")).toBeNull();
  expect(parseSourceInput("octo/notes", "bad..ref")).toBeNull();
  expect(describeSource({ owner: "o", repo: "r", path: "p" })).toBe("o/r/p");
});

it("finds a built plugin through GitHub's API on the default branch", async () => {
  const host = fakeHost({
    [api]: publicRepo,
    [`${api}/contents/plugins/notes/manifest.json?ref=main`]: manifest,
    [`${api}/contents/plugins/notes/plugin.js?ref=main`]: { status: 200 },
  });
  const result = await checkSource(host, {
    owner: "octo",
    repo: "notes",
    path: "plugins/notes",
  });
  expect(result).toEqual({
    ok: true,
    source: {
      owner: "octo",
      repo: "notes",
      ref: "main",
      path: "plugins/notes",
      id: "octo.notes",
      name: "Octo notes",
      description: "Notes.",
    },
  });
  expect(
    host.request.mock.calls.every(([input]) =>
      input.url.startsWith("https://api.github.com/"),
    ),
  ).toBe(true);
  expect(host.request.mock.calls.at(-1)?.[0]).toMatchObject({ method: "HEAD" });
});

it.each([
  [{ [api]: { status: 404 } }, "GitHub can't find octo/notes"],
  [{ [api]: { status: 200, body: '{"private":true}' } }, "is private"],
  [
    { [api]: publicRepo },
    "There's no manifest.json in the repository root on main",
  ],
  [
    {
      [api]: publicRepo,
      [`${api}/contents/manifest.json?ref=main`]: {
        status: 200,
        body: encoded({ id: "Bad Id", name: "x" }),
      },
    },
    "manifest.json needs an id",
  ],
  [
    {
      [api]: publicRepo,
      [`${api}/contents/manifest.json?ref=main`]: manifest,
    },
    "There's no plugin.js next to manifest.json on main",
  ],
  [{ [api]: { status: 403 } }, "Try again in a few minutes"],
])("explains why a source can't be listed", async (answers, message) => {
  const result = await checkSource(fakeHost(answers), {
    owner: "octo",
    repo: "notes",
    path: "",
  });
  expect(result.ok).toBe(false);
  expect(!result.ok && result.message).toContain(message);
});

const source = {
  owner: "octo",
  repo: "notes",
  ref: "main",
  path: "",
  id: "octo.notes",
  name: "Octo notes",
  description: "",
};

it("writes the source as a sources.txt line and a listing key", () => {
  expect(sourceLine(source)).toBe("https://github.com/octo/notes main");
  expect(sourceLine({ ...source, ref: "v2", path: "plugins/a" })).toBe(
    "https://github.com/octo/notes v2 plugins/a",
  );
  expect(sourceKey(source)).toBe("github.com/octo/notes");
  expect(sourceKey({ ...source, path: "plugins/a" })).toBe(
    "github.com/octo/notes/plugins/a",
  );
});

it("links to a sources.txt pull request and a filled-in issue form", () => {
  const links = listingLinks("block/buzz-plugins", {
    ...source,
    name: "Notes & more",
    path: "plugins/a",
  });
  expect(links.pullRequest).toBe(
    "https://github.com/block/buzz-plugins/edit/main/sources.txt",
  );
  const issue = new URL(links.issue);
  expect(`${issue.origin}${issue.pathname}`).toBe(
    "https://github.com/block/buzz-plugins/issues/new",
  );
  expect(Object.fromEntries(issue.searchParams)).toEqual({
    template: "list-plugin.yml",
    title: "List: Notes & more",
    source: "https://github.com/octo/notes main plugins/a",
  });
});
