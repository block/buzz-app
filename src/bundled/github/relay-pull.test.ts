import { expect, it } from "vitest";
import type { EventData } from "../../features/relay/events";
import type { Hook } from "./hooks";
import {
  announcementUrl,
  isAnnouncement,
  parseRecord,
  pullStateOf,
} from "./relay-pull";

const relay = "a".repeat(64);
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
  pubkey: relay,
  created_at: 5,
  kind: 45010,
  content: JSON.stringify(body),
  tags: [
    ["ar", "1"],
    ["d", "e".repeat(8)],
    ["h", channel],
    ["type", "buzz.github.pull"],
    ["title", "#7 · Add the card"],
    ["r", url],
    ["root", root],
    ["op", "create"],
    ...tags,
  ],
  ...extra,
});

const retagged = (name: string, value: string): EventData => {
  const base = event();
  return {
    ...base,
    tags: base.tags.map((entry) => (entry[0] === name ? [name, value] : entry)),
  };
};

it("trusts a pull request revision only when the relay itself signed it", () => {
  expect(parseRecord(event(), relay)).toMatchObject({
    channel,
    root,
    pull: { url, number: 7, state: "open", repo: "block/buzz-app" },
  });
  expect(parseRecord(event(), "f".repeat(64))).toBeUndefined();
  expect(parseRecord(event(), undefined)).toBeUndefined();
  expect(
    parseRecord(event(content, { pubkey: "9".repeat(64) }), relay),
  ).toBeUndefined();
});

it("ignores a revision that is not a well formed version 1 pull request", () => {
  const other = (type: string) =>
    event(content, {
      tags: [
        ["d", "d"],
        ["h", channel],
        ["type", type],
      ],
    });
  expect(parseRecord(other("buzz.github.hook"), relay)).toBeUndefined();
  expect(parseRecord(event(content, { kind: 9 }), relay)).toBeUndefined();
  expect(
    parseRecord(event(content, { content: "not json" }), relay),
  ).toBeUndefined();
  expect(parseRecord(event([content]), relay)).toBeUndefined();
  expect(parseRecord(event({ ...content, version: 2 }), relay)).toBeUndefined();
  expect(
    parseRecord(event({ ...content, state: "reopened" }), relay),
  ).toBeUndefined();
  expect(
    parseRecord(event({ ...content, url: "https://example.com/p/7" }), relay),
  ).toBeUndefined();
  expect(
    parseRecord(event({ ...content, number: "7" }), relay),
  ).toBeUndefined();
  expect(
    parseRecord(event({ ...content, title: undefined }), relay),
  ).toBeUndefined();
  // The `r` tag must name the same pull request as the content.
  const marked = retagged("r", "https://github.com/block/buzz-app/pull/8");
  expect(parseRecord(marked, relay)).toBeUndefined();
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
    relay,
  );
  expect(record?.pull).toMatchObject({
    additions: undefined,
    updatedAt: undefined,
    checks: { state: "none", runs: { lint: "success" } },
    reviews: { ana: "approved" },
    requestedReviewers: ["cy"],
  });
  expect(
    parseRecord(event({ ...content, checks: undefined }), relay)?.pull.checks,
  ).toEqual({ state: "none", runs: {} });
  const unrooted = retagged("root", "nope");
  expect(parseRecord(unrooted, relay)?.root).toBeUndefined();
});

it("models a relay pull request as the store models one read from GitHub", () => {
  const pull = parseRecord(event(), relay)?.pull;
  if (!pull) throw new Error("not parsed");
  expect(pullStateOf(pull, false)).toEqual({
    state: "open",
    checks: "failure",
    source: "relay",
    head: "c0ffee",
    settled: false,
    failed: ["lint"],
  });
  const details = pullStateOf(pull, true).details;
  expect(details).toMatchObject({
    signedIn: false,
    details: {
      title: "Add the card",
      state: "open",
      author: "joah",
      headSha: "c0ffee",
      facts: [
        ["Branch", { head: { label: "joah/card" }, base: { label: "main" } }],
        ["Files changed", 3],
        ["Changes", { additions: 10, deletions: 2 }],
      ],
    },
    publicChecks: { state: "failure" },
  });
  for (const [state, label] of [
    ["merged", "Merged"],
    ["draft", "Draft"],
    ["closed", "closed"],
  ] as const)
    expect(pullStateOf({ ...pull, state }, true).details?.details.state).toBe(
      label,
    );
});

it("settles checks only when every run is done and none is pending", () => {
  const pull = parseRecord(
    event({
      ...content,
      checks: { state: "success", runs: { build: "success", lint: "neutral" } },
    }),
    relay,
  )?.pull;
  if (!pull) throw new Error("not parsed");
  expect(pullStateOf(pull, false)).toMatchObject({
    checks: "success",
    settled: true,
    failed: [],
  });
  expect(
    pullStateOf({ ...pull, checks: { state: "none", runs: {} } }, false),
  ).toMatchObject({ checks: undefined, settled: false });
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

it("trusts a publisher's revision only for the live hook that names them, in its channel and repository", () => {
  const mike = "c".repeat(64);
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
  const signed = (body: unknown = content, extra: Partial<EventData> = {}) =>
    event(body, { pubkey: mike, ...extra }, [["hook", "hook-d"]]);

  expect(parseRecord(signed(), relay, hookOf)).toMatchObject({
    publisher: mike,
    hook: "hook-d",
    pull: { url, state: "open" },
  });
  expect(parseRecord(signed(), relay)).toBeUndefined();
  expect(
    parseRecord(signed(content, { pubkey: "9".repeat(64) }), relay, hookOf),
  ).toBeUndefined();
  expect(
    parseRecord(signed({ ...content, repo: "block/other" }), relay, hookOf),
  ).toBeUndefined();
  expect(
    parseRecord(
      signed({
        ...content,
        url: "https://github.com/block/other/pull/7",
      }),
      relay,
      hookOf,
    ),
  ).toBeUndefined();
  expect(
    parseRecord(signed(), relay, (at, d) =>
      at === channel && d === "hook-d"
        ? { ...hook, publisher: undefined }
        : undefined,
    ),
  ).toBeUndefined();
  expect(parseRecord(signed(), relay, () => undefined)).toBeUndefined();
  expect(parseRecord(event(), relay, hookOf)?.publisher).toBeUndefined();
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
