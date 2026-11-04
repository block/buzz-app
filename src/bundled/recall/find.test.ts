// biome-ignore-all lint/style/noNonNullAssertion: Fixtures deliberately require their arranged calls, elements and results to exist.
import { describe, expect, it } from "vitest";
import {
  find,
  keywords,
  LIMIT,
  mayFlow,
  merge,
  ownerOnly,
  scoreMemories,
} from "./find.ts";
import {
  DEFAULT_SETTINGS,
  type AudienceFacts,
  type Candidate,
  type ReadFilter,
  type Settings,
} from "./types.ts";
import { AGENT, CHANNEL, message, OWNER, turn } from "./fake.ts";

const open: AudienceFacts = {
  visibility: "open",
  members: [],
  complete: false,
};
const priv = (members: string[], complete = true): AudienceFacts => ({
  visibility: "private",
  members,
  complete,
});
const dm = (members: string[]): AudienceFacts => ({
  visibility: "dm",
  members,
  complete: true,
});
const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  ...over,
});
const memory = (slug: string, body: string) => ({
  slug,
  body,
  createdAt: 1_700_000_000,
});
const candidate = (id: string, text = id): Candidate => ({
  id,
  kind: "message",
  text,
  at: 0,
});

describe("mayFlow: everyone who can read T could already read S", () => {
  it.each([
    ["S = T, facts unknown", "t", undefined, undefined, true],
    ["S unknown", "s", undefined, open, false],
    ["T unknown", "s", open, undefined, false],
    ["S open → T open", "s", open, open, true],
    ["S open → T private", "s", open, priv(["x"]), true],
    [
      "S private → T open, even with T's few listed members",
      "s",
      priv(["x", "y"]),
      { ...open, members: ["x"] },
      false,
    ],
    ["S private → T private, T ⊆ S", "s", priv(["x", "y"]), priv(["x"]), true],
    [
      "S private → T private, T = S",
      "s",
      priv(["x", "y"]),
      priv(["y", "x"]),
      true,
    ],
    ["S private → T private, T ⊄ S", "s", priv(["x"]), priv(["x", "z"]), false],
    ["S dm → T dm, T ⊆ S", "s", dm(["x", "y"]), dm(["x", "y"]), true],
    ["S private incomplete", "s", priv(["x", "y"], false), priv(["x"]), false],
    ["T private incomplete", "s", priv(["x", "y"]), priv(["x"], false), false],
  ] as const)("%s", (_, s, source, target, allowed) => {
    expect(mayFlow(s, "t", source, target)).toBe(allowed);
  });
});

describe("ownerOnly", () => {
  it.each([
    ["owner and agent, private", priv([OWNER, AGENT]), true],
    ["owner and agent, dm", dm([OWNER, AGENT]), true],
    ["owner alone", dm([OWNER]), true],
    [
      "open with only two listed members",
      { ...open, members: [OWNER, AGENT], complete: true },
      false,
    ],
    ["someone else is there", priv([OWNER, AGENT, "x"]), false],
    ["incomplete listing", priv([OWNER, AGENT], false), false],
    ["unknown facts", undefined, false],
  ] as const)("%s", (_, facts, expected) => {
    expect(ownerOnly(facts, OWNER, AGENT)).toBe(expected);
  });

  it("is false when the owner is unknown", () => {
    expect(ownerOnly(priv([AGENT]), "", AGENT)).toBe(false);
  });
});

