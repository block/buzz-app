// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { webcrypto } from "node:crypto";
import { projectTemplateId } from "./workspace";
import { composerDOMFixture } from "../messages/composer-testing";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
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
import { useContext, useLayoutEffect } from "react";
import { TaskCompletionContext } from "../messages/selected-mention-context";
import { createRelaySession, type RelaySession } from "../relay/session";
import * as modelStorage from "../messages/solo-model-picks-storage";
import { readView, writeView } from "../../shared/view-state";
import { linkedDraftKey, type LinkedChat } from "./linked-chat";
import { SoloDraft, resetNewChatProject } from "./SoloDraft";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { ChatNotStarted, createChannelWrites } from "../relay/channel-writes";
import { createOutbox, type Outbox } from "../relay/outbox";
import { createMessages } from "../relay/messages";
import { taskTokenFallback, taskTokenTags } from "../messages/task-tokens";
import { composerMarkdown } from "../messages/composer-markdown";
import { composerTokenName } from "../messages/composer-token";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { SOLO_LABEL } from "./labels";
import { setDefaultAgent } from "./default-agent";
import { attachmentDraft } from "../messages/attachment-draft";
import { createSoloRegionFixture } from "../channel-navigation/solo-navigation-testing";
import { mentionDraft } from "../messages/mention-draft";
import {
  projectComposerDocument,
  readComposerDocument,
} from "../messages/composer-document";
import * as soloNavigation from "../channel-navigation/solo-navigation";
import { soloDraft } from "../channel-navigation/routes";
import { MentionPicker } from "../../bundled/mentions/MentionPicker";
import type {
  ComposerToolProps,
  ConversationExtensions,
} from "../conversation/contracts";
import { createAgentChoices } from "../agents/choices";
import { createAgentLibrary } from "../agents/library";
import { AgentsContext } from "../agents/react";
import type { Agents } from "../agents/service";
import { MentionCompletion } from "../../bundled/mentions/MentionCompletion";
import { mentionQuery } from "../../bundled/mentions/mention-query";
import type { ComposerCompletion } from "../conversation/contracts";
import type { Contribution } from "../../plugins/contributions";

vi.mock(
  "../messages/solo-model-picks-storage",
  () => import("../messages/solo-model-picks-storage-testing"),
);

composerDOMFixture();
afterEach(cleanup);
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: { request: async (_name: string, run: () => unknown) => run() },
  });
  // jsdom lacks what the completion popup uses to position and reveal rows.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
const existing = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Engineering",
  channelType: "stream" as const,
  members: ["a".repeat(64)],
};
function taggedDraft(
  text: string,
  key = "a".repeat(64),
  name = "Member agent",
) {
  const mention = `@${name}`;
  return {
    text: `${mention} ${text}`,
    recipients: [{ pubkey: key, name, start: 0, end: mention.length }],
  };
}
const noOperations: readonly never[] = [];
/** Stands in for the mentions picker's pill: same name, same audience contract. */
function Audience({ audience }: ComposerToolProps) {
  return audience ? (
    <>
      <output
        aria-label={`Sending to ${audience.recipients
          .map((person) => person.name)
          .join(", ")}. Change agents`}
      />
      {[
        { pubkey: "a".repeat(64), name: "Member agent" },
        { pubkey: "b".repeat(64), name: "Outside agent" },
      ].map((agent) => (
        <button
          key={agent.pubkey}
          type="button"
          onClick={() => audience.only([agent])}
        >
          Send to {agent.name}
        </button>
      ))}
    </>
  ) : null;
}
const pillTools = [
  {
    id: "audience",
    key: "test/audience",
    pluginId: "test",
    revision: "1",
    title: "Audience",
    component: Audience,
  },
];
const noInline: readonly never[] = [];
const withPill = {
  inline: { snapshot: () => noInline, subscribe: () => () => {} },
  tools: { snapshot: () => pillTools, subscribe: () => () => {} },
} as unknown as ConversationExtensions;
const sendingTo = (names: string) =>
  screen.getByRole("status", { name: `Sending to ${names}. Change agents` });
function setup(available = true) {
  const rows = [
    { pubkey: "a".repeat(64), name: "Member agent" },
    { pubkey: "b".repeat(64), name: "Outside agent" },
  ];
  const agents = {
    status: "ready",
    complete: true,
    identities: rows,
    selectable: rows,
    archives: { status: "unavailable" as const, archived: [] },
  };
  const emoji = { status: "ready", entries: [] };
  const channelWrites = {
    available,
    addAgents: vi.fn(async () => {}),
    create: vi.fn<RelaySession["channelWrites"]["create"]>(() =>
      "c".repeat(64),
    ),
    delivered: vi.fn<RelaySession["channelWrites"]["delivered"]>(
      async () => {},
    ),
    refresh: vi.fn(async () => {}),
    failed: (_id: string) => false,
    discardFailed: vi.fn(async (_id: string) => {}),
    ready: Promise.resolve() as Promise<void>,
    start: vi.fn(
      (
        id: string,
        title: string,
        members: readonly string[],
        ttlSeconds?: number,
        named = false,
        setup?: { canvas: string; apply(): Promise<void> },
      ) => {
        const create = channelWrites.create(
          id,
          title,
          ttlSeconds,
          named,
          members,
        );
        void channelWrites.ready.then(() => setup?.apply()).catch(() => {});
        return { create, ready: channelWrites.ready };
      },
    ),
  };
  const messages = {
    send: vi.fn<RelaySession["messages"]["send"]>(() => "d".repeat(64)),
  };
  const viewer = "f".repeat(64);
  let channelSnapshot = {
    channels: [
      {
        id: "",
        channelType: "solo" as const,
        creator: viewer,
        members: existing.members,
      },
    ],
  };
  const profileSnapshot = new Map();
  const session = {
    viewer,
    channelWrites,
    messages,
    channels: {
      list: () => {
        // The chat a start last refreshed, or the one it just created.
        const id =
          (
            channelWrites.refresh.mock.calls.at(-1) as string[] | undefined
          )?.[0] ??
          channelWrites.create.mock.calls.at(-1)?.[0] ??
          "";
        if (channelSnapshot.channels[0]?.id !== id)
          channelSnapshot = {
            channels: [
              {
                id,
                channelType: "solo",
                creator: viewer,
                members: existing.members,
              },
            ],
          };
        return channelSnapshot;
      },
      subscribeList: () => () => {},
    },
    profiles: {
      ensure: vi.fn(async () => {}),
      snapshot: () => profileSnapshot,
      subscribe: () => () => {},
    },
    agentChoices: {
      retain: () => () => {},
      snapshot: () => agents,
      subscribe: () => () => {},
      refresh: async () => {},
    },
    emoji: {
      snapshot: () => emoji,
      subscribe: () => () => {},
      ensure: async () => {},
    },
    outbox: {
      ready: async () => {},
      whenPrepared: vi.fn(async () => ({})),
      supports: () => true,
      snapshot: () => noOperations,
      subscribe: () => () => {},
      dismiss: vi.fn(async () => {}),
    },
    media: (url: string) => url,
  } as unknown as RelaySession;
  return { session, channelWrites, messages };
}
it("uses restored explicit mentions, not a separate picker", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  writeView("test", "solo:new-draft", {
    text: "@Outside agent Help",
    recipients: [
      { pubkey: "b".repeat(64), name: "Outside agent", start: 0, end: 14 },
    ],
  });
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  expect(screen.queryByRole("button", { name: "Choose an agent" })).toBeNull();
  await user.click(screen.getByRole("textbox"));
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  // The create names the agent; no separate add.
  expect(test.channelWrites.start).toHaveBeenCalledWith(
    id,
    expect.any(String),
    ["b".repeat(64)],
    undefined,
    false,
    undefined,
  );
  expect(test.channelWrites.addAgents).not.toHaveBeenCalled();
  expect(test.messages.send).toHaveBeenCalledWith(id, "@Outside agent Help", [
    "b".repeat(64),
  ]);
});
type User = ReturnType<typeof userEvent.setup>;
it.each([
  {
    begun: "text",
    begin: (user: User) => user.type(screen.getByRole("textbox"), "Next idea"),
    kept: () =>
      expect(screen.getByRole("textbox")).toHaveTextContent("Next idea"),
  },
  {
    begun: "a file",
    begin: (user: User) =>
      user.upload(
        screen.getByLabelText("Choose attachments"),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ),
    // The chip is still animating in; whether it is kept is what matters.
    kept: () =>
      expect(
        screen.getByRole("button", { name: "Remove notes.txt" }),
      ).toBeInTheDocument(),
  },
  {
    begun: "settings",
    begin: async (user: User) => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
      await user.click(
        await screen.findByRole("radio", { name: /^Temporary/ }),
      );
      await user.click(screen.getByRole("button", { name: "Save changes" }));
    },
    kept: () =>
      expect(readView("test", "solo:settings", null)).toMatchObject({
        ttlSeconds: 604800,
      }),
  },
  {
    begun: "a workspace",
    begin: async (user: User) => {
      await user.click(screen.getByRole("button", { name: "Add workspace" }));
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Other" }),
      );
    },
    kept: () =>
      expect(
        screen.getByRole("button", { name: "Workspace: Other" }),
      ).toBeVisible(),
  },
])(
  "a refused start reports why and never overwrites $begun begun in New chat since",
  async ({ begin, kept }) => {
    const test = await projectSetup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    Object.assign(test.session, {
      attachments: { uploadForNewChat: vi.fn(async () => notes) },
    });
    const refuse = refusedStart(test);
    const view = () => (
      <SoloDraft
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    );
    const first = render(view());
    await user.type(screen.getByRole("textbox"), "Lost start");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    const id = test.channelWrites.create.mock.calls[0]?.[0];
    first.unmount();
    // A new chat is being written when the relay refuses the first.
    render(view());
    await begin(user);
    await refuse();
    await waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        id,
        expect.stringMatching(
          /^Couldn't start ".+": Channel creation rejected\. New chat has a newer draft, so your message was not restored\.$/,
        ),
      ),
    );
    kept();
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Lost start");
    expect(readView("test", `draft:${id}`, null)).toBeNull();
  },
);
it("a refused start gives its prompt, files and settings back to a blank New chat", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Audit the onboarding flow"));
  writeView("test", "solo:settings", { name: "Onboarding audit" });
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  first.unmount();
  // New chat is open and still blank when the relay refuses the first.
  render(view());
  expect(screen.getByRole("textbox")).not.toHaveTextContent("Audit");
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      id,
      `Couldn't start "Onboarding audit": Channel creation rejected. Your message is back in New chat.`,
    ),
  );
  expect(screen.getByRole("textbox")).toHaveTextContent(
    "Audit the onboarding flow",
  );
  expect(screen.getByRole("button", { name: "Remove notes.txt" })).toBeTruthy();
  expect(readView("test", `draft:${id}`, null)).toBeNull();
  // Sending again starts a new chat with the same name and the upload made.
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  const retry = test.channelWrites.create.mock.calls[1]?.[0];
  expect(retry).not.toBe(id);
  expect(test.channelWrites.start).toHaveBeenLastCalledWith(
    retry,
    "Onboarding audit",
    ["a".repeat(64)],
    undefined,
    true,
    undefined,
  );
  expect(test.messages.send).toHaveBeenLastCalledWith(
    retry,
    taggedDraft("Audit the onboarding flow").text,
    ["a".repeat(64)],
    [notes],
  );
  expect(uploadForNewChat).toHaveBeenCalledOnce();
});
/** The next start the relay refuses once `refuse` is called. */
function refusedStart(test: ReturnType<typeof setup>) {
  let refuse = () => {};
  const ready = new Promise<void>((_resolve, reject) => {
    refuse = () => reject(new ChatNotStarted("Channel creation rejected"));
  });
  ready.catch(() => {});
  test.channelWrites.ready = ready;
  return async () => {
    await act(async () => {
      refuse();
      await ready.catch(() => {});
    });
  };
}
/** Writes to these view keys fail, as when storage is full. */
function failingViewWrites(
  keys: readonly string[],
  fails: (value: string) => boolean = () => true,
) {
  const names = new Set(
    keys.map((key) => `buzz-view.v1:${JSON.stringify(["test", key])}`),
  );
  const setItem = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    name,
    value,
  ) {
    if (names.has(name) && fails(value)) throw new Error("Storage full");
    setItem.call(this, name, value);
  });
}
it.each([true, false])(
  "a prompt given back to an open New chat keeps the caret only where it was (in the editor=%s)",
  async (inEditor) => {
    const test = setup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    const refuse = refusedStart(test);
    writeView("test", "solo:new-draft", taggedDraft("Audit the flow"));
    const view = (focusRequest = 0) => (
      <SoloDraft
        focusRequest={focusRequest}
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    );
    const first = render(view());
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    first.unmount();
    render(view(1));
    expect(screen.getByRole("textbox")).toHaveFocus();
    // Stands in for Settings or another surface that owns focus.
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    try {
      if (!inEditor) elsewhere.focus();
      await refuse();
      await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      expect(input).toHaveTextContent("Audit the flow");
      if (inEditor) {
        expect(input).toHaveFocus();
        expect(input.selectionStart).toBe(input.value.length);
      } else expect(elsewhere).toHaveFocus();
    } finally {
      elsewhere.remove();
    }
  },
);
it("a prompt that can't be saved back leaves an open New chat as it is", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Audit the flow"));
  writeView("test", "solo:settings", { name: "Audit the flow" });
  const picks = { ["a".repeat(64)]: { model: "deep", type: "test/agent" } };
  writeView("test", "solo:model-picks:solo:new-draft", picks);
  const agents = soloModelAgents();
  const view = () => (
    <AgentsContext.Provider value={agents}>
      <SoloDraft
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    </AgentsContext.Provider>
  );
  const first = render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  render(view());
  const storage = failingViewWrites(["solo:new-draft"]);
  try {
    await refuse();
    await waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("Retry to restore your message"),
        expect.any(Function),
      ),
    );
    expect(onFailed.mock.calls[0]?.[1]).toContain(
      "Your message could not be saved on this device.",
    );
    expect(onFailed.mock.calls[0]?.[1]).not.toContain("Window ownership");
    // Nothing else is given back either: the settings would be those of a
    // prompt New chat does not hold.
    expect(screen.getByRole("textbox")).not.toHaveTextContent("Audit");
    expect(readView("test", "solo:settings", null)).toBeNull();
    expect(
      readView("test", "solo:model-picks:solo:new-draft", null) ?? {},
    ).toEqual({});
  } finally {
    storage.mockRestore();
  }
  await act(async () => onFailed.mock.calls[0]?.[2]());
  expect(screen.getByRole("textbox")).toHaveTextContent("Audit the flow");
  expect(readView("test", "solo:settings", null)).toMatchObject({
    name: "Audit the flow",
  });
  expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual(
    picks,
  );
  expect(onFailed.mock.calls[1]?.[1]).toContain(
    "Your message is back in New chat",
  );
  expect(onFailed.mock.calls[1]?.[2]).toBeUndefined();
  expect(test.messages.send).toHaveBeenCalledOnce();
});
it("a newer draft the composer couldn't save still keeps a refused prompt out of New chat", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  const refused = taggedDraft("Audit");
  writeView("test", "solo:new-draft", refused);
  const modelAgents = soloModelAgents();
  const view = () => (
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    </AgentsContext.Provider>
  );
  const first = render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  render(view());
  // Storage near its quota: the longer new prompt no longer fits, while the
  // shorter refused one still would.
  const storage = failingViewWrites(
    ["solo:new-draft"],
    (value) => value.length > JSON.stringify(refused).length,
  );
  try {
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.value = "A much longer idea than storage has room for now. ".repeat(
      4,
    );
    fireEvent.input(input);
    expect(readView("test", "solo:new-draft", null)).toBe("");
    // Saving a model choice must not clear the unsaved text guard either.
    await user.click(
      screen.getByRole("button", { name: "Model and effort for this chat" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Model for Member agent in this chat",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Deep" }),
    );
    // Remove the durable choice so only the unsaved text protects recovery.
    act(() => {
      writeView("test", "solo:model-picks:solo:new-draft", null);
    });
    await refuse();
    await waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringMatching(
          /\. New chat has a newer draft, so your message was not restored\.$/,
        ),
      ),
    );
    expect(screen.getByRole("textbox")).toBe(input);
    expect(input.value).toContain("A much longer idea");
    expect(readView("test", "solo:new-draft", null)).toBe("");
  } finally {
    storage.mockRestore();
  }
});
it("a prompt given back whose settings can't be saved says so instead of retrying with defaults", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Audit the flow"));
  writeView("test", "solo:settings", { name: "Audit", ttlSeconds: 604800 });
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  render(view());
  const storage = failingViewWrites(["solo:settings", "solo:new-project"]);
  try {
    await refuse();
    await waitFor(() =>
      expect(onFailed).toHaveBeenCalledWith(
        expect.any(String),
        `Couldn't start "Audit": Channel creation rejected. Your message is back in New chat, but its settings and workspace could not be saved on this device.`,
      ),
    );
    expect(screen.getByRole("textbox")).toHaveTextContent("Audit the flow");
    expect(readView("test", "solo:settings", null)).toBeNull();
  } finally {
    storage.mockRestore();
  }
});
it("a refused start leaves New chat alone while its settings are being edited", async () => {
  const test = await projectSetup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Audit the flow"));
  writeView("test", "solo:settings", { name: "Audit", ttlSeconds: 604800 });
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  render(view());
  await user.click(screen.getByRole("button", { name: "Chat settings" }));
  const name = await screen.findByRole("textbox", { name: /^Chat name/ });
  expect(name).toHaveValue("");
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(
        /\. New chat has a newer draft, so your message was not restored\.$/,
      ),
    ),
  );
  // The dialog saves what it shows, not settings it never showed.
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(readView("test", "solo:settings", null)).toEqual({
      canvas: "",
      name: "",
    }),
  );
  expect(screen.getByRole("textbox")).not.toHaveTextContent("Audit the flow");
});
it("a second refused start finds the first's prompt in New chat and says so", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const refuseFirst = refusedStart(test);
  const first = render(view());
  await user.type(screen.getByRole("textbox"), "First idea");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  const refuseSecond = refusedStart(test);
  const second = render(view());
  await user.type(screen.getByRole("textbox"), "Second idea");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  second.unmount();
  const [a, b] = test.channelWrites.create.mock.calls.map((call) => call[0]);
  await refuseFirst();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      a,
      expect.stringMatching(/\. Your message is back in New chat\.$/),
    ),
  );
  await refuseSecond();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      b,
      expect.stringMatching(
        /\. New chat holds an earlier message that couldn't be sent, so this one was not restored\.$/,
      ),
    ),
  );
  render(view());
  expect(screen.getByRole("textbox")).toHaveTextContent("First idea");
  expect(screen.getByRole("textbox")).not.toHaveTextContent("Second idea");
});
it("a refused start gives the pill's chosen agent back with its prompt", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      extensions={withPill}
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await user.click(
    screen.getByRole("button", { name: "Send to Outside agent" }),
  );
  expect(sendingTo("Outside agent")).toBeInTheDocument();
  await user.type(screen.getByRole("textbox"), "Hello");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  expect(test.messages.send).toHaveBeenLastCalledWith(id, "Hello", [
    "b".repeat(64),
  ]);
  first.unmount();
  // New chat opens again from the default agent, as always.
  render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      id,
      expect.stringMatching(/\. Your message is back in New chat\.$/),
    ),
  );
  expect(screen.getByRole("textbox")).toHaveTextContent("Hello");
  await waitFor(() => expect(sendingTo("Outside agent")).toBeInTheDocument());
  expect(screen.getByRole("textbox")).not.toHaveTextContent("@");
  // The relay accepts the retry.
  test.channelWrites.ready = Promise.resolve();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  const retry = test.channelWrites.create.mock.calls[1]?.[0];
  expect(test.channelWrites.start).toHaveBeenLastCalledWith(
    retry,
    expect.any(String),
    ["b".repeat(64)],
    undefined,
    false,
    undefined,
  );
  expect(test.messages.send).toHaveBeenLastCalledWith(retry, "Hello", [
    "b".repeat(64),
  ]);
  // The pick was for that prompt: the next New chat starts from the default.
  expect(readView("test", "solo:new-draft:agents", null)).toBeNull();
});
it("a pick after a refused start's agent comes back replaces it, unsaved", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      extensions={withPill}
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const sent = render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await user.click(
    screen.getByRole("button", { name: "Send to Outside agent" }),
  );
  await user.type(screen.getByRole("textbox"), "Hello");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  sent.unmount();
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringMatching(/\. Your message is back in New chat\.$/),
    ),
  );
  const restored = render(view());
  await waitFor(() => expect(sendingTo("Outside agent")).toBeInTheDocument());
  await user.click(
    screen.getByRole("button", { name: "Send to Member agent" }),
  );
  expect(sendingTo("Member agent")).toBeInTheDocument();
  restored.unmount();
  // Shown again, New chat starts from the default, not the refused pick.
  render(view());
  expect(screen.getByRole("textbox")).toHaveTextContent("Hello");
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
});
it("a refused linked start gives its source and workspace back to the New chat opened after it", async () => {
  const test = await projectSetup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const refuse = refusedStart(test);
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  writeView("test", linkedDraftKey(linkedId), source);
  const view = () => (
    <SoloDraft
      session={test.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      focusRequest={1}
      extensions={withPill}
      onStarted={onStarted}
      onFailed={onFailed}
    />
  );
  const first = render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  expect(screen.getByRole("textbox")).toHaveValue(`${source.link} `);
  await user.keyboard("Investigate");
  await user.click(screen.getByRole("button", { name: "Add workspace" }));
  await user.click(await screen.findByRole("menuitemradio", { name: "Other" }));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  first.unmount();
  // The start used up the source, so nothing could open this draft again.
  expect(readView("test", linkedDraftKey(linkedId), null)).toBeNull();
  await refuse();
  await waitFor(() =>
    expect(onFailed).toHaveBeenCalledWith(
      test.channelWrites.create.mock.calls[0]?.[0],
      expect.stringMatching(/\. Your message is back in New chat\.$/),
    ),
  );
  expect(readView("test", linkedDraftKey(linkedId), null)).toEqual(source);
  expect(test.messages.send).toHaveBeenCalledExactlyOnceWith(
    test.channelWrites.create.mock.calls[0]?.[0],
    `${source.link} Investigate`,
    ["a".repeat(64)],
  );
  // New chat, opened as the refusal is reported, holds it all again.
  render(view());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.value).toBe(`${source.link} Investigate`);
  expect(input).toHaveFocus();
  expect(input.selectionStart).toBe(input.value.length);
  expect(
    screen.getByRole("button", { name: "Workspace: Other" }),
  ).toBeVisible();
});

