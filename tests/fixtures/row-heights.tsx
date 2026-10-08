// The real ChannelTimeline and fonts, the bundled links and emoji plugins,
// folded events and no relay: the row height model against the browser's own
// layout (row-heights*.spec.mjs).
// URL: ?corpus=static|complex|paging|arrivals &width=<css px> &height=<css px> &scale=<text scale>
//   &rows=<complex rows, default 300>
//   &initial=<rows> (rows in the window when it opens: arrivals 0, paging 40,
//   else all; older rows page in 20 at a time)
//   &target=<initial window index> (an inline target reveal)
//   &hold=cyrillic (that Inter subset is not preloaded; the test holds it)
//   &pretext=lazy (neither Pretext nor fonts.ready awaited; the test holds it)
import "../../src/shared/styles/globals.css";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import { Context } from "@deepseek-ai/cordis";
import { getPublicKey } from "nostr-tools";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import * as emojiPlugin from "../../src/bundled/emoji";
import * as linksPlugin from "../../src/bundled/links";
import { ConversationService } from "../../src/features/conversation/service";
import { ChannelTimeline } from "../../src/features/messages/ChannelTimeline";
import { profileTarget } from "../../src/features/profiles/target";
import type { ChannelWindow } from "../../src/features/relay/contracts";
import { foldMessages } from "../../src/features/relay/fold";
import { createRelaySession } from "../../src/features/relay/session";
import { type Key, message, signed } from "../../src/features/relay/testing";
import { PluginRuntime } from "../../src/plugins/runtime";
import { ToastProvider } from "../../src/shared/design-system/ui/Toast";
import { complexCorpus } from "./complex-corpus.mjs";

const params = new URLSearchParams(location.search);
const corpus = params.get("corpus") ?? "static";
// The appearance service's text scale, written before anything renders.
document.documentElement.style.setProperty(
  "--buzz-text-scale",
  params.get("scale") ?? "1",
);
// Stable keys: byline names are pubkey prefixes, whose width must not vary.
const key = (seed: number): Key => {
  const secret = new Uint8Array(32).fill(seed);
  return { secret, pubkey: getPublicKey(secret) };
};
const relay = key(1);
const viewer = key(2);
const authors = [key(3), key(4), key(5)];
const channelId = "heights";
// Mentioned identities (never authors, so bylines keep their widths): a
// person and two agents, one of which the reader cannot open (a span).
const [alice, bot, helper, long] = [key(6), key(7), key(8), key(9)];
// Names in system fallback fonts, which grow their button's line, and an
// agent the reader cannot open with a name a line can break inside.
const [rocket, hindi, thai, arabic, notes] = [10, 11, 12, 13, 14].map(key);
const profiles = new Map([
  [alice.pubkey, { name: "Alice Chen" }],
  // Wider than a 480px timeline's text: it wraps inside its button there.
  [
    long.pubkey,
    { name: "Alexandria Montgomery Featherstonehaugh of the North Guild" },
  ],
  [rocket.pubkey, { name: "Ryan 🚀" }],
  [hindi.pubkey, { name: "अमित शर्मा" }],
  [thai.pubkey, { name: "สมชาย ใจดี" }],
  [arabic.pubkey, { name: "محمد علي" }],
  [bot.pubkey, { name: "Build Bot", isAgent: true }],
  [helper.pubkey, { name: "Helper Bot", isAgent: true }],
  [notes.pubkey, { name: "Release Notes Assistant", isAgent: true }],
]);
const agents = [
  { pubkey: bot.pubkey, name: "Build Bot" },
  { pubkey: helper.pubkey, name: "Helper Bot" },
  { pubkey: notes.pubkey, name: "Release Notes Assistant" },
];
const library = { definitions: [], identities: agents };
const closed = [helper, notes].map(({ pubkey }) => profileTarget(pubkey));
const canOpenLink = (target: string) => !closed.includes(target);
const channels = {
  status: "ready",
  channels: [
    { id: "general", name: "general", channelType: "stream" },
    { id: "design", name: "design", channelType: "stream" },
  ],
};
const hex = (digit: string) => digit.repeat(64);
// Custom emoji: served (the test routes emoji.test), failing (404) and
// refused by the media policy (not https).
const emoji = [
  ["emoji", "party", "https://emoji.test/party.png"],
  ["emoji", "broken", "https://emoji.test/missing.png"],
  ["emoji", "unsafe", "http://emoji.test/unsafe.png"],
];
const media = (url: string) => (url.startsWith("https://") ? url : undefined);
const mention = (...people: Key[]) => people.map(({ pubkey }) => ["p", pubkey]);
// The bundled links and emoji plugins, as shipped (revision "bundled").
const plugins = new Context();
const runtime = new PluginRuntime(plugins, async (plugin) =>
  plugin.manifest.id === "buzz.emoji" ? emojiPlugin : linksPlugin,
);
const conversation = new ConversationService(plugins);
runtime.reconcile(
  [
    ["buzz.links", "Links"],
    ["buzz.emoji", "Emoji"],
  ].map(([id, name]) => ({
    manifest: { id, name, apiVersion: 1 },
    enabled: true,
    source: "bundled",
    revision: "bundled",
    previous: null,
    reloadable: false,
    error: null,
  })) as never,
);