describe("keywords", () => {
  it("keeps salient words, lowercased, unique, in order", () => {
    expect(keywords("What is the Cedar launch code? The cedar CODE!")).toEqual([
      "cedar",
      "launch",
      "code",
    ]);
  });
  it("keeps letters and digits from any script", () => {
    expect(keywords("café 東京 v2 x")).toEqual(["café", "東京", "v2"]);
  });
  it("keeps at most 32", () => {
    expect(
      keywords(Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")),
    ).toHaveLength(32);
  });
});

describe("scoreMemories", () => {
  it("ranks matching lines by BM25 and drops the rest", () => {
    const listing = {
      entries: [
        memory("mem/notes", "cedar launch is friday\nlunch at noon\n\ncedar"),
      ],
      partial: false,
    };
    const hits = scoreMemories(listing, ["cedar", "launch"]);
    expect(hits.map((c) => c.id)).toEqual(["mem/notes#0", "mem/notes#3"]);
    expect(hits[0]).toMatchObject({
      kind: "memory",
      text: "cedar launch is friday",
      at: 1_700_000_000,
    });
  });
  it("prefers the rarer word", () => {
    const listing = {
      entries: [memory("mem/m", "common rare\ncommon\ncommon\ncommon x")],
      partial: false,
    };
    expect(scoreMemories(listing, ["common", "rare"])[0]!.id).toBe("mem/m#0");
  });
});

describe("merge", () => {
  it("fuses ranks so an item high in both lists wins", () => {
    const merged = merge([
      [candidate("a"), candidate("b")],
      [candidate("b"), candidate("c")],
    ]);
    expect(merged.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });
  it("drops repeated text, keeping the better ranked copy", () => {
    expect(
      merge([
        [candidate("a", "same"), candidate("b", "same"), candidate("c")],
      ]).map((c) => c.id),
    ).toEqual(["a", "c"]);
  });
});

describe("find", () => {
  it("recalls nothing for a turn with no salient words, without reading", async () => {
    let reads = 0;
    const t = turn(
      { text: "what is it?" },
      {
        events: async () => {
          reads++;
          return [];
        },
        channel: async () => {
          reads++;
          return undefined;
        },
      },
    );
    expect(await find(t, settings())).toEqual([]);
    expect(reads).toBe(0);
  });

  it("searches this channel only, by default", async () => {
    const filters: ReadFilter[] = [];
    const t = turn(
      { text: "cedar launch" },
      {
        events: async (f) => {
          filters.push(f);
          return [];
        },
      },
    );
    await find(t, settings());
    expect(filters).toEqual([
      { kinds: [9], search: "cedar OR launch", "#h": [CHANNEL], limit: 40 },
    ]);
  });

  it("searches every readable channel when the owner chooses relay", async () => {
    const filters: ReadFilter[] = [];
    const t = turn(
      { text: "cedar" },
      {
        events: async (f) => {
          filters.push(f);
          return [];
        },
      },
    );
    await find(t, settings({ scope: "relay" }));
    expect(filters[0]).not.toHaveProperty("#h");
  });

  it("keeps hits the audience may see and drops the rest", async () => {
    const facts: Record<string, AudienceFacts> = {
      [CHANNEL]: priv([OWNER, AGENT, "x"]),
      wide: open,
      wider: priv([OWNER, AGENT, "x", "y"]),
      narrow: priv([OWNER, AGENT]),
    };
    const hits = [
      message("here", "cedar here"),
      message("wide", "cedar wide", { tags: [["h", "wide"]] }),
      message("wider", "cedar wider", { tags: [["h", "wider"]] }),
      message("narrow", "cedar narrow", { tags: [["h", "narrow"]] }),
      message("nowhere", "cedar nowhere", { tags: [] }),
      message("ambiguous", "cedar ambiguous", {
        tags: [
          ["h", CHANNEL],
          ["h", "narrow"],
        ],
      }),
      message("unknown", "cedar unknown", { tags: [["h", "gone"]] }),
    ];
    const t = turn(
      { text: "cedar" },
      { events: async () => hits, channel: async (id) => facts[id] },
    );
    const found = await find(t, settings({ scope: "relay" }));
    expect(found.map((c) => c.id)).toEqual(["here", "wide", "wider"]);
    expect(found[0]).toMatchObject({
      kind: "message",
      text: "cedar here",
      channel: CHANNEL,
      author: "b".repeat(64),
    });
  });

  it("keeps only this channel's hits when this channel's audience is unknown", async () => {
    const hits = [
      message("here", "cedar here"),
      message("wide", "cedar wide", { tags: [["h", "wide"]] }),
    ];
    const t = turn(
      { text: "cedar" },
      {
        events: async () => hits,
        channel: async (id) => (id === "wide" ? open : undefined),
      },
    );
    expect(
      (await find(t, settings({ scope: "relay" }))).map((c) => c.id),
    ).toEqual(["here"]);
  });

  it("drops the triggering message", async () => {
    const t = turn(
      { text: "cedar", event: "me" },
      { events: async () => [message("me", "cedar"), message("x", "cedar x")] },
    );
    expect((await find(t, settings())).map((c) => c.id)).toEqual(["x"]);
  });

  it(`keeps at most ${LIMIT}`, async () => {
    const hits = Array.from({ length: 40 }, (_, i) =>
      message(`m${i}`, `cedar ${i}`),
    );
    const t = turn({ text: "cedar" }, { events: async () => hits });
    expect(await find(t, settings())).toHaveLength(LIMIT);
  });

  describe("memories", () => {
    const listing = {
      entries: [memory("mem/plan", "cedar ships friday")],
      partial: false,
    };
    const withFacts = (facts: AudienceFacts | undefined) => {
      let read = false;
      const t = turn(
        { text: "cedar" },
        {
          channel: async () => facts,
          memories: async () => {
            read = true;
            return listing;
          },
        },
      );
      return { t, read: () => read };
    };

    it("are recalled in a chat only the owner and agent can read", async () => {
      const { t } = withFacts(dm([OWNER, AGENT]));
      expect((await find(t, settings())).map((c) => c.id)).toEqual([
        "mem/plan#0",
      ]);
    });

    it.each([
      ["open", { ...open, members: [OWNER, AGENT], complete: true }],
      ["shared", priv([OWNER, AGENT, "x"])],
      ["unknown", undefined],
    ] as const)("are not even read in an %s channel", async (_, facts) => {
      const { t, read } = withFacts(facts);
      expect(await find(t, settings())).toEqual([]);
      expect(read()).toBe(false);
    });

    it("are recalled anywhere once the owner opts in", async () => {
      const { t } = withFacts(open);
      expect(
        (await find(t, settings({ sharedMemories: true }))).map((c) => c.id),
      ).toEqual(["mem/plan#0"]);
    });
  });
});
