// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { npubEncode } from "nostr-tools/nip19";
import { afterEach, expect, it, vi } from "vitest";
import {
  communityRequest,
  type CommunityInfo,
} from "../../features/communities/api";
import type {
  CommunityReader,
  Membership,
} from "../../features/communities/service";
import { DEFAULT_WELCOME_MESSAGE } from "../../features/communities/WelcomeCard";
import type {
  ConversationExtensions,
  LinkRenderer,
} from "../../features/conversation/contracts";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { profileTarget } from "../../features/profiles/target";
import type { Contribution } from "../../plugins/contributions";
import {
  ChannelLifecycleUnconfirmed,
  type ChannelLanding,
  type ChannelLifecycleCapability,
} from "../../features/relay/channel-lifecycle";
import type { ChannelSummary } from "../../features/relay/contracts";
import { PublishRejected } from "../../features/relay/outbox";
import type { RelayData } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { WelcomeSettings } from "./WelcomeSettings";

vi.mock("../../features/communities/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../features/communities/api")>()),
  communityRequest: vi.fn(),
}));

composerDOMFixture();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const owner = "0".repeat(64);
const lobby = "11111111-1111-4111-8111-111111111111";
const square = "22222222-2222-4222-8222-222222222222";
const random = "55555555-5555-4555-8555-555555555555";
type DirectoryRow = Readonly<{
  id: string;
  name: string;
  channelType: "stream" | "forum";
  autoJoin?: true;
  archived?: true;
}>;
const rows: DirectoryRow[] = [
  { id: lobby, name: "Lobby", channelType: "stream" as const },
  {
    id: square,
    name: "Town square",
    channelType: "stream" as const,
    autoJoin: true as const,
  },
  {
    id: random,
    name: "Random",
    channelType: "stream" as const,
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Old news",
    channelType: "stream" as const,
    archived: true as const,
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    name: "Questions",
    channelType: "forum" as const,
  },
];