const words =
  "the quick brown fox jumps over a lazy dog while seven bright engineers review layout changes and measure every line twice before shipping".split(
    " ",
  );
const prose = (seed: number, count: number) =>
  Array.from(
    { length: count },
    (_, index) => words[(seed * 7 + index * 3) % words.length],
  ).join(" ");
/** Every shape the model claims (plain prose, strong, emphasis and
 * strikethrough, in the scripts the engines lay out like Pretext), plus rows
 * it must leave to measurement: a link, a reaction, and each reason below. */
const staticContent = [
  "Short.",
  "ok",
  prose(1, 12),
  prose(2, 40),
  prose(3, 90),
  prose(4, 160),
  prose(5, 260),
  `${prose(6, 30)}\n${prose(7, 8)}\n${prose(8, 50)}`,
  `${prose(9, 20)}\n\n${prose(10, 35)}\n\n${prose(11, 6)}`,
  "Line one\nLine two\nLine three\nLine four",
  `Unbroken ${"x".repeat(180)} token`,
  // Kerned pairs in a word overflow-wrap breaks: left to measurement (wrap).
  `Token ${"AV".repeat(120)} then more words follow it`,
  `Hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 and ${prose(12, 10)}`,
  "supercalifragilisticexpialidocious-antidisestablishmentarianism-pneumonoultramicroscopicsilicovolcanoconiosis",
  "“Curly quotes,” she said — ‘it’s fine’ … and so on, with an apostrophe’s worth of punctuation.",
  `Shipping today 🚀 with 🎉 for everyone 👩‍💻 and a flag 🇯🇵 ${prose(13, 18)}`,
  "これは日本語のテキストです これは長い文章を折り返して確認するためのものです 日本語の行分割は単語の境界がありません",
  "这是中文测试文本 用于检查换行是否与浏览器一致 中文没有空格分隔单词 所以每个字符都可以换行",
  "مرحبا بالعالم هذه رسالة طويلة مكتوبة باللغة العربية للتحقق من التفاف الأسطر في المتصفح والنموذج",
  "שלום עולם זוהי הודעה ארוכה בעברית כדי לבדוק את גלישת השורות בדפדפן ובמודל",
  "Привет мир это сообщение на русском языке для проверки переноса строк",
  "Γεια σου κόσμε αυτό είναι ένα μήνυμα στα ελληνικά για τον έλεγχο",
  "Tiếng Việt có dấu: đường phố Hà Nội rất đông đúc vào buổi sáng",
  "Café naïve façade résumé jalapeño Ångström Øresund Łódź",
  `${prose(14, 70)} ${prose(15, 70)}`,
  "Release 2026-10-06 shipped build 1.2.3-rc.4 to staging (x86_64-apple-darwin) at 09:41",
  // Curly quotes beside Han, an en dash, small kana (reasons below).
  "他说“你好”然后就走了，我们明天见。",
  "Please read pages 12–48 before Monday and chapters 3–5 before Wednesday.",
  `${prose(18, 4)}\n${prose(19, 4)}`,
  prose(20, 120),
  "きのうはチョコレートケーキをいっしょに食べました。",
  "**Heads up:** the deploy script now needs a flag. See the _notes_ below before you run it.",
  `This has **bold words**, *emphasised text* and ~~struck words~~ ${prose(22, 30)}`,
  `***${prose(23, 25)}*** then ${prose(24, 20)}\n__${prose(25, 6)}__ and _${prose(26, 9)}_`,
  "これはひらがなとカタカナだけのテキストですキスとテストとコーヒーとケーキとタクシーとスキーをたべました",
  "สวัสดีชาวโลก นี่คือข้อความภาษาไทยที่ยาวมากเพื่อทดสอบการตัดบรรทัดในเบราว์เซอร์และโมเดลของเรา",
  "नमस्ते दुनिया यह हिंदी में एक लंबा संदेश है ताकि पंक्तियों की जाँच हो सके और मॉडल भी सही रहे।",
  "안녕하세요! 오늘 회의는 오후 3시에 시작합니다. 자료를 확인해 주세요, 감사합니다.",
  "Team 👩‍💻 👨‍💻 🧑‍🔬 shipped 👨‍👩‍👧‍👦 the release with 👍🏽 done 🎉🎉 and flags 🇬🇧 🇮🇹 🇪🇸",
  // Left to measurement in every engine: CJK punctuation beside Latin text
  // and curly quotes beside Han (cjk-punctuation), kerning across Pretext's
  // pieces (shaping), one word in two text nodes of one font (glue), nested
  // strong and code; opening quotes after a word in another script, a
  // punctuated number in right-to-left text and an emoji glued to a word.
  "GitHubでPRを作りました。React、Vueのどれ？",
  "Plans: re-Test, pre-View, co-Author, x-Ray, T-Value, V-Twin and A-Team.",
  "un~~struck~~able words",
  "**bold __bolder__ boldest**",
  "run `pnpm test` first",
  "Привет, это сообщение про «Vote» и “Team” для проверки.",
  "הפגישה נדחתה לשעה 10:30. נא לאשר הגעה, תודה לכולם.",
  "Shipping now🚀and the release notes follow after lunch today.",
];
const link = "Read the notes at https://example.com/notes before merging.";
/** Atomic boxes, which never grow a line: mention buttons (a person, an
 * agent, bold), link chips (short, long, HTTP, Markdown, Buzz) and channel
 * references, whose widths only lie between none and the chip's cap, and
 * custom emoji (served, failing, refused): the same box. Then rows the model
 * must decline, kind `declined:<reason>`: a button whose name needs a
 * fallback font (it grows the line), a link label with a line break (a
 * two-line chip), and an agent the reader cannot open (a span, which WebKit
 * narrows a line by where it breaks inside it). */
