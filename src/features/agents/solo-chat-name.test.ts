import { expect, it, vi } from "vitest";
import type { RelayData } from "../relay/service";
import type { RelayEvent } from "../relay/events";
import { nameSoloChat } from "./solo-chat-name";

const first = "a".repeat(64),
  second = "b".repeat(64),
  owner = "c".repeat(64);
const event = {
  id: "1".repeat(64),
  pubkey: owner,
  kind: 9,
  created_at: 100,
  content: "Discuss this change",
  tags: [
    ["h", "chat"],
    ["p", first],
    ["p", second],
  ],
} as unknown as RelayEvent;

// The owner's Solo chat, as the relay lists it.
const soloChannels = {
  list: () => ({
    status: "ready",
    channels: [{ id: "chat", channelType: "solo", creator: owner }],
  }),
};

// Session identity stays stable across reads, as it does in the owning service.
function connection(
  snapshot: () => { status: string; viewer: string; session: unknown },
): RelayData {
  const state = snapshot();
  return { snapshot: () => state } as unknown as RelayData;
}

it("only the first tagged agent names an unchanged new Berd chat, once", async () => {
  let name = event.content;
  const save = vi.fn(async (_base, draft) => {
    name = draft.name;
  });
  const load = vi.fn(async () => ({
    name,
    canEdit: true,
    channelId: "chat",
    version: "v1",
  }));
  // The owner's own thread reply is in the same history; it is not the original.
  const reply = {
    ...event,
    id: "3".repeat(64),
    created_at: 90,
    tags: [...event.tags, ["e", "e".repeat(64), "", "reply"]],
  };
  const read = vi.fn(async () => [event, reply]);
  const relay = connection(() => ({
    status: "ready",
    viewer: owner,
    session: {
      channels: soloChannels,
      read,
      profiles: { snapshot: () => new Map() },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: { available: true, load, save },
    },
  }));
  await nameSoloChat(relay, owner, second, event, "Second agent wins?");
  expect(load).not.toHaveBeenCalled();
  await nameSoloChat(relay, owner, first, event, "A useful title");
  expect(name).toBe("A useful title");
  // A plain NIP-01 read: the relay rejects a channel-window `until` without a cursor.
  expect(read).toHaveBeenCalledWith([
    {
      kinds: [9],
      authors: [owner],
      "#h": ["chat"],
      until: event.created_at,
      limit: 100,
      consistency: "strong",
    },
  ]);
  // The create event the owner signed for this chat, read from the writer:
  // the chat may have been created a moment ago.
  expect(read).toHaveBeenCalledWith([
    {
      kinds: [9007],
      authors: [owner],
      "#h": ["chat"],
      limit: 2,
      consistency: "strong",
    },
  ]);
  await nameSoloChat(relay, owner, first, event, "Another title");
  expect(save).toHaveBeenCalledOnce();
  name = "My manual title";
  await nameSoloChat(relay, owner, first, event, "Please overwrite");
  expect(name).toBe("My manual title");
  expect(save).toHaveBeenCalledOnce();
});

it("recognizes a clean starting title from signed recipient tags without stripping literal @ text", async () => {
  const sent = { ...event, content: "@Agent @Literal investigate this" };
  const save = vi.fn();
  const relay = connection(() => ({
    status: "ready",
    viewer: owner,
    session: {
      channels: soloChannels,
      read: async () => [sent],
      profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: {
        available: true,
        load: async () => ({
          name: "@Literal investigate this",
          canEdit: true,
        }),
        save,
      },
    },
  }));
  await nameSoloChat(relay, owner, first, sent, "Useful title");
  expect(save).toHaveBeenCalledOnce();
});

