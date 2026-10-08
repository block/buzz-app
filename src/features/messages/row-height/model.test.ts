import { describe, expect, it, vi } from "vitest";
import type { Contribution } from "../../../plugins/contributions";
import type { InlineRenderer } from "../../conversation/contracts";
import { profileTarget } from "../../profiles/target";
import type { ChannelMessage } from "../../relay/contracts";
import { emojiMatches } from "../../relay/emoji";
import {
  createRowHeights,
  type Context,
  type Measurer,
  type Metrics,
  type TextReason,
} from "./model";
import { placements } from "./placement";
import { type Inputs, prose } from "./prose";

const row = (
  content: string,
  extra: Partial<ChannelMessage> = {},
): ChannelMessage => ({
  id: content.slice(0, 12) || "empty",
  channelId: "channel",
  authorId: "alice",
  content,
  createdAt: 1_700_000_000,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
  ...extra,
});
const none: Inputs = {
  messages: [],
  inline: [],
  links: [],
  profiles: new Map(),
  channels: [],
  agents: [],
  resolveName: (_, fallback) => fallback,
};
/** Paragraphs of `<br>` segments of body text. */
const body = (...paragraphs: string[][]) =>
  paragraphs.map((segments) =>
    segments.map((text) => [{ text, style: "body" }]),
  );

describe("placements", () => {
  it("shares the renderer's day dividers and author grouping", () => {
    const at = (seconds: number, authorId = "alice") =>
      row(`m${seconds}`, { id: `m${seconds}`, createdAt: seconds, authorId });
    const day = 86_400 * 19_700;
    expect(
      placements([
        at(day + 10),
        at(day + 20),
        at(day + 400), // more than five minutes later
        at(day + 410, "bob"),
        at(day + 86_400), // the next local day
        at(day + 86_410),
      ]),
    ).toEqual([
      { day: true, layout: "timeline" },
      { day: false, layout: "continuation" },
      { day: false, layout: "timeline" },
      { day: false, layout: "timeline" },
      { day: true, layout: "timeline" },
      { day: false, layout: "continuation" },
    ]);
  });
});

describe("prose", () => {
  it("returns paragraphs of break-separated text nodes exactly as rendered", () => {
    expect(
      prose(
        row("First line\nsecond line \\*\n\nNext   paragraph &amp; more"),
        none,
      ),
    ).toEqual(
      body(["First line", "second line *"], ["Next   paragraph & more"]),
    );
    expect(
      prose(
        row("First line\nsecond *line*\\*\n\n**Next ~~para~~** __*graph*__"),
        none,
      ),
    ).toEqual([
      [
        [{ text: "First line", style: "body" }],
        [
          { text: "second ", style: "body" },
          { text: "line", style: "italic" },
          { text: "*", style: "body" },
        ],
      ],
      [
        [
          { text: "Next ", style: "bold" },
          { text: "para", style: "bold" },
          { text: " ", style: "body" },
          { text: "graph", style: "bold-italic" },
        ],
      ],
    ]);
  });

  it.each([
    ["membership", { membership: { type: "join" } as never }],
    ["diff", { diff: { truncated: false } }],
    [
      "attachments",
      { attachments: [{ url: "https://x.test/a.png" } as never] },
    ],
    ["reactions", { reactions: [{ content: "+" } as never] }],
    ["thread", { replyCount: 2 }],
    ["sent-from-thread", { sentFromThread: { rootId: "root" } }],
    ["workflow", { workflowOwnerId: "owner" }],
    ["delivery", { delivery: "sending" as const }],
  ])("leaves %s rows to measurement", (reason, extra) => {
    expect(prose(row("Plain words", extra), none)).toBe(reason);
  });

  it.each([
    ["characters", "tab\tseparated"],
    ["characters", "soft\u00adhyphen"],
    ["spoiler", "a ||secret|| b"],
    ["entity", "a&#64;b"],
    ["link", "[label]\\(https://example.com)"],
    ["time-reply", "[1:05] at that moment"],
    ["large-emoji", "🎉 🎉"],
    ["nested-strong", "**bold __bolder__** words"],
    ["markdown", "- a list"],
    ["markdown", "`code`"],
    ["markdown", "![alt](https://example.com/a.png)"],
    ["empty", ""],
    ["empty", "a  \n\\\nb"],
  ])("leaves %s content to measurement: %s", (reason, content) => {
    expect(prose(row(content), none)).toBe(reason);
  });

  it("leaves message and inline renderer matches to their plugins", () => {
    const matches = vi.fn(() => [{ start: 0, end: 4 }]);
    const inline = [
      { matches } as unknown as Contribution<InlineRenderer>,
    ] as const;
    const target = row("Fancy words\nmore");
    expect(prose(target, { ...none, inline })).toBe("inline-renderer");
    expect(matches).toHaveBeenCalledWith({
      text: "Fancy words",
      message: target,
    });
    expect(
      prose(target, { ...none, messages: [{ matches: () => true } as never] }),
    ).toBe("message-renderer");
    expect(
      prose(target, {
        ...none,
        messages: [
          {
            matches: () => {
              throw new Error("broken");
            },
          } as never,
        ],
      }),
    ).toEqual(body(["Fancy words", "more"]));
  });
});