const inlineContent = [
  [
    "mention",
    `Thanks @Alice Chen, can you review this today? ${prose(27, 12)}`,
    mention(alice),
  ],
  [
    "mention",
    "@Build Bot run the exactness spec on WebKit please.",
    mention(bot),
  ],
  [
    "mention",
    "Welcome @Alexandria Montgomery Featherstonehaugh of the North Guild!",
    mention(long),
  ],
  [
    "mention",
    `**@Alice Chen** and (@Build Bot) both ${prose(29, 20)}`,
    mention(alice, bot),
  ],
  ["chip", "Notes: https://example.com/notes"],
  ["chip", "Local preview at http://localhost:3000/health is up."],
  [
    "chip",
    `Long link https://github.com/block/buzz-app/pull/619/files#diff-0123456789abcdef0123456789abcdef then ${prose(30, 14)}`,
  ],
  [
    "chip",
    `See [the design notes](https://example.com/docs/design) and buzz://message?channel=general&id=${hex("1")} for context.`,
  ],
  ["chip", `Discuss in #general and #design, then lunch. ${prose(31, 8)}`],
  ["emoji", "Ship it :party: today :party:", emoji],
  [
    "emoji",
    `Failing :broken: and refused :unsafe: emoji keep their box ${prose(32, 9)}`,
    emoji,
  ],
  [
    "chip",
    `@Alice Chen see [docs](https://example.com/docs) :party: in #general ${prose(33, 16)}`,
    [...mention(alice), ...emoji],
  ],
  ["declined:mention-font", "Thanks @Ryan 🚀", mention(rocket)],
  [
    "declined:mention-font",
    `Thanks @अमित शर्मा and @สมชาย ใจดี ${prose(34, 6)}`,
    mention(hindi, thai),
  ],
  ["declined:mention-font", "Thanks @محمد علي", mention(arabic)],
  ["declined:link", "See [first part\nsecond part](https://example.com/br)."],
  [
    "declined:link",
    "See [first part\\\nsecond part](https://example.com/br) and [a  \nb](https://example.com/two).",
  ],
  [
    "declined:mentions",
    `Ask @Helper Bot about the flaky test ${prose(28, 6)}`,
    mention(helper),
  ],
  [
    "declined:mentions",
    "The draft from @Release Notes Assistant looks good to me and I think we can ship it today",
    mention(notes),
  ],
] as const;