it.each(["bold", "bullet_list"])(
  "a %s first draft and its sent message agree on the starting title",
  async (format) => {
    const { startingChatTitle } = await import("../solo/chat-title");
    const { mentionDraft } = await import("../messages/mention-draft");
    const { composerMarkdown } = await import("../messages/composer-markdown");
    const paragraph = {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "fix login",
          ...(format === "bold" ? { marks: [{ type: "bold" }] } : {}),
        },
      ],
    };
    const draft = mentionDraft({
      document: {
        version: 1,
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "token",
                  attrs: {
                    source: "@Agent",
                    recipient: { pubkey: first, name: "Agent" },
                    editAsText: false,
                  },
                },
                { type: "text", text: " " },
              ],
            },
            format === "bullet_list"
              ? {
                  type: "bullet_list",
                  content: [{ type: "list_item", content: [paragraph] }],
                }
              : paragraph,
          ],
        },
      },
    });
    const name = startingChatTitle(draft);
    expect(name).toBe(format === "bold" ? "**fix login**" : "- fix login");
    const sent = { ...event, content: composerMarkdown(draft) };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: async () => [sent],
        profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({ name, canEdit: true }),
          save,
        },
      },
    }));
    await nameSoloChat(relay, owner, first, sent, "Login repair");
    expect(save).toHaveBeenCalledOnce();
  },
);

it.each([first, second])(
  "retry wording and tag order do not change the original naming agent (%s)",
  async (agent) => {
    const retry = {
      ...event,
      id: "2".repeat(64),
      created_at: 110,
      content: "Try again",
      tags: [
        ["h", "chat"],
        ["p", second],
        ["p", first],
      ],
    };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: vi.fn(async () => [retry, event]),
        profiles: { snapshot: () => new Map() },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({ name: event.content, canEdit: true }),
          save,
        },
      },
    }));
    await nameSoloChat(relay, owner, agent, retry, "A useful title");
    expect(save).toHaveBeenCalledTimes(agent === first ? 1 : 0);
  },
);

it.each(["empty", "full", "same-second", "unrelated", "unsent"])(
  "keeps the title when original-message evidence is %s",
  async (evidence) => {
    const retry = {
      ...event,
      id: "2".repeat(64),
      created_at: 110,
      content: "Try again",
    };
    const history =
      evidence === "empty"
        ? []
        : evidence === "full"
          ? Array.from({ length: 100 }, (_, index) => ({
              ...event,
              id: index.toString(16).padStart(64, "0"),
              created_at: index,
            }))
          : evidence === "unsent"
            ? [{ ...event, delivery: "failed" }, retry]
            : evidence === "same-second"
              ? [event, { ...retry, created_at: event.created_at }]
              : [
                  { ...event, pubkey: second },
                  { ...event, tags: [["h", "other"]] },
                  {
                    ...event,
                    tags: [...event.tags, ["e", "e".repeat(64), "", "reply"]],
                  },
                ];
    const save = vi.fn();
    const load = vi.fn(async () => ({ name: event.content, canEdit: true }));
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: async () => history,
        profiles: { snapshot: () => new Map() },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: { available: true, load, save },
      },
    }));
    await nameSoloChat(relay, owner, first, retry, "Must not replace");
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  },
);

it.each(["history", "creation", "details"])(
  "does not rename after the owning session changes during %s",
  async (stage) => {
    let release!: () => void;
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const save = vi.fn();
    const session = {
      channels: soloChannels,
      read: async ([filter]: readonly { kinds: readonly number[] }[]) => {
        const creation = !!filter?.kinds.includes(9007);
        if (stage === (creation ? "creation" : "history")) {
          began();
          await gate;
        }
        return creation ? [] : [event];
      },
      profiles: { snapshot: () => new Map() },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: {
        available: true,
        load: async () => {
          if (stage === "details") {
            began();
            await gate;
          }
          return { name: event.content, canEdit: true };
        },
        save,
      },
    };
    let current = session;
    const relay = {
      snapshot: () => ({ status: "ready", viewer: owner, session: current }),
    } as unknown as RelayData;
    const work = nameSoloChat(relay, owner, first, event, "Do not rename");
    try {
      await started;
      current = { ...session };
    } finally {
      release();
    }
    await work;
    expect(save).not.toHaveBeenCalled();
  },
);