describe("prose: mentions, links, channel references and custom emoji", () => {
  const bob = "b".repeat(64);
  const people: Inputs = {
    ...none,
    profiles: new Map([[bob, { name: "Bob" }]]),
    canOpenLink: () => true,
    resolveName: (key, fallback) => (key === bob ? "Bob B" : fallback),
  };
  const text = (value: string, style = "body") => ({ text: value, style });
  const box = (value: string, kind: string, style = "body") => ({
    text: value,
    style,
    box: kind,
  });
  const mentioned = (content: string, extra: Partial<ChannelMessage> = {}) =>
    row(content, { mentions: [bob], ...extra });

  it("renders a mention as renderProfile does: button, agent span or text", () => {
    expect(prose(mentioned("Hi @Bob, see"), people)).toEqual([
      [[text("Hi "), box("Bob B", "person"), text(", see")]],
    ]);
    const agents = [{ pubkey: bob, name: "Bob" }] as Inputs["agents"];
    expect(prose(mentioned("**@Bob** ok"), { ...people, agents })).toEqual([
      [[box("Bob B", "agent", "bold"), text(" ok")]],
    ]);
    // An agent the reader cannot open is a span, left to measurement: WebKit
    // narrows a line that breaks inside it.
    expect(
      prose(mentioned("Hi @Bob"), {
        ...people,
        agents,
        canOpenLink: () => false,
      }),
    ).toBe("mentions");
    // A person the reader cannot open, or an edited body: plain text.
    expect(
      prose(mentioned("Hi @Bob"), { ...people, canOpenLink: undefined }),
    ).toEqual([[[text("Hi "), text("@Bob")]]]);
    expect(prose(mentioned("Hi @Bob", { edited: true }), people)).toEqual([
      [[text("Hi @Bob")]],
    ]);
    // Beside a removed attachment a name binds; across its seam it is text.
    expect(
      prose(mentioned("Hi @Bob", { attachmentSeams: [3] }), people),
    ).toEqual([[[text("Hi "), box("Bob B", "person")]]]);
    expect(
      prose(mentioned("Hi @Bob", { attachmentSeams: [5] }), people),
    ).toEqual([[[text("Hi @Bob")]]]);
    // An openable profile link is a mention; another is left to measurement.
    const link = `[@Bob](${profileTarget(bob)})`;
    expect(prose(row(`see ${link}`), people)).toEqual([
      [[text("see "), box("Bob B", "person")]],
    ]);
    expect(
      prose(row(`see ${link}`), { ...people, canOpenLink: () => false }),
    ).toBe("mentions");
  });

  it("puts every link and channel reference in a chip of the known renderers", () => {
    const url = "https://example.com/notes";
    expect(prose(row(`Read ${url}. Then [docs](${url}) too`), none)).toEqual([
      [
        [
          text("Read "),
          box(url, "chip"),
          text(". Then "),
          box(url, "chip"),
          text(" too"),
        ],
      ],
    ]);
    const channels = [
      { id: "c1", name: "general", channelType: "stream" },
    ] as unknown as Inputs["channels"];
    expect(
      prose(row("see #general, then #other"), { ...none, channels }),
    ).toEqual([
      [[text("see "), box("buzz://channel/c1", "chip"), text(", then #other")]],
    ]);
    const renderer = (key: string, revision: string) =>
      ({ key, revision, matches: () => true }) as never;
    expect(
      prose(row(`Read ${url}`), {
        ...none,
        links: [renderer("buzz.links/links", "bundled")],
      }),
    ).toEqual([[[text("Read "), box(url, "chip")]]]);
    for (const other of [
      renderer("buzz.links/links", "1.0.0"),
      renderer("acme.links/links", "bundled"),
    ])
      expect(prose(row(`Read ${url}`), { ...none, links: [other] })).toBe(
        "link-renderer",
      );
    // A chip is one line of text: a label with a line break (soft or hard)
    // or other content is left to measurement.
    expect(prose(row(`[**docs** ~~old~~](${url}) ok`), none)).toEqual([
      [[box(url, "chip"), text(" ok")]],
    ]);
    for (const label of ["a\nb", "a\\\nb", "a  \nb", "the `flag`"])
      expect(prose(row(`see [${label}](${url})`), none)).toBe("link");
    // Credential-free HTTP is a chip like HTTPS; a refused destination
    // renders its text as it is (no chip, no channel).
    expect(prose(row("see http://example.com now"), none)).toEqual([
      [[text("see "), box("http://example.com/", "chip"), text(" now")]],
    ]);
    const refused = "https://user:secret@example.com";
    expect(prose(row(`see ${refused} now`), none)).toEqual([
      [[text("see "), text(refused), text(" now")]],
    ]);
    expect(
      prose(row("see [#general](ftp://example.com) now"), {
        ...none,
        channels,
      }),
    ).toEqual([[[text("see "), text("#general"), text(" now")]]]);
  });

  it("knows the bundled custom emoji renderer's box and no other renderer", () => {
    const party = { shortcode: "party", url: "https://emoji.test/p.png" };
    const renderer = (revision: string) =>
      ({
        key: "buzz.emoji/custom",
        revision,
        matches: ({
          text: value,
          message,
        }: {
          text: string;
          message: ChannelMessage;
        }) => [...emojiMatches(value, message.emoji ?? [])],
      }) as never;
    const target = row("Ship :party: now :nope:", { emoji: [party] });
    expect(prose(target, { ...none, inline: [renderer("bundled")] })).toEqual([
      [[text("Ship "), box("", "emoji"), text(" now :nope:")]],
    ]);
    expect(prose(target, { ...none, inline: [renderer("2")] })).toBe(
      "inline-renderer",
    );
  });
});

