import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createCodeReader, MAX_BYTES, parseCodeLink } from "./code";
import { GhUnavailable, type GitHubCli } from "./gh";

afterEach(() => vi.unstubAllGlobals());

const base = "https://github.com/example-org/sample";
const hash = (path: string) => createHash("sha256").update(path).digest("hex");

it("parses file, line and range links, and pull request diff anchors", () => {
  expect(parseCodeLink(`${base}/blob/main/src/a.ts`)).toEqual({
    kind: "blob",
    repository: "example-org/sample",
    segments: ["main", "src", "a.ts"],
  });
  expect(parseCodeLink(`${base}/blob/main/src/a.ts#L42`)?.lines).toEqual({
    start: 42,
    end: 42,
  });
  expect(parseCodeLink(`${base}/blob/main/src/a.ts#L42-L60`)?.lines).toEqual({
    start: 42,
    end: 60,
  });
  expect(
    parseCodeLink(`${base}/blob/abc123/src/a%20b.ts?plain=1#L42C3-L60C9`),
  ).toEqual({
    kind: "blob",
    repository: "example-org/sample",
    segments: ["abc123", "src", "a b.ts"],
    lines: { start: 42, end: 60 },
  });
  expect(parseCodeLink(`${base}/blob/main/a.ts#L60-L42`)?.lines).toEqual({
    start: 42,
    end: 60,
  });
  const file = hash("src/a.ts");
  expect(parseCodeLink(`${base}/pull/7/files#diff-${file}R12`)).toEqual({
    kind: "pull",
    repository: "example-org/sample",
    number: 7,
    file,
    side: "RIGHT",
    lines: { start: 12, end: 12 },
  });
  expect(
    parseCodeLink(`${base}/pull/7/changes#diff-${file}L3-L9`),
  ).toMatchObject({ side: "LEFT", lines: { start: 3, end: 9 } });
  // A range across both sides shows where it starts.
  expect(
    parseCodeLink(`${base}/pull/7/files#diff-${file}L3-R9`)?.lines,
  ).toEqual({ start: 3, end: 3 });
});

it.each([
  "https://github.com.example.org/example-org/sample/blob/main/a.ts",
  "https://www.github.com/example-org/sample/blob/main/a.ts",
  "https://user@github.com/example-org/sample/blob/main/a.ts",
  "https://github.com:8443/example-org/sample/blob/main/a.ts",
  "http://github.com/example-org/sample/blob/main/a.ts",
  "https://raw.githubusercontent.com/example-org/sample/main/a.ts",
  `${base}/blob/main`,
  `${base}/tree/main/src`,
  `${base}/blob/main/a.ts#readme`,
  `${base}/blob/main/a.ts#L0`,
  `${base}/pull/7`,
  `${base}/pull/7/files`,
  `${base}/pull/7/files#diff-${hash("a")}`,
  `${base}/pull/7/commits#diff-${hash("a")}R1`,
  `${base}/pull/0/files#diff-${hash("a")}R1`,
  "not a url",
])("rejects %s", (url) => {
  expect(parseCodeLink(url)).toBeUndefined();
});

it("reads a file with gh, finding where a ref with slashes ends", async () => {
  const gh = vi.fn(
    async (_query: string, variables: Record<string, unknown>) => {
      expect(variables).toEqual({
        owner: "example-org",
        name: "sample",
        e0: "feature:x/src/a.ts",
        e1: "feature/x:src/a.ts",
        e2: "feature/x/src:a.ts",
      });
      return {
        repository: {
          // A folder matches the Blob fragment as an empty object.
          f0: {},
          f1: { byteSize: 9, isBinary: false, text: "const a;\n" },
          f2: null,
        },
      };
    },
  ) as unknown as GitHubCli;
  const link = parseCodeLink(`${base}/blob/feature/x/src/a.ts#L1`);
  if (!link) throw new Error("unparsed");
  await expect(createCodeReader(gh).read(link)).resolves.toEqual({
    ref: "feature/x",
    path: "src/a.ts",
    text: "const a;\n",
  });
});

it("refuses files that are too large or binary, and says why a file is missing", async () => {
  const answer = vi.fn();
  const gh = (async () => answer()) as GitHubCli;
  const read = (path: string) => {
    const link = parseCodeLink(`${base}/blob/main/${path}`);
    if (!link) throw new Error("unparsed");
    return createCodeReader(gh).read(link);
  };
  answer.mockReturnValueOnce({
    repository: { f0: { byteSize: MAX_BYTES + 1, isBinary: false, text: "" } },
  });
  await expect(read("big.ts")).rejects.toThrow("too large");
  answer.mockReturnValueOnce({
    repository: { f0: { byteSize: 10, isBinary: true, text: null } },
  });
  await expect(read("image.png")).rejects.toThrow("binary");
  answer.mockReturnValueOnce({ repository: { f0: null } });
  await expect(read("gone.ts")).rejects.toThrow(
    "GitHub couldn’t find this, or your GitHub account can’t see it.",
  );
});