it.each([
  { chosen: false, caption: "Review this", title: "Review this" },
  { chosen: true, caption: "Review this", title: "Review this" },
  {
    chosen: false,
    caption: "Review [\\#design](buzz://channel/design)",
    title: "Review #design",
  },
  {
    chosen: true,
    caption: "Review [\\#design](buzz://channel/design)",
    title: "Review #design",
  },
])(
  "staged cards and $caption preserve automatic naming and chosen names (chosen=$chosen)",
  async ({ chosen, caption, title }) => {
    const { startingChatTitle } = await import("../solo/chat-title");
    const { composerMarkdown } = await import("../messages/composer-markdown");
    const draft = {
      text: `@Agent ${caption}`,
      recipients: [{ pubkey: first, name: "Agent", start: 0, end: 6 }],
      chatCards: ["[Session: Fix](buzz://channel/session-id)"],
    };
    const name = startingChatTitle(draft);
    expect(name).toBe(title);
    const sent = { ...event, content: composerMarkdown(draft) };
    const save = vi.fn();
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: async () => [sent],
        profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({
            name,
            labels: chosen ? ["buzz.session.named"] : [],
            canEdit: true,
          }),
          save,
        },
      },
    }));
    await nameSoloChat(relay, owner, first, sent, "Useful title");
    expect(save).toHaveBeenCalledTimes(chosen ? 0 : 1);
  },
);

it.each([
  "Review [\\#design](buzz://channel/design)",
  `Review [\\#design](buzz://channel/${"x".repeat(100)})`,
  `Review 😀 [\\#design](buzz://channel/${"x".repeat(100)})`,
  "[Session: Fix](buzz://channel/session-id)",
])(
  "recognizes the legacy starting title for %s without overwriting chosen names",
  async (caption) => {
    // Persist the old algorithm's literal, truncated title, not the new helper's result.
    const legacyName = [...caption].slice(0, 80).join("");
    const sent = { ...event, content: `@Agent ${caption}` };
    let name = legacyName;
    let labels: string[] = [];
    const save = vi.fn(async (_base, draft) => {
      name = draft.name;
    });
    const relay = connection(() => ({
      status: "ready",
      viewer: owner,
      session: {
        channels: soloChannels,
        read: async () => [sent],
        profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
        agentChoices: { snapshot: () => ({ identities: [] }) },
        channelDetails: {
          available: true,
          load: async () => ({ name, labels, canEdit: true }),
          save,
        },
      },
    }));
    // Even a chosen name equal to the legacy default must remain protected.
    labels = ["buzz.session.named"];
    await nameSoloChat(relay, owner, first, sent, "Useful title");
    expect(save).not.toHaveBeenCalled();
    labels = [];
    name = "My manual title";
    await nameSoloChat(relay, owner, first, sent, "Useful title");
    expect(save).not.toHaveBeenCalled();
    name = legacyName;
    await nameSoloChat(relay, owner, first, sent, "Useful title");
    expect(save).toHaveBeenCalledOnce();
    expect(name).toBe("Useful title");
    await nameSoloChat(relay, owner, first, sent, "Another title");
    expect(save).toHaveBeenCalledOnce();
  },
);

it("an agent tag without a caption retains the session-card starting title", async () => {
  const { startingChatTitle } = await import("../solo/chat-title");
  expect(
    startingChatTitle({
      text: "@Agent ",
      recipients: [{ pubkey: first, name: "Agent", start: 0, end: 6 }],
      chatCards: ["[Session: Fix](buzz://channel/session-id)"],
    }),
  ).toBe("Session: Fix");
});

// A stored name is its message's source from its start, cut at 80 characters.
const media = (file: string) =>
  `https://relay.example/media/${"d".repeat(60)}${file}`;
const imeta = (file: string, type: string, filename?: string) => [
  "imeta",
  `url ${media(file)}`,
  `m ${type}`,
  ...(filename ? [`filename ${filename}`] : []),
];
const video = media("1.mp4");
const notes = media("2.txt");
const voice = media("3.mp4");