/** Each content twice, in runs of one to four messages by an author; days
 * change every 17 messages. */
function staticEvents(
  contents: readonly (string | readonly [string, string[][]])[],
  special = false,
) {
  const events = [];
  let time = Date.UTC(2023, 10, 12, 9, 0) / 1000;
  let run = 0;
  for (let index = 0; index < contents.length * 2; index++) {
    // Runs of one to four messages; a new author or a 10 minute gap ends one.
    if (index % 4 === 0 || index % 7 === 0) {
      run++;
      time += 600;
    } else time += 30;
    if (index > 0 && index % 17 === 0) time += 86_400;
    const author = authors[run % authors.length] ?? relay;
    const entry = contents[index % contents.length] ?? "";
    const [content, tags] = typeof entry === "string" ? [entry, []] : entry;
    events.push(
      message(
        author,
        channelId,
        special && index === 23 ? link : content,
        time,
        [...tags],
      ),
    );
  }
  // One reaction: its strip is left to measurement.
  const target = events[31];
  if (special && target)
    events.push(
      signed(viewer, {
        kind: 7,
        content: "+",
        created_at: time + 1,
        tags: [
          ["h", channelId],
          ["e", target.id],
          ["p", target.pubkey],
        ],
      }),
    );
  return events;
}
function pagingEvents(count: number) {
  let time = Date.UTC(2023, 10, 1, 9, 0) / 1000;
  return Array.from({ length: count }, (_, index) => {
    time += index % 5 === 0 ? 900 : 40;
    if (index > 0 && index % 60 === 0) time += 86_400;
    const author = authors[Math.floor(index / 3) % authors.length] ?? relay;
    return message(
      author,
      channelId,
      index % 9 === 4
        ? `${prose(index, 14)}\n${prose(index + 1, 9)}`
        : prose(index, 4 + ((index * 13) % 70)),
      time,
    );
  });
}

// The live mix of row kinds (tests/fixtures/complex-corpus.mjs).
const complex =
  corpus === "complex"
    ? complexCorpus({
        count: Number(params.get("rows") ?? 300),
        channelId,
        start: Date.UTC(2023, 9, 2, 9, 0) / 1000,
        authors,
        agent: bot,
        relay,
        viewer,
        people: {
          person: alice.pubkey,
          agent: bot.pubkey,
          closed: helper.pubkey,
        },
        sign: (key: Key, template: Parameters<typeof signed>[1]) =>
          signed(key, template),
      })
    : undefined;