it("a start that is only unconfirmed keeps the chat and its message", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  test.channelWrites.ready = Promise.reject(
    new Error("Still waiting for confirmation"),
  );
  test.channelWrites.ready.catch(() => {});
  render(
    <SoloDraft
      session={test.session}
      scope="test"
      onStarted={onStarted}
      onFailed={onFailed}
    />,
  );
  await user.type(screen.getByRole("textbox"), "Maybe made");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  await act(() => test.channelWrites.ready.catch(() => {}));
  expect(onFailed).not.toHaveBeenCalled();
  expect(test.session.outbox?.dismiss).not.toHaveBeenCalled();
  expect(test.channelWrites.discardFailed).not.toHaveBeenCalled();
  expect(readView("test", "solo:new-draft", null)).toBe("");
});
it("cannot send on an unsupported community", async () => {
  const test = setup(false),
    user = userEvent.setup();
  render(
    <SoloDraft session={test.session} scope="test" onStarted={() => {}} />,
  );
  await user.type(screen.getByRole("textbox"), "Draft");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
});

it("opens the chat and sends its message before the relay confirms the create", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  test.channelWrites.ready = new Promise(() => {});
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.type(screen.getByRole("textbox"), "Right away");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.channelWrites.start).toHaveBeenCalledOnce();
  expect(test.channelWrites.delivered).not.toHaveBeenCalled();
  expect(test.messages.send).toHaveBeenCalledWith(
    test.channelWrites.create.mock.calls[0]?.[0],
    "Right away",
    ["a".repeat(64)],
  );
});

it.each([false, true])(
  "applies section defaults once the chat starts; failed setup still keeps the chat (failure=%s)",
  async (failure) => {
    vi.stubGlobal("crypto", webcrypto);
    try {
      const test = setup();
      const sequence: string[] = [];
      const onStarted = vi.fn();
      const id = await projectTemplateId("work");
      const canvasSave = vi.fn(async (_channel: string, _content: string) => {
        sequence.push("canvas");
        if (failure) throw new Error("Canvas save failed");
        return { id: "f".repeat(64) };
      });
      Object.assign(test.session, {
        channelKit: {
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            entries: [
              {
                eventId: "head",
                record: {
                  value: {
                    type: "template",
                    id,
                    canvas: "Use /repo",
                    agents: [],
                    teamIds: [],
                  },
                },
              },
            ],
          }),
        },
        soloPreferences: {
          writable: true,
          refresh: async () => {},
          snapshot: () => ({
            status: "ready",
            data: { sections: [{ id: "work", name: "Work" }], assignments: {} },
          }),
          assign: async () => {
            sequence.push("placement");
          },
        },
        canvas: { read: async () => undefined, save: canvasSave },
      });
      test.messages.send.mockImplementation(() => {
        sequence.push("send");
        return "d".repeat(64);
      });
      writeView(
        "test",
        "solo:project:work:new-draft",
        taggedDraft("Build this"),
      );
      render(
        <SoloDraft
          session={test.session}
          scope="test"
          projectId="work"
          onStarted={onStarted}
        />,
      );
      const user = userEvent.setup();
      await user.click(
        screen.getByRole("textbox", { name: "Message your agents" }),
      );
      await user.keyboard("{Enter}");
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      expect(test.channelWrites.create).toHaveBeenCalledOnce();
      await waitFor(() =>
        // The chat joins its workspace at once and its message goes out;
        // the Canvas is saved behind them.
        expect(sequence).toEqual(["placement", "send", "canvas"]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it("edits draft settings before creation, restores them, and applies Canvas once the chat starts", async () => {
  const test = setup();
  const order: string[] = [];
  const saveCanvas = vi.fn(async () => {
    order.push("canvas");
  });
  Object.assign(test.session, {
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  test.messages.send.mockImplementation(() => {
    order.push("send");
    return "d".repeat(64);
  });
  const onStarted = vi.fn();
  const user = userEvent.setup();
  const view = (focusRequest: number | AbortSignal = 0) => (
    <SoloDraft
      focusRequest={focusRequest}
      session={test.session}
      scope="test"
      onStarted={onStarted}
    />
  );
  let mounted = render(view());
  await user.click(screen.getByRole("button", { name: "Chat settings" }));
  const canvas = await screen.findByRole("textbox", { name: /^Instructions/ });
  expect(canvas).toHaveValue("");
  await user.clear(canvas);
  await user.type(canvas, "Keep the change small");
  // A stray outside click keeps the dialog and the typed instructions.
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await Promise.resolve();
  expect(screen.getByRole("textbox", { name: /^Instructions/ })).toHaveValue(
    "Keep the change small",
  );
  await user.click(screen.getByRole("radio", { name: /^Temporary/ }));
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Chat settings" })).toHaveFocus(),
  );
  expect(screen.queryByRole("menu")).toBeNull();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(saveCanvas).not.toHaveBeenCalled();
  mounted.unmount();
  mounted = render(view(1));
  const composer = screen.getByRole("textbox", {
    name: "Message your agents",
  });
  expect(composer).toHaveFocus();
  const actions = screen.getByRole("button", { name: "Chat settings" });
  actions.focus();
  expect(actions).toHaveFocus();
  mounted.rerender(view(new AbortController().signal));
  expect(composer).toHaveFocus();
  await user.type(composer, "Build this");
  await user.keyboard("{Enter}");
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(test.channelWrites.create.mock.calls[0]?.[2]).toBe(604800);
  expect(test.channelWrites.create).toHaveBeenCalledOnce();
  await waitFor(() =>
    expect(saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "Keep the change small",
      undefined,
    ),
  );
  expect(order).toEqual(["send", "canvas"]);
});

it("a new Solo chat for a named agent starts with it in the pill, not the default", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const agent = "b".repeat(64);
  render(
    <SoloDraft
      agent={agent}
      session={f.session}
      scope="me-route-agent"
      extensions={withPill}
      onStarted={started}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(sendingTo("Outside agent")).toBeInTheDocument());
  // The agent is never inserted into the text.
  expect(input).not.toHaveTextContent("@");
  await user.type(input, "Hello");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const [id] = started.mock.calls[0] ?? [];
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(id, "Hello", [agent]);
});

it("a named agent replaces a saved new-chat draft that holds only another agent's tag", async () => {
  const f = setup();
  const scope = "me-route-agent-after-default";
  // A draft saved by an earlier default that tagged its agent in the text.
  writeView(scope, "solo:new-draft", taggedDraft(""));
  render(
    <SoloDraft
      agent={"b".repeat(64)}
      session={f.session}
      scope={scope}
      extensions={withPill}
      onStarted={vi.fn()}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(sendingTo("Outside agent")).toBeInTheDocument());
  expect(input).not.toHaveTextContent("@Member agent");
});

it("a named agent keeps a saved new-chat draft that has the person's own text, whose mention is the recipient", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const scope = "me-route-agent-after-text";
  writeView(scope, "solo:new-draft", taggedDraft("Keep this"));
  render(
    <SoloDraft
      agent={"b".repeat(64)}
      session={f.session}
      scope={scope}
      extensions={withPill}
      onStarted={started}
    />,
  );
  const input = screen.getByRole("textbox");
  await waitFor(() => expect(input).toHaveTextContent("Keep this"));
  expect(input).toHaveTextContent("@Member agent");
  expect(input).not.toHaveTextContent("@Outside agent");
  // Its inline mention decides who hears it; the named agent steps aside.
  expect(sendingTo("Member agent")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.messages.send).toHaveBeenCalledExactlyOnceWith(
    started.mock.calls[0]?.[0],
    expect.stringContaining("Keep this"),
    ["a".repeat(64)],
  );
});

it("a new Solo chat needs a tagged agent to send", async () => {
  const f = setup();
  // No agent is available, so nothing seeds the pill.
  const none = {
    status: "ready",
    complete: true,
    identities: [],
    selectable: [],
    archives: { status: "unavailable" as const, archived: [] },
  };
  Object.assign(f.session.agentChoices, { snapshot: () => none });
  const user = userEvent.setup();
  render(
    <SoloDraft
      session={f.session}
      scope="me-untagged"
      extensions={withPill}
      onStarted={vi.fn()}
    />,
  );
  expect(sendingTo("")).toBeInTheDocument();
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  input.value = "Start here";
  fireEvent.input(input);
  await user.keyboard("{Enter}");
  const form = input.closest("form");
  if (!form) throw new Error("Missing composer form");
  fireEvent.submit(form);
  expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  expect(f.channelWrites.create).not.toHaveBeenCalled();
});

it("opens and saves local draft settings in a fresh Solo project after a failed initial read", async () => {
  vi.stubGlobal("crypto", webcrypto);
  try {
    const f = setup();
    const refreshSolo = vi.fn(async () => {});
    // Both the workspace's preload on mount and the settings dialog's read
    // fail.
    refreshSolo
      .mockRejectedValueOnce(new Error("Settings unavailable"))
      .mockRejectedValueOnce(new Error("Settings unavailable"));
    Object.assign(f.session, {
      soloPreferences: {
        writable: true,
        refresh: refreshSolo,
        snapshot: () => ({
          status: "ready",
          data: {
            sections: [{ id: "solo-only", name: "Work" }],
            assignments: {},
          },
        }),
      },
      channelKit: {
        refresh: async () => {},
        snapshot: () => ({ status: "ready", entries: [] }),
      },
    });
    const view = () => (
      <SoloDraft
        session={f.session}
        scope="solo-settings"
        projectId="solo-only"
        onStarted={() => {}}
      />
    );
    const user = userEvent.setup();
    const mounted = render(view());
    const open = async () => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
    };
    await open();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings unavailable",
    );
    expect(screen.queryByText("Loading settings…")).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshSolo.mockImplementationOnce(() => held);
    const reads = refreshSolo.mock.calls.length;
    try {
      await user.click(screen.getByRole("button", { name: "Retry settings" }));
      await waitFor(() => expect(refreshSolo).toHaveBeenCalledTimes(reads + 1));
      expect(screen.getByRole("status")).toHaveTextContent("Loading settings…");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
    } finally {
      release();
    }
    await user.type(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
      "Keep this Solo draft",
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(refreshSolo).toHaveBeenCalledTimes(reads + 1);
    mounted.unmount();
    render(view());
    await open();
    expect(
      await screen.findByRole("textbox", { name: /^Instructions/ }),
    ).toHaveValue("Keep this Solo draft");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(f.channelWrites.create).not.toHaveBeenCalled();
    expect(f.messages.send).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("invalid stored draft lifetime fails visibly without a new create", async () => {
  const h = setup();
  writeView("test", "solo:new-draft", taggedDraft("Keep this draft"));
  writeView("test", "solo:settings", { canvas: "", ttlSeconds: -1 });
  const user = userEvent.setup();
  render(<SoloDraft session={h.session} scope="test" onStarted={() => {}} />);
  await user.click(screen.getByRole("button", { name: "Send message" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "duration could not be verified",
  );
  expect(h.channelWrites.create).not.toHaveBeenCalled();
  expect(h.channelWrites.delivered).not.toHaveBeenCalled();
});

async function projectSetup() {
  vi.stubGlobal("crypto", webcrypto);
  const f = setup();
  const entries = await Promise.all(
    ["work", "other"].map(async (id) => ({
      eventId: id,
      record: {
        value: {
          type: "template",
          id: await projectTemplateId(id),
          canvas: `${id} instructions`,
          agents: [],
          teamIds: [],
        },
      },
    })),
  );
  const preferences = {
    status: "ready",
    data: {
      sections: [
        { id: "work", name: "Work" },
        { id: "other", name: "Other" },
      ],
      assignments: {},
    },
  };
  const saveCanvas = vi.fn(async () => {});
  const assign = vi.fn(async (_id: string, _sectionId?: string) => {});
  Object.assign(f.session, {
    soloPreferences: {
      writable: true,
      refresh: async () => {},
      snapshot: () => preferences,
      subscribe: () => () => {},
      assign,
    },
    channelKit: {
      refresh: async () => {},
      snapshot: () => ({ status: "ready", entries }),
    },
    canvas: { read: async () => undefined, save: saveCanvas },
  });
  return { ...f, saveCanvas, assign, entries };
}

it("a workspace's defaults changed while New chat is open start the chat", async () => {
  const f = await projectSetup();
  const refresh = vi.fn(async () => {});
  Object.assign(f.session.channelKit, { refresh });
  const user = userEvent.setup();
  const started = vi.fn();
  render(
    <SoloDraft
      session={f.session}
      scope="changed-defaults"
      projectId="work"
      onStarted={started}
    />,
  );
  // The defaults load once the workspace is picked; then they are saved anew.
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  await act(async () => {});
  const [work] = f.entries;
  if (!work) throw new Error("missing work defaults");
  f.entries[0] = {
    ...work,
    eventId: "work-2",
    record: {
      value: { ...work.record.value, canvas: "new work instructions" },
    },
  };
  await user.type(screen.getByRole("textbox"), "Go");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(f.saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "new work instructions",
      undefined,
    ),
  );
});

it("re-entering a mounted project clears changed defaults", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const scope = "project-reset";
  const key = "solo:project:work";
  writeView(scope, `${key}:new-project`, "other");
  writeView(scope, `${key}:settings`, "other edited instructions");
  render(
    <SoloDraft
      projectId="work"
      session={f.session}
      scope={scope}
      onStarted={started}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Workspace: Other" }),
  ).toBeVisible();
  act(() => resetNewChatProject(scope, "work"));
  expect(
    await screen.findByRole("button", { name: "Workspace: Work" }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Chat settings" }));
  expect(
    await screen.findByRole("textbox", { name: /^Instructions/ }),
  ).toHaveValue("work instructions");
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.type(screen.getByRole("textbox"), "Start in Work");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.assign).toHaveBeenCalledWith(expect.any(String), "work");
  expect(f.saveCanvas).toHaveBeenCalledWith(
    expect.any(String),
    "work instructions",
    undefined,
  );
});

it("keeps a locally chosen project when its persistence fails and other draft writes succeed", async () => {
  const f = await projectSetup();
  const started = vi.fn();
  const user = userEvent.setup();
  const scope = "project-write-failure";
  const key = `buzz-view.v1:${JSON.stringify([scope, "solo:project:work:new-project"])}`;
  const setItem = Storage.prototype.setItem;
  const storage = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, name, value) {
      if (name === key) throw new Error("Storage unavailable");
      setItem.call(this, name, value);
    });
  try {
    render(
      <SoloDraft
        projectId="work"
        session={f.session}
        scope={scope}
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Workspace: Work" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Other" }),
    );
    await user.type(screen.getByRole("textbox"), "Keep this project");
    expect(
      screen.getByRole("button", { name: "Workspace: Other" }),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.assign).toHaveBeenCalledWith(expect.any(String), "other");
  } finally {
    storage.mockRestore();
  }
});

it("inherits the project's defaults for two consecutive new chats", async () => {
  const f = await projectSetup();
  const user = userEvent.setup();
  const started = vi.fn();
  for (let index = 0; index < 2; index++) {
    const view = render(
      <SoloDraft
        session={f.session}
        scope="repeat-project"
        projectId="work"
        onStarted={started}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Workspace: Work" }),
    ).toBeVisible();
    await user.type(screen.getByRole("textbox"), `Chat ${index}`);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledTimes(index + 1));
    await waitFor(() =>
      expect(f.saveCanvas).toHaveBeenNthCalledWith(
        index + 1,
        expect.any(String),
        "work instructions",
        undefined,
      ),
    );
    view.unmount();
  }
  expect(f.channelWrites.create.mock.calls[0]?.[0]).not.toBe(
    f.channelWrites.create.mock.calls[1]?.[0],
  );
});

