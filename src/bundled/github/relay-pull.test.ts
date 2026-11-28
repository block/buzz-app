import { expect, it } from "vitest";
import type { EventData } from "../../features/relay/events";
import type { Hook } from "./hooks";
import { announcementUrl, isAnnouncement, parseRecord } from "./relay-pull";

const mike = "c".repeat(64);
const channel = "11111111-1111-4111-8111-111111111111";
const url = "https://github.com/block/buzz-app/pull/7";
const root = "b".repeat(64);

const content = {
  version: 1,
  url,
  repo: "block/buzz-app",
  number: 7,
  title: "Add the card",
  author: "joah",
  state: "open",
  base: "main",
  head: "joah/card",
  head_sha: "c0ffee",
  updated_at: "2026-11-04T10:00:00Z",
  additions: 10,
  deletions: 2,
  changed_files: 3,
  checks: {
    state: "failure",
    runs: { build: "success", lint: "failure", e2e: "pending" },
  },
  reviews: { ana: "approved", bo: "changes_requested" },
  requested_reviewers: ["cy", "team:core"],
};

const event = (
  body: unknown = content,
  extra: Partial<EventData> = {},
  tags: string[][] = [],
): EventData => ({
  id: "d".repeat(64),
  pubkey: mike,
  created_at: 5,
  kind: 45010,
  content: JSON.stringify(body),
  tags: [
    ["ar", "1"],
    ["d", "e".repeat(8)],
    ["h", channel],
    ["type", "github.pull"],
    ["title", "#7 · Add the card"],
    ["r", url],
    ["root", root],
    ["op", "create"],
    ["hook", "hook-d"],
    ...tags,
  ],
  ...extra,
});

const hook: Hook = {
  d: "hook-d",
  repo: "block/buzz-app",
  head: "1".repeat(64),
  author: mike,
  createdAt: 1,
  publisher: mike,
};
const hooks = new Map([[`${channel}\0hook-d`, hook]]);
const hookOf = (at: string, d: string) => hooks.get(`${at}\0${d}`);

const retagged = (name: string, value: string): EventData => {
  const base = event();
  return {
    ...base,
    tags: base.tags.map((entry) => (entry[0] === name ? [name, value] : entry)),
  };
};

it("ignores a revision that is not a well formed version 1 pull request", () => {
  const other = (type: string) =>
    event(content, {
      tags: [
        ["d", "d"],
        ["h", channel],
        ["type", type],
      ],
    });
  expect(parseRecord(other("github.hook"), hookOf)).toBeUndefined();
  expect(parseRecord(event(content, { kind: 9 }), hookOf)).toBeUndefined();
  expect(
    parseRecord(event(content, { content: "not json" }), hookOf),
  ).toBeUndefined();
  expect(parseRecord(event([content]), hookOf)).toBeUndefined();
  expect(
    parseRecord(event({ ...content, version: 2 }), hookOf),
  ).toBeUndefined();
  expect(
    parseRecord(event({ ...content, state: "reopened" }), hookOf),
  ).toBeUndefined();
  expect(
    parseRecord(event({ ...content, url: "https://example.com/p/7" }), hookOf),
  ).toBeUndefined();
  expect(
    parseRecord(event({ ...content, number: "7" }), hookOf),
  ).toBeUndefined();
  expect(
    parseRecord(event({ ...content, title: undefined }), hookOf),
  ).toBeUndefined();
  // The `r` tag must name the same pull request as the content.
  const marked = retagged("r", "https://github.com/block/buzz-app/pull/8");
  expect(parseRecord(marked, hookOf)).toBeUndefined();
});

it("keeps what it can of an optional field that is malformed", () => {
  const record = parseRecord(
    event({
      ...content,
      additions: -1,
      updated_at: "yesterday",
      checks: { state: "weird", runs: { build: 3, lint: "success" } },
      reviews: { ana: "approved", bo: "shrugged" },
      requested_reviewers: ["cy", 4],
    }),
    hookOf,
  );
  expect(record?.pull).toMatchObject({
    additions: undefined,
    updatedAt: undefined,
    checks: { state: "none", runs: { lint: "success" } },
    reviews: { ana: "approved" },
    requestedReviewers: ["cy"],
  });
  expect(
    parseRecord(event({ ...content, checks: undefined }), hookOf)?.pull.checks,
  ).toEqual({ state: "none", runs: {} });
  const unrooted = retagged("root", "nope");
  expect(parseRecord(unrooted, hookOf)?.root).toBeUndefined();
});

it("takes the pull request URL from an announcement's last line only", () => {
  const other = "https://github.com/o/r/pull/99";
  expect(announcementUrl(`#7 · Add the card\n${url}`)).toBe(url);
  expect(announcementUrl(`#7 · see ${other}\n${url}`)).toBe(url);
  expect(announcementUrl(`#99 · see ${url}\n${other}`)).toBe(other);
  expect(announcementUrl(`see ${url}?diff=split`)).toBeUndefined();
  expect(announcementUrl("Merged by joah")).toBeUndefined();
  expect(
    announcementUrl("#7 · x\nhttps://github.com/block/buzz-app/issues/7"),
  ).toBeUndefined();
});

it("trusts a revision only from the publisher of the live hook it names, in its channel and repository", () => {
  expect(parseRecord(event(), hookOf)).toMatchObject({
    channel,
    root,
    publisher: mike,
    hook: "hook-d",
    pull: { url, number: 7, state: "open", repo: "block/buzz-app" },
  });
  // A relay's or any other member's signature vouches for nothing.
  expect(
    parseRecord(event(content, { pubkey: "a".repeat(64) }), hookOf),
  ).toBeUndefined();
  expect(
    parseRecord(event({ ...content, repo: "block/other" }), hookOf),
  ).toBeUndefined();
  expect(
    parseRecord(
      event({ ...content, url: "https://github.com/block/other/pull/7" }),
      hookOf,
    ),
  ).toBeUndefined();
  expect(
    parseRecord(event(), (at, d) =>
      at === channel && d === "hook-d"
        ? { ...hook, publisher: "9".repeat(64) }
        : undefined,
    ),
  ).toBeUndefined();
  expect(parseRecord(event(), () => undefined)).toBeUndefined();
  const unhooked = event();
  expect(
    parseRecord(
      { ...unhooked, tags: unhooked.tags.filter(([name]) => name !== "hook") },
      hookOf,
    ),
  ).toBeUndefined();
});

it("knows an announcement only by its exact shape", () => {
  expect(isAnnouncement(`#7 · Add the card\n${url}`)).toBe(true);
  expect(isAnnouncement(`#8 · Add the card\n${url}`)).toBe(false);
  expect(isAnnouncement(`#7 · Add the card\n${url} thanks`)).toBe(false);
  expect(isAnnouncement(`see #7 · Add the card\n${url}`)).toBe(false);
  expect(
    isAnnouncement("#7 · x\nhttps://github.com.evil.example/a/b/pull/7"),
  ).toBe(false);
});