const rows = foldMessages(
  channelId,
  relay.pubkey,
  complex?.events ??
    (corpus === "static"
      ? staticEvents(staticContent, true)
      : corpus === "inline"
        ? staticEvents(
            inlineContent.map(([, content, tags = []]) => [content, [...tags]]),
          )
        : pagingEvents(240)),
);
const owner = createRelaySession({
  viewer: viewer.pubkey,
  relayAuthor: relay.pubkey,
  media,
  query: async () => [],
  subscribe: () => ({ update() {}, retry() {}, dispose() {} }),
} as never);
const page = 20;
// `arrivals` opens with the first `initial` rows and no older history; the
// test appends the rest like live messages.
const arrivals = corpus === "arrivals";
const initial = Number(
  params.get("initial") ??
    (arrivals ? 0 : corpus === "paging" ? 40 : rows.length),
);
let current: ChannelWindow = {
  channelId,
  rows: arrivals ? rows.slice(0, initial) : rows.slice(rows.length - initial),
  status: "ready",
  hasMore: !arrivals && initial < rows.length,
  loadingOlder: false,
  error: undefined,
  freshness: "fresh",
};
// Older pages are held until the test releases them. `remount` replaces the
// timeline (a channel switch away and back), optionally at another width;
// `hide` hides it like a retained pane.
let show: (view: ChannelWindow) => void = () => {};
let replace: (width: string) => void = () => {};
let hide: (hidden: boolean) => void = () => {};
const update = (next: ChannelWindow) => {
  current = next;
  show(next);
};
const control = {
  rows: rows.length,
  window: () => current.rows.length,
  pending: 0,
  release: () => {},
  remount: (width: number) => replace(String(width)),
  hide: (hidden: boolean) => hide(hidden),
  /** `arrivals` only: the next rows, appended in one commit. */
  append: (count: number) =>
    update({ ...current, rows: rows.slice(0, current.rows.length + count) }),
  /** With `pretext=lazy`: resolves once the model's inputs have loaded. */
  ready: () =>
    Promise.all([
      document.fonts.ready,
      import("@chenglou/pretext"),
      import("@chenglou/pretext/rich-inline"),
    ]).then(() => {}),
  /** Diagnostics only: the committed rows, for per-row reports on failure. */
  view: () => current.rows,
  /** `complex` and `inline`: each message row's kinds. */
  kinds:
    complex?.kinds ??
    Object.fromEntries(
      corpus === "inline"
        ? rows.map((row) => [
            row.id,
            inlineContent
              .filter(([, content]) => content === row.content)
              .map(([kind]) => kind),
          ])
        : [],
    ),
  /** Diagnostics: the model's outcome for every row with the timeline's
   * inputs, beside its measured height (the spec checks it agrees with the
   * timeline's own counters). */
  outcomes: async () => {
    const [{ environment }, { placements }, { membershipRows }, grouping] =
      await Promise.all([
        import("../../src/features/messages/row-height/environment"),
        import("../../src/features/messages/row-height/placement"),
        import("../../src/features/messages/membership-rows"),
        import("../../src/features/messages/message-grouping"),
      ]);
    const { model, metrics, fonts } = environment.snapshot();
    const probe = document.querySelector(
      "[data-message-scroller] > div[aria-hidden]",
    );
    if (!model || !metrics || !probe) return undefined;
    const timeline = membershipRows(current.rows);
    const placed = placements(timeline);
    const resolveName = (pubkey: string, fallback: string) =>
      queries.names?.resolve(pubkey, fallback, []) ?? fallback;
    const context = {
      metrics,
      width: probe.getBoundingClientRect().width - metrics.inset,
      fonts,
      inputs: {
        messages: conversation.messages?.snapshot() ?? [],
        inline: conversation.inline.snapshot(),
        links: conversation.links?.snapshot() ?? [],
        profiles,
        channels: channels.channels,
        agents,
        canOpenLink,
        resolveName,
      },
      name: (row: (typeof timeline)[number]) =>
        grouping.bylineName(row, profiles.get(row.authorId), resolveName),
    } as never;
    return timeline.map((row, index) => {
      const item = document.querySelector(`[data-message-id="${row.id}"]`);
      const at = placed[index];
      return {
        id: row.id,
        outcome: at ? model.predict(row, at, context) : undefined,
        height: item?.parentElement?.getBoundingClientRect().height,
      };
    });
  },
};
(window as { __rowHeights?: typeof control }).__rowHeights = control;
const queries = {
  ...owner.session,
  profiles: {
    ...owner.session.profiles,
    snapshot: () => profiles,
    subscribe: () => () => {},
  },
  agentLibrary: {
    ...owner.session.agentLibrary,
    snapshot: () => library,
    subscribe: () => () => {},
  },
  channels: {
    ...owner.session.channels,
    list: () => channels,
    subscribeList: () => () => {},
    window: () => current,
    loadOlder: () => {
      if (current.loadingOlder || !current.hasMore) return;
      update({ ...current, loadingOlder: true });
      control.pending++;
      control.release = () => {
        control.pending--;
        const start = rows.length - current.rows.length;
        update({
          ...current,
          rows: rows.slice(Math.max(0, start - page)),
          hasMore: start - page > 0,
          loadingOlder: false,
        });
      };
    },
  },
};