it.each([
  { saved: true, remount: true, fromProject: true },
  { saved: false, remount: false, fromProject: false },
])(
  "switching projects uses new defaults and retains independent naming/lifetime (saved=$saved, remount=$remount, fromProject=$fromProject)",
  async ({ saved, remount, fromProject }) => {
    const f = await projectSetup();
    const user = userEvent.setup();
    const started = vi.fn();
    const draftKey = fromProject ? "solo:project:work" : "solo";
    writeView("switch-project", `${draftKey}:settings`, {
      name: "My chosen title",
      ttlSeconds: 600,
    });
    const view = () => (
      <SoloDraft
        session={f.session}
        scope="switch-project"
        projectId={fromProject ? "work" : undefined}
        onStarted={started}
      />
    );
    const mounted = render(view());
    const openSettings = async () => {
      await user.click(screen.getByRole("button", { name: "Chat settings" }));
      return screen.findByRole("textbox", { name: /^Instructions/ });
    };
    if (saved) {
      const canvas = await openSettings();
      await waitFor(() =>
        expect(canvas).toHaveValue(fromProject ? "work instructions" : ""),
      );
      await user.clear(canvas);
      await user.type(canvas, "Old project override");
      await user.click(screen.getByRole("button", { name: "Save changes" }));
    }
    await user.click(
      screen.getByRole("button", {
        name: fromProject ? "Workspace: Work" : "Add workspace",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: /^Other$/ }),
    );
    if (remount) {
      mounted.unmount();
      render(view());
    }
    const canvas = await openSettings();
    await waitFor(() => expect(canvas).toHaveValue("other instructions"));
    expect(screen.getByRole("textbox", { name: /^Chat name/ })).toHaveValue(
      "My chosen title",
    );
    expect(screen.getByRole("radio", { name: /^Temporary/ })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await user.type(screen.getByRole("textbox"), "New project chat");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.channelWrites.create).toHaveBeenCalledWith(
      expect.any(String),
      "My chosen title",
      600,
      true,
      ["a".repeat(64)],
    );
    await waitFor(() =>
      expect(f.assign).toHaveBeenCalledWith(expect.any(String), "other"),
    );
    expect(f.saveCanvas).toHaveBeenCalledWith(
      expect.any(String),
      "other instructions",
      undefined,
    );
  },
);

it("allows changing an unavailable assistant before any remote creation", async () => {
  const f = setup();
  const user = userEvent.setup();
  const started = vi.fn();
  const choices = f.session.agentChoices.snapshot();
  vi.spyOn(f.session.agentChoices, "snapshot").mockReturnValue({
    ...choices,
    selectable: choices.selectable.filter(
      (agent) => agent.pubkey === "a".repeat(64),
    ),
  });
  writeView(
    "unavailable-agent",
    "solo:new-draft",
    taggedDraft("Keep my draft", "b".repeat(64), "Outside agent"),
  );
  render(
    <SoloDraft
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(
    "Only your available agents can be mentioned in Solo chats. Remove the unavailable recipient and retry.",
  );
  expect(f.channelWrites.create).not.toHaveBeenCalled();
  cleanup();
  writeView(
    "unavailable-agent",
    "solo:new-draft",
    taggedDraft("Keep my draft"),
  );
  render(
    <SoloDraft
      session={f.session}
      scope="unavailable-agent"
      onStarted={started}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(f.messages.send).toHaveBeenCalledWith(
    expect.any(String),
    "@Member agent Keep my draft",
    ["a".repeat(64)],
  );
});

it.each([{ fields: { name: 7 } }, { fields: { name: "x".repeat(121) } }])(
  "rejects malformed persisted naming before start side effects: $fields",
  async ({ fields }) => {
    const h = setup(),
      user = userEvent.setup(),
      started = vi.fn();
    const refreshPreferences = vi.fn(async () => {});
    const refreshSetup = vi.fn(async () => {});
    const readCanvas = vi.fn(async () => undefined);
    const saveCanvas = vi.fn(async () => {});
    const refreshAgents = vi.fn(async () => {});
    Object.assign(h.session, {
      channelKit: { refresh: refreshSetup },
      soloPreferences: {
        refresh: refreshPreferences,
        snapshot: () => ({
          data: { sections: [{ id: "work", name: "Work" }] },
        }),
      },
      canvas: { read: readCanvas, save: saveCanvas },
      agentChoices: { ...h.session.agentChoices, refresh: refreshAgents },
    });
    const key = "solo:project:work";
    writeView("test", `${key}:new-draft`, taggedDraft("Keep this draft"));
    writeView("test", `${key}:settings`, fields);
    render(
      <SoloDraft
        session={h.session}
        scope="test"
        projectId="work"
        onStarted={started}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/name/i);
    // The workspace's defaults load when it is picked; that is a read, not a
    // start.
    for (const operation of [
      readCanvas,
      saveCanvas,
      refreshAgents,
      h.channelWrites.create,
      h.channelWrites.delivered,
      h.channelWrites.refresh,
      h.channelWrites.addAgents,
      h.messages.send,
      started,
    ]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "naming crosses the real composer → creation/outbox boundary with frozen intent (explicit=%s)",
  async (explicit) => {
    const h = setup();
    const viewer = keypair();
    const publish = vi.fn(async (_event: Parameters<typeof signed>[1]) => {});
    const sign = vi.fn(async (template: Parameters<typeof signed>[1]) =>
      signed(viewer, template),
    );
    const outbox = createOutbox(
      viewer.pubkey,
      { kinds: [9, 9007], sign, publish },
      { load: () => [], save() {} },
    );
    const lifetime = new AbortController();
    writeView("real-creation", "solo:settings", {
      name: explicit ? "Chosen title" : "",
      ttlSeconds: 600,
    });
    writeView(
      "real-creation",
      "solo:new-draft",
      taggedDraft(
        "Original [\\#design](buzz://channel/design) prompt",
        viewer.pubkey,
        "Viewer",
      ),
    );
    let observed = outbox.outbox.snapshot();
    let channelList = {
      status: "ready" as const,
      channels: [] as {
        id: string;
        name: string;
        channelType: "solo";
        creator: string;
        members: string[];
      }[],
    };
    const channels = {
      ...h.session.channels,
      list: () => {
        const next = outbox.outbox.snapshot();
        if (next !== observed) {
          observed = next;
          channelList = {
            status: "ready",
            channels: next
              .filter(({ event }) => event.kind === 9007)
              .map(({ event }) => ({
                id: event.tags.find(([key]) => key === "h")?.[1] ?? "",
                name: "Chosen title",
                channelType: "solo",
                creator: viewer.pubkey,
                members: [viewer.pubkey],
              })),
          };
        }
        return channelList;
      },
    };
    const authority = keypair();
    const channelWrites = createChannelWrites(
      outbox.outbox,
      channels,
      {
        read: async (filters) =>
          filters.flatMap((filter) =>
            filter.kinds?.includes(39002)
              ? [
                  signed(authority, {
                    kind: 39002,
                    content: "",
                    created_at: 1,
                    tags: [
                      ["d", filter["#d"]?.[0] ?? ""],
                      ["p", viewer.pubkey],
                    ],
                  }),
                ]
              : [],
          ),
      },
      lifetime.signal,
      undefined,
      undefined,
      undefined,
      authority.pubkey,
      undefined,
      true,
    );
    const eligible = {
      ...h.session.agentChoices.snapshot(),
      selectable: [{ pubkey: viewer.pubkey, name: "Viewer", managed: true }],
    };
    const session = {
      ...h.session,
      agentChoices: { ...h.session.agentChoices, snapshot: () => eligible },
      viewer: viewer.pubkey,
      channels,
      channelWrites,
      messages: {
        ...h.session.messages,
        send: (id: string, text: string, recipients: readonly string[] = []) =>
          outbox.outbox.send({
            kind: 9,
            content: text,
            tags: [["h", id], ...recipients.map((key) => ["p", key])],
          }),
      },
    } as RelaySession;
    const started = vi.fn();
    const mounted = render(
      <SoloDraft session={session} scope="real-creation" onStarted={started} />,
    );
    try {
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      const created = publish.mock.calls
        .map(([event]) => event)
        .find((event) => event.kind === 9007);
      expect(created?.tags).toContainEqual([
        "name",
        explicit ? "Chosen title" : "Original #design prompt",
      ]);
      expect(created?.tags).toContainEqual(["t", SOLO_LABEL]);
      expect(created?.tags.some(([key]) => key === "about")).toBe(false);
      expect(created?.tags).toContainEqual(["ttl", "600"]);
      expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([
        9007, 9,
      ]);
      expect(publish.mock.calls[1]?.[0].content).toContain(
        "[\\#design](buzz://channel/design)",
      );
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      mounted.unmount();
      lifetime.abort();
      outbox.dispose();
    }
  },
);

it("starts a new chat with a session card and no caption", async () => {
  const h = setup(),
    started = vi.fn(),
    user = userEvent.setup();
  const link = "[Session: Fix](buzz://channel/session-id)";
  writeView("test", "solo:new-draft", taggedDraft(link));
  render(<SoloDraft session={h.session} scope="test" onStarted={started} />);
  const send = screen.getByRole("button", { name: "Send message" });
  await waitFor(() => expect(send).toBeEnabled());
  await user.click(send);
  await waitFor(() => expect(started).toHaveBeenCalled());
  expect(h.channelWrites.create).toHaveBeenCalledOnce();
  expect(h.messages.send).toHaveBeenCalledWith(
    h.channelWrites.create.mock.calls[0]?.[0],
    expect.stringContaining(link),
    ["a".repeat(64)],
  );
});

it("starting titles omit structured leading tags but retain literal @ text", async () => {
  const f = setup();
  const content = "@Literal investigate this";
  writeView("clean-title", "solo:new-draft", taggedDraft(content));
  render(
    <SoloDraft session={f.session} scope="clean-title" onStarted={vi.fn()} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(f.messages.send).toHaveBeenCalledOnce());
  expect(f.channelWrites.create.mock.calls[0]?.[1]).toBe(content);
});

it.each(["remember", "off"])(
  "first Solo send reaches all tagged agents and leaves the chat's next draft empty, as every routed send does (%s)",
  async (mode) => {
    const { setRememberAgentsPreference } = await import(
      "../messages/mention-preferences"
    );
    const { followupDraft } = await import("../messages/mention-draft");
    const f = setup();
    const recipients = [
      { pubkey: "a".repeat(64), name: "Member agent" },
      { pubkey: "b".repeat(64), name: "Outside agent" },
    ];
    const tags = followupDraft(recipients);
    writeView("first-followup", "solo:new-draft", {
      ...tags,
      text: `${tags.text}Start here`,
    });
    if (mode === "off") setRememberAgentsPreference(false);
    const started = vi.fn();
    render(
      <SoloDraft
        session={f.session}
        scope="first-followup"
        onStarted={started}
      />,
    );
    try {
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      expect(f.messages.send).toHaveBeenCalledOnce();
      expect(f.channelWrites.create).toHaveBeenCalledOnce();
      const id = started.mock.calls[0]?.[0];
      expect(readView("first-followup", `draft:${id}`, null)).toEqual({
        text: "",
        recipients: [],
      });
      expect(f.messages.send.mock.calls[0]?.[2]).toEqual(
        recipients.map((r) => r.pubkey),
      );
    } finally {
      setRememberAgentsPreference(true);
    }
  },
);

it("a routed first send leaves the chat's follow-up draft empty", async () => {
  const f = setup();
  const started = vi.fn();
  render(
    <SoloDraft
      session={f.session}
      scope="routed-followup"
      extensions={withPill}
      onStarted={started}
    />,
  );
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await userEvent.type(screen.getByRole("textbox"), "Start here");
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const id = started.mock.calls[0]?.[0];
  expect(f.messages.send.mock.calls[0]?.[2]).toEqual(["a".repeat(64)]);
  expect(readView("routed-followup", `draft:${id}`, null)).toEqual({
    text: "",
    recipients: [],
  });
});

const notes = {
  name: "notes.txt",
  url: `https://relay.test/media/${"f".repeat(64)}.txt`,
  type: "text/plain",
  size: 5,
  sha256: "f".repeat(64),
};

it("uploads files as soon as they are attached to a new chat, then sends them", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const upload = vi.fn();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, { attachments: { upload, uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(uploadForNewChat).toHaveBeenCalledOnce();
  expect(upload).not.toHaveBeenCalled();
  const id = test.channelWrites.create.mock.calls[0]?.[0];
  expect(test.messages.send).toHaveBeenCalledWith(
    id,
    expect.stringContaining("See attached"),
    ["a".repeat(64)],
    [notes],
  );
  if (!id) throw new Error("Expected a created chat");
  expect(
    attachmentDraft(test.session, `test:draft:${id}`, id).snapshot(),
  ).toEqual([]);
});

it("a file dropped anywhere on the new chat page attaches to its composer", async () => {
  const test = setup();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, {
    attachments: { upload: vi.fn(), uploadForNewChat },
  });
  render(<SoloDraft session={test.session} scope="test" onStarted={vi.fn()} />);
  const page = screen.getByRole("region", { name: "New chat" });
  const dataTransfer = {
    types: ["Files"],
    files: [new File(["notes"], "notes.txt", { type: "text/plain" })],
    dropEffect: "uninitialized",
  };
  fireEvent.dragEnter(page, { dataTransfer });
  expect(
    await screen.findByText("Drop files into this conversation"),
  ).toBeInTheDocument();
  fireEvent.drop(page, { dataTransfer });
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  expect(screen.queryByText("Drop files into this conversation")).toBeNull();
});

it("a failed upload blocks a new chat before anything is created", async () => {
  const test = setup(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(async () => {
    throw new Error("Upload failed. Retry or remove this file.");
  });
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(<SoloDraft session={test.session} scope="test" onStarted={vi.fn()} />);
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  expect(
    await screen.findByRole("button", { name: "Retry notes.txt" }),
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(test.messages.send).not.toHaveBeenCalled();
});

it("a first message that can't go out waits in the new chat's composer with its files", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  Object.assign(test.session, {
    attachments: { uploadForNewChat: vi.fn(async () => notes) },
  });
  test.messages.send.mockImplementationOnce(() => {
    throw new Error("offline");
  });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(readView("test", `draft:${id}`, null)).toEqual(
    taggedDraft("See attached"),
  );
  expect(
    attachmentDraft(test.session, `test:draft:${id}`, id)
      .snapshot()
      .map((item) => item.uploaded),
  ).toEqual([notes]);
});

function soloModelAgents() {
  const pubkey = "a".repeat(64);
  const agent = {
    pubkey,
    key: pubkey,
    name: "Member agent",
    type: "test/agent",
  };
  const snapshot = { status: "ready", agents: [agent] };
  const types = [
    {
      key: "test/agent",
      models: () => ({
        current: "fast",
        sendDefaults: true,
        models: [
          { id: "fast", label: "Fast", efforts: [] },
          {
            id: "deep",
            label: "Deep",
            efforts: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      }),
    },
  ];
  return {
    find: (key: string) => (key === pubkey ? agent : undefined),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
}

it("sends the selected model and effort with a Solo chat's first message", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const modelAgents = soloModelAgents();
  writeView("test", "solo:new-draft", taggedDraft("Start with care"));
  const firstMount = render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );

  await user.click(
    await screen.findByRole("button", { name: /Model.*effort/ }),
  );
  await user.click(
    await screen.findByRole("button", {
      name: "Model for Member agent in this chat",
    }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Deep" }));
  const effort = await screen.findByLabelText(
    "Effort for Member agent in this chat",
  );
  effort.focus();
  await user.keyboard("{ArrowRight}");
  expect(effort).toHaveAttribute("aria-valuetext", "High");

  expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual({
    [pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  firstMount.unmount();
  render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );
  await user.click(
    screen.getByRole("button", { name: "Model and effort for this chat" }),
  );
  const restoredModel = await screen.findByRole("button", {
    name: "Model for Member agent in this chat",
  });
  expect(restoredModel).toHaveTextContent("Deep");
  expect(
    await screen.findByLabelText("Effort for Member agent in this chat"),
  ).toHaveAttribute("aria-valuetext", "High");

  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(test.messages.send).toHaveBeenLastCalledWith(
    id,
    "@Member agent Start with care",
    [pubkey],
    [],
    undefined,
    [],
    { [pubkey]: { model: "deep", effort: "high" } },
  );
  expect(readView("test", `solo:model-picks:${id}`, null)).toEqual({
    [pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  await waitFor(() =>
    expect(
      readView("test", "solo:model-picks:solo:new-draft", null),
    ).toBeNull(),
  );
});

it("retains a saved first-chat model when its catalog no longer needs controls", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const agents = soloModelAgents();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const types = [
    {
      key: "test/agent",
      models: async () => {
        await ready;
        return {
          current: "deep",
          sendDefaults: true,
          models: [{ id: "deep", label: "Deep", efforts: [] }],
        };
      },
    },
  ];
  const modelAgents = { ...agents, types: () => types } as unknown as Agents;
  const picks = { [pubkey]: { model: "deep", type: "test/agent" } };
  writeView("test", "solo:new-draft", taggedDraft("Keep my model"));
  writeView("test", "solo:model-picks:solo:new-draft", picks);
  render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );

  await user.click(
    await screen.findByRole("button", {
      name: "Model and effort for this chat",
    }),
  );
  try {
    expect(await screen.findByText("Loading model and effort…")).toBeVisible();
  } finally {
    await act(async () => release());
  }
  expect(
    screen.getByRole("button", { name: "Reset model and effort" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", {
      name: "Model for Member agent in this chat",
    }),
  ).toBeNull();
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(test.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [pubkey]: { model: "deep" },
  });
  expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(picks);
  expect(readView("test", "solo:model-picks:solo:new-draft", null)).toBeNull();
});

it("restores model and effort after a refused first Solo start", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    onFailed = vi.fn(),
    user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const modelAgents = soloModelAgents();
  const refuse = refusedStart(test);
  writeView("test", "solo:new-draft", taggedDraft("Retry with care"));
  render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft
        session={test.session}
        scope="test"
        onStarted={onStarted}
        onFailed={onFailed}
      />
    </AgentsContext.Provider>,
  );

  await user.click(
    screen.getByRole("button", { name: "Model and effort for this chat" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Model for Member agent in this chat" }),
  );
  await user.click(await screen.findByRole("menuitemradio", { name: "Deep" }));
  const effort = await screen.findByLabelText(
    "Effort for Member agent in this chat",
  );
  effort.focus();
  await user.keyboard("{ArrowRight}");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(test.messages.send.mock.calls[0]?.at(-1)).toEqual({
    [pubkey]: { model: "deep", effort: "high" },
  });

  await refuse();
  await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
  expect(readView("test", `solo:model-picks:${id}`, null)).toBeNull();
  expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual({
    [pubkey]: { model: "deep", effort: "high", type: "test/agent" },
  });
  expect(
    screen.getByRole("button", { name: "Model and effort for this chat" }),
  ).toBeVisible();

  test.channelWrites.ready = Promise.resolve();
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
  expect(test.messages.send.mock.calls[1]?.at(-1)).toEqual({
    [pubkey]: { model: "deep", effort: "high" },
  });
});

it.each(["select", "reset"])(
  "consumes the saved New chat baseline after an unsaved %s and storage recovery",
  async (action) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const key = "solo:model-picks:solo:new-draft";
    const modelAgents = soloModelAgents();
    writeView("test", "solo:new-draft", taggedDraft("First start"));
    const baseline = {
      [pubkey]: {
        model: action === "select" ? "fast" : "deep",
        type: "test/agent",
      },
    };
    writeView("test", key, baseline);
    const view = () => (
      <AgentsContext.Provider value={modelAgents}>
        <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
      </AgentsContext.Provider>
    );
    const first = render(view());
    await user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
    const storage = failingViewWrites([key]);
    try {
      if (action === "select") {
        await user.click(
          await screen.findByRole("button", {
            name: "Model for Member agent in this chat",
          }),
        );
        await user.click(
          await screen.findByRole("menuitemradio", { name: "Deep" }),
        );
      } else {
        await user.click(
          screen.getByRole("button", { name: "Reset model and effort" }),
        );
      }
      expect(readView("test", key, null)).toEqual(baseline);
    } finally {
      storage.mockRestore();
    }
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    const [id] = onStarted.mock.calls[0] ?? [];
    expect(test.messages.send.mock.calls[0]?.[6]).toEqual(
      action === "select" ? { [pubkey]: { model: "deep" } } : undefined,
    );
    expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(
      action === "select"
        ? { [pubkey]: { model: "deep", type: "test/agent" } }
        : null,
    );
    expect(readView("test", key, null)).toBeNull();
    first.unmount();
    writeView("test", "solo:new-draft", taggedDraft("Next start"));
    render(view());
    await user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Model for Member agent in this chat",
      }),
    ).toHaveTextContent("Fast");
  },
);

it.each(["before Send", "after notification", "during upload"])(
  "compares shared model choices against the accepted Send snapshot for a write %s while uploading",
  async (timing) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const key = "solo:model-picks:solo:new-draft";
    const newer = { [pubkey]: { model: "fast", type: "test/agent" } };
    let release!: () => void;
    const pending = new Promise<typeof notes>((resolve) => {
      release = () => resolve(notes);
    });
    const uploadForNewChat = vi.fn(() => pending);
    Object.assign(test.session, { attachments: { uploadForNewChat } });
    writeView("test", "solo:new-draft", taggedDraft("First start"));
    writeView("test", key, {
      [pubkey]: { model: "deep", effort: "high", type: "test/agent" },
    });
    render(
      <AgentsContext.Provider value={soloModelAgents()}>
        <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
      </AgentsContext.Provider>,
    );
    try {
      await user.upload(
        screen.getByLabelText("Choose attachments"),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      );
      await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
      if (timing === "during upload")
        await user.click(screen.getByRole("button", { name: "Send message" }));
      const storageKey = `buzz-view.v1:${JSON.stringify(["test", key])}`;
      localStorage.setItem(storageKey, JSON.stringify(newer));
      if (timing === "after notification") {
        const send = screen.getByRole("button", { name: "Send message" });
        act(() => {
          // Deliver the external revision, then submit before its render commits.
          window.dispatchEvent(
            new StorageEvent("storage", {
              key: storageKey,
              storageArea: localStorage,
            }),
          );
          send.click();
        });
        // IDB's post-notification read must commit before a second Send.
        expect(test.channelWrites.start).not.toHaveBeenCalled();
        await waitFor(() =>
          expect(
            screen
              .getByRole("form")
              .querySelector('.buzz-loading-region[aria-busy="true"]'),
          ).toBeNull(),
        );
        await user.click(send);
      }
      if (timing === "before Send")
        await user.click(screen.getByRole("button", { name: "Send message" }));
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      expect(test.channelWrites.start).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        release();
        await pending;
      });
    }
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(test.messages.send.mock.calls[0]?.at(-1)).toEqual({
      [pubkey]:
        timing === "after notification"
          ? { model: "fast" }
          : { model: "deep", effort: "high" },
    });
    // After notification the accepted Send consumes the reconciled snapshot;
    // otherwise a write unseen by that Send belongs to the next draft.
    expect(readView("test", key, null)).toEqual(
      timing === "after notification" ? null : newer,
    );
  },
);

it("keeps a newer New chat draft while the first start awaits model ownership", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  writeView("test", "solo:new-draft", taggedDraft("First start"));
  render(
    <AgentsContext.Provider value={soloModelAgents()}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (_name: string, run: () => unknown) => {
        entered();
        await pending;
        return run();
      },
    },
  });
  const newer = taggedDraft("Newer draft");
  try {
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await requested;
    expect(test.messages.send).toHaveBeenCalledOnce();
    expect(onStarted).not.toHaveBeenCalled();
    // Another context can begin its next draft while local ownership is pending.
    writeView("test", "solo:new-draft", newer);
    writeView("test", "solo:settings", { name: "Newer title" });
  } finally {
    await act(async () => {
      release();
      await pending;
    });
  }
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(readView("test", "solo:new-draft", null)).toEqual(newer);
  expect(readView("test", "solo:settings", null)).toEqual({
    name: "Newer title",
  });
});