it.each([
  {
    sent: "a desktop video",
    content: `@Agent\n\n![video](<${video}>)`,
    tags: [imeta("1.mp4", "video/mp4")],
    // This build's title, then an earlier desktop's.
    names: ["Video", "Chat"],
  },
  // The mobile app sends no agent tag in its text, and a line per attachment.
  {
    sent: "a mobile video",
    content: `\n![video](${video})`,
    tags: [imeta("1.mp4", "video/mp4")],
    names: ["Video", `![video](${video})`],
  },
  {
    sent: "a mobile file",
    content: `\n[notes.txt](${notes})`,
    tags: [imeta("2.txt", "text/plain", "notes.txt")],
    names: ["Attachment", `[notes.txt](${notes})`],
  },
  {
    sent: "several mobile attachments",
    content: `\n![image](${media("4.png")})\n![video](${video})\n[notes.txt](${notes})`,
    tags: [
      imeta("4.png", "image/png"),
      imeta("1.mp4", "video/mp4"),
      imeta("2.txt", "text/plain", "notes.txt"),
    ],
    names: ["3 attachments", `![image](${media("4.png")}) ![video](${video})`],
  },
  {
    sent: "mobile images",
    content: `\n![image](${media("4.png")})\n![image](${media("5.jpg")})`,
    tags: [imeta("4.png", "image/png"), imeta("5.jpg", "image/jpeg")],
    names: ["2 images"],
  },
  {
    // Packaged as a video file, and named as the voice note it is.
    sent: "a mobile voice note",
    content: `\n[voice-note-7.mp4](${voice})`,
    tags: [imeta("3.mp4", "video/mp4", "voice-note-7.mp4")],
    names: ["Attachment", `[voice-note-7.mp4](${voice})`],
  },
  {
    sent: "mobile audio",
    content: `\n![audio](${media("6.m4a")})`,
    tags: [imeta("6.m4a", "audio/mp4")],
    names: ["Attachment", `![audio](${media("6.m4a")})`],
  },
  // The mobile app keeps a caption as written and reads no link label; each
  // is followed here by what desktop derives.
  {
    sent: "a mobile photo captioned with an address",
    content: `Send this to <dev@example.org>\n![image](${media("4.png")})`,
    tags: [imeta("4.png", "image/png")],
    names: ["Send this to <dev@example.org>", "Send this to dev@example.org"],
  },
  {
    sent: "a mobile photo captioned with a link",
    content: `[a](https://example.com/x(1(2))) b\n![image](${media("4.png")})`,
    tags: [imeta("4.png", "image/png")],
    names: ["[a](https://example.com/x(1(2))) b", "a b"],
  },
  {
    sent: "a link",
    content: `https://www.example.com/${"x".repeat(90)}`,
    tags: [],
    names: ["Link to example.com", `https://www.example.com/${"x".repeat(90)}`],
  },
])(
  "without its create event, names a chat that still has a title $sent alone gave it",
  async ({ content, tags, names }) => {
    const sent = {
      ...event,
      content,
      tags: [["h", "chat"], ["p", first], ...tags],
    } as unknown as RelayEvent;
    // A name the owner chose is kept; "Image" is no title for any of these.
    for (const [stored, renamed] of [
      ...names.map((name) => [[...name].slice(0, 80).join(""), true] as const),
      ["Image", false] as const,
    ]) {
      let name: string = stored;
      const relay = connection(() => ({
        status: "ready",
        viewer: owner,
        session: {
          channels: soloChannels,
          read: async () => [sent],
          profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
          agentChoices: { snapshot: () => ({ identities: [] }) },
          channelDetails: {
            available: true,
            load: async () => ({ name, canEdit: true }),
            save: async (_base: unknown, draft: { name: string }) => {
              name = draft.name;
            },
          },
        },
      }));
      await nameSoloChat(relay, owner, first, sent, "Review the clip");
      expect(name, stored).toBe(renamed ? "Review the clip" : stored);
    }
  },
);

// The chat's own create event, as the relay keeps it: the name as signed.
const creation = (name: string, author = owner, more: string[][] = []) => ({
  id: name.length.toString(16).padStart(64, "9"),
  pubkey: author,
  kind: 9007,
  created_at: 90,
  content: "",
  tags: [["h", "chat"], ["name", name], ...more],
});

/** A chat `stored` under a name, whose first message is `sent`. `created`
 * answers the read of its create event. `offer` has its agent's harness offer
 * "Review the clip". */
function soloChat(
  sent: RelayEvent,
  stored: string,
  created: () => Promise<unknown[]>,
  labels: string[] = [],
) {
  let name = stored;
  const relay = connection(() => ({
    status: "ready",
    viewer: owner,
    session: {
      channels: soloChannels,
      read: async ([filter]: readonly { kinds: readonly number[] }[]) =>
        filter?.kinds.includes(9007) ? created() : [sent],
      profiles: { snapshot: () => new Map([[first, { name: "Agent" }]]) },
      agentChoices: { snapshot: () => ({ identities: [] }) },
      channelDetails: {
        available: true,
        load: async () => ({ name, labels, canEdit: true }),
        save: async (_base: unknown, draft: { name: string }) => {
          name = draft.name;
        },
      },
    },
  }));
  return {
    name: () => name,
    offer: () => nameSoloChat(relay, owner, first, sent, "Review the clip"),
  };
}