const metrics = (epoch = 1): Metrics => ({
  epoch,
  pitch: 19.984375,
  gap: 12,
  day: 52,
  single: { timeline: 60, continuation: 24 },
  chrome: { timeline: 20.03125, continuation: 4.03125 },
  inset: 52,
  bylineGap: 8,
  text: {
    body: { font: "normal 400 14px Inter", letterSpacing: 0 },
    bold: { font: "normal 600 14px Inter", letterSpacing: 0 },
    italic: { font: "italic 400 14px Inter", letterSpacing: 0 },
    "bold-italic": { font: "italic 600 14px Inter", letterSpacing: 0 },
  },
  name: { font: "500 14px Inter", letterSpacing: -0.035 },
  time: { font: "400 12px Inter", letterSpacing: 0.16 },
  times: ["2:34 PM", "Yesterday at 10:58 PM"],
  kana: 0,
});
/** Ten pixels per character; a word never splits. */
function fakeMeasurer() {
  const pending = new Set<string>();
  const measurer = {
    prepare: vi.fn(
      (
        runs: readonly { text: string }[],
      ): { text: string } | TextReason | undefined => {
        const text = runs.map((run) => run.text).join("");
        return pending.has(text) ? undefined : { text };
      },
    ),
    lines: vi.fn((prepared: object, width: number): number | TextReason => {
      const { text } = prepared as { text: string };
      let lines = 1;
      let used = 0;
      for (const word of text.split(" ")) {
        const advance = (used ? 1 : 0) + word.length;
        if (used && (used + advance) * 10 > width) {
          lines++;
          used = word.length;
        } else used += advance;
      }
      return text ? lines : 0;
    }),
    width: vi.fn((text: string) =>
      pending.has(text) ? undefined : text.length * 10,
    ),
  } satisfies Measurer;
  return { measurer, pending };
}
const context = (overrides: Partial<Context> = {}): Context => ({
  metrics: metrics(),
  width: 300,
  inputs: none,
  name: () => "Alice",
  fonts: 0,
  ...overrides,
});
const timeline = { day: false, layout: "timeline" } as const;
const continuation = { day: false, layout: "continuation" } as const;