it.each([
  ...["created", "refused"].flatMap((outcome) =>
    ["saved", "unsaved"].map((storage) => ({ outcome, storage })),
  ),
  { outcome: "refused", storage: "pending" },
  { outcome: "refused", storage: "reset" },
])(
  "keeps a later New chat's $storage choices separate while the first start is $outcome",
  async ({ outcome, storage }) => {
    const test = setup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const modelAgents = soloModelAgents();
    const picks = { [pubkey]: { model: "deep", type: "test/agent" } };
    let settle!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      settle = () => {
        if (outcome === "created") resolve();
        else reject(new ChatNotStarted("Channel creation rejected"));
      };
    });
    test.channelWrites.ready = ready;
    writeView("test", "solo:new-draft", taggedDraft("First start"));
    writeView("test", "solo:model-picks:solo:new-draft", picks);
    const view = () => (
      <AgentsContext.Provider value={modelAgents}>
        <SoloDraft
          session={test.session}
          scope="test"
          onStarted={onStarted}
          onFailed={onFailed}
        />
      </AgentsContext.Provider>
    );
    const first = render(view());
    let writes: ReturnType<typeof failingViewWrites> | undefined;
    let release: (() => void) | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    try {
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      first.unmount();
      render(view());
      if (storage === "pending") {
        tail = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered!: () => void;
        const requested = new Promise<void>((resolve) => {
          entered = resolve;
        });
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value: {
            request: (_name: string, run: () => unknown) => {
              entered();
              const result = tail.then(run);
              tail = result.catch(() => {});
              return result;
            },
          },
        });
        // Queue refusal recovery before the new pick's save can acquire ownership.
        await act(async () => {
          settle();
          await ready.catch(() => {});
          await requested;
        });
      }
      if (storage === "unsaved")
        writes = failingViewWrites(["solo:model-picks:solo:new-draft"]);
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      const model = screen.getByRole("button", {
        name: "Model for Member agent in this chat",
      });
      expect(model).toHaveTextContent("Fast");
      // Deliberately choose the same model: equality with the first start's
      // snapshot must not let that start clear this later draft's choice.
      await user.click(model);
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Deep" }),
      );
      if (storage === "reset") {
        await user.click(
          screen.getByRole("button", { name: "Reset model and effort" }),
        );
        await waitFor(() =>
          expect(
            readView("test", "solo:model-picks:solo:new-draft", null),
          ).toEqual({}),
        );
      }
      if (writes) {
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Could not save model and effort",
        );
        writes.mockRestore();
        // A successful text save must not clear the unsaved model guard.
        const input = screen.getByRole("textbox") as HTMLTextAreaElement;
        input.value = " ";
        fireEvent.input(input);
      }
    } finally {
      writes?.mockRestore();
      await act(async () => {
        release?.();
        await tail;
        if (storage !== "pending") settle();
        await ready.catch(() => {});
      });
    }
    if (outcome === "refused")
      await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
    expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual(
      storage === "unsaved" ? null : storage === "reset" ? {} : picks,
    );
    if (storage === "reset")
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
    expect(
      screen.getByRole("button", {
        name: "Model for Member agent in this chat",
      }),
    ).toHaveTextContent(storage === "reset" ? "Fast" : "Deep");
    expect(screen.getByRole("textbox")).not.toHaveTextContent("First start");
    if (outcome === "refused")
      expect(onFailed).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("New chat has a newer draft"),
      );
  },
);

it.each(
  ["missing", "rejected"].flatMap((ownership) => [
    ...["transfer", "restore"].flatMap((failureAt) =>
      [false, true].map((newer) => ({
        ownership,
        failureAt,
        newer,
        reset: false,
      })),
    ),
    { ownership, failureAt: "transfer", newer: false, reset: true },
  ]),
)(
  "retains a refused start for retry after $ownership ownership at $failureAt, protecting newer work=$newer, reset=$reset",
  async ({ ownership, failureAt, newer, reset }) => {
    const test = setup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const picks = { [pubkey]: { model: "deep", type: "test/agent" } };
    const modelKey = "solo:model-picks:solo:new-draft";
    const modelAgents = soloModelAgents();
    const refuse = refusedStart(test);
    writeView(
      "test",
      "solo:new-draft",
      taggedDraft("Keep this refused message"),
    );
    writeView("test", modelKey, picks);
    const view = () => (
      <AgentsContext.Provider value={modelAgents}>
        <SoloDraft
          session={test.session}
          scope="test"
          onStarted={onStarted}
          onFailed={onFailed}
        />
      </AgentsContext.Provider>
    );
    const first = render(view());
    const locks = navigator.locks;
    const failOwnership = () =>
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value:
          ownership === "missing"
            ? undefined
            : {
                request: async () => {
                  throw new Error("Lock refused");
                },
              },
      });
    if (failureAt === "transfer") failOwnership();
    if (reset) {
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Reset model and effort" }),
      );
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Could not save model and effort",
        ),
      );
    }
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    const id = onStarted.mock.calls[0]?.[0];
    first.unmount();
    render(view());
    failOwnership();
    const draftPicks = failureAt === "transfer" ? picks : null;
    const chatPicks = failureAt === "transfer" ? null : picks;
    try {
      await refuse();
      await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
      // Ownership failure changes neither shared model map.
      expect(readView("test", modelKey, null)).toEqual(draftPicks);
      expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(
        chatPicks,
      );
      expect(onFailed.mock.calls[0]?.[1]).toContain("Window ownership");
      const retry = onFailed.mock.calls[0]?.[2];
      expect(retry).toEqual(expect.any(Function));
      await act(async () => {
        await retry();
      });
      expect(onFailed).toHaveBeenCalledTimes(2);
      expect(onFailed.mock.calls[1]?.[2]).toBe(retry);
      expect(readView("test", modelKey, null)).toEqual(draftPicks);
      expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(
        chatPicks,
      );
    } finally {
      Object.defineProperty(navigator, "locks", {
        configurable: true,
        value: locks,
      });
    }
    if (newer) {
      await user.type(screen.getByRole("textbox"), "Newer draft");
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      await user.click(
        screen.getByRole("button", {
          name: "Model for Member agent in this chat",
        }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Fast" }),
      );
    }
    await act(async () => {
      const retry = onFailed.mock.calls[1]?.[2];
      await Promise.all([retry(), retry()]);
    });
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("textbox")).toHaveTextContent(
      newer ? "Newer draft" : "Keep this refused message",
    );
    expect(readView("test", modelKey, null)).toEqual(
      newer
        ? { [pubkey]: { model: "fast", type: "test/agent" } }
        : reset
          ? {}
          : picks,
    );
    expect(readView("test", `solo:model-picks:${id}`, null)).toBeNull();
    expect(onFailed.mock.calls[2]?.[1]).toContain(
      newer ? "New chat has a newer draft" : "Your message is back in New chat",
    );
    // A stale callback is harmless after a completed restore.
    writeView("test", `solo:model-picks:${id}`, picks);
    await act(async () => {
      await onFailed.mock.calls[1]?.[2]();
    });
    expect(readView("test", `solo:model-picks:${id}`, null)).toEqual(picks);
    expect(onFailed).toHaveBeenCalledTimes(3);
    expect(test.messages.send).toHaveBeenCalledOnce();
    if (reset) {
      expect(test.messages.send.mock.calls[0]?.[6]).toBeUndefined();
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      expect(
        screen.getByRole("button", {
          name: "Model for Member agent in this chat",
        }),
      ).toHaveTextContent("Fast");
      await user.keyboard("{Escape}");
      test.channelWrites.ready = Promise.resolve();
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(2));
      expect(test.messages.send.mock.calls[1]?.[6]).toBeUndefined();
    }
  },
);

it.each(["newer text", "failed prompt write"])(
  "retains recovery through failed compensation after %s during the model commit",
  async (interruption) => {
    const test = setup(),
      onStarted = vi.fn(),
      onFailed = vi.fn(),
      user = userEvent.setup();
    const modelKey = "solo:model-picks:solo:new-draft";
    const picks = { ["a".repeat(64)]: { model: "deep", type: "test/agent" } };
    let refuse!: () => void;
    test.channelWrites.ready = new Promise<void>((_resolve, reject) => {
      refuse = () => reject(new ChatNotStarted("Channel creation rejected"));
    });
    void test.channelWrites.ready.catch(() => {});
    writeView("test", "solo:new-draft", taggedDraft("Original prompt"));
    writeView("test", modelKey, picks);
    render(
      <AgentsContext.Provider value={soloModelAgents()}>
        <SoloDraft
          session={test.session}
          scope="test"
          onStarted={onStarted}
          onFailed={onFailed}
        />
      </AgentsContext.Provider>,
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const transact = modelStorage.transactModelPicks;
    let failUndo = true;
    let held = false;
    const storage = vi
      .spyOn(modelStorage, "transactModelPicks")
      .mockImplementation(async (scope, keys, change) => {
        if (held && keys.length === 1 && failUndo)
          throw new Error("IDB compensation unavailable");
        const result = await transact(scope, keys, change);
        if (!held && keys.length === 2) {
          held = true;
          entered();
          await gate;
        }
        return result;
      });
    let textFailure: ReturnType<typeof failingViewWrites> | undefined;
    try {
      act(() => refuse());
      await committed;
      if (interruption === "newer text")
        fireEvent.input(screen.getByRole("textbox"), {
          target: { textContent: "Newer prompt" },
        });
      else textFailure = failingViewWrites(["solo:new-draft"]);
      await act(async () => {
        release();
      });
      await waitFor(() => expect(onFailed).toHaveBeenCalledOnce());
      const retry = onFailed.mock.calls[0]?.[2];
      expect(retry).toEqual(expect.any(Function));
      await act(async () => retry());
      expect(onFailed.mock.calls[1]?.[2]).toBe(retry);
      failUndo = false;
      textFailure?.mockRestore();
      await act(async () => retry());
      expect(onFailed).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("textbox")).toHaveTextContent(
        interruption === "newer text" ? "Newer prompt" : "Original prompt",
      );
      expect(readView("test", modelKey, null)).toEqual(
        interruption === "newer text" ? {} : picks,
      );
      expect(test.messages.send).toHaveBeenCalledOnce();
    } finally {
      release();
      textFailure?.mockRestore();
      storage.mockRestore();
    }
  },
);