const target = params.get("target");
const inlineTarget = target
  ? {
      messageId: current.rows[Number(target)]?.id ?? "",
      signal: new AbortController().signal,
    }
  : undefined;

function Fixture() {
  const [view, setView] = useState(current);
  const [mount, setMount] = useState({
    generation: 0,
    width: params.get("width") ?? "900",
  });
  const [hidden, setHidden] = useState(false);
  show = setView;
  replace = (width) =>
    setMount(({ generation }) => ({ generation: generation + 1, width }));
  hide = setHidden;
  return (
    <ToastProvider>
      <div
        key={mount.generation}
        style={{
          width: `${mount.width}px`,
          height: `${params.get("height") ?? 700}px`,
          display: hidden ? "none" : "flex",
          flexDirection: "column",
        }}
      >
        <ChannelTimeline
          scope="row-heights"
          channelId={channelId}
          queries={queries as never}
          window={view}
          extensions={conversation}
          onOpenLink={() => false}
          canOpenLink={canOpenLink}
          {...(inlineTarget ? { inlineTarget } : {})}
        />
      </div>
    </ToastProvider>
  );
}

// Measure in loaded faces only: the model waits for each subset itself, and
// this fixture asserts exactness, not loading order (except a held subset).
const held = params.get("hold") === "cyrillic" ? /[\u0400-\u04ff]/ : /$^/;
await Promise.all(
  [...new Set(rows.map((row) => row.content).join(""))]
    .filter((char) => !held.test(char))
    .flatMap((char) => [
      document.fonts.load('400 14px "Inter Variable"', char),
      document.fonts.load('italic 400 14px "Inter Variable"', char),
    ]),
);
// WebKit's `fonts.ready` also waits for the document's load, which a held
// Pretext request blocks; the faces above are loaded either way.
if (params.get("pretext") !== "lazy") {
  await document.fonts.ready;
  await Promise.all([
    import("@chenglou/pretext"),
    import("@chenglou/pretext/rich-inline"),
  ]);
}
// The bundled renderers are registered before the timeline mounts, as at
// launch: its calibration probe renders the custom emoji renderer.
await new Promise<void>((resolve) => {
  const ready = () =>
    conversation.inline.snapshot().length &&
    conversation.links?.snapshot().length;
  if (ready()) return resolve();
  const stop = conversation.inline.subscribe(() => {
    if (!ready()) return;
    stop();
    resolve();
  });
});
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