function setup({
  info = { policy: null, landingChannels: true, landingChannel: lobby },
  landing = { landing: true, welcome: "Hi there", name: "Lobby" },
  joined = [],
  directory = rows,
  names,
  membership = { name: "Primary" },
  extensions,
}: {
  info?: CommunityInfo;
  landing?: ChannelLanding | undefined;
  /** The viewer's own channels, beside the directory. */
  joined?: ChannelSummary[];
  directory?: DirectoryRow[];
  /** Known names by public key. */
  names?: Readonly<Record<string, string>>;
  /** How the viewer's saved membership names the community. */
  membership?: Omit<Membership, "id">;
  /** The conversation's renderers, as the plugin passes them. */
  extensions?: ConversationExtensions;
} = {}) {
  const readLanding = vi.fn<ChannelLifecycleCapability["readLanding"]>(
    async () => landing,
  );
  const setLanding = vi.fn<ChannelLifecycleCapability["setLanding"]>(
    async () => {},
  );
  let list = { status: "ready", channels: joined };
  let listed = directory;
  const rosterListeners = new Set<() => void>();
  const directoryListeners = new Set<() => void>();
  /** The relay shows a channel's starter flag, as a strong read hands it to
   * the roster and the directory. */
  const flag = (id: string, enabled: boolean) => {
    const set = <T extends { id: string; autoJoin?: true }>(row: T): T => {
      if (row.id !== id) return row;
      const { autoJoin: _, ...rest } = row;
      return (enabled ? { ...rest, autoJoin: true } : rest) as T;
    };
    listed = listed.map(set);
    list = { ...list, channels: list.channels.map(set) };
    act(() => {
      for (const listener of [...rosterListeners, ...directoryListeners])
        listener();
    });
  };
  // A confirmed command's readback updates the flag before it resolves.
  const run = vi.fn<ChannelLifecycleCapability["run"]>(async (action, id) =>
    flag(id, action === "auto-join-on"),
  );
  const session = {
    viewer: owner,
    media: () => undefined,
    channelLifecycle: { available: true, readLanding, setLanding, run },
    ...(names && {
      names: {
        resolve: (pubkey: string, fallback?: string) =>
          names[pubkey] ?? fallback,
        snapshot: () => 0,
        subscribe: () => () => {},
      },
    }),
    channels: {
      list: () => list,
      ensureList: () => () => {},
      subscribeList(listener: () => void) {
        rosterListeners.add(listener);
        return () => rosterListeners.delete(listener);
      },
      subscribeDirectory(listener: () => void) {
        directoryListeners.add(listener);
        return () => directoryListeners.delete(listener);
      },
      openDirectory: () => listed,
      browseDirectory: () => listed,
      readDirectory: async () => ({ partial: false }),
      directoryComplete: () => true,
    },
  } as unknown as RelaySession;
  let snapshot = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${owner}`,
    viewer: owner,
    session,
  };
  const listeners = new Set<() => void>();
  const relay = {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as RelayData;
  /** The relay republished a joined channel's metadata. */
  const setJoined = (channels: ChannelSummary[]) => {
    list = { status: "ready", channels };
    act(() => {
      for (const listener of rosterListeners) listener();
    });
  };
  /** The same community reconnects: a new session generation. */
  const reconnect = () => {
    snapshot = { ...snapshot, generation: snapshot.generation + 1 };
    act(() => {
      for (const listener of listeners) listener();
    });
  };
  // A stable snapshot, as the real reader keeps: a new one each call would
  // never let useSyncExternalStore settle.
  const saved = {
    memberships: [{ id: "https://primary.example", ...membership }],
  };
  const communities = {
    snapshot: () => saved,
    subscribe: () => () => {},
  } as unknown as CommunityReader;
  vi.mocked(communityRequest).mockResolvedValue(info);
  const view = render(
    <WelcomeSettings
      relay={relay}
      communities={communities}
      active={() => true}
      extensions={extensions}
    />,
    { wrapper: ToastProvider },
  );
  return {
    readLanding,
    setLanding,
    run,
    flag,
    setJoined,
    reconnect,
    view,
    user: userEvent.setup(),
  };
}

const channel = () => screen.getByRole("combobox", { name: "Welcome channel" });
const titleField = () => screen.getByRole("textbox", { name: "Title" });
const messageField = () => screen.getByRole("textbox", { name: "Message" });
/** Replace the whole message, as the published text arriving would. The
 * editor's value setter dispatches its change at once, so it runs in act:
 * fireEvent.change would set it while building the event, outside act. */
const setMessage = (text: string) =>
  act(() => {
    (messageField() as ComposerInputElement).value = text;
  });
const starters = () =>
  screen.getByRole("region", { name: "Also add new members to" });
const removeLabel = (name: string) => `Remove #${name} from starter channels`;
const remove = (name: string) =>
  screen.getByRole("button", { name: removeLabel(name) });
const removable = (name: string) =>
  screen.queryByRole("button", { name: removeLabel(name) });
const addField = () => screen.getByRole("combobox", { name: "Add a channel" });
const welcome = (message: string, title = "") => ({ message, title });

it("opens on the designated channel, its title and its message, read fresh", async () => {
  const { readLanding } = setup();
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  // The chosen channel shows its icon, as in the list.
  expect(
    channel()
      .closest(".buzz-input-group")
      ?.querySelector(".buzz-input-leading svg"),
  ).not.toBeNull();
  expect(titleField()).toHaveValue("Welcome to Primary");
  expect(messageField()).toHaveValue("Hi there");
  expect(communityRequest).toHaveBeenCalledWith(
    "https://primary.example",
    "info",
    undefined,
    expect.any(AbortSignal),
  );
  expect(readLanding).toHaveBeenCalledWith(lobby, expect.any(AbortSignal));
  // Nothing changed yet, so there is nothing to save.
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("opens on a custom title", async () => {
  setup({
    landing: {
      landing: true,
      welcome: "Say **hi**",
      welcomeTitle: "Hello, newcomer",
      name: "Lobby",
    },
  });
  await waitFor(() => expect(titleField()).toHaveValue("Hello, newcomer"));
  expect(messageField()).toHaveValue("Say **hi**");
  expect(
    screen.getByText(
      /Format with the toolbar or Markdown\. To link a channel or person, paste a copied channel link or npub\./,
    ),
  ).toBeVisible();
});

it("writes toolbar formatting and a pasted channel link into the message as Markdown", async () => {
  const { setLanding, user } = setup();
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  const input = messageField();
  setMessage("");
  // A channel's Copy link writes the bare link.
  const link = `buzz://channel/${square}`;
  act(() => {
    input.focus();
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        getData: (type: string) => (type === "text/plain" ? link : ""),
      },
    });
  });
  // A pointer click leaves focus and the caret in the editor.
  await user.click(screen.getByRole("button", { name: "Toggle formatting" }));
  await user.click(screen.getByRole("button", { name: "Bold" }));
  expect(input).toHaveFocus();
  await user.keyboard("Join");
  expect(input.querySelector("strong")).toHaveTextContent("Join");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(`${link} **Join**`),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

// Link styling comes from the links plugin's renderer, which messages reach
// through the conversation extensions. Without them, a pasted channel link
// shows as plain `#name` text in the editor while the card underlines it.
it("shows a pasted channel link through the conversation's link renderer, as the card does", async () => {
  const renderer: Contribution<LinkRenderer> = {
    id: "links",
    title: "Links",
    key: "test/links",
    pluginId: "test",
    revision: "one",
    matches: (url) => url.startsWith("buzz://channel/"),
    className: "link-style",
    component: ({ url }) => <span>{url}</span>,
  };
  const subscribe = () => () => {};
  // Registries keep their snapshot until a contribution changes.
  const links = [renderer];
  const none: never[] = [];
  setup({
    extensions: {
      links: { snapshot: () => links, subscribe },
      inline: { snapshot: () => none, subscribe },
      tools: { snapshot: () => none, subscribe },
    },
  });
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  pasteIntoMessage(`buzz://channel/${square}`);
  const chip = await waitFor(() => {
    const found = messageField().querySelector("[data-link-renderer]");
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  // The chip only names the channel: no anchor, so nothing opens from the editor.
  expect(chip.tagName).toBe("SPAN");
  expect(chip).toHaveAttribute("data-link-renderer", "test/links");
  expect(chip).toHaveClass("link-style");
  expect(chip).toHaveTextContent(`buzz://channel/${square}`);
});

/** A plain-text clipboard holding `text`. */
const plainClipboard = (text: string) => ({
  clipboardData: {
    items: [],
    getData: (type: string) => (type === "text/plain" ? text : ""),
  },
});

/** Paste `text` as plain text into a message field holding only `before` and
 * `after`, with the caret between them. */
function pasteIntoMessage(text: string, before = "", after = "") {
  setMessage(before + after);
  const input = messageField() as ComposerInputElement;
  act(() => {
    input.focus();
    input.setSelectionRange(before.length, before.length);
    document.dispatchEvent(new Event("selectionchange"));
    fireEvent.paste(input, plainClipboard(text));
  });
}

it("links a pasted npub to the person, named as their profile names them", async () => {
  const alice = "b".repeat(64);
  const npub = npubEncode(alice);
  const { setLanding, user } = setup({ names: { [alice]: "Alice" } });
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  // Copy npub writes the bare npub.
  pasteIntoMessage(npub);
  await user.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(`[@Alice](nostr:${npub})`),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("labels a pasted nostr: npub with a short key when the name is unknown", async () => {
  const npub = npubEncode("c".repeat(64));
  const { setLanding, user } = setup({ names: {} });
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  pasteIntoMessage(`nostr:${npub}`);
  await user.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(`[@npub…${npub.slice(-3)}](nostr:${npub})`),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("links an npub pasted into prose", async () => {
  const alice = "b".repeat(64);
  const npub = npubEncode(alice);
  const { setLanding, user } = setup({ names: { [alice]: "Alice" } });
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  pasteIntoMessage(npub, "Ask ", " anything");
  await user.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(`Ask [@Alice](nostr:${npub}) anything`),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("keeps an npub pasted as a link destination being typed, so the link completes", async () => {
  const alice = "b".repeat(64);
  const npub = npubEncode(alice);
  const { setLanding, user } = setup({ names: { [alice]: "Alice" } });
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  pasteIntoMessage(`nostr:${npub}`, "Ask [@Alice](");
  await user.keyboard(")");
  expect(messageField()).toHaveValue(`Ask [@Alice](nostr:${npub})`);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(`Ask [@Alice](nostr:${npub})`),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it.each([
  ["inside a code span", "Key: `id ", " here`"],
  ["after an unclosed backtick", "Key: `", ""],
  ["inside a link label", "[see ", " here](https://example.com)"],
  ["completing a bare URL", "https://primal.net/p/", ""],
])("keeps an npub pasted %s as pasted", async (_, before, after) => {
  const alice = "b".repeat(64);
  const npub = npubEncode(alice);
  const { setLanding, user } = setup({ names: { [alice]: "Alice" } });
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  pasteIntoMessage(npub, before, after);
  expect(messageField()).toHaveValue(before + npub + after);
  await user.click(await screen.findByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(before + npub + after),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("keeps an npub pasted into toolbar code as pasted", async () => {
  const alice = "b".repeat(64);
  const npub = npubEncode(alice);
  const { setLanding, user } = setup({ names: { [alice]: "Alice" } });
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  const input = messageField();
  setMessage("");
  act(() => {
    input.focus();
    document.dispatchEvent(new Event("selectionchange"));
  });
  // A pointer click leaves focus and the caret, with Code on, in the editor.
  await user.click(screen.getByRole("button", { name: "Toggle formatting" }));
  await user.click(screen.getByRole("button", { name: "Code" }));
  expect(input).toHaveFocus();
  act(() => {
    fireEvent.paste(input, plainClipboard(npub));
  });
  expect(input.querySelector("code")).toHaveTextContent(npub);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(`\`${npub}\``),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

const publishedMarkdown = [
  "**Welcome** to _Primary_",
  "",
  `- Say hi in [#Town square](buzz://channel/${square})`,
  `- Ask [@Ada](${profileTarget("a".repeat(64))}) anything`,
].join("\n");

it("opens published Markdown as its source and sends it back unchanged", async () => {
  const markdown = publishedMarkdown;
  const { setLanding, user } = setup({
    landing: { landing: true, welcome: markdown, name: "Lobby" },
  });
  await waitFor(() => expect(messageField()).toHaveValue(markdown));
  // Nothing changed yet, so there is nothing to save.
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  const input = messageField() as ComposerInputElement;
  act(() => {
    input.focus();
    input.setSelectionRange(markdown.length, markdown.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await user.keyboard("!");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(`${markdown}!`),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("bolds one word inside published Markdown and keeps the rest of the source", async () => {
  const markdown = publishedMarkdown;
  const { setLanding, user } = setup({
    landing: { landing: true, welcome: markdown, name: "Lobby" },
  });
  await waitFor(() => expect(messageField()).toHaveValue(markdown));
  const input = messageField() as ComposerInputElement;
  const word = "anything";
  const start = markdown.indexOf(word);
  act(() => {
    input.focus();
    input.setSelectionRange(start, start + word.length);
    document.dispatchEvent(new Event("selectionchange"));
  });
  // A pointer click keeps the selection in the editor.
  await user.click(screen.getByRole("button", { name: "Toggle formatting" }));
  await user.click(screen.getByRole("button", { name: "Bold" }));
  expect(input).toHaveFocus();
  expect(
    [...input.querySelectorAll("strong")].map((node) => node.textContent),
  ).toContain(word);
  // Only the selected word changes; the emphasis, list and links around it
  // are sent as they were published.
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome(markdown.replace(word, `**${word}**`)),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("moves the welcome to another public channel with its full state", async () => {
  const { setLanding, user } = setup();
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  await user.click(screen.getByRole("button", { name: "Browse channels" }));
  // Only active public stream channels are offered, each with its icon.
  const options = await screen.findAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "Lobby",
    "Random",
    "Town square",
  ]);
  for (const option of options)
    expect(option.querySelector("svg")).not.toBeNull();
  await user.click(screen.getByRole("option", { name: "Town square" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      square,
      welcome("Hi there"),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("requires a channel when none is designated and sends the defaults as empty", async () => {
  const { readLanding, setLanding, user } = setup({
    info: { policy: null, landingChannels: true },
  });
  await waitFor(() =>
    expect(messageField()).toHaveValue(DEFAULT_WELCOME_MESSAGE),
  );
  expect(channel()).toHaveValue("");
  expect(readLanding).not.toHaveBeenCalled();
  setMessage(`${DEFAULT_WELCOME_MESSAGE}\n`);
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.type(channel(), "town");
  await user.click(await screen.findByRole("option", { name: "Town square" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  // The normalized defaults are never stored as custom text.
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      square,
      welcome(""),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("normalizes line endings and trims the title and message before sending", async () => {
  const { setLanding, user } = setup();
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  setMessage("  Hi\r\nall  ");
  fireEvent.change(titleField(), { target: { value: "  Hello, newcomer " } });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome("Hi\nall", "Hello, newcomer"),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("blocks messages the relay would refuse and restores the defaults in the draft", async () => {
  const { setLanding, user } = setup();
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  setMessage("  \n ");
  expect(
    screen.getByText("Enter a welcome message, or restore the defaults."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  setMessage("a".repeat(4001));
  expect(
    screen.getByText("Shorten the message to 4,000 characters."),
  ).toBeVisible();
  setMessage("a\u0007b");
  expect(
    screen.getByText(
      "Remove control characters. Line breaks and tabs are fine.",
    ),
  ).toBeVisible();
  // Unicode scalar values, not UTF-16 units, as the relay counts; tabs pass.
  setMessage(`${"😀".repeat(1999)}\t${"😀".repeat(2000)}`);
  expect(screen.getByText("4,000 of 4,000 characters")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  fireEvent.change(titleField(), { target: { value: "Hello" } });
  await user.click(screen.getByRole("button", { name: "Restore defaults" }));
  expect(messageField()).toHaveValue(DEFAULT_WELCOME_MESSAGE);
  expect(titleField()).toHaveValue("Welcome to Primary");
  expect(screen.queryByRole("button", { name: "Restore defaults" })).toBeNull();
  expect(setLanding).not.toHaveBeenCalled();
});

it("blocks titles the relay would refuse", async () => {
  const { setLanding } = setup();
  await waitFor(() => expect(titleField()).toHaveValue("Welcome to Primary"));
  fireEvent.change(titleField(), { target: { value: "   " } });
  expect(
    screen.getByText("Enter a title, or restore the defaults."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(titleField(), { target: { value: "a".repeat(121) } });
  expect(
    screen.getByText("Shorten the title to 120 characters."),
  ).toBeVisible();
  fireEvent.change(titleField(), { target: { value: "a\tb" } });
  expect(screen.getByText("Use one line of text for the title.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(titleField(), { target: { value: "a\u2028b" } });
  expect(screen.getByText("Use one line of text for the title.")).toBeVisible();
  fireEvent.change(titleField(), { target: { value: "😀".repeat(120) } });
  expect(screen.getByText("120 of 120 characters")).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  expect(setLanding).not.toHaveBeenCalled();
});

it("blocks invisible-only text and hidden direction characters, as the relay does", async () => {
  const { setLanding } = setup();
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  // Zero-width and braille-blank characters alone leave nothing to read.
  setMessage("\u200B\u2800");
  expect(
    screen.getByText("Enter a welcome message, or restore the defaults."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  setMessage("\u202Eabc");
  expect(
    screen.getByText("Remove the hidden text-direction characters."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  // A zero-width space inside readable text is fine.
  setMessage("Hello\u200Bworld");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  fireEvent.change(titleField(), { target: { value: " \u200B " } });
  expect(
    screen.getByText("Enter a title, or restore the defaults."),
  ).toBeVisible();
  fireEvent.change(titleField(), { target: { value: "Hi\u2066there" } });
  expect(
    screen.getByText("Remove the hidden text-direction characters."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(setLanding).not.toHaveBeenCalled();
});

it('titles the default "Welcome" for a community known only by its address', async () => {
  // Joined without a published name, the membership holds only the host.
  const { setLanding, user } = setup({
    membership: { name: "primary.example" },
  });
  await waitFor(() => expect(titleField()).toHaveValue("Welcome"));
  setMessage("Say hello");
  await user.click(screen.getByRole("button", { name: "Save" }));
  // An untouched default title is sent as the default.
  await waitFor(() =>
    expect(setLanding).toHaveBeenCalledWith(
      lobby,
      welcome("Say hello"),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("resends a published title untouched, even one matching this viewer's default", async () => {
  // Another viewer may know the community by another name, so the default is
  // never inferred from the text: only Restore defaults sends it.
  const { setLanding, user } = setup({
    landing: {
      landing: true,
      welcome: "Hi there",
      welcomeTitle: "Welcome to Primary",
      name: "Lobby",
    },
  });
  await waitFor(() => expect(titleField()).toHaveValue("Welcome to Primary"));
  setMessage("Say hello");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenLastCalledWith(
      lobby,
      welcome("Say hello", "Welcome to Primary"),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
  await user.click(screen.getByRole("button", { name: "Restore defaults" }));
  expect(titleField()).toHaveValue("Welcome to Primary");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenLastCalledWith(
      lobby,
      welcome(""),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
  // Cleared and typed back in, the same words are a custom title.
  fireEvent.change(titleField(), { target: { value: "" } });
  fireEvent.change(titleField(), { target: { value: "Welcome to Primary" } });
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(setLanding).toHaveBeenLastCalledWith(
      lobby,
      welcome("", "Welcome to Primary"),
      expect.any(AbortSignal),
      expect.any(Function),
    ),
  );
});

it("shows the relay's reason and keeps the draft when it refuses", async () => {
  const { setLanding, user } = setup();
  setLanding.mockRejectedValueOnce(
    new PublishRejected(
      "rejected",
      "invalid: landing requires an open, unarchived channel without a ttl",
    ),
  );
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  setMessage("Say hello");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Landing requires an open, unarchived channel without a ttl",
  );
  expect(messageField()).toHaveValue("Say hello");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
});

/** Saves, but the relay never showed the result within the readback window. */
async function unconfirmedSave(fixture: ReturnType<typeof setup>) {
  fixture.setLanding.mockRejectedValueOnce(
    new ChannelLifecycleUnconfirmed(new Error("timeout")),
  );
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  setMessage("Say hello");
  await fixture.user.click(screen.getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Not confirmed yet");
  expect(alert).not.toHaveTextContent("Saved");
  // The draft stays, but another save would republish blind.
  expect(messageField()).toHaveValue("Say hello");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
}

it("settles an unconfirmed save by reading again, clearing a draft the relay shows", async () => {
  const fixture = setup();
  const { readLanding, setLanding, user } = fixture;
  await unconfirmedSave(fixture);
  readLanding.mockResolvedValue({
    landing: true,
    welcome: "Say hello",
    name: "Lobby",
  });
  await user.click(screen.getByRole("button", { name: "Check again" }));
  // The confirmed outcome is announced like a direct save.
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(readLanding).toHaveBeenCalledTimes(2);
  expect(setLanding).toHaveBeenCalledTimes(1);
  expect(messageField()).toHaveValue("Say hello");
  expect(screen.queryByText(/Not confirmed yet/)).toBeNull();
});

it("keeps the draft in view during the check and reopens Save when the change is missing", async () => {
  const fixture = setup();
  const { readLanding, setLanding, user } = fixture;
  await unconfirmedSave(fixture);
  let release!: (state: ChannelLanding) => void;
  readLanding.mockImplementationOnce(
    () =>
      new Promise<ChannelLanding>((resolve) => {
        release = resolve;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Check again" }));
  try {
    // The published form stays in view while the relay is read again.
    expect(readLanding).toHaveBeenCalledTimes(2);
    expect(messageField()).toBeVisible();
    expect(messageField()).toHaveValue("Say hello");
    const check = screen.getByRole("button", { name: "Check again" });
    expect(check).toHaveAttribute("aria-busy", "true");
    expect(check).toHaveFocus();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  } finally {
    release({ landing: true, welcome: "Hi there", name: "Lobby" });
  }
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  expect(setLanding).toHaveBeenCalledTimes(1);
  expect(messageField()).toHaveValue("Say hello");
  expect(messageField()).toHaveFocus();
  expect(screen.queryByText(/Not confirmed yet/)).toBeNull();
  expect(screen.queryByText("Welcome saved")).toBeNull();
});

it("ends an unconfirmed welcome save, with its draft, when the relay stops supporting welcome channels", async () => {
  const fixture = setup();
  const { user } = fixture;
  await unconfirmedSave(fixture);
  vi.mocked(communityRequest).mockResolvedValueOnce({
    policy: null,
    landingChannels: false,
  });
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(
    await screen.findByText(
      "This community’s relay doesn’t support a welcome channel.",
    ),
  ).toBeVisible();
  // Nothing of the welcome can be saved here now: no notice, check or draft.
  expect(screen.queryByText(/Not confirmed yet/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  // The starter list stays usable, and takes the focus the check had.
  expect(remove("Town square")).toBeEnabled();
  expect(addField()).toHaveFocus();
});

it("announces starter edits, and rests focus in the pane when Cancel or Save takes the action row away", async () => {
  const { user } = setup();
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  await user.click(remove("Town square"));
  expect(
    screen.getByText("#Town square will be removed when you save"),
  ).toHaveAttribute("role", "status");
  await user.type(addField(), "ran");
  await user.click(await screen.findByRole("option", { name: "Random" }));
  expect(
    screen.getByText("#Random will be added when you save"),
  ).toHaveAttribute("role", "status");
  // Back to the published flags: each is an undo, not the reverse change.
  await user.click(remove("Random"));
  expect(screen.getByText("#Random won’t be added")).toHaveAttribute(
    "role",
    "status",
  );
  await user.type(addField(), "town");
  await user.click(await screen.findByRole("option", { name: "Town square" }));
  expect(
    screen.getByText("#Town square stays a starter channel"),
  ).toHaveAttribute("role", "status");
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(remove("Town square"));
  await user.type(addField(), "ran");
  await user.click(await screen.findByRole("option", { name: "Random" }));
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Starter changes discarded")).toHaveAttribute(
    "role",
    "status",
  );
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(channel()).toHaveFocus();
  await user.click(remove("Town square"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  // Save speaks for itself; the edit's announcement is withdrawn.
  expect(screen.queryByText(/will be removed when you save/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(channel()).toHaveFocus();
});

it("keeps the starter list, its typed search and focus when a re-read finds the relay no longer supports welcome channels", async () => {
  const fixture = setup();
  const { user } = fixture;
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  await user.click(remove("Town square"));
  await unconfirmedSave(fixture);
  // The relay's support is read again, and answers while the admin is
  // searching for a channel to add.
  let answer!: () => void;
  vi.mocked(communityRequest).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = () => resolve({ policy: null, landingChannels: false });
      }),
  );
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(communityRequest).toHaveBeenCalledTimes(2));
  await user.type(addField(), "ran");
  await act(async () => answer());
  expect(
    await screen.findByText(
      "This community’s relay doesn’t support a welcome channel.",
    ),
  ).toBeVisible();
  // The same list, not a new one: the search and the pending removal stay.
  expect(addField()).toHaveValue("ran");
  expect(addField()).toHaveFocus();
  expect(removable("Town square")).toBeNull();
  // The search's open list hides the action row from role queries.
  expect(
    screen.getByRole("button", { name: "Save", hidden: true }),
  ).toBeEnabled();
  expect(
    screen.queryByRole("textbox", { name: "Message", hidden: true }),
  ).toBeNull();
});

it("shows Save only for a change, and Cancel returns to the published state", async () => {
  const { setLanding, user } = setup();
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  setMessage("Hi there!");
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  // Typing back to the published text leaves nothing to save.
  setMessage("Hi there");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  setMessage("Draft");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(messageField()).toHaveValue("Hi there");
  expect(channel()).toHaveValue("Lobby");
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(setLanding).not.toHaveBeenCalled();
});

it("starts over from the relay when the community's session changes", async () => {
  const { readLanding, reconnect } = setup();
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  setMessage("Draft");
  reconnect();
  await waitFor(() => expect(readLanding).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("abandons a save that is still in flight when the form closes", async () => {
  const { setLanding, user, view } = setup();
  let settle!: () => void;
  setLanding.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  setMessage("Say hello");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(setLanding).toHaveBeenCalledTimes(1));
  const [, , signal, active] = setLanding.mock.calls[0] ?? [];
  expect(active?.()).toBe(true);
  view.unmount();
  // The lifecycle owner checks this guard right before publishing.
  expect(signal?.aborted).toBe(true);
  expect(active?.()).toBe(false);
  settle();
  await act(async () => {});
});

it("offers a retry when the current welcome cannot be read", async () => {
  const { readLanding, user } = setup();
  readLanding.mockRejectedValueOnce(new Error("Relay unavailable"));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Welcome settings couldn’t be loaded. Relay unavailable",
  );
  await user.click(
    screen.getByRole("button", { name: "Retry loading welcome settings" }),
  );
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
});

it("lists only the starter channels, the welcome channel fixed first", async () => {
  const { user } = setup({
    joined: [
      // Joined channels the directory leaves out are eligible; others are not.
      {
        id: "66666666-6666-4666-8666-666666666666",
        name: "Unlisted",
        channelType: "stream",
        visibility: "public",
        autoJoin: true,
      },
      {
        id: "77777777-7777-4777-8777-777777777777",
        name: "Staff",
        channelType: "stream",
        visibility: "private",
        private: true,
      },
    ],
  });
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  const group = starters();
  // Each flagged channel is listed and removable; the welcome is fixed.
  expect(
    within(group)
      .getAllByRole("button", { name: /^Remove / })
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual([removeLabel("Town square"), removeLabel("Unlisted")]);
  const fixed = within(group).getByText("Lobby");
  expect(
    within(group).getByText("Welcome channel · always joined"),
  ).toBeVisible();
  expect(
    fixed.compareDocumentPosition(remove("Town square")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(removable("Lobby")).toBeNull();
  // Channels that are not starters have no row, however many there are.
  expect(within(group).queryByText("Random")).toBeNull();
  expect(within(group).queryByText("Staff")).toBeNull();
  expect(group).toHaveTextContent(
    "Changes apply when you save, to people who join from then on",
  );
  // The search offers the rest: neither the welcome channel nor a starter.
  await user.click(
    screen.getByRole("button", { name: "Browse channels to add" }),
  );
  const options = await screen.findAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual(["Random"]);
  expect(options[0]?.querySelector("svg")).not.toBeNull();
});

it("browses the first 50 channels by name in both pickers and finds the rest by searching", async () => {
  // Sixty more public channels, each sorting before the fixture's own.
  const many = Array.from({ length: 60 }, (_, index) => {
    const n = String(index + 1).padStart(2, "0");
    return {
      id: `aaaaaa${n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      name: `Channel ${n}`,
      channelType: "stream" as const,
    };
  });
  const { user } = setup({ directory: [...rows, ...many] });
  const hint = "Showing the first 50 channels. Type a name to find more.";
  const names = () =>
    screen.getAllByRole("option").map((option) => option.textContent);
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  // The welcome channel picker: 63 eligible channels, the first 50 shown,
  // also while the field still shows the selected channel's name.
  await user.click(screen.getByRole("button", { name: "Browse channels" }));
  await waitFor(() => expect(names()).toHaveLength(50));
  expect(channel()).toHaveValue("Lobby");
  expect(names()[0]).toBe("Channel 01");
  expect(names()[49]).toBe("Channel 50");
  expect(screen.getByText(hint)).toBeVisible();
  // Reopened by clicking the field, the selection still browses 50.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
  await user.click(channel());
  await waitFor(() => expect(names()).toHaveLength(50));
  expect(channel()).toHaveValue("Lobby");
  // A search covers every channel, including those past the first 50.
  await user.clear(channel());
  await user.type(channel(), "town");
  await waitFor(() => expect(names()).toEqual(["Town square"]));
  expect(screen.queryByText(hint)).toBeNull();
  await user.keyboard("{Escape}");
  // The starter search: 61 addable channels, without the welcome or a starter.
  await user.click(
    screen.getByRole("button", { name: "Browse channels to add" }),
  );
  await waitFor(() => expect(names()).toHaveLength(50));
  expect(names()[0]).toBe("Channel 01");
  expect(screen.getByText(hint)).toBeVisible();
  await user.type(addField(), "random");
  await waitFor(() => expect(names()).toEqual(["Random"]));
  expect(screen.queryByText(hint)).toBeNull();
});

/** Holds the next starter command until `release`, as the relay confirms. */
function holdRun(
  run: ReturnType<typeof setup>["run"],
  flag: ReturnType<typeof setup>["flag"],
) {
  let release!: () => void;
  run.mockImplementationOnce(
    (action, id) =>
      new Promise<void>((resolve) => {
        release = () => {
          flag(id, action === "auto-join-on");
          resolve();
        };
      }),
  );
  return () => act(async () => release());
}

it("adds a starter to the draft and publishes it, after the welcome, on Save", async () => {
  const { flag, run, setLanding, user } = setup();
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  await user.type(addField(), "ran");
  await user.click(await screen.findByRole("option", { name: "Random" }));
  // Only the draft changes: the row is listed as not saved yet.
  expect(run).not.toHaveBeenCalled();
  expect(addField()).toHaveValue("");
  expect(within(starters()).getByText("Added · not saved yet")).toBeVisible();
  expect(remove("Random")).toBeEnabled();
  // A starter change alone offers Save.
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  setMessage("Say hello");
  const release = holdRun(run, flag);
  await user.click(screen.getByRole("button", { name: "Save" }));
  try {
    await waitFor(() =>
      expect(run).toHaveBeenCalledWith(
        "auto-join-on",
        random,
        expect.any(AbortSignal),
        expect.any(Function),
      ),
    );
    // The welcome is published first, then each starter flag.
    expect(setLanding.mock.invocationCallOrder[0]).toBeLessThan(
      run.mock.invocationCallOrder[0] ?? 0,
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(remove("Random")).toBeDisabled();
    expect(remove("Town square")).toBeDisabled();
  } finally {
    await release();
  }
  // One notice for the whole save, and the row is now published.
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  expect(screen.queryByText("Added #Random")).toBeNull();
  expect(within(starters()).queryByText("Added · not saved yet")).toBeNull();
  expect(remove("Random")).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(run).toHaveBeenCalledOnce();
  await user.click(
    screen.getByRole("button", { name: "Browse channels to add" }),
  );
  expect(await screen.findByText("No matching public channels.")).toBeVisible();
});

it("drops a removed starter from the list until Cancel, and publishes the removal on Save", async () => {
  const { run, setLanding, user } = setup();
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  await user.click(remove("Town square"));
  // The row leaves with its button, so focus moves to the search.
  expect(run).not.toHaveBeenCalled();
  expect(removable("Town square")).toBeNull();
  expect(addField()).toHaveFocus();
  expect(within(starters()).getByRole("status")).toHaveTextContent(
    "No other channels added yet",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(remove("Town square")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(remove("Town square"));
  // Adding back a drafted removal leaves nothing to save.
  await user.type(addField(), "town");
  await user.click(await screen.findByRole("option", { name: "Town square" }));
  expect(within(starters()).queryByText("Added · not saved yet")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  await user.click(remove("Town square"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  // An unchanged welcome is not republished.
  expect(setLanding).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "auto-join-off",
    square,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(removable("Town square")).toBeNull();
  // Removed, it can be added again.
  await user.click(
    screen.getByRole("button", { name: "Browse channels to add" }),
  );
  const options = await screen.findAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "Random",
    "Town square",
  ]);
});

it("follows the roster for a joined channel once its flag is saved", async () => {
  const unlisted: ChannelSummary = {
    id: "66666666-6666-4666-8666-666666666666",
    name: "Unlisted",
    channelType: "stream",
    visibility: "public",
  };
  const { run, setJoined, user } = setup({ joined: [unlisted] });
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  await user.type(addField(), "unl");
  await user.click(await screen.findByRole("option", { name: "Unlisted" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  expect(run).toHaveBeenCalledOnce();
  // The readback republished the joined channel; that is what the list shows.
  expect(remove("Unlisted")).toBeVisible();
  expect(within(starters()).queryByText("Added · not saved yet")).toBeNull();
  // Another admin's later change shows too; nothing kept here overrides it.
  setJoined([unlisted]);
  expect(removable("Unlisted")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
});

it("explains a refused removal beside its row and a refused addition on the search", async () => {
  const { run, user } = setup();
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  run.mockRejectedValueOnce(new PublishRejected("rejected"));
  await user.click(remove("Town square"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Only community owners and admins can change this.",
  );
  // The refused removal is listed again, its reason after its row and
  // before the search; nothing is left to save.
  expect(
    remove("Town square").compareDocumentPosition(alert) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    alert.compareDocumentPosition(addField()) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByText("Welcome saved")).toBeNull();
  // Removing it again clears the reason.
  await user.click(remove("Town square"));
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  // A refused addition has no row, so the search explains it.
  run.mockRejectedValueOnce(new PublishRejected("rejected"));
  await user.type(addField(), "ran");
  await user.click(await screen.findByRole("option", { name: "Random" }));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "#Random: Only community owners and admins can change this.",
  );
  expect(removable("Random")).toBeNull();
  // The reason is on the search, and so is the focus Save had.
  expect(addField()).toHaveFocus();
  // Adding it again clears the reason.
  await user.type(addField(), "ran");
  await user.click(await screen.findByRole("option", { name: "Random" }));
  expect(remove("Random")).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("publishes the steps before a refusal and keeps the ones after it in the draft", async () => {
  const unlisted: ChannelSummary = {
    id: "66666666-6666-4666-8666-666666666666",
    name: "Unlisted",
    channelType: "stream",
    visibility: "public",
  };
  const { run, setLanding, user } = setup({ joined: [unlisted] });
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  setMessage("Say hello");
  // Steps run by channel name: Random, Town square, then Unlisted.
  await user.type(addField(), "ran");
  await user.click(await screen.findByRole("option", { name: "Random" }));
  await user.click(remove("Town square"));
  await user.type(addField(), "unl");
  await user.click(await screen.findByRole("option", { name: "Unlisted" }));
  const confirm = run.getMockImplementation();
  if (!confirm) throw new Error("The fixture confirms starter commands");
  run
    .mockImplementationOnce(confirm)
    .mockRejectedValueOnce(
      new PublishRejected("rejected", "invalid: channel is busy"),
    );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Channel is busy");
  expect(setLanding).toHaveBeenCalledOnce();
  expect(run.mock.calls.map(([action, id]) => [action, id])).toEqual([
    ["auto-join-on", random],
    ["auto-join-off", square],
  ]);
  // The welcome is published, so its draft is gone.
  expect(messageField()).toHaveValue("Say hello");
  expect(screen.queryByText("Welcome saved")).toBeNull();
  // Random is published, the refused removal is listed again with its
  // reason, and the step after it waits in the draft.
  expect(remove("Random")).toBeVisible();
  expect(remove("Town square")).toBeVisible();
  const drafted = within(starters()).getAllByText("Added · not saved yet");
  expect(drafted).toHaveLength(1);
  expect(remove("Unlisted").closest(".buzz-preference-row")).toHaveTextContent(
    "Added · not saved yet",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  expect(setLanding).toHaveBeenCalledOnce();
  expect(run.mock.calls.slice(2).map(([action, id]) => [action, id])).toEqual([
    ["auto-join-on", unlisted.id],
  ]);
  expect(within(starters()).queryByText("Added · not saved yet")).toBeNull();
});

it("checks an unconfirmed starter step by reading its channel again", async () => {
  const { flag, readLanding, run, user } = setup();
  await waitFor(() => expect(channel()).toHaveValue("Lobby"));
  readLanding.mockClear();
  run.mockRejectedValueOnce(
    new ChannelLifecycleUnconfirmed(new Error("timeout")),
  );
  await user.click(remove("Town square"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(
    "Not confirmed yet. The relay hasn’t shown the change to #Town square; check before saving again.",
  );
  // The removal stays drafted, but another save would republish blind.
  expect(removable("Town square")).toBeNull();
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  // The relay does not show it yet: Save opens again for the same draft.
  readLanding.mockResolvedValueOnce({ name: "Town square", autoJoin: true });
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
  );
  expect(readLanding).toHaveBeenCalledExactlyOnceWith(
    square,
    expect.any(AbortSignal),
  );
  expect(screen.queryByText(/Not confirmed yet/)).toBeNull();
  expect(screen.queryByText("Welcome saved")).toBeNull();
  expect(removable("Town square")).toBeNull();
  // Unconfirmed again, and this time the check finds it.
  run.mockRejectedValueOnce(
    new ChannelLifecycleUnconfirmed(new Error("timeout")),
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/Not confirmed yet/);
  readLanding.mockImplementationOnce(async () => {
    flag(square, false);
    return { name: "Town square" };
  });
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  expect(screen.queryByText(/Not confirmed yet/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(removable("Town square")).toBeNull();
  // The welcome form was not read again.
  expect(communityRequest).toHaveBeenCalledOnce();
});

it("holds starter edits while the welcome saves", async () => {
  const { setLanding, user } = setup();
  let settle!: () => void;
  setLanding.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  await waitFor(() => expect(messageField()).toHaveValue("Hi there"));
  setMessage("Say hello");
  await user.click(screen.getByRole("button", { name: "Save" }));
  try {
    expect(remove("Town square")).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Browse channels to add" }),
    );
    expect(
      await screen.findByRole("option", { name: "Random" }),
    ).toHaveAttribute("aria-disabled", "true");
  } finally {
    await act(async () => settle());
  }
  // The browse list is still open, hiding the rows from role queries.
  expect(
    screen.getByRole("button", {
      name: removeLabel("Town square"),
      hidden: true,
    }),
  ).toBeEnabled();
});

it("still lists and saves starter channels when the relay has no welcome channel", async () => {
  const { readLanding, run, user } = setup({
    info: { policy: null, landingChannels: false },
  });
  expect(
    await screen.findByText(
      "This community’s relay doesn’t support a welcome channel.",
    ),
  ).toBeVisible();
  await waitFor(() => expect(remove("Town square")).toBeVisible());
  expect(addField()).toBeEnabled();
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(screen.queryByText("Welcome channel · always joined")).toBeNull();
  expect(readLanding).not.toHaveBeenCalled();
  await user.click(remove("Town square"));
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("Welcome saved")).toBeInTheDocument();
  expect(run).toHaveBeenCalledExactlyOnceWith(
    "auto-join-off",
    square,
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(removable("Town square")).toBeNull();
  // With no welcome form, focus from the departed Save rests on the search.
  expect(addField()).toHaveFocus();
});