it.each(["chat", "draft", "missing", "rejected"])(
  "reports and recovers failed first-send choice storage for the %s",
  async (failure) => {
    const test = setup(),
      onStarted = vi.fn(),
      user = userEvent.setup();
    const pubkey = "a".repeat(64);
    const picks = { [pubkey]: { model: "deep", type: "test/agent" } };
    writeView("test", "solo:new-draft", taggedDraft("Keep the first send"));
    writeView("test", "solo:model-picks:solo:new-draft", picks);
    const create = test.channelWrites.start.getMockImplementation();
    if (!create) throw new Error("Expected the start fixture implementation");
    let storage: ReturnType<typeof failingViewWrites> | undefined;
    test.channelWrites.start.mockImplementationOnce((...args) => {
      if (failure === "missing" || failure === "rejected") {
        Object.defineProperty(navigator, "locks", {
          configurable: true,
          value:
            failure === "missing"
              ? undefined
              : {
                  request: async () => {
                    throw new Error("Lock refused");
                  },
                },
        });
      } else
        storage = failingViewWrites([
          failure === "chat"
            ? `solo:model-picks:${args[0]}`
            : "solo:model-picks:solo:new-draft",
        ]);
      return create(...args);
    });
    render(
      <ToastProvider>
        <AgentsContext.Provider value={soloModelAgents()}>
          <SoloDraft
            session={test.session}
            scope="test"
            onStarted={onStarted}
          />
        </AgentsContext.Provider>
      </ToastProvider>,
    );
    try {
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      expect(test.messages.send.mock.calls[0]?.at(-1)).toEqual({
        [pubkey]: { model: "deep" },
      });
      expect(
        await screen.findByRole("dialog", {
          name:
            failure === "chat"
              ? "Could not save model and effort for this chat. Choose them again before your next message."
              : "Could not clear model and effort from New chat. Reset them before starting another chat.",
        }),
      ).toBeVisible();
    } finally {
      storage?.mockRestore();
    }
    if (failure === "draft") {
      expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual(
        picks,
      );
      await user.click(
        screen.getByRole("button", { name: "Model and effort for this chat" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Reset model and effort" }),
      );
      expect(readView("test", "solo:model-picks:solo:new-draft", null)).toEqual(
        {},
      );
      expect(test.messages.send).toHaveBeenCalledOnce();
    }
  },
);

it("keeps provider defaults unchanged on an unconfigured Solo first message", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const pubkey = "a".repeat(64);
  const agent = {
    pubkey,
    key: pubkey,
    name: "Member agent",
    type: "test/agent",
  };
  const snapshot = { status: "ready", agents: [agent] };
  const types = [
    {
      key: "test/agent",
      models: () => ({
        current: "fast",
        sendDefaults: true,
        models: [
          { id: "fast", label: "Fast", efforts: [] },
          { id: "deep", label: "Deep", efforts: [] },
        ],
      }),
    },
  ];
  const modelAgents = {
    find: (key: string) => (key === pubkey ? agent : undefined),
    joinable: () => [],
    sessionState: () => "unavailable" as const,
    subscribe: () => () => {},
    snapshot: () => snapshot,
    types: () => types,
  } as unknown as Agents;
  writeView("test", "solo:new-draft", taggedDraft("Use configured defaults"));
  render(
    <AgentsContext.Provider value={modelAgents}>
      <SoloDraft session={test.session} scope="test" onStarted={onStarted} />
    </AgentsContext.Provider>,
  );

  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  const [id] = onStarted.mock.calls[0] ?? [];
  expect(test.messages.send).toHaveBeenLastCalledWith(
    id,
    "@Member agent Use configured defaults",
    [pubkey],
  );
  expect(readView("test", `solo:model-picks:${id}`, null)).toBeNull();
});

it("resumes a new chat's interrupted upload after navigating away and back", async () => {
  const test = setup(),
    onStarted = vi.fn(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(
    (_file: File, signal: AbortSignal) =>
      new Promise<typeof notes>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  );
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  writeView("test", "solo:new-draft", taggedDraft("See attached"));
  const view = render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  view.unmount();

  uploadForNewChat.mockImplementation(async () => notes);
  render(
    <SoloDraft session={test.session} scope="test" onStarted={onStarted} />,
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledTimes(2));
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
  expect(test.messages.send).toHaveBeenCalledWith(
    test.channelWrites.create.mock.calls[0]?.[0],
    expect.stringContaining("See attached"),
    ["a".repeat(64)],
    [notes],
  );
});

it("shows an editable ordinary source link and sends it to the pill's default agent", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: `buzz://message?channel=design&id=${"c".repeat(64)}&thread=${"b".repeat(64)}`,
  };
  writeView("test", linkedDraftKey(linkedId), source);
  const started = vi.fn();
  render(
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      extensions={withPill}
      onStarted={started}
    />,
  );
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.value).toContain(source.link);
  expect(input.value).not.toContain("@Member agent");
  expect(t.channelWrites.create).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  const id = started.mock.calls[0]?.[0];
  expect(t.channelWrites.start).toHaveBeenCalledWith(
    id,
    expect.any(String),
    ["a".repeat(64)],
    undefined,
    false,
    undefined,
  );
  expect(t.messages.send).toHaveBeenCalledWith(
    id,
    expect.stringContaining(source.link),
    ["a".repeat(64)],
  );
});
it("types prose after a seeded source link instead of extending it", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: `buzz://message?channel=design&id=${"c".repeat(64)}`,
  };
  writeView("test", linkedDraftKey(linkedId), source);
  render(
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      focusRequest={1}
      extensions={withPill}
      onStarted={vi.fn()}
    />,
  );
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(input.value).toBe(`${source.link} `);
  expect(input.selectionStart).toBe(input.value.length);
  await userEvent.keyboard("Investigate");
  expect(input.value).toBe(`${source.link} Investigate`);
});
it("starting again from a sent source seeds its link and the pill's default agent again", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  const start = () => {
    writeView("test", linkedDraftKey(linkedId), source);
    return render(
      <SoloDraft
        session={t.session}
        scope="test"
        linkedId={linkedId}
        source={source}
        extensions={withPill}
        onStarted={started}
      />,
    );
  };
  const started = vi.fn();
  const first = start();
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  first.unmount();
  start();
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const again = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(again.value).toContain(source.link);
  expect(again.value).not.toContain("@Member agent");
});
it("keeps the pill's default agent out of the text when the linked draft is reopened", async () => {
  const t = setup();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  writeView("test", linkedDraftKey(linkedId), source);
  const draft = () => (
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      extensions={withPill}
      onStarted={vi.fn()}
    />
  );
  const first = render(draft());
  await waitFor(() => expect(sendingTo("Member agent")).toBeInTheDocument());
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  await userEvent.clear(input);
  await userEvent.type(input, source.link);
  await waitFor(() =>
    expect(
      readView<{ text?: string } | null>(
        "test",
        `${linkedDraftKey(linkedId)}:new-draft`,
        null,
      )?.text,
    ).toBe(source.link),
  );
  first.unmount();
  render(draft());
  const reopened = screen.getByRole("textbox") as HTMLTextAreaElement;
  expect(reopened.value).toBe(source.link);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(reopened.value).not.toContain("@Member agent");
  // The pill still holds the default agent; it is never a removable tag.
  expect(sendingTo("Member agent")).toBeInTheDocument();
});
it("keeps an edited linked draft instead of reinserting its removed source", async () => {
  const t = setup();
  const started = vi.fn();
  const linkedId = "22222222-2222-4222-8222-222222222222";
  const source: LinkedChat = {
    channelId: "design",
    link: "buzz://channel/design",
  };
  writeView(
    "test",
    `${linkedDraftKey(linkedId)}:new-draft`,
    taggedDraft("Changed request"),
  );
  render(
    <SoloDraft
      session={t.session}
      scope="test"
      linkedId={linkedId}
      source={source}
      onStarted={started}
    />,
  );
  expect(
    (screen.getByRole("textbox") as HTMLTextAreaElement).value,
  ).not.toContain(source.link);
  await userEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(started).toHaveBeenCalledOnce());
  expect(t.messages.send.mock.calls[0]?.[1]).toBe(
    "@Member agent Changed request",
  );
});

it("restores workspace-only openDraft and never reseeds a removal, which undo restores", async () => {
  const f = setup();
  const region = createSoloRegionFixture(f.session.viewer);
  const agent = "a".repeat(64);
  const workspace = { id: "selected-workspace", label: "Selected workspace" };
  const prepare = vi.fn<
    import("../channel-navigation/solo-navigation-contract").SoloTaskMode["prepare"]
  >(async () => ({ ok: false, reason: "Review this task" }));
  const source = await region.register({
    task: {
      prepare,
      markChannelStarted: async () => "start",
      recordFirstEvent: async () => {},
      participants: {
        eligible: (key) => key === agent,
        defaultRecipient: () => agent,
        makePrimary: async () => {},
      },
      header: (props) =>
        "draft" in props ? (
          <>
            {props.draft.workspace && (
              <span>Workspace {props.draft.workspace.label}</span>
            )}
            <button type="button" onClick={() => props.removeWorkspace()}>
              Remove workspace
            </button>
          </>
        ) : null,
    },
  });
  const lookup = vi
    .spyOn(soloNavigation, "soloNavigationFor")
    .mockReturnValue(region.service);
  try {
    source.handle.openDraft(source.binding(), {
      mode: "task",
      seed: { workspace, lead: true },
    });
    const target = region.navigator.snapshot().entry.target;
    if (target.kind !== "page") throw new Error("Missing task route");
    const route = soloDraft(target.route?.params);
    if (!route?.task) throw new Error("Missing task draft identity");
    const mount = () =>
      render(
        <SoloDraft
          session={f.session}
          scope={region.scope}
          agent={route.agent}
          task={route.task}
          onStarted={vi.fn()}
        />,
      );
    let view = mount();
    const user = userEvent.setup();
    expect(screen.getByText("Workspace Selected workspace")).toBeVisible();
    expect(route.agent).toBeUndefined();
    const input = screen.getByRole(
      "textbox",
    ) as import("../messages/composer-dom").ComposerInputElement;
    act(() =>
      input.insertText(
        "@Member agent ",
        { pubkey: agent, name: "Member agent" },
        { start: 0, end: 0 },
      ),
    );
    await user.click(input);
    await user.type(input, "Do the task");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({
      workspaceLead: workspace.id,
      primary: agent,
      recipients: [agent],
      workspace,
    });
    expect(f.channelWrites.start).not.toHaveBeenCalled();
    view.unmount();
    view = mount();
    expect(screen.getByText("Workspace Selected workspace")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Remove workspace" }));
    await waitFor(() =>
      expect(screen.queryByText(/^Workspace /)).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("textbox")).toHaveFocus();
    await user.keyboard("{Control>}z{/Control}");
    expect(
      await screen.findByText("Workspace Selected workspace"),
    ).toBeVisible();
    // Removing the workspace retired its lead; undo restores only the filing.
    expect(
      readView<{ workspaceLead?: string | null }>(
        region.scope,
        `solo:task:${route.task.draftId}:identity`,
        {},
      ).workspaceLead,
    ).toBeNull();
    await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await waitFor(() =>
      expect(screen.queryByText(/^Workspace /)).not.toBeInTheDocument(),
    );
    view.unmount();
    mount();
    expect(screen.queryByText(/^Workspace /)).not.toBeInTheDocument();
    const saved = mentionDraft(
      readView(region.scope, `solo:task:${route.task.draftId}:new-draft`, null),
    );
    expect(saved.workspace).toBeUndefined();
    expect(saved.recipients.map((item) => item.pubkey)).toEqual([agent]);
    expect(screen.getByRole("textbox")).toHaveTextContent("Do the task");
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(prepare.mock.calls[1]?.[0].workspace).toBeUndefined();
    expect(prepare.mock.calls[1]?.[0].workspaceLead).toBeUndefined();
  } finally {
    cleanup();
    lookup.mockRestore();
    await region.dispose();
  }
});

const chip = {
  kind: "nexus.repository",
  id: "repo",
  label: "@repo",
  verified: true,
};
// Each saved chip either restores as one (see the next test) or marks the
// draft another build's.
const savedChips = {
  projects: undefined,
  kind: { source: "@repo", semantic: { kind: "nexus.repository", id: "repo" } },
  label: { source: "@other", semantic: chip },
  recipient: {
    source: "@repo",
    semantic: chip,
    recipient: { pubkey: "a".repeat(64), name: "repo" },
  },
  resource: {
    source: "@repo",
    semantic: chip,
    resource: { uri: "buzz://channel/c", label: "@repo" },
  },
  pending: {
    source: "@repo",
    semantic: chip,
    pending: { id: "p", name: "repo" },
  },
  snapshot: { source: "@repo", semantic: chip },
};

it.each(Object.keys(savedChips) as (keyof typeof savedChips)[])(
  "keeps another build's task draft with a staged chat link unchanged and unsent across mount, send and remount (%s)",
  async (variant) => {
    const f = setup();
    const region = createSoloRegionFixture(f.session.viewer);
    const agent = "a".repeat(64);
    const prepare = vi.fn();
    const source = await region.register({
      task: {
        prepare,
        markChannelStarted: async () => "start",
        recordFirstEvent: async () => {},
        participants: {
          eligible: (key) => key === agent,
          defaultRecipient: () => agent,
          makePrimary: async () => {},
        },
      },
    });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    try {
      source.handle.openDraft(source.binding(), { mode: "task" });
      const target = region.navigator.snapshot().entry.target;
      if (target.kind !== "page") throw new Error("Missing task route");
      const route = soloDraft(target.route?.params);
      if (!route?.task) throw new Error("Missing task draft identity");
      // A stageable chat link beside data only another build understands.
      const own = projectComposerDocument(
        readComposerDocument(
          mentionDraft("Fix [Session: Fix](buzz://channel/session-id)"),
          [],
        ),
      ).draft;
      const doc = own.document?.content as {
        content: { content: unknown[] }[];
      };
      const [paragraph] = doc.content;
      assert.exists(paragraph);
      const content =
        variant === "projects"
          ? { ...doc, attrs: { projects: [{ id: "p", label: "Project" }] } }
          : {
              ...doc,
              content: [
                {
                  ...paragraph,
                  content: [
                    { type: "token", attrs: savedChips[variant] },
                    // Supported chip data in an otherwise unreadable snapshot.
                    ...(variant === "snapshot" ? [{ type: "text" }] : []),
                    ...paragraph.content,
                  ],
                },
              ],
            };
      const key = `solo:task:${route.task.draftId}:new-draft`;
      writeView(region.scope, key, {
        ...own,
        document: { version: 1, content },
      });
      const storage = `buzz-view.v1:${JSON.stringify([region.scope, key])}`;
      const saved = localStorage.getItem(storage);
      const user = userEvent.setup();
      for (let mount = 0; mount < 2; mount++) {
        const view = render(
          <SoloDraft
            session={f.session}
            scope={region.scope}
            agent={route.agent}
            task={route.task}
            onStarted={vi.fn()}
          />,
        );
        expect(screen.getByText(/cannot send/)).toBeVisible();
        expect(
          screen.queryByRole("img", { name: "Repository @repo" }),
        ).toBeNull();
        await user.click(screen.getByRole("button", { name: "Send message" }));
        expect(prepare).not.toHaveBeenCalled();
        expect(f.channelWrites.start).not.toHaveBeenCalled();
        expect(f.messages.send).not.toHaveBeenCalled();
        view.unmount();
        expect(localStorage.getItem(storage)).toBe(saved);
      }
    } finally {
      cleanup();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);

const otherSkill = {
  kind: "nexus.skill",
  id: JSON.stringify({ path: "/repo/SKILL.md" }),
  label: "/Review",
  target: "b".repeat(64),
};
it.each([
  ["a repository", chip],
  ["another agent's skill", otherSkill],
] as const)(
  "restores %s chip saved beside a staged chat link across remount; starts the task with it inline and signed only if it is for the primary agent",
  async (_, saved) => {
    const f = setup();
    const region = createSoloRegionFixture(f.session.viewer);
    const agent = "a".repeat(64);
    const prepare = vi.fn<
      import("../channel-navigation/solo-navigation-contract").SoloTaskMode["prepare"]
    >(async (input) => ({
      ok: true as const,
      channelId: "22222222-2222-4222-8222-222222222222",
      members: input.recipients,
      revision: input.revision,
      preparationId: `prepared:${input.revision}`,
    }));
    const source = await region.register({
      task: {
        prepare,
        markChannelStarted: async () => "start",
        recordFirstEvent: async () => {},
        participants: {
          eligible: (key) => key === agent,
          defaultRecipient: () => agent,
          makePrimary: async () => {},
        },
      },
    });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    // The real message API, so the event shows what the host signs.
    const events: { content: string; tags: string[][] }[] = [];
    const relay = createMessages(
      {
        supports: () => true,
        send: (event: { content: string; tags: string[][] }) => {
          events.push(event);
          return "d".repeat(64);
        },
      } as unknown as Outbox,
      f.session.viewer,
      () => undefined,
      () => [],
      () => {},
    );
    f.messages.send.mockImplementation((...args) => relay.send(...args));
    try {
      source.handle.openDraft(source.binding(), { mode: "task" });
      const target = region.navigator.snapshot().entry.target;
      if (target.kind !== "page") throw new Error("Missing task route");
      const route = soloDraft(target.route?.params);
      if (!route?.task) throw new Error("Missing task draft identity");
      const own = projectComposerDocument(
        readComposerDocument(
          mentionDraft("Fix [Session: Fix](buzz://channel/session-id)"),
          [],
        ),
      ).draft;
      const doc = own.document?.content as {
        content: { content: unknown[] }[];
      };
      const [paragraph] = doc.content;
      assert.exists(paragraph);
      const key = `solo:task:${route.task.draftId}:new-draft`;
      writeView(region.scope, key, {
        ...own,
        document: {
          version: 1,
          content: {
            ...doc,
            content: [
              {
                ...paragraph,
                content: [
                  {
                    type: "token",
                    attrs: { source: saved.label, semantic: saved },
                  },
                  { type: "text", text: " " },
                  ...paragraph.content,
                ],
              },
            ],
          },
        },
      });
      const storage = `buzz-view.v1:${JSON.stringify([region.scope, key])}`;
      const stored = localStorage.getItem(storage);
      const started = vi.fn();
      const mount = () =>
        render(
          <SoloDraft
            session={f.session}
            scope={region.scope}
            agent={route.agent}
            task={route.task}
            onStarted={started}
          />,
        );
      const first = mount();
      expect(
        screen.getByRole(saved === otherSkill ? "button" : "img", {
          name: composerTokenName(saved as never),
        }),
      ).toBeVisible();
      expect(screen.queryByText(/cannot send/)).toBeNull();
      first.unmount();
      expect(localStorage.getItem(storage)).toBe(stored);
      mount();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      if (saved === otherSkill) {
        expect(
          await screen.findByText("Select a skill for the primary agent."),
        ).toBeVisible();
        expect(prepare).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        return;
      }
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      expect(prepare.mock.calls[0]?.[0].references).toEqual([chip]);
      expect(events).toHaveLength(1);
      // The chip is its label as literal text, never a mention.
      expect(events[0]?.content).toContain("&#64;repo Fix");
      expect(events[0]?.content).toContain("buzz://channel/session-id");
      expect(events[0]?.tags).toContainEqual(taskTokenTags([chip as never])[0]);
    } finally {
      cleanup();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);

it("gives the task draft's own region binding to its composer's completions", async () => {
  const f = setup();
  const region = createSoloRegionFixture(f.session.viewer);
  const agent = "a".repeat(64);
  const source = await region.register({
    task: {
      prepare: async () => ({ ok: false, reason: "unused" }),
      markChannelStarted: async () => "start",
      recordFirstEvent: async () => {},
      participants: {
        eligible: (key) => key === agent,
        defaultRecipient: () => agent,
        makePrimary: async () => {},
      },
    },
  });
  const lookup = vi
    .spyOn(soloNavigation, "soloNavigationFor")
    .mockReturnValue(region.service);
  const contexts: unknown[] = [];
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "probe",
      key: "probe/probe",
      pluginId: "probe",
      revision: "1",
      title: "Probe",
      match: ({ text, start }) =>
        text.startsWith("#") ? { start: 0, end: start, query: "" } : null,
      component: () => {
        contexts.push(useContext(TaskCompletionContext));
        return null;
      },
    },
  ];
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  try {
    render(
      <SoloDraft
        session={f.session}
        scope="task-binding"
        agent={agent}
        task={{
          region: source.handle.label,
          draftId: "44444444-4444-4444-8444-444444444444",
        }}
        extensions={{
          inline: none,
          tools: none,
          completions: {
            snapshot: () => completions,
            subscribe: () => () => {},
          },
        }}
        onStarted={vi.fn()}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "#");
    const { scope, viewer, incarnation } = source.binding();
    expect(contexts.at(-1)).toEqual({
      binding: { scope, viewer, incarnation },
      draft: true,
    });
  } finally {
    cleanup();
    lookup.mockRestore();
    await region.dispose();
  }
});

it("prepares a task before starting it, keeps a refused draft and signs only its primary recipient", async () => {
  const f = setup();
  const region = createSoloRegionFixture(f.session.viewer);
  const agent = "a".repeat(64);
  const workspace = {
    id: "selected-workspace",
    label: "#Private workspace label",
  };
  const prepare = vi.fn<
    import("../channel-navigation/solo-navigation-contract").SoloTaskMode["prepare"]
  >(async (input) => ({
    ok: true as const,
    channelId: "22222222-2222-4222-8222-222222222222",
    members: input.recipients,
    revision: input.revision,
    preparationId: `prepared:${input.revision}`,
  }));
  prepare.mockImplementationOnce(async () => ({
    ok: false,
    reason: "Choose another agent",
  }));
  const source = await region.register({
    task: {
      prepare,
      markChannelStarted: async () => "start",
      recordFirstEvent: async () => {},
      participants: {
        eligible: (key) => key === agent,
        defaultRecipient: () => agent,
        makePrimary: async () => {},
      },
    },
  });
  const lookup = vi
    .spyOn(soloNavigation, "soloNavigationFor")
    .mockReturnValue(region.service);
  const started = vi.fn();
  const route = {
    region: source.handle.label,
    draftId: "33333333-3333-4333-8333-333333333333",
  };
  try {
    render(
      <SoloDraft
        session={f.session}
        scope="task-test"
        agent={agent}
        task={route}
        onStarted={started}
      />,
    );
    const user = userEvent.setup();
    const input = screen.getByRole(
      "textbox",
    ) as import("../messages/composer-dom").ComposerInputElement;
    act(() => {
      expect(input.setWorkspace(workspace)).toBe(true);
    });
    expect(input.value).not.toContain(workspace.label);
    await user.click(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Do the task");
    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Choose another agent",
      ),
    );
    expect(f.channelWrites.start).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveTextContent("Do the task");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(started).toHaveBeenCalledOnce());
    const prepared = prepare.mock.calls[1]?.[0];
    expect(prepared).toMatchObject({
      draftId: route.draftId,
      primary: agent,
      workspace,
      attachments: [],
    });
    expect(f.channelWrites.start.mock.calls[0]?.[2]).toEqual([agent]);
    expect(f.messages.send.mock.calls[0]?.[2]).toEqual([agent]);
    expect(f.messages.send.mock.calls[0]).toHaveLength(5);
    expect(f.messages.send.mock.calls[0]?.[1]).not.toContain(workspace.label);
    const recovery = f.messages.send.mock.calls[0]?.[4];
    expect(JSON.parse(recovery?.value ?? "null")).toMatchObject({
      draftId: route.draftId,
      revision: prepared?.revision,
      preparationId: `prepared:${prepared?.revision}`,
      regionLabel: route.region,
    });
    expect(screen.queryByRole("button", { name: /workspace/i })).toBeNull();
  } finally {
    cleanup();
    lookup.mockRestore();
    await region.dispose();
  }
});

it("rejects multiple task targets before preparation or creation and retains the draft", async () => {
  const f = setup();
  const region = createSoloRegionFixture(f.session.viewer);
  const prepare = vi.fn();
  const source = await region.register({
    task: {
      prepare,
      markChannelStarted: async () => "start",
      recordFirstEvent: async () => {},
      participants: {
        eligible: () => true,
        defaultRecipient: () => undefined,
        makePrimary: async () => {},
        maxRecipients: 1,
      },
    },
  });
  const lookup = vi
    .spyOn(soloNavigation, "soloNavigationFor")
    .mockReturnValue(region.service);
  const route = {
    region: source.handle.label,
    draftId: "33333333-3333-4333-8333-333333333333",
  };
  const first = "@Member agent",
    second = "@Outside agent";
  const draft = {
    text: `${first} ${second} Help`,
    recipients: [
      {
        pubkey: "a".repeat(64),
        name: "Member agent",
        start: 0,
        end: first.length,
      },
      {
        pubkey: "b".repeat(64),
        name: "Outside agent",
        start: first.length + 1,
        end: first.length + 1 + second.length,
      },
    ],
  };
  writeView("task-many", `solo:task:${route.draftId}:new-draft`, draft);
  try {
    render(
      <SoloDraft
        session={f.session}
        scope="task-many"
        task={route}
        onStarted={vi.fn()}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Tag one agent per message",
      ),
    );
    expect(prepare).not.toHaveBeenCalled();
    expect(f.channelWrites.start).not.toHaveBeenCalled();
    expect(f.messages.send).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveTextContent("Help");
    expect(
      readView("task-many", `solo:task:${route.draftId}:new-draft`, null),
    ).toMatchObject(draft);
  } finally {
    cleanup();
    lookup.mockRestore();
    await region.dispose();
  }
});