const videoOnly = {
  ...event,
  content: `\n![video](${video})`,
  tags: [["h", "chat"], ["p", first], imeta("1.mp4", "video/mp4")],
} as unknown as RelayEvent;

it.each([
  // Names no desktop rule derives from these messages; the mobile app does.
  {
    sent: "links with nested parentheses",
    content: "[a](https://example.com/x(1(2))) [b](https://example.com)",
    stored: "[a](https://example.com/x(1(2))) b",
  },
  {
    sent: "a quoted message and a prompt",
    content:
      "> The deploy failed on step 3\n> see the log\n\nWhat went wrong here?",
    stored: "What went wrong here?",
  },
  {
    sent: "a leading agent name",
    content: "@Agent summarize the release notes",
    stored: "@Agent summarize the release notes",
  },
  // The relay stores a name without a leading "#" or outer whitespace.
  {
    sent: "a heading",
    content: "# Plan the launch",
    stored: "Plan the launch",
    created: "# Plan the launch ",
  },
])(
  "names a chat started with $sent while it has the name it was created with",
  async ({ content, stored, created = stored }) => {
    const chat = soloChat(
      { ...event, content } as unknown as RelayEvent,
      stored,
      async () => [creation(created)],
    );
    await chat.offer();
    expect(chat.name()).toBe("Review the clip");
  },
);

it.each([
  {
    kept: "differs from the name it was created with",
    // "Chat" is a title an earlier desktop gave a video; here a person chose it.
    stored: "Chat",
    created: [creation("Video")],
    labels: [],
  },
  {
    kept: "is marked as chosen",
    stored: "Video",
    created: [creation("Video")],
    labels: ["buzz.session.named"],
  },
  {
    kept: "has create events that disagree",
    stored: "Video",
    created: [creation("Video"), creation("Clip")],
    labels: [],
  },
  // Only the create event the owner signed for this chat alone is evidence.
  // Any other answer is ignored, and the first message gives no such title.
  {
    kept: "only a create event another key signed carries",
    stored: "Release planning",
    created: [creation("Release planning", second)],
    labels: [],
  },
  {
    kept: "only a create event for a second chat as well carries",
    stored: "Release planning",
    created: [creation("Release planning", owner, [["h", "other"]])],
    labels: [],
  },
])("keeps a chat's name that $kept", async ({ stored, created, labels }) => {
  const chat = soloChat(videoOnly, stored, async () => created, labels);
  await chat.offer();
  expect(chat.name()).toBe(stored);
});

it.each([
  { listed: "as named", summary: { labels: ["buzz.session.named"] } },
  { listed: "under the harness's title", summary: { name: "Review the clip" } },
])("a chat listed $listed costs no relay read", async ({ summary }) => {
  const read = vi.fn(async () => [videoOnly]);
  const load = vi.fn();
  const relay = connection(() => ({
    status: "ready",
    viewer: owner,
    session: {
      channels: {
        list: () => ({
          status: "ready",
          channels: [
            { id: "chat", channelType: "solo", creator: owner, ...summary },
          ],
        }),
      },
      read,
      channelDetails: { available: true, load, save: vi.fn() },
    },
  }));
  await nameSoloChat(relay, owner, first, videoOnly, "Review the clip");
  expect(read).not.toHaveBeenCalled();
  expect(load).not.toHaveBeenCalled();
});

it("a chat with no create event is named only while it has a title its first message gives", async () => {
  // Its creator can delete the create event; the chat stays live.
  const none = async () => [];
  const untouched = soloChat(videoOnly, "Video", none);
  await untouched.offer();
  expect(untouched.name()).toBe("Review the clip");
  const renamed = soloChat(videoOnly, "My clip", none);
  await renamed.offer();
  expect(renamed.name()).toBe("My clip");
});

it("a refused read of the create event names nothing", async () => {
  // Not "no create event": "Video" would pass as this message's own title.
  const chat = soloChat(videoOnly, "Video", async () => {
    throw new Error("rate-limited: quota exceeded; retry in 4s");
  });
  await expect(chat.offer()).rejects.toThrow("rate-limited");
  expect(chat.name()).toBe("Video");
});