describe("createRowHeights", () => {
  it("adds placement chrome to the cached text's lines on every call", () => {
    const { measurer } = fakeMeasurer();
    const heights = createRowHeights(measurer);
    const one = row("short");
    const three = row(
      "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp",
    );
    const two = row("one\n\ntwo");
    const c = context();
    expect(heights.predict(one, timeline, c)).toBe(60);
    expect(heights.predict(one, { day: true, layout: "continuation" }, c)).toBe(
      52 + 24,
    );
    expect(heights.predict(three, continuation, c)).toBe(
      4.03125 + 3 * 19.984375,
    );
    // The boundary row of a prepend loses its divider and header: same text.
    expect(heights.predict(three, { day: true, layout: "timeline" }, c)).toBe(
      52 + 20.03125 + 3 * 19.984375,
    );
    expect(heights.predict(two, timeline, c)).toBe(
      20.03125 + 2 * 19.984375 + 12,
    );
    // Once per segment: one each, and one per paragraph of `two`.
    expect(measurer.prepare).toHaveBeenCalledTimes(4);
  });

  it("parses and prepares once per row and font epoch; width only lays out again", () => {
    const { measurer } = fakeMeasurer();
    const heights = createRowHeights(measurer);
    const target = row("aaaa bbbb cccc dddd eeee ffff gggg hhhh");
    expect(heights.predict(target, continuation, context())).toBe(
      4.03125 + 2 * 19.984375,
    );
    expect(heights.predict(target, continuation, context({ width: 100 }))).toBe(
      4.03125 + 4 * 19.984375,
    );
    expect(heights.predict(target, continuation, context({ width: 100 }))).toBe(
      4.03125 + 4 * 19.984375,
    );
    expect(measurer.prepare).toHaveBeenCalledTimes(1);
    expect(measurer.lines).toHaveBeenCalledTimes(2);
    heights.predict(target, continuation, context({ metrics: metrics(2) }));
    expect(measurer.prepare).toHaveBeenCalledTimes(2);
    // A new row object is new content: its text is parsed again.
    heights.predict({ ...target }, continuation, context());
    expect(measurer.prepare).toHaveBeenCalledTimes(3);
  });

  it("caches reasons until a renderer registry changes", () => {
    const { measurer } = fakeMeasurer();
    const heights = createRowHeights(measurer);
    const target = row("Fancy words");
    const inline = [
      { matches: () => [{ start: 0, end: 5 }] } as never,
    ] as Inputs["inline"];
    const fancy = context({ inputs: { ...none, inline } });
    expect(heights.predict(target, continuation, fancy)).toBe(
      "inline-renderer",
    );
    expect(heights.predict(target, continuation, fancy, false)).toBe(
      "inline-renderer",
    );
    expect(heights.predict(target, continuation, context())).toBe(24);
  });

  it("without compute, a row that needs parsing or preparing is a budget miss", () => {
    const { measurer } = fakeMeasurer();
    const heights = createRowHeights(measurer);
    const target = row("short");
    expect(heights.predict(target, continuation, context(), false)).toBe(
      "budget",
    );
    expect(heights.predict(target, continuation, context())).toBe(24);
    expect(heights.predict(target, continuation, context(), false)).toBe(24);
    expect(
      heights.predict(
        target,
        continuation,
        context({ metrics: metrics(2) }),
        false,
      ),
    ).toBe("budget");
    // Layout at another width is cheap and needs no compute.
    expect(
      heights.predict(target, continuation, context({ width: 300 }), false),
    ).toBe(24);
  });

  it("waits for a font, then retries when the font version changes", () => {
    const { measurer, pending } = fakeMeasurer();
    const heights = createRowHeights(measurer);
    const target = row("Привет мир");
    pending.add("Привет мир");
    expect(heights.predict(target, continuation, context())).toBe("font");
    expect(heights.predict(target, continuation, context())).toBe("font");
    // The font is the reason whether or not this pass may compute.
    expect(heights.predict(target, continuation, context(), false)).toBe(
      "font",
    );
    expect(measurer.prepare).toHaveBeenCalledTimes(1);
    pending.clear();
    expect(heights.predict(target, continuation, context({ fonts: 1 }))).toBe(
      24,
    );
  });

  it("keeps prepared text for the newest rows only; older rows keep their height", () => {
    const { measurer } = fakeMeasurer();
    const heights = createRowHeights(measurer);
    // Four rows of 99,000 characters exceed the 300,000 retained.
    const rows = ["a", "b", "c", "d"].map((letter) =>
      row(`${letter.repeat(9)} `.repeat(9_900).trim(), { id: letter }),
    );
    const [oldest, , , newest] = rows;
    if (!oldest || !newest) throw new Error("rows");
    const sizes = rows.map((target) =>
      heights.predict(target, continuation, context()),
    );
    expect(measurer.prepare).toHaveBeenCalledTimes(4);
    // Same width: every height stays known without preparing again.
    expect(
      rows.map((target) =>
        heights.predict(target, continuation, context(), false),
      ),
    ).toEqual(sizes);
    // Another width: only retained text lays out again without compute.
    const narrow = context({ width: 200 });
    expect(heights.predict(newest, continuation, narrow, false)).toBeTypeOf(
      "number",
    );
    expect(heights.predict(oldest, continuation, narrow, false)).toBe("budget");
    expect(heights.predict(oldest, continuation, narrow)).toBeTypeOf("number");
    expect(measurer.prepare).toHaveBeenCalledTimes(5);
  });

  it("leaves text the measurer cannot lay out exactly to measurement", () => {
    const { measurer } = fakeMeasurer();
    measurer.prepare.mockImplementation((runs) =>
      runs[0]?.text.startsWith("こんにちは")
        ? "kana"
        : { text: runs[0]?.text ?? "" },
    );
    const heights = createRowHeights(measurer);
    const target = row("plain\nこんにちは 世界");
    expect(heights.predict(target, continuation, context())).toBe("kana");
    expect(heights.predict(target, continuation, context(), false)).toBe(
      "kana",
    );
    expect(measurer.prepare).toHaveBeenCalledTimes(2);
  });

  it("leaves a line count the measurer cannot be sure of to measurement", () => {
    const { measurer } = fakeMeasurer();
    measurer.lines.mockImplementation((prepared) =>
      (prepared as { text: string }).text.startsWith("مرحبا") ? "edge" : 1,
    );
    const heights = createRowHeights(measurer);
    expect(
      heights.predict(row("plain\nمرحبا بالعالم"), continuation, context()),
    ).toBe("edge");
    expect(heights.predict(row("plain"), continuation, context())).toBe(24);
  });

  it("requires a timeline byline to fit beside the widest time label", () => {
    const { measurer, pending } = fakeMeasurer();
    const heights = createRowHeights(measurer);
    const target = row("short");
    // "Yesterday at 10:58 PM" is 210px; with the name, gap and slack: 269.
    expect(heights.predict(target, timeline, context({ width: 268 }))).toBe(
      "byline",
    );
    expect(heights.predict(target, timeline, context({ width: 269 }))).toBe(60);
    expect(
      heights.predict(
        target,
        timeline,
        context({ width: 269, name: () => "Alice Longer" }),
        false,
      ),
    ).toBe("budget");
    expect(heights.predict(target, continuation, context({ width: 100 }))).toBe(
      24,
    );
    pending.add("Pending");
    expect(
      heights.predict(target, timeline, context({ name: () => "Pending" })),
    ).toBe("font");
  });

  it("bounds byline times by the widest digit, which proportional digits vary", () => {
    const { measurer } = fakeMeasurer();
    measurer.width.mockImplementation((text: string) =>
      Array.from(text).reduce((sum, char) => sum + (char === "8" ? 14 : 10), 0),
    );
    const heights = createRowHeights(measurer);
    const target = row("short");
    const c = (width: number) =>
      context({ width, metrics: { ...metrics(), times: ["1:11 PM"] } });
    // "8:88 PM" is 82px; with "Alice", the gap and slack: 141.
    expect(heights.predict(target, timeline, c(140))).toBe("byline");
    expect(heights.predict(target, timeline, c(141))).toBe(60);
  });

  it("measures boxes with their calibrated widths; a chip must not change the line count", () => {
    const measurer = {
      prepare: vi.fn((runs: readonly { text: string; box?: number }[]) => ({
        width: runs.reduce(
          (sum, { text, box }) => sum + text.length * 10 + (box ?? 0),
          0,
        ),
      })),
      lines: vi.fn((prepared: object, width: number) =>
        Math.ceil((prepared as { width: number }).width / width),
      ),
      width: vi.fn((value: string) => value.length * 10),
    } satisfies Measurer;
    const heights = createRowHeights(measurer);
    const boxes = { person: 14, agent: 17, emoji: 22, chip: 392 };
    const c = (width: number, overrides: Partial<Metrics> = {}) =>
      context({ width, metrics: { ...metrics(), boxes, ...overrides } });
    const bob = "b".repeat(64);
    const inputs = {
      ...none,
      profiles: new Map([[bob, { name: "Bob" }]]),
      canOpenLink: () => true,
    };
    const mention = row("Hi @Bob", { mentions: [bob] });
    expect(heights.predict(mention, continuation, { ...c(300), inputs })).toBe(
      24,
    );
    expect(measurer.prepare).toHaveBeenLastCalledWith([
      expect.objectContaining({ text: "Hi " }),
      expect.objectContaining({ text: "Bob", box: 14 }),
    ]);
    // "Read " is 50px: with the chip at none or its 392px cap, one line at
    // 500px, but one or two at 300px.
    const link = row("Read https://example.com/a");
    expect(heights.predict(link, continuation, c(500))).toBe(24);
    expect(measurer.prepare).toHaveBeenCalledTimes(3);
    expect(
      measurer.prepare.mock.calls.slice(1).map(([runs]) => runs[1]?.box),
    ).toEqual([0, 392]);
    expect(heights.predict(link, continuation, c(300))).toBe("link-width");
    // Not calibrated, or a line holding boxes grew: left to measurement.
    expect(
      heights.predict(
        row("Read https://example.com/b"),
        continuation,
        c(500, { boxes: undefined }),
      ),
    ).toBe("boxes");
  });

  it("describes a row again when inputs it reads change, keeping unchanged text prepared", () => {
    const { measurer } = fakeMeasurer();
    const heights = createRowHeights(measurer);
    const bob = "b".repeat(64);
    const inputs = (name: string): Inputs => ({
      ...none,
      profiles: new Map([[bob, { name: "Bob" }]]),
      canOpenLink: () => true,
      resolveName: () => name,
    });
    const boxes = { person: 0, agent: 0, chip: 0 };
    const c = (value: Inputs) =>
      context({ inputs: value, metrics: { ...metrics(), boxes } });
    const plain = row("short words");
    const mention = row("Hi @Bob", { mentions: [bob] });
    for (const target of [plain, mention])
      heights.predict(target, continuation, c(inputs("Bob")));
    expect(measurer.prepare).toHaveBeenCalledTimes(2);
    // New inputs with the same presentation: nothing prepares again.
    for (const target of [plain, mention])
      heights.predict(target, continuation, c(inputs("Bob")));
    expect(measurer.prepare).toHaveBeenCalledTimes(2);
    // A new label for the mention prepares that row only.
    for (const target of [plain, mention])
      heights.predict(target, continuation, c(inputs("Robert")));
    expect(measurer.prepare).toHaveBeenCalledTimes(3);
    expect(measurer.prepare).toHaveBeenLastCalledWith([
      expect.objectContaining({ text: "Hi " }),
      expect.objectContaining({ text: "Robert", box: 0 }),
    ]);
  });

  it("estimates rows left to measurement from their lines, blocks and strips", () => {
    const heights = createRowHeights(fakeMeasurer().measurer);
    // Ten pixels per character: 30 characters a line at width 300.
    const c = context();
    const estimate = (content: string, extra: Partial<ChannelMessage> = {}) =>
      heights.estimate(row(content, extra), continuation, c);
    const lines = (count: number, gaps = 0) =>
      4.03125 + count * 19.984375 + gaps * 12;
    expect(estimate("short")).toBe(24);
    expect(heights.estimate(row("short"), { ...timeline, day: true }, c)).toBe(
      52 + 60,
    );
    // Wrapped by length, then a gap between paragraphs.
    expect(estimate(`${"x".repeat(65)}\n\nnext`)).toBe(lines(4, 1));
    // A list after a paragraph is a second block; ordered items one list.
    expect(estimate("Plan:\n- one\n- two\n- three")).toBe(lines(4, 1));
    expect(estimate("1. one\n2. two\n3. three")).toBe(lines(3));
    expect(estimate("# Title\n## Subtitle")).toBe(lines(2, 1));
    expect(estimate("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(lines(3));
    // Quotes and code add padding and inner margins; code lines never wrap.
    expect(estimate("> quoted\n\nreply")).toBe(lines(2, 1 + 2));
    expect(estimate(`Try:\n\`\`\`\n${"y".repeat(65)}\n\`\`\`\ndone`)).toBe(
      lines(3, 2 + 2),
    );
    // Strips below the text: reactions, a thread summary, attachments (the
    // first image or video as its fallback tile).
    expect(
      estimate("short", {
        reactions: [{} as never],
        replyCount: 2,
        attachments: [
          { kind: "image" } as never,
          { kind: "video" } as never,
          { kind: "file" } as never,
        ],
      }),
    ).toBeCloseTo(lines(1) + 3 * (19.984375 + 12) + (300 * 8) / 9, 9);
  });
});