it.each([
  "text",
  "token",
  "workspace",
  "legacy-workspace",
  "malformed",
] as const)(
  "resumes the saved task pair before prepare and transfers edits, including a chip-only change; refuses malformed signed chips (%s)",
  async (variant) => {
    const tokenOnly = variant === "token";
    const malformed = variant === "malformed";
    const f = setup();
    const region = createSoloRegionFixture(f.session.viewer);
    let eligible = true;
    const prepare = vi.fn();
    const source = await region.register({
      task: {
        prepare,
        markChannelStarted: async () => "start",
        recordFirstEvent: async () => {},
        participants: {
          eligible: () => eligible,
          defaultRecipient: () => "a".repeat(64),
          makePrimary: async () => {},
        },
      },
    });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    const route = {
      region: source.handle.label,
      draftId: "33333333-3333-4333-8333-333333333333",
    };
    const channelId = "22222222-2222-4222-8222-222222222222";
    const recovery = {
      key: `solo-task:${route.draftId}`,
      value: JSON.stringify({
        ...route,
        regionLabel: route.region,
        revision: 1,
        preparationId: "original-preparation",
        channelId,
      }),
    };
    const event = {
      id: "d".repeat(64),
      pubkey: f.session.viewer,
      kind: 9,
      created_at: 1,
      content: "original",
      tags: [
        ["h", channelId],
        ["p", "a".repeat(64)],
      ],
    };
    const create = {
      ...event,
      id: "c".repeat(64),
      kind: 9007,
      tags: [
        ["h", channelId],
        ["p", "a".repeat(64)],
        ["t", SOLO_LABEL],
        ["t", route.region],
        ["t", "solo-task-mode:v1"],
      ],
    };
    const retry = vi.fn();
    const resumeStart = vi.fn(() => ({
      create: create.id,
      ready: Promise.resolve(),
    }));
    const savedOperations = [
      { event, recovery, delivery: "failed" },
      { event: create, delivery: "failed", guarded: true },
    ];
    assert.exists(f.session.outbox);
    Object.assign(f.session.outbox, {
      snapshot: () => savedOperations,
      retry,
    });
    Object.assign(f.session.channelWrites, { resumeStart });
    const savedChannels = {
      channels: [
        {
          id: channelId,
          creator: f.session.viewer,
          channelType: "solo",
          members: [f.session.viewer, "a".repeat(64)],
          labels: [SOLO_LABEL, route.region, "solo-task-mode:v1"],
        },
      ],
    };
    Object.assign(f.session.channels, { list: () => savedChannels });
    const newToken = {
      kind: "nexus.repository" as const,
      id: "new-repository",
      label: "@repo",
      verified: false,
    };
    const draft = tokenOnly
      ? {
          text: "",
          recipients: [],
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
                        source: "@Member agent",
                        recipient: {
                          pubkey: "a".repeat(64),
                          name: "Member agent",
                        },
                      },
                    },
                    {
                      type: "text",
                      text: " Edited while original was signing ",
                    },
                    {
                      type: "token",
                      attrs: { source: newToken.label, semantic: newToken },
                    },
                  ],
                },
              ],
            },
          },
        }
      : taggedDraft("Edited while original was signing");
    if (tokenOnly) {
      Object.assign(draft, mentionDraft(draft));
      // An earlier build signed the old chip as a fallback line.
      const oldToken = { ...newToken, id: "old-repository" };
      event.content = [
        composerMarkdown(mentionDraft(draft), "legacy"),
        taskTokenFallback([oldToken]),
      ].join("\n\n");
      event.tags.push(...taskTokenTags([oldToken]));
    }
    if (malformed) event.tags.push(["nexus.tokens.v1", "[{}]"]);
    if (variant === "workspace" || variant === "legacy-workspace") {
      // Personal filing is document metadata, never signed message content.
      const workspace = {
        id: "solo-workspace:private",
        label: "Private workspace",
      };
      const filed = mentionDraft({
        ...draft,
        document: {
          version: 1,
          content: {
            type: "doc",
            // An earlier build filed the draft as a project token and signed it.
            attrs:
              variant === "workspace"
                ? { workspace }
                : { projects: [{ kind: "nexus.project", ...workspace }] },
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "token",
                    attrs: {
                      source: "@Member agent",
                      recipient: {
                        pubkey: "a".repeat(64),
                        name: "Member agent",
                      },
                    },
                  },
                  { type: "text", text: " Edited while original was signing" },
                ],
              },
            ],
          },
        },
      });
      expect(filed.workspace).toEqual(workspace);
      Object.assign(draft, filed);
      event.content = filed.text;
      if (variant === "legacy-workspace")
        event.tags.push([
          "nexus.tokens.v1",
          JSON.stringify([{ kind: "nexus.project", ...workspace }]),
        ]);
    }
    writeView("task-resume", `solo:task:${route.draftId}:new-draft`, draft);
    const saved = localStorage.getItem(
      `buzz-view.v1:${JSON.stringify(["task-resume", `solo:task:${route.draftId}:new-draft`])}`,
    );
    const started = vi.fn();
    try {
      const mounted = render(
        <SoloDraft
          session={f.session}
          scope="task-resume"
          task={route}
          onStarted={started}
        />,
      );
      if (malformed) {
        await userEvent
          .setup()
          .click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() =>
          expect(screen.getByRole("alert")).toHaveTextContent(
            "invalid task tokens",
          ),
        );
        expect(resumeStart).not.toHaveBeenCalled();
        expect(retry).not.toHaveBeenCalled();
        expect(started).not.toHaveBeenCalled();
        expect(prepare).not.toHaveBeenCalled();
        mounted.unmount();
        expect(
          localStorage.getItem(
            `buzz-view.v1:${JSON.stringify(["task-resume", `solo:task:${route.draftId}:new-draft`])}`,
          ),
        ).toBe(saved);
        return;
      }
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(started).toHaveBeenCalledWith(channelId));
      expect(prepare).not.toHaveBeenCalled();
      expect(f.channelWrites.start).not.toHaveBeenCalled();
      expect(f.messages.send).not.toHaveBeenCalled();
      expect(resumeStart).toHaveBeenCalledWith(
        create.id,
        channelId,
        f.session.viewer,
        expect.any(Function),
      );
      expect(retry).toHaveBeenCalledWith(event.id, expect.any(Function));
      expect(
        readView("task-resume", `solo:task:${route.draftId}:new-draft`, null),
      ).toBe("");
      if (variant === "workspace" || variant === "legacy-workspace") {
        expect(readView("task-resume", `draft:${channelId}`, null)).toBeNull();
        mounted.unmount();
        return;
      }
      expect(readView("task-resume", `draft:${channelId}`, null)).toMatchObject(
        draft,
      );
      mounted.unmount();
      writeView("task-resume", `solo:task:${route.draftId}:new-draft`, draft);
      started.mockClear();
      resumeStart.mockClear();
      retry.mockClear();
      const cardOnly = {
        text: "",
        recipients: [],
        chatCards: ["[Session: Existing work](buzz://channel/existing)"],
      };
      writeView("task-resume", `draft:${channelId}`, cardOnly);
      const conflict = render(
        <SoloDraft
          session={f.session}
          scope="task-resume"
          task={route}
          onStarted={started}
        />,
      );
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "already has a draft",
        ),
      );
      expect(resumeStart).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(readView("task-resume", `draft:${channelId}`, null)).toMatchObject(
        cardOnly,
      );
      expect(screen.getByRole("textbox")).toHaveTextContent(
        "Edited while original was signing",
      );
      conflict.unmount();
      eligible = false;
      started.mockClear();
      resumeStart.mockClear();
      retry.mockClear();
      render(
        <SoloDraft
          session={f.session}
          scope="task-resume"
          task={route}
          onStarted={started}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      expect(resumeStart).not.toHaveBeenCalled();
      expect(retry).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      cleanup();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);