it("reads public files from the API without gh, and keeps what it read", async () => {
  const fetch = vi.fn(async (url: string) =>
    url.includes("/contents/x/a.ts?ref=feature")
      ? new Response(null, { status: 404 })
      : new Response("print(1)\n"),
  );
  vi.stubGlobal("fetch", fetch);
  const unavailable = vi.fn(async () => {
    throw new GhUnavailable("gh auth login");
  }) as unknown as GitHubCli;
  const reader = createCodeReader(unavailable);
  const link = parseCodeLink(`${base}/blob/feature/x/a.ts#L1`);
  if (!link) throw new Error("unparsed");
  await expect(reader.read(link)).resolves.toEqual({
    ref: "feature/x",
    path: "a.ts",
    text: "print(1)\n",
  });
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://api.github.com/repos/example-org/sample/contents/x/a.ts?ref=feature",
    "https://api.github.com/repos/example-org/sample/contents/a.ts?ref=feature%2Fx",
  ]);
  await reader.read(link);
  expect(fetch).toHaveBeenCalledTimes(2);
  reader.forget(link);
  await reader.read(link);
  expect(fetch).toHaveBeenCalledTimes(4);

  fetch.mockResolvedValue(new Response(null, { status: 404 }));
  const missing = parseCodeLink(`${base}/blob/main/private.ts`);
  if (!missing) throw new Error("unparsed");
  await expect(createCodeReader(undefined).read(missing)).rejects.toThrow(
    "private or unavailable",
  );
  fetch.mockResolvedValue(
    new Response(null, {
      status: 403,
      headers: { "x-ratelimit-reset": "100" },
    }),
  );
  await expect(createCodeReader(undefined).read(missing)).rejects.toThrow(
    "limit was reached",
  );
});

it("finds a pull request's file by its anchor across pages, at head or base, with its open review threads", async () => {
  const path = "src/b.ts";
  const gh = vi.fn(
    async (query: string, variables: Record<string, unknown>) => {
      if (query.includes("files(")) {
        return variables.after === null
          ? {
              repository: {
                pullRequest: {
                  headRefOid: "head1",
                  baseRefOid: "base1",
                  files: {
                    pageInfo: { hasNextPage: true, endCursor: "c1" },
                    nodes: [{ path: "src/a.ts" }],
                  },
                },
              },
            }
          : {
              repository: {
                pullRequest: {
                  headRefOid: "head1",
                  baseRefOid: "base1",
                  files: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{ path }],
                  },
                },
              },
            };
      }
      return {
        repository: {
          object: { byteSize: 6, isBinary: false, text: "a\nb\nc\n" },
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  path,
                  line: 2,
                  startLine: null,
                  diffSide: "RIGHT",
                  isOutdated: false,
                  comments: {
                    nodes: [{ author: { login: "octo" }, bodyText: "Why?" }],
                  },
                },
                {
                  path,
                  line: 1,
                  startLine: null,
                  diffSide: "RIGHT",
                  isOutdated: true,
                  comments: { nodes: [] },
                },
                {
                  path: "src/a.ts",
                  line: 1,
                  startLine: null,
                  diffSide: "RIGHT",
                  isOutdated: false,
                  comments: { nodes: [] },
                },
              ],
            },
          },
        },
      };
    },
  );
  const reader = createCodeReader(gh as unknown as GitHubCli);
  const head = parseCodeLink(`${base}/pull/7/files#diff-${hash(path)}R2`);
  if (!head) throw new Error("unparsed");
  await expect(reader.read(head)).resolves.toEqual({
    ref: "head1",
    path,
    text: "a\nb\nc\n",
    pull: {
      head: "head1",
      threads: [
        {
          line: 2,
          startLine: 2,
          side: "RIGHT",
          comments: [{ author: "octo", body: "Why?" }],
        },
      ],
    },
  });
  expect(gh.mock.calls.at(-1)?.[1]).toMatchObject({
    number: 7,
    expression: `head1:${path}`,
  });
  const baseLink = parseCodeLink(`${base}/pull/7/files#diff-${hash(path)}L2`);
  if (!baseLink) throw new Error("unparsed");
  await reader.read(baseLink);
  expect(gh.mock.calls.at(-1)?.[1]).toMatchObject({
    expression: `base1:${path}`,
  });

  const gone = parseCodeLink(`${base}/pull/7/files#diff-${hash("x")}R1`);
  if (!gone) throw new Error("unparsed");
  await expect(reader.read(gone)).rejects.toThrow(
    "no longer part of this pull request",
  );
  // Pull request changes need gh.
  await expect(createCodeReader(undefined).read(gone)).rejects.toThrow(
    "Sign in to the gh CLI",
  );
});
