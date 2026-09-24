import { expect, it, vi } from "vitest";
import { finalizeEvent, getPublicKey } from "nostr-tools";
import { entityFromEvent, projectDestinations } from "./destinations";
import { matchesEvent } from "../relay/projection";
import type { ReadFilter, RelayEvent } from "../relay/events";
import type { EntityRoute } from "./routes";

const key = new Uint8Array(32).fill(1),
  outsider = new Uint8Array(32).fill(2);
const owner = getPublicKey(key),
  address = `30617:${owner}:repo`;
function event(
  kind: number,
  tags: string[][],
  content = "",
  created_at = 1,
  signer = key,
) {
  return finalizeEvent({ kind, tags, content, created_at }, signer);
}
const repo = event(30617, [
  ["d", "repo"],
  ["name", "Actual repository"],
]);
const project = event(30621, [
  ["d", "project"],
  ["name", "Actual project"],
  ["a", address],
  ["buzz-related-channel", "general"],
]);
const issue = event(
  1621,
  [
    ["a", address],
    ["subject", "Fix the reader"],
  ],
  "Issue description",
);
const pr = event(
  1618,
  [
    ["a", address],
    ["subject", "Reader changes"],
    ["c", "a".repeat(40)],
  ],
  "Pull request description",
);
const base = { owner, dtag: "repo" };
function fixture(events: RelayEvent[]) {
  const read = vi.fn(
    async (filters: readonly ReadFilter[], signal: AbortSignal) => {
      signal.throwIfAborted();
      return events.filter((event) =>
        filters.some((filter) => matchesEvent(event, filter)),
      );
    },
  );
  return { read, destinations: projectDestinations(read) };
}
it("resolves exact repository and project coordinates, members and related channels", async () => {
  const { destinations } = fixture([repo, project]);
  expect(
    await destinations.load(
      { type: "repo", ...base },
      new AbortController().signal,
    ),
  ).toMatchObject({ entity: { name: "Actual repository" } });
  expect(
    await destinations.load(
      { type: "project", owner, dtag: "project" },
      new AbortController().signal,
    ),
  ).toMatchObject({
    entity: { name: "Actual project" },
    repositories: [{ address }],
    channels: ["general"],
  });
});
it.each([issue, pr])(
  "resolves the selected event and only authorized lifecycle changes ($kind)",
  async (item) => {
    const good = event(1632, [["e", item.id, "", "root"]], "", 2);
    const forged = event(1631, [["e", item.id, "", "root"]], "", 3, outsider);
    const comment = event(
      1111,
      [["E", item.id]],
      "Review discussion",
      4,
      outsider,
    );
    const { destinations } = fixture([repo, item, good, forged, comment]);
    const result = await destinations.load(
      { type: item.kind === 1618 ? "pr" : "issue", ...base, id: item.id },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      item,
      status: "Closed",
      activity: [comment],
    });
  },
);
it.each([
  { type: "repo", owner, dtag: "missing" },
  { type: "pr", ...base, id: issue.id },
  { type: "issue", owner, dtag: "other", id: issue.id },
] as EntityRoute[])(
  "does not acknowledge missing or mismatched destinations",
  async (route) => {
    const other = event(30617, [["d", "other"]]);
    await expect(
      fixture([repo, other, issue]).destinations.load(
        route,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "not-found" });
  },
);
it("does not fall back to an old announcement when the latest is deleted or malformed", async () => {
  const latest = event(30617, [["d", "repo"]], "new", 4);
  const removal = event(5, [["a", address]], "", 5);
  const malicious = event(5, [["a", address]], "", 6, outsider);
  const route = { type: "repo" as const, ...base };
  await expect(
    fixture([repo, latest, removal]).destinations.load(
      route,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "not-found" });
  expect(
    (
      await fixture([latest, malicious]).destinations.load(
        route,
        new AbortController().signal,
      )
    ).entity.event.id,
  ).toBe(latest.id);
  const malformed = event(
    30621,
    [
      ["d", "project"],
      ["a", "not-a-coordinate"],
    ],
    "",
    5,
  );
  await expect(
    fixture([project, malformed]).destinations.load(
      { type: "project", owner, dtag: "project" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "not-found" });
});
it("checks event deletion, lists the correct repository's items and exposes unavailable project members", async () => {
  const removal = event(5, [["e", issue.id]], "", 3);
  await expect(
    fixture([repo, issue, removal]).destinations.load(
      { type: "issue", ...base, id: issue.id },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ reason: "not-found" });
  expect(
    (
      await fixture([repo, issue, pr]).destinations.load(
        { type: "repo", ...base, tab: "prs" },
        new AbortController().signal,
      )
    ).items,
  ).toEqual([pr]);
  expect(
    (
      await fixture([project]).destinations.load(
        { type: "project", owner, dtag: "project" },
        new AbortController().signal,
      )
    ).unavailableRepositories,
  ).toEqual([address]);
});
it("batches directory deletion reads and never substitutes empty results on transport failure", async () => {
  const { destinations, read } = fixture([
    repo,
    project,
    event(5, [["a", address]], "", 3),
  ]);
  expect(
    (await destinations.list(new AbortController().signal)).map((e) => e.name),
  ).toEqual(["Actual project"]);
  expect(read).toHaveBeenCalledTimes(2);
  read.mockRejectedValueOnce(new Error("offline"));
  await expect(destinations.list(new AbortController().signal)).rejects.toThrow(
    "offline",
  );
});
it("retains valid metadata coordinates outside the narrower share-link grammar", async () => {
  const member = event(30617, [["d", "nested:repository"]]);
  const parent = event(30621, [
    ["d", "project"],
    ["a", `30617:${owner}:nested:repository`],
  ]);
  const result = await fixture([parent, member]).destinations.load(
    { type: "project", owner, dtag: "project" },
    new AbortController().signal,
  );
  expect(result.repositories).toMatchObject([{ dtag: "nested:repository" }]);
});
it("honors the newest trusted PR revision and draft status without accepting an outsider's update", async () => {
  const root = event(1618, [
    ["a", address],
    ["c", "a".repeat(40)],
    ["t", "draft"],
  ]);
  const update = event(
    1619,
    [
      ["a", address],
      ["E", root.id],
      ["P", root.pubkey],
      ["c", "b".repeat(40)],
      ["clone", "https://git.example/repo.git"],
    ],
    "",
    2,
  );
  const forged = event(
    1619,
    [
      ["E", root.id],
      ["c", "c".repeat(40)],
    ],
    "",
    3,
    outsider,
  );
  const misdirected = event(
    1619,
    [
      ["e", root.id],
      ["c", "d".repeat(40)],
    ],
    "",
    4,
  );
  const result = await fixture([
    repo,
    root,
    update,
    forged,
    misdirected,
  ]).destinations.load(
    { type: "pr", ...base, id: root.id },
    new AbortController().signal,
  );
  expect(result).toMatchObject({ status: "Draft", commit: "b".repeat(40) });
});
it("does not resurrect a listed announcement after its owner marks it unlisted", async () => {
  const hidden = event(
    30617,
    [
      ["d", "repo"],
      ["buzz-visibility", "unlisted"],
    ],
    "",
    2,
  );
  expect(
    await fixture([repo, hidden]).destinations.list(
      new AbortController().signal,
    ),
  ).toEqual([]);
});

it.each([issue, pr])(
  "accepts statuses from all current multi-value maintainers ($kind)",
  async (item) => {
    const maintained = event(
      30617,
      [
        ["d", "repo"],
        ["maintainers", "f".repeat(64), getPublicKey(outsider)],
      ],
      "",
      2,
    );
    const status = event(1632, [["e", item.id, "", "root"]], "", 3, outsider);
    const result = await fixture([maintained, item, status]).destinations.load(
      { type: item.kind === 1618 ? "pr" : "issue", ...base, id: item.id },
      new AbortController().signal,
    );
    expect(result.status).toBe("Closed");
  },
);
it.each([
  ["maintainer", outsider],
  ["repository owner", key],
] as const)(
  "does not let a %s replace another author's PR tip",
  async (_, signer) => {
    const author = new Uint8Array(32).fill(3);
    const maintained = event(30617, [
      ["d", "repo"],
      ["maintainers", getPublicKey(outsider)],
    ]);
    const root = event(
      1618,
      [
        ["a", address],
        ["c", "a".repeat(40)],
      ],
      "",
      1,
      author,
    );
    const tags = [
      ["a", address],
      ["E", root.id],
      ["P", root.pubkey],
      ["c", "b".repeat(40)],
      ["clone", "https://git.example/repo.git"],
    ];
    const valid = event(1619, tags, "", 2, author);
    const forged = event(
      1619,
      tags.map((t) => (t[0] === "c" ? ["c", "c".repeat(40)] : t)),
      "",
      3,
      signer,
    );
    const status = event(1632, [["e", root.id, "", "root"]], "", 4, signer);
    const result = await fixture([
      maintained,
      root,
      valid,
      forged,
      status,
    ]).destinations.load(
      { type: "pr", ...base, id: root.id },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ commit: "b".repeat(40), status: "Closed" });
  },
);
it.each(
  [
    [["E", pr.id]],
    [["e", pr.id, "", "reply"]],
    [
      ["e", "f".repeat(64), "", "root"],
      ["e", pr.id, "", "reply"],
    ],
    [
      ["e", pr.id, "", "root"],
      ["e", "f".repeat(64), "", "root"],
    ],
    [
      ["e", pr.id, "", "root"],
      ["a", `30617:${owner}:other`],
    ],
  ].map((tags) => ({ tags })),
)(
  "ignores status events that do not name this exact root: $tags",
  async ({ tags }) => {
    const status = event(1632, tags, "", 2);
    const result = await fixture([repo, pr, status]).destinations.load(
      { type: "pr", ...base, id: pr.id },
      new AbortController().signal,
    );
    expect(result.status).toBe("Open");
  },
);
it.each([
  ["c", []],
  ["c", [["c", "invalid"]]],
  [
    "c",
    [
      ["c", "c".repeat(40)],
      ["c", "d".repeat(40)],
    ],
  ],
  [
    "E",
    [
      ["E", pr.id],
      ["E", "f".repeat(64)],
    ],
  ],
  ["a", []],
  ["a", [["a", `30617:${owner}:other`]]],
  ["P", []],
  ["P", [["P", getPublicKey(outsider)]]],
  ["clone", []],
] as [string, string[][]][])(
  "ignores malformed newer PR updates (%s %j) before selecting the revision",
  async (tag, replacement) => {
    const tags = [
      ["a", address],
      ["E", pr.id],
      ["P", pr.pubkey],
      ["c", "b".repeat(40)],
      ["clone", "https://git.example/repo.git"],
    ];
    const valid = event(1619, tags, "", 2);
    const malformed = event(
      1619,
      [
        ...tags
          .filter((t) => t[0] !== tag)
          .map((t) => (t[0] === "c" ? ["c", "e".repeat(40)] : t)),
        ...replacement,
      ],
      "",
      3,
    );
    const result = await fixture([
      repo,
      pr,
      valid,
      malformed,
    ]).destinations.load(
      { type: "pr", ...base, id: pr.id },
      new AbortController().signal,
    );
    expect(result.commit).toBe("b".repeat(40));
  },
);

it("does not interpret project content as description metadata", () => {
  expect(
    entityFromEvent(event(30621, [["d", "project"]], "ignored"))?.description,
  ).toBe("");
});