it.each(["resume", "already_sent"])(
  "permits one start across already-open drafts and preserves unresolved payload (%s)",
  async (response) => {
    const a = setup(),
      b = setup();
    const region = createSoloRegionFixture(a.session.viewer);
    let claimed = false;
    const mark = vi.fn(async () => {
      if (claimed) return "resume" as const;
      claimed = true;
      return "start" as const;
    });
    const source = await region.register({
      task: {
        prepare: async (input) =>
          claimed && response === "already_sent"
            ? {
                ok: false,
                reason: "already_sent",
                channelId: "22222222-2222-4222-8222-222222222222",
              }
            : {
                ok: true,
                channelId: "22222222-2222-4222-8222-222222222222",
                preparationId: "frozen",
                revision: input.revision,
                members: input.recipients,
              },
        markChannelStarted: mark,
        recordFirstEvent: async () => {},
        participants: {
          eligible: () => true,
          defaultRecipient: () => "a".repeat(64),
          makePrimary: async () => {},
        },
      },
    });
    const existingChannel = {
      channels: [
        {
          id: "22222222-2222-4222-8222-222222222222",
          creator: b.session.viewer,
          channelType: "solo",
          members: [b.session.viewer, "a".repeat(64)],
          labels: [SOLO_LABEL, source.handle.label, "solo-task-mode:v1"],
        },
      ],
    };
    Object.assign(b.session.channels, { list: () => existingChannel });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    let release = () => {};
    const binding = new Promise<void>((resolve) => {
      release = resolve;
    });
    assert.exists(a.session.outbox);
    Object.assign(a.session.outbox, { whenPrepared: () => binding });
    const route = {
      region: source.handle.label,
      draftId: "33333333-3333-4333-8333-333333333333",
    };
    const startedA = vi.fn(),
      startedB = vi.fn();
    try {
      const first = render(
        <SoloDraft
          session={a.session}
          scope="window-a"
          agent={"a".repeat(64)}
          task={route}
          onStarted={startedA}
        />,
      );
      const second = render(
        <SoloDraft
          session={b.session}
          scope="window-b"
          agent={"a".repeat(64)}
          task={route}
          onStarted={startedB}
        />,
      );
      const user = userEvent.setup();
      await user.type(
        within(first.container).getByRole("textbox"),
        "Frozen request",
      );
      await user.click(
        within(first.container).getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(a.messages.send).toHaveBeenCalledOnce());
      expect(
        readView("window-a", `solo:task:${route.draftId}:new-draft`, null),
      ).toMatchObject({ text: expect.stringContaining("Frozen request") });
      expect(startedA).not.toHaveBeenCalled();
      await user.type(
        within(second.container).getByRole("textbox"),
        "Different request",
      );
      await user.click(
        within(second.container).getByRole("button", { name: "Send message" }),
      );
      await waitFor(() =>
        expect(within(second.container).getByRole("alert")).toHaveTextContent(
          "Finish creating",
        ),
      );
      expect(b.channelWrites.start).not.toHaveBeenCalled();
      expect(b.messages.send).not.toHaveBeenCalled();
      expect(startedB).not.toHaveBeenCalled();
      release();
      await waitFor(() => expect(startedA).toHaveBeenCalledOnce());
      expect(
        readView("window-a", `solo:task:${route.draftId}:new-draft`, null),
      ).toBe("");
      expect(
        readView("window-b", `solo:task:${route.draftId}:new-draft`, null),
      ).toMatchObject({ text: expect.stringContaining("Different request") });
    } finally {
      release();
      cleanup();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);

it.each([
  { modified: false, implicit: false },
  { modified: true, implicit: false },
  { modified: false, implicit: true },
])(
  "same-ID attachment recovery transfers only actual file edits ($modified, implicit=$implicit)",
  async ({ modified, implicit }) => {
    const f = setup(),
      region = createSoloRegionFixture(f.session.viewer);
    const viewer = f.session.viewer;
    assert.exists(viewer);
    const prepare = vi.fn(
      async (
        input: import("../channel-navigation/solo-navigation-contract").TaskDraft,
      ) => ({
        ok: true as const,
        channelId: "22222222-2222-4222-8222-222222222222",
        revision: input.revision,
        preparationId: "frozen",
        members: input.recipients,
      }),
    );
    const source = await region.register({
      task: {
        prepare,
        markChannelStarted: async () => "start",
        recordFirstEvent: async () => {},
        participants: {
          eligible: () => true,
          defaultRecipient: () => "a".repeat(64),
          makePrimary: async () => {},
        },
      },
    });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    const route = {
      region: source.handle.label,
      draftId: "33333333-3333-4333-8333-333333333333",
    };
    const channelId = "22222222-2222-4222-8222-222222222222";
    const { attachmentMessage } = await import("../relay/attachments");
    const upload = vi.fn(async () => notes);
    Object.assign(f.session, { attachments: { uploadForNewChat: upload } });
    const files = attachmentDraft(
      f.session,
      `files:solo:task:${route.draftId}:new-draft`,
      route.draftId,
    );
    files.addUploaded(notes);
    writeView(
      "files",
      `solo:task:${route.draftId}:new-draft`,
      implicit ? "See attached" : taggedDraft("See attached"),
    );
    const eventId = "d".repeat(64),
      retry = vi.fn();
    let operations: readonly import("../relay/outbox").OutgoingEvent[] = [];
    const whenPrepared = vi
      .fn()
      .mockRejectedValueOnce(new Error("Binding interrupted"))
      .mockResolvedValue(undefined);
    assert.exists(f.session.outbox);
    Object.assign(f.session.outbox, {
      snapshot: () => operations,
      retry,
      whenPrepared,
    });
    Object.assign(f.session.channelWrites, {
      resumeStart: () => ({ create: "c".repeat(64), ready: Promise.resolve() }),
    });
    f.messages.send.mockImplementation(
      (id, content, recipients, uploaded, recovery) => {
        const message = attachmentMessage(content, uploaded ?? [], notes.url);
        const event = {
          id: eventId,
          kind: 9,
          pubkey: viewer,
          content: message.content,
          created_at: 1,
          tags: [
            ["h", id],
            ...(recipients ?? []).map((key) => ["p", key]),
            ...message.tags,
          ],
        };
        operations = [{ event, recovery, delivery: "failed" }];
        return eventId;
      },
    );
    const started = vi.fn();
    try {
      render(
        <SoloDraft
          session={f.session}
          scope="files"
          task={route}
          onStarted={started}
        />,
      );
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Binding interrupted",
        ),
      );
      expect(files.snapshot()).toHaveLength(1);
      const savedBytes = JSON.stringify(operations[0]?.event);
      expect(started).not.toHaveBeenCalled();
      const listed = {
        channels: [
          {
            id: channelId,
            channelType: "solo",
            creator: f.session.viewer,
            members: [f.session.viewer, "a".repeat(64)],
            labels: [SOLO_LABEL, source.handle.label, "solo-task-mode:v1"],
          },
        ],
      };
      Object.assign(f.session.channels, { list: () => listed });
      if (modified)
        act(() =>
          files.addUploaded({
            ...notes,
            name: "other.txt",
            sha256: "e".repeat(64),
            url: `https://relay.test/media/${"e".repeat(64)}.txt`,
          }),
        );
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(started).toHaveBeenCalledWith(channelId));
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(f.messages.send).toHaveBeenCalledTimes(1);
      if (implicit) {
        expect(f.messages.send.mock.calls[0]?.[1]).not.toContain(
          "@Member agent",
        );
        expect(f.messages.send.mock.calls[0]?.[2]).toEqual(["a".repeat(64)]);
      }
      expect(retry).toHaveBeenCalledWith(eventId, expect.any(Function));
      expect(JSON.stringify(operations[0]?.event)).toBe(savedBytes);
      expect(upload).not.toHaveBeenCalled();
      expect(files.snapshot()).toHaveLength(0);
      const target = attachmentDraft(
        f.session,
        `files:draft:${channelId}`,
        channelId,
      );
      expect(target.snapshot()).toHaveLength(modified ? 2 : 0);
      expect(readView("files", `draft:${channelId}`, null)).toEqual(
        modified
          ? expect.objectContaining({
              text: expect.stringContaining("See attached"),
            })
          : null,
      );
    } finally {
      cleanup();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);

it.each(["refresh", "stable", "revoked", "startup"] as const)(
  "persists first-message intent before waiting for task creation (%s)",
  async (mode) => {
    const viewer = keypair(),
      agent = keypair(),
      authority = keypair();
    const region = createSoloRegionFixture(viewer.pubkey);
    const channelId = "22222222-2222-4222-8222-222222222222";
    const draftId = "33333333-3333-4333-8333-333333333333";
    const gate = () => {
      let resolve = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const createGate = gate();
    const createEntered = gate();
    const messageGate = gate();
    const archiveGate = gate();
    const archiveEntered = gate();
    let refreshingFirstEvent = false;
    let recordCalls = 0;
    const signs: number[] = [];
    let records: readonly import("../relay/outbox").OutgoingEvent[] = [];
    let created = false;
    let authorized = true;
    const publish = vi.fn(async (event: Parameters<typeof signed>[1]) => {
      if (event.kind === 9007) created = true;
    });
    const native = {
      status: "ready" as const,
      agents: [
        {
          pubkey: agent.pubkey,
          name: "Task agent",
          owner: viewer.pubkey,
          relayUrl: "https://relay.test",
        },
      ],
    };
    const owner = createRelaySession(
      {
        viewer: viewer.pubkey,
        scope: "https://relay.test",
        relayAuthor: authority.pubkey,
        archiveAuthority: authority.pubkey,
        channelIdentity: true,
        media: () => undefined,
        query: async (filters) => {
          if (
            refreshingFirstEvent &&
            filters.some((filter) => filter.kinds?.includes(13535))
          ) {
            archiveEntered.resolve();
            await archiveGate.promise;
          }
          if (!created) return [];
          return [
            roster(authority, channelId, [viewer.pubkey, agent.pubkey]),
            metadata(authority, channelId, "Task", undefined, [
              ["t", "stream"],
              ["private"],
              ["t", SOLO_LABEL],
              ["t", source.handle.label],
              ["t", "solo-task-mode:v1"],
              ["P", viewer.pubkey],
            ]),
          ].filter((event) =>
            filters.some((filter) => filter.kinds?.includes(event.kind)),
          );
        },
        writer: {
          kinds: [9, 9007],
          sign: async (template) => {
            signs.push(template.kind);
            if (template.kind === 9007) {
              createEntered.resolve();
              await createGate.promise;
            }
            if (template.kind === 9) await messageGate.promise;
            return signed(viewer, template);
          },
          publish,
        },
      },
      {
        outboxStorage: {
          load: () => [],
          save: (next) => {
            records = structuredClone(next);
          },
        },
        agentChoices: {
          snapshot: () => native,
          subscribe: () => () => {},
          refresh: async () => {},
        },
      },
    );
    const samples: {
      archives: string;
      eligible: boolean;
      incarnation: string;
      aborted: boolean;
    }[] = [];
    const source = await region.register({
      task: {
        prepare: async (draft) => ({
          ok: true,
          channelId,
          revision: draft.revision,
          preparationId: "first-send",
          members: [viewer.pubkey, agent.pubkey],
        }),
        markChannelStarted: async () => "start",
        // Exact plugin16 authorization boundary: fresh template refresh includes archives.
        recordFirstEvent: async () => {
          recordCalls++;
          if (mode === "stable") return;
          refreshingFirstEvent = true;
          await owner.session.agentChoices.refresh("templates", {
            fresh: true,
          });
        },
        participants: {
          eligible: (key) => {
            const archives =
              owner.session.agentChoices.snapshot().archives.status;
            const eligible =
              authorized && key === agent.pubkey && archives === "ready";
            samples.push({
              archives,
              eligible,
              incarnation: source.binding().incarnation,
              aborted: source.signal().aborted,
            });
            return eligible;
          },
          defaultRecipient: () => agent.pubkey,
          makePrimary: async () => {},
        },
      },
    });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    const started = vi.fn();
    let mounted: ReturnType<typeof render> | undefined;
    try {
      await owner.session.outbox?.ready();
      if (mode !== "startup") {
        owner.session.channels.ensureList();
        await waitFor(() =>
          expect(owner.session.channels.list().status).toBe("ready"),
        );
      }
      expect(owner.session.channels.list().channels).toHaveLength(0);
      expect(created).toBe(false);
      await owner.session.agentChoices.refresh("templates", { fresh: true });
      const incarnation = source.binding().incarnation;
      writeView(
        "first-send-order",
        `solo:task:${draftId}:new-draft`,
        mode === "stable"
          ? "Original task request"
          : taggedDraft("Original task request", agent.pubkey, "Task agent"),
      );
      if (mode === "stable") setDefaultAgent("first-send-order", agent.pubkey);
      mounted = render(
        <SoloDraft
          session={owner.session}
          scope="first-send-order"
          task={{ region: source.handle.label, draftId }}
          onStarted={started}
        />,
      );
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await createEntered.promise;
      await act(async () => {
        messageGate.resolve();
      });
      await waitFor(() =>
        expect(
          records.find((item) => item.event.kind === 9)?.signed,
        ).toBeDefined(),
      );
      if (mode === "stable") {
        expect(
          records.find((item) => item.event.kind === 9)?.signed,
        ).toMatchObject({
          content: "Original task request",
          tags: expect.arrayContaining([["p", agent.pubkey]]),
        });
      }
      expect(refreshingFirstEvent).toBe(false);
      expect(
        owner.session.outbox?.snapshot().map((item) => item.event.kind),
      ).toEqual([9007, 9]);
      expect(started).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox")).toHaveTextContent(
        "Original task request",
      );
      authorized = mode !== "revoked";
      await act(async () => {
        createGate.resolve();
      });
      if (mode === "revoked") {
        await waitFor(() =>
          expect(
            records.find((item) => item.event.kind === 9007),
          ).toMatchObject({
            signed: expect.anything(),
            delivery: "failed",
            guarded: true,
            error: expect.stringContaining("Channel addition cancelled"),
          }),
        );
        await waitFor(() =>
          expect(screen.getByRole("alert")).toHaveTextContent(
            "Channel addition cancelled",
          ),
        );
        await waitFor(() =>
          expect(records.find((item) => item.event.kind === 9)).toMatchObject({
            signed: expect.anything(),
            recovery: expect.anything(),
            delivery: "failed",
          }),
        );
        expect(started).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        expect(recordCalls).toBe(0);
        return;
      }
      await waitFor(() =>
        expect(
          owner.session.channels
            .list()
            .channels.find(
              (channel) => channel.id === channelId && !channel.pending,
            ),
        ).toBeDefined(),
      );
      await act(async () => {
        messageGate.resolve();
      });
      if (mode === "refresh" || mode === "startup") {
        await archiveEntered.promise;
        expect(owner.session.agentChoices.snapshot().archives.status).toBe(
          "loading",
        );
        expect(samples).toContainEqual({
          archives: "ready",
          eligible: true,
          incarnation,
          aborted: false,
        });
        expect(source.binding().incarnation).toBe(incarnation);
        expect(source.signal().aborted).toBe(false);
        await act(async () => {
          archiveGate.resolve();
        });
      }
      await waitFor(() =>
        expect(
          owner.session.outbox?.snapshot().find((item) => item.event.kind === 9)
            ?.delivery,
        ).not.toBe("sending"),
      );
      let retriedRecordCalls = 0;
      if (mode === "startup") {
        const original = records.find((item) => item.event.kind === 9);
        expect(original).toMatchObject({
          signed: expect.anything(),
          recovery: expect.anything(),
          delivery: "failed",
        });
        await waitFor(() =>
          expect(screen.getByRole("alert")).toHaveTextContent("participant"),
        );
        expect(started).not.toHaveBeenCalled();
        await owner.session.agentChoices.refresh("templates", { fresh: true });
        await waitFor(() =>
          expect(owner.session.channels.list().status).toBe("ready"),
        );
        retriedRecordCalls = recordCalls;
        await userEvent
          .setup()
          .click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() =>
          expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([
            9007, 9,
          ]),
        );
        expect(records.find((item) => item.event.kind === 9)?.event.id).toBe(
          original?.event.id,
        );
      }
      expect(
        owner.session.outbox?.snapshot().find((item) => item.event.kind === 9)
          ?.error,
      ).toBeUndefined();
      await waitFor(() =>
        expect(publish.mock.calls.map(([event]) => event.kind)).toEqual([
          9007, 9,
        ]),
      );
      expect(records.find((item) => item.event.kind === 9007)?.delivery).toBe(
        "accepted",
      );
      expect(
        records.find((item) => item.event.kind === 9)?.error,
      ).toBeUndefined();
      expect(started).toHaveBeenCalledWith(channelId);
      expect(recordCalls).toBe(retriedRecordCalls + 1);
      expect(signs).toEqual([9007, 9]);
    } finally {
      createGate.resolve();
      messageGate.resolve();
      archiveGate.resolve();
      mounted?.unmount();
      owner.dispose();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);

it("shows pending accepted-message recovery and cancels binding when its draft region ends", async () => {
  const f = setup(),
    viewer = keypair(),
    agent = "a".repeat(64);
  Object.assign(f.session, { viewer: viewer.pubkey });
  const region = createSoloRegionFixture(viewer.pubkey);
  const record = vi.fn(async () => {}),
    started = vi.fn(),
    retry = vi.fn();
  const channelId = "22222222-2222-4222-8222-222222222222",
    draftId = "33333333-3333-4333-8333-333333333333";
  let resolve = () => {};
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  const starting = vi.fn(() => ready);
  const source = await region.register({
    task: {
      prepare: async () => ({ ok: false, reason: "Saved message only" }),
      markChannelStarted: async () => "resume",
      recordFirstEvent: record,
      participants: {
        eligible: (key) => key === agent,
        defaultRecipient: () => agent,
        makePrimary: async () => {},
      },
    },
  });
  const lookup = vi
    .spyOn(soloNavigation, "soloNavigationFor")
    .mockReturnValue(region.service);
  const labels = [SOLO_LABEL, source.handle.label, "solo-task-mode:v1"];
  const event = signed(viewer, {
    kind: 9,
    content: "@Member agent Saved request",
    tags: [
      ["h", channelId],
      ["p", agent],
    ],
  });
  const create = signed(viewer, {
    kind: 9007,
    content: "",
    tags: [
      ["h", channelId],
      ["name", "Saved task"],
      ["visibility", "private"],
      ["channel_type", "stream"],
      ...labels.map((label) => ["t", label]),
      ["p", viewer.pubkey],
      ["p", agent],
    ],
  });
  const recovery = {
    key: `solo-task:${draftId}`,
    value: JSON.stringify({
      draftId,
      revision: 7,
      preparationId: "prepared:7",
      channelId,
      regionLabel: source.handle.label,
    }),
  };
  const operations = [
    { event, signed: event, delivery: "accepted", recovery },
    { event: create, signed: create, delivery: "accepted" },
  ];
  const channelList = {
    channels: [
      {
        id: channelId,
        channelType: "solo",
        creator: viewer.pubkey,
        members: [viewer.pubkey, agent],
        labels,
      },
    ],
  };
  Object.assign(f.session.channels, { list: () => channelList });
  Object.assign(f.session.channelWrites, {
    starting,
    resumeStart: () => ({ create: create.id, ready }),
  });
  Object.assign(f.session.outbox as object, {
    snapshot: () => operations,
    retry,
  });
  const key = `solo:task:${draftId}:new-draft`;
  writeView("accepted-recovery", key, taggedDraft("Saved request"));
  const view = render(
    <SoloDraft
      session={f.session}
      scope="accepted-recovery"
      task={{ region: source.handle.label, draftId }}
      onStarted={started}
    />,
  );
  try {
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(starting).toHaveBeenCalledWith(channelId));
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(record).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    await act(async () => {
      region.cache();
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/abort/i);
    await act(async () => {
      resolve();
    });
    expect(record).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
    expect(operations[0]).toMatchObject({
      event: { id: event.id },
      signed: event,
      recovery,
    });
    expect(readView("accepted-recovery", key, null)).toMatchObject({
      text: expect.stringContaining("Saved request"),
    });
  } finally {
    resolve();
    view.unmount();
    lookup.mockRestore();
    await region.dispose();
  }
});

it.each([
  "fresh",
  "saved prose",
  "late adoption",
  "requested",
  "saved primary",
  "explicit saved",
  "task eligible fallback",
  "remove project with keyboard",
  "remove project with icon",
  "toolbar primary",
  "typed explicit",
  "toolbar demotes explicit",
  "toolbar same explicit",
  "toolbar failed explicit",
  "toolbar ineligible explicit",
  "toolbar undo explicit",
] as const)(
  "sends task prose with implicit routing and preserves workspace metadata (%s)",
  async (mode) => {
    const f = setup();
    const region = createSoloRegionFixture(f.session.viewer);
    const a = "a".repeat(64),
      b = "b".repeat(64);
    const scope = `implicit-${mode}`;
    const draftId = "33333333-3333-4333-8333-333333333333";
    const key = `solo:task:${draftId}`;
    setDefaultAgent(scope, b);
    let adopt!: (value: string) => void;
    if (mode === "late adoption")
      Object.assign(f.session, {
        mainAgent: {
          read: () =>
            new Promise<string>((resolve) => {
              adopt = resolve;
            }),
          write: vi.fn(),
        },
      });
    if (mode === "saved prose")
      writeView(scope, `${key}:new-draft`, "Do the task");
    if (mode === "saved primary")
      writeView(scope, `${key}:identity`, { primary: a, revision: 2 });
    if (
      mode === "explicit saved" ||
      (mode.endsWith(" explicit") && mode.startsWith("toolbar"))
    ) {
      writeView(scope, `${key}:new-draft`, taggedDraft("Do the task"));
      writeView(scope, `${key}:identity`, { primary: null });
    }
    const prepare = vi.fn<
      import("../channel-navigation/solo-navigation-contract").SoloTaskMode["prepare"]
    >(async (input) => ({
      ok: true,
      channelId: "22222222-2222-4222-8222-222222222222",
      members: input.recipients,
      revision: input.revision,
      preparationId: "implicit",
    }));
    const source = await region.register({
      task: {
        prepare,
        markChannelStarted: async () => "start",
        recordFirstEvent: async () => {},
        participants: {
          eligible: (key) =>
            key === a ||
            (![
              "explicit saved",
              "task eligible fallback",
              "toolbar ineligible explicit",
            ].includes(mode) &&
              key === b),
          defaultRecipient: () => a,
          makePrimary: async () => {},
        },
        header: (props) => {
          if (!("draft" in props)) return null;
          const workspace = props.draft.workspace;
          return workspace ? (
            <props.ui.Title
              title={workspace.label}
              actions={[
                {
                  id: "remove-project",
                  label: `Remove project ${workspace.label}`,
                  onSelect: () => {
                    props.removeWorkspace();
                  },
                },
              ]}
            />
          ) : null;
        },
      },
    });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    const started = vi.fn();
    const tools = [
      {
        id: "picker",
        key: "mentions/picker",
        order: -10,
        pluginId: "mentions",
        revision: "1",
        title: "Mentions",
        component: (props: ComposerToolProps) => (
          <MentionPicker {...props} select={props.insertMention} />
        ),
      },
    ];
    const completions = [
      {
        id: "typeahead",
        key: "mentions/typeahead",
        pluginId: "mentions",
        revision: "1",
        title: "Mention",
        match: (
          value: import("../conversation/contracts").ComposerObservation,
        ) => mentionQuery(value.text, value.start),
        component: MentionCompletion,
      },
    ];
    try {
      const renderDraft = (mountKey = 0) => (
        <SoloDraft
          key={mountKey}
          session={f.session}
          scope={scope}
          task={{ region: source.handle.label, draftId }}
          agent={mode === "requested" ? a : undefined}
          extensions={{
            inline: { snapshot: () => [], subscribe: () => () => {} },
            tools: { snapshot: () => tools, subscribe: () => () => {} },
            completions: {
              snapshot: () => completions,
              subscribe: () => () => {},
            },
          }}
          onStarted={started}
        />
      );
      const rendered = render(renderDraft());
      let input = screen.getByRole(
        "textbox",
      ) as import("../messages/composer-dom").ComposerInputElement;
      const project = { id: "project-id", label: "Private project" };
      act(() => {
        expect(input.setWorkspace(project)).toBe(true);
      });
      if (mode === "typed explicit") {
        await userEvent.type(input, "@Mem");
        await userEvent.click(
          await screen.findByRole("option", { name: /^Member agent/ }),
        );
        await userEvent.type(input, "Do the task");
      } else if (
        mode !== "saved prose" &&
        mode !== "explicit saved" &&
        !mode.endsWith(" explicit")
      )
        await userEvent.type(input, "Do the task");
      if (mode === "late adoption") {
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeDisabled();
        expect(input.value).toBe("Do the task");
        await act(async () => adopt(b));
      }
      const savedExplicit =
        mode.endsWith(" explicit") && mode.startsWith("toolbar");
      const rejected =
        mode === "toolbar failed explicit" ||
        mode === "toolbar ineligible explicit";
      const explicit =
        mode === "explicit saved" ||
        mode === "typed explicit" ||
        (savedExplicit && mode !== "toolbar demotes explicit");
      if (savedExplicit) {
        const before = input.value;
        const beforeDraft = readView(scope, `${key}:new-draft`, null);
        const beforeIdentity = readView(scope, `${key}:identity`, null);
        const caret = input.selectionStart;
        await userEvent.click(
          screen.getByRole("button", {
            name: "Choose primary agent, current recipient Member agent",
          }),
        );
        const save = Storage.prototype.setItem;
        const failure =
          mode === "toolbar failed explicit"
            ? vi
                .spyOn(Storage.prototype, "setItem")
                .mockImplementation(function (this: Storage, key, value) {
                  if (key.includes(":identity"))
                    throw new Error("Storage refused");
                  save.call(this, key, value);
                })
            : undefined;
        try {
          if (mode === "toolbar ineligible explicit")
            expect(
              screen.queryByRole("button", { name: /^Outside agent\s*Agent$/ }),
            ).toBeNull();
          else
            await userEvent.click(
              screen.getByRole("button", {
                name:
                  mode === "toolbar same explicit"
                    ? /^Member agent\s*Agent$/
                    : /^Outside agent\s*Agent$/,
              }),
            );
        } finally {
          failure?.mockRestore();
        }
        expect(input.value).toBe(before);
        expect(input.selectionStart).toBe(caret);
        if (rejected) {
          expect(readView(scope, `${key}:new-draft`, null)).toEqual(
            beforeDraft,
          );
          expect(readView(scope, `${key}:identity`, null)).toEqual(
            beforeIdentity,
          );
          await userEvent.keyboard("{Escape}");
        } else if (mode === "toolbar undo explicit") {
          act(() => input.undo(false));
        }
        expect(
          mentionDraft(readView(scope, `${key}:new-draft`, "")).recipients.map(
            (person) => person.pubkey,
          ),
        ).toEqual(explicit ? [a] : []);
      }
      if (mode === "toolbar primary") {
        const before = input.value;
        await userEvent.click(
          screen.getByRole("button", {
            name: "Choose primary agent, current recipient Outside agent",
          }),
        );
        await userEvent.click(
          screen.getByRole("button", { name: /^Member agent\s*Agent$/ }),
        );
        expect(input.value).toBe(before);
        expect(readView(scope, `${key}:identity`, null)).toMatchObject({
          primary: a,
        });
        rendered.rerender(renderDraft(1));
        input = screen.getByRole(
          "textbox",
        ) as import("../messages/composer-dom").ComposerInputElement;
        expect(input.value).toBe(before);
      }
      const authored =
        explicit || savedExplicit ? "@Member agent Do the task" : "Do the task";
      const prose = authored;
      expect(input.value).toBe(authored);
      expect(screen.queryByText(/^Primary:/)).toBeNull();
      expect(screen.queryByText(/^To /)).toBeNull();
      expect(
        screen.getByText(project.label).closest(".inline-chip"),
      ).not.toBeNull();
      const primary = [
        "requested",
        "saved primary",
        "explicit saved",
        "task eligible fallback",
        "toolbar primary",
        "typed explicit",
        "toolbar same explicit",
        "toolbar failed explicit",
        "toolbar ineligible explicit",
        "toolbar undo explicit",
      ].includes(mode)
        ? a
        : b;
      expect(
        screen.getByRole("button", {
          name: `Choose primary agent, current recipient ${primary === a ? "Member agent" : "Outside agent"}`,
        }),
      ).toHaveTextContent(primary === a ? "Member agent" : "Outside agent");
      const removeProject = screen.getByRole("button", {
        name: `Remove project ${project.label}`,
      });
      const removed = mode.startsWith("remove project");
      if (mode === "remove project with keyboard") {
        removeProject.focus();
        await userEvent.keyboard("{Enter}");
      } else if (mode === "remove project with icon") {
        const icon = removeProject.querySelector("svg");
        assert(icon);
        await userEvent.click(icon);
      }
      if (removed) {
        expect(
          screen.queryByRole("button", {
            name: `Remove project ${project.label}`,
          }),
        ).toBeNull();
        expect(input.value).toBe("Do the task");
      }
      const send = screen.getByRole("button", { name: "Send message" });
      // Send waits for the chat's saved model choices.
      await waitFor(() => expect(send).toBeEnabled());
      await userEvent.click(send);
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      expect(prepare.mock.calls[0]?.[0]).toMatchObject({
        primary,
        recipients: [primary],
        text: prose,
      });
      expect(prepare.mock.calls[0]?.[0].workspace).toEqual(
        removed ? undefined : project,
      );
      expect(f.messages.send.mock.calls[0]?.[1]).toBe(prose);
      expect(f.messages.send.mock.calls[0]?.[2]).toEqual([primary]);
      expect(f.messages.send.mock.calls[0]).toHaveLength(5);
      expect(readView(scope, "solo:default-agent", null)).toBe(b);
      expect(f.messages.send.mock.calls[0]?.[1]).not.toContain(project.label);
    } finally {
      adopt?.(b);
      cleanup();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);

it.each([
  { phase: "outbox", saved: true },
  { phase: "prepare", saved: false },
  { phase: "claim", saved: true },
] as const)(
  "refuses an implicit target that becomes unavailable during $phase (saved=$saved)",
  async ({ phase, saved }) => {
    const f = setup(),
      region = createSoloRegionFixture(f.session.viewer);
    const a = "a".repeat(64),
      b = "b".repeat(64);
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const hold = async () => {
      entered();
      await pending;
    };
    setDefaultAgent("stale-implicit", b);
    if (saved)
      writeView(
        "stale-implicit",
        "solo:task:33333333-3333-4333-8333-333333333333:identity",
        { primary: a, revision: 1 },
      );
    if (phase === "outbox")
      Object.assign(f.session.outbox as object, { ready: hold });
    const prepare = vi.fn<
      import("../channel-navigation/solo-navigation-contract").SoloTaskMode["prepare"]
    >(async (input) => {
      if (phase === "prepare") await hold();
      return {
        ok: true,
        channelId: "22222222-2222-4222-8222-222222222222",
        members: input.recipients,
        revision: input.revision,
        preparationId: "captured",
      };
    });
    const source = await region.register({
      task: {
        prepare,
        markChannelStarted: async () => {
          if (phase === "claim") await hold();
          return "start";
        },
        recordFirstEvent: async () => {},
        participants: {
          eligible: () => true,
          defaultRecipient: () => b,
          makePrimary: async () => {},
        },
      },
    });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    try {
      render(
        <SoloDraft
          session={f.session}
          scope="stale-implicit"
          agent={saved ? undefined : a}
          task={{
            region: source.handle.label,
            draftId: "33333333-3333-4333-8333-333333333333",
          }}
          onStarted={vi.fn()}
        />,
      );
      await userEvent.type(screen.getByRole("textbox"), "Keep my request");
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await began;
      expect(f.channelWrites.start).not.toHaveBeenCalled();
      const choices = f.session.agentChoices.snapshot();
      const withoutRequested = {
        ...choices,
        selectable: choices.selectable.filter((choice) => choice.pubkey !== a),
      };
      Object.assign(f.session.agentChoices, {
        snapshot: () => withoutRequested,
      });
      await act(async () => release());
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "no longer eligible",
        ),
      );
      expect(f.channelWrites.start).not.toHaveBeenCalled();
      expect(f.messages.send).not.toHaveBeenCalled();
      expect(prepare.mock.calls.every(([input]) => input.primary === a)).toBe(
        true,
      );
      expect(screen.getByRole("textbox")).toHaveTextContent("Keep my request");
      expect(screen.getByRole("textbox")).not.toHaveTextContent(
        "@Member agent",
      );
    } finally {
      release();
      cleanup();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);
const aaron = { pubkey: "e".repeat(64), name: "Aaron" };
/** A new Solo chat over the real mentions completion, with the agent
 * inventory answered by `read`; returns the composer and the `p` tags the
 * eventual send carried. */
function soloDraftWithInventory(
  read: () => Promise<{ definitions: []; identities: [typeof aaron] }>,
) {
  const test = setup();
  const library = createAgentLibrary(read);
  const session = {
    ...test.session,
    agentChoices: createAgentChoices({
      scope: "test",
      library: library.queries,
      signal: new AbortController().signal,
    }),
  } as unknown as RelaySession;
  const completions: readonly Contribution<ComposerCompletion>[] = [
    {
      id: "typeahead",
      key: "buzz.mentions/typeahead",
      pluginId: "buzz.mentions",
      revision: "1",
      title: "Mention",
      match: ({ text, start }) => mentionQuery(text, start),
      component: MentionCompletion,
    },
  ];
  const empty: [] = [];
  const none = { snapshot: () => empty, subscribe: () => () => {} };
  const onStarted = vi.fn();
  render(
    <SoloDraft
      session={session}
      scope="test"
      onStarted={onStarted}
      extensions={{
        tools: none,
        inline: none,
        completions: { snapshot: () => completions, subscribe: () => () => {} },
      }}
    />,
  );
  const input = screen.getByRole("textbox");
  return {
    input,
    chip: () =>
      within(input).queryByRole("img", { name: "Resolving mention Aaron" }),
    async send() {
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
      const id = test.channelWrites.create.mock.calls[0]?.[0];
      expect(test.channelWrites.start).toHaveBeenCalledWith(
        id,
        expect.any(String),
        [aaron.pubkey],
        undefined,
        false,
        undefined,
      );
      expect(test.messages.send).toHaveBeenCalledWith(id, "@Aaron hi", [
        aaron.pubkey,
      ]);
    },
    dispose: library.dispose,
  };
}
it("tags an agent whose name was typed with Space before the agent inventory loaded", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const draft = soloDraftWithInventory(async () => {
    await gate;
    return { definitions: [], identities: [aaron] };
  });
  try {
    // Fast typing: the inventory has not answered when Space arrives.
    await userEvent.type(draft.input, "@Aaron hi");
    expect(draft.input).toHaveValue("@Aaron hi");
    expect(draft.chip()).toHaveAttribute("aria-busy", "true");
    await act(async () => release());
    await waitFor(() => expect(draft.chip()).toBeNull());
    await draft.send();
  } finally {
    release();
    draft.dispose();
  }
});
it("tags an agent whose name was typed with Space while a retry after a failed inventory read loads", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  const draft = soloDraftWithInventory(async () => {
    if (reads++ === 0) throw new Error("offline");
    await gate;
    return { definitions: [], identities: [aaron] };
  });
  try {
    await userEvent.click(
      await screen.findByRole("button", { name: "Retry agents" }),
    );
    // The failed read settled the roster empty; the retry's Space must wait
    // for the retry, not consume that settled roster.
    await userEvent.type(draft.input, "@Aaron hi");
    expect(draft.input).toHaveValue("@Aaron hi");
    expect(draft.chip()).toHaveAttribute("aria-busy", "true");
    await act(async () => release());
    await waitFor(() => expect(draft.chip()).toBeNull());
    await draft.send();
  } finally {
    release();
    draft.dispose();
  }
});

it.each(["selected", "refused", "typed later"] as const)(
  "a toolbar choice supersedes an earlier pending mention only after saving (%s)",
  async (mode) => {
    const refused = mode === "refused";
    const f = setup();
    const region = createSoloRegionFixture(f.session.viewer);
    const a = "a".repeat(64),
      b = "b".repeat(64);
    const scope = "pending-primary";
    const draftId = "33333333-3333-4333-8333-333333333333";
    const key = `solo:task:${draftId}`;
    setDefaultAgent(scope, a);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolve = vi.fn(async (_signal: AbortSignal) => {
      await gate;
      return { pubkey: a, name: "A" };
    });
    const source = await region.register({
      task: {
        prepare: async (draft) => ({
          ok: true,
          channelId: "22222222-2222-4222-8222-222222222222",
          members: draft.recipients,
          revision: draft.revision,
          preparationId: "pending-primary",
        }),
        markChannelStarted: async () => "start",
        recordFirstEvent: async () => {},
        participants: {
          eligible: (key) => key === a || key === b,
          defaultRecipient: () => a,
          makePrimary: async () => {},
        },
      },
    });
    const lookup = vi
      .spyOn(soloNavigation, "soloNavigationFor")
      .mockReturnValue(region.service);
    const started = vi.fn();
    const tools = [
      {
        id: "picker",
        order: -10,
        key: "mentions/picker",
        pluginId: "mentions",
        revision: "1",
        title: "Mentions",
        component: (props: ComposerToolProps) => (
          <MentionPicker {...props} select={props.insertMention} />
        ),
      },
    ];
    const completions: readonly Contribution<ComposerCompletion>[] = [
      {
        id: "pending",
        key: "mentions/pending",
        pluginId: "mentions",
        revision: "1",
        title: "Mention",
        match: ({ text, start }) => mentionQuery(text, start),
        component: function Pending({ publish }) {
          useLayoutEffect(() => {
            const stop = publish({
              items: [],
              spacePending: { name: "A", resolve },
            });
            return typeof stop === "function" ? stop : undefined;
          }, [publish]);
          return null;
        },
      },
    ];
    let failure: ReturnType<typeof vi.spyOn> | undefined;
    try {
      render(
        <SoloDraft
          session={f.session}
          scope={scope}
          agent={a}
          task={{ region: source.handle.label, draftId }}
          extensions={{
            tools: { snapshot: () => tools, subscribe: () => () => {} },
            completions: {
              snapshot: () => completions,
              subscribe: () => () => {},
            },
            inline: { snapshot: () => [], subscribe: () => () => {} },
          }}
          onStarted={started}
        />,
      );
      const input = screen.getByRole(
        "textbox",
      ) as import("../messages/composer-dom").ComposerInputElement;
      await userEvent.type(input, "@A hi");
      await waitFor(() => expect(resolve).toHaveBeenCalledOnce());
      expect(
        within(input).getByRole("img", { name: "Resolving mention A" }),
      ).toBeInTheDocument();
      const before = input.value;
      const caret = input.selectionStart;
      await userEvent.click(
        screen.getByRole("button", {
          name: "Choose primary agent, current recipient Member agent",
        }),
      );
      if (refused) {
        const save = Storage.prototype.setItem;
        failure = vi
          .spyOn(Storage.prototype, "setItem")
          .mockImplementation(function (this: Storage, key, value) {
            if (key.includes(":identity")) throw new Error("Storage refused");
            save.call(this, key, value);
          });
      }
      await userEvent.click(
        screen.getByRole("button", { name: /^Outside agent\s*Agent$/ }),
      );
      failure?.mockRestore();
      failure = undefined;
      expect(input.value).toBe(before);
      expect(input.selectionStart).toBe(caret);
      if (refused) await userEvent.keyboard("{Escape}");
      else
        expect(readView(scope, `${key}:identity`, null)).toMatchObject({
          primary: b,
        });
      // Completion barrier: release the real mounted host's pending resolver,
      // then Send waits for any resolver that could still change recipients.
      await act(async () => release());
      if (mode === "typed later") {
        input.focus();
        input.setSelectionRange(0, 0);
        await userEvent.keyboard(" @A ");
      }
      await userEvent.click(
        screen.getByRole("button", { name: "Send message" }),
      );
      await waitFor(() => expect(started).toHaveBeenCalledOnce());
      expect(f.messages.send.mock.calls[0]?.[1]).toBe(
        mode === "typed later" ? ` @A ${before}` : before,
      );
      expect(f.messages.send.mock.calls[0]?.[2]).toEqual([
        refused || mode === "typed later" ? a : b,
      ]);
      expect(
        mentionDraft(readView(scope, `${key}:new-draft`, "")).recipients,
      ).toHaveLength(0);
    } finally {
      failure?.mockRestore();
      release();
      cleanup();
      lookup.mockRestore();
      await region.dispose();
    }
  },
);

it("does not start a named Solo chat from a file alone", async () => {
  const test = setup(),
    user = userEvent.setup();
  const uploadForNewChat = vi.fn(async () => notes);
  Object.assign(test.session, { attachments: { uploadForNewChat } });
  render(<SoloDraft session={test.session} scope="test" onStarted={vi.fn()} />);
  await user.clear(screen.getByRole("textbox"));
  await user.upload(
    screen.getByLabelText("Choose attachments"),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
  );
  await waitFor(() => expect(uploadForNewChat).toHaveBeenCalledOnce());
  // The pill addresses the main agent, so only the missing text disables Send.
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  const form = screen.getByRole("textbox").closest("form");
  if (!form) throw new Error("Expected composer form");
  fireEvent.submit(form);
  expect(test.channelWrites.create).not.toHaveBeenCalled();
  expect(test.messages.send).not.toHaveBeenCalled();
});
