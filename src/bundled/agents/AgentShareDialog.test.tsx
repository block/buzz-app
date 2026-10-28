// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { readSnapshot } from "../../features/agents/agent-share";
import { agentAvatars } from "../../features/agents/avatar-packs";
import type { Agent, RegisteredAgentType } from "../../features/agents/service";
import type { EventData } from "../../features/relay/events";
import type { RelaySession } from "../../features/relay/session";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { AgentShareDialog } from "./AgentShareDialog";

const desktop = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => desktop.tauri,
  invoke: desktop.invoke,
}));

const bea = { pubkey: "b".repeat(64), name: "Bea" };
const cy = { pubkey: "c".repeat(64), name: "Cy" };
const design = {
  id: "d".repeat(36),
  name: "design",
  channelType: "stream",
  members: ["f".repeat(64)],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const owner = "f".repeat(64);
const agent: Agent = {
  key: "a".repeat(64),
  pubkey: "a".repeat(64),
  name: "Ada",
  type: "test/echo",
  owner,
  relay: "wss://relay.example",
  place: "here",
  config: { instructions: "Review pull requests.", model: "echo-1" },
  attention: {},
  skipped: {},
  timers: {},
  attentionEnabled: true,
};
const echo = {
  key: "test/echo",
  title: "Echo",
  carry: (saved: { instructions: string }) => ({
    instructions: saved.instructions,
  }),
  exportShared: (saved: { model: string }) => ({
    runtime: "echo",
    model: saved.model,
  }),
} as unknown as RegisteredAgentType;

/** A community whose catalog holds the heads its outbox accepted. */
function community() {
  const heads: EventData[] = [];
  const listeners = new Set<() => void>();
  let pending: { event: EventData; delivery: string } | undefined;
  const outbox = {
    supports: (kind: number) => kind === 30175,
    ready: async () => {},
    send: vi.fn((input: Pick<EventData, "kind" | "content" | "tags">) => {
      const event = {
        ...input,
        id: String(heads.length + 1).repeat(64),
        pubkey: owner,
        created_at: heads.length + 1,
      } as EventData;
      pending = { event, delivery: "sending" };
      return event.id;
    }),
    snapshot: () => (pending ? [pending] : []),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss: vi.fn(async () => {}),
  };
  /** The relay accepts what was sent. */
  const accept = () => {
    if (pending) heads.push(pending.event);
    pending = undefined;
    for (const listener of listeners) listener();
  };
  /** The relay never answers, whether or not it `landed`. */
  const lose = (landed: boolean) => {
    if (!pending) return;
    if (landed) heads.push(pending.event);
    pending = { ...pending, delivery: "unknown" };
    for (const listener of listeners) listener();
  };
  const read = vi.fn(async () => [...heads]);
  const channels = { channels: [design] };
  const directMessages = {
    available: true,
    people: vi.fn(async () => ({
      people: [
        bea,
        cy,
        { pubkey: "e".repeat(64), name: "Echo", isAgent: true },
      ],
      hasMore: false,
    })),
    open: vi.fn(async ([pubkey]: string[]) => `dm-${pubkey?.[0]}`),
    delivered: vi.fn(async (_id: string, _channel: string) => {}),
    delivery: vi.fn((_id: string) => "accepted"),
  };
  const attachments = {
    upload: vi.fn(async (file: File, _channel: string) => ({
      name: file.name,
      url: "https://media.example/ada.agent.png",
      type: file.type,
      size: file.size,
      sha256: "0".repeat(64),
    })),
  };
  const messages = {
    send: vi.fn((channel: string, _content: string) => `sent-${channel}`),
  };
  return {
    session: {
      read,
      outbox,
      viewer: owner,
      directMessages,
      attachments,
      messages,
      channels: {
        list: () => channels,
        subscribeList: () => () => {},
      },
      media: (url: string) => url,
    } as unknown as RelaySession,
    heads,
    outbox,
    accept,
    lose,
    read,
    directMessages,
    attachments,
    messages,
  };
}

function share(session: RelaySession, overrides: Partial<Agent> = {}) {
  return render(
    <AgentShareDialog
      agent={{ ...agent, ...overrides }}
      type={echo}
      session={session}
      onClose={() => {}}
    />,
    { wrapper: ToastProvider },
  );
}

/** The Marketplace switch, once the listing has been read. */
async function listing() {
  const toggle = await screen.findByRole("switch", {
    name: "Post to Marketplace",
  });
  await vi.waitFor(() =>
    expect(toggle).not.toHaveAttribute("aria-disabled", "true"),
  );
  return toggle;
}

/** A person or channel among the results, ready to choose. */
const choice = (name: string) =>
  screen.findByRole("button", { name, pressed: false });

/** The footer's export, which saves an image unless JSON is chosen. */
const exportButton = (name = "Ada") =>
  screen.getByRole("button", { name: `Export ${name} as an agent card` });

const sharedContent = JSON.stringify({
  display_name: "Ada",
  system_prompt: "Review pull requests.",
  acp_command: "buzz-acp",
  runtime: "echo",
  model: "echo-1",
});

const LISTING_NOTE =
  "Anyone in this community can add a copy, instructions included. Memories and chats stay with you.";
const toggle = () =>
  screen.getByRole("switch", { name: "Post to Marketplace" });
/** Done applies what the switch asks for. */
const done = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Done" }));

it("publishes on Done when switched on, and removes what it published when switched off", async () => {
  const user = userEvent.setup();
  const { session, outbox, accept } = community();
  const onClose = vi.fn();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );
  expect(
    await within(screen.getByRole("dialog", { name: "Share Ada" })).findByText(
      LISTING_NOTE,
    ),
  ).toBeInTheDocument();
  await user.click(await listing());
  // The switch only asks; nothing is published until Done.
  expect(toggle()).toBeChecked();
  expect(outbox.send).not.toHaveBeenCalled();
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  // The switch shows what it asked for while the relay answers.
  expect(toggle()).toBeChecked();
  expect(toggle()).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByText("Publishing…")).toBeInTheDocument();
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [
        ["d", agent.pubkey],
        ["shared", "true"],
      ],
    },
    undefined,
    expect.any(Function),
  );
  expect(onClose).not.toHaveBeenCalled();
  accept();
  expect(
    await screen.findByText("Published Ada to the Marketplace."),
  ).toBeInTheDocument();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(toggle()).toBeChecked();

  await user.click(await listing());
  expect(outbox.send).toHaveBeenCalledTimes(1);
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Removing…")).toBeInTheDocument();
  // Removing replaces the shared head with what it shared.
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [["d", agent.pubkey]],
      supersedes: 1,
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await screen.findByText("Removed Ada from the Marketplace."),
  ).toBeInTheDocument();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  expect(toggle()).not.toBeChecked();
});

it("closes on Done without publishing when the switch is unchanged", async () => {
  const user = userEvent.setup();
  const { session, outbox } = community();
  const onClose = vi.fn();
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={session}
      onClose={onClose}
    />,
    { wrapper: ToastProvider },
  );
  // Switched on and back off is no change.
  await user.click(await listing());
  await user.click(toggle());
  await done(user);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(outbox.send).not.toHaveBeenCalled();
});

it("says up front why an agent can't be shared, before anything is sent", async () => {
  const { session, outbox, read } = community();
  share(session, {
    config: { instructions: "password: hunter2hunter2", model: "" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Ada can’t be shared. Portable configuration appears to contain a credential. Remove it before sharing or exporting.",
  );
  await vi.waitFor(() => expect(read).toHaveBeenCalled());
  await screen.findByText(LISTING_NOTE);
  expect(toggle()).toHaveAttribute("aria-disabled", "true");
  expect(exportButton()).toBeDisabled();
  expect(await choice("Bea")).toBeDisabled();
  expect(outbox.send).not.toHaveBeenCalled();
});

it("asks the relay what an unanswered publish did before saying it failed", async () => {
  const user = userEvent.setup();
  const { session, outbox, lose } = community();
  share(session);
  await user.click(await listing());
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  lose(true);
  expect(
    await screen.findByText("Published Ada to the Marketplace."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await user.click(await listing());
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  lose(false);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  // The switch keeps what was asked for, so Done tries again.
  expect(await listing()).not.toBeChecked();
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(3));
});

/** Publishes Ada, then switches the listing off. */
async function publishThenRemove(
  user: ReturnType<typeof userEvent.setup>,
  { outbox, accept }: ReturnType<typeof community>,
) {
  await user.click(await listing());
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  accept();
  await screen.findByText("Published Ada to the Marketplace.");
  await user.click(await listing());
  await done(user);
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
}

it("says removing failed when a newer shared head wins over the accepted one", async () => {
  const user = userEvent.setup();
  const fixture = community();
  share(fixture.session);
  await publishThenRemove(user, fixture);
  // Another device shared it again, later, before this removal landed.
  const shared = fixture.heads[0];
  if (shared)
    fixture.heads.push({ ...shared, id: "9".repeat(64), created_at: 99 });
  fixture.accept();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  expect(await listing()).not.toBeChecked();
});

it("keeps the confirmed state when the relay cannot say which head won", async () => {
  const user = userEvent.setup();
  const fixture = community();
  share(fixture.session);
  await publishThenRemove(user, fixture);
  fixture.read.mockRejectedValueOnce(new Error("offline"));
  fixture.accept();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  expect(await listing()).not.toBeChecked();
});

it("reads the listing again after the first read fails, leaving Export usable", async () => {
  const user = userEvent.setup();
  const { session, read } = community();
  read.mockRejectedValueOnce(new Error("offline"));
  share(session);
  expect(
    await screen.findByText("Couldn’t check the Marketplace."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("switch", { name: "Post to Marketplace" }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(exportButton()).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await listing();
  expect(
    screen.queryByText("Couldn’t check the Marketplace."),
  ).not.toBeInTheDocument();
});

it("exports the agent as an .agent.json snapshot", async () => {
  const user = userEvent.setup();
  const blobs: Blob[] = [];
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return "blob:snapshot";
    },
    revokeObjectURL: () => {},
  });
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("Ada.agent.json");
      expect(this.href).toBe("blob:snapshot");
    });
  share(community().session);
  await user.click(
    screen.getByRole("button", { name: "Choose an export format" }),
  );
  // The menu says what an agent card is before offering the backup format.
  expect(
    await screen.findByText(
      "An agent card is an image that holds the agent’s setup, so anyone can add it to Buzz.",
    ),
  ).toBeInTheDocument();
  await user.click(
    await screen.findByRole("menuitemradio", { name: "JSON file" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Export Ada as a JSON file" }),
  );
  expect(await screen.findByText("Saved Ada.")).toBeInTheDocument();
  expect(click).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await blobs[0]?.text()) ?? "")).toEqual({
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name: "Ada",
      systemPrompt: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    },
    profile: { displayName: "Ada" },
    memory: { level: "none", entries: [] },
  });
  click.mockRestore();
});

it("names a desktop export so every platform accepts it", async () => {
  const user = userEvent.setup();
  desktop.tauri = true;
  desktop.invoke.mockClear();
  try {
    const names: [string, string][] = [
      ["Con", "Con-agent.agent.png"],
      ["lpt1", "lpt1-agent.agent.png"],
      ["Console", "Console.agent.png"],
      ["x".repeat(128), `${"x".repeat(64)}.agent.png`],
    ];
    for (const [name, file] of names) {
      share(community().session, { name });
      await user.click(exportButton(name));
      expect(
        await screen.findByText(`Saved an agent card for ${name}.`),
      ).toBeInTheDocument();
      expect(desktop.invoke.mock.lastCall?.[2]).toEqual({
        headers: { "x-buzz-file-name": file },
      });
      cleanup();
    }
  } finally {
    desktop.tauri = false;
  }
});

it("exports without the picture when it does not load in time", async () => {
  desktop.tauri = true;
  desktop.invoke.mockClear();
  vi.stubGlobal(
    "Image",
    class {
      decode = () => new Promise(() => {});
    },
  );
  try {
    share(community().session, { picture: "https://media.example/ada.png" });
    // Only the wait for the picture runs on a controlled clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(exportButton());
    await vi.advanceTimersByTimeAsync(4999);
    expect(desktop.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(desktop.invoke).toHaveBeenCalledOnce());
    expect(
      await readSnapshot(new Blob([desktop.invoke.mock.calls[0]?.[1]])),
    ).toMatchObject({ name: "Ada", picture: "https://media.example/ada.png" });
  } finally {
    desktop.tauri = false;
    vi.useRealTimers();
  }
});

it("draws pack art from the app's own copy, since its CDN can't be read back", async () => {
  const pack = agentAvatars[0];
  if (!pack?.preview) throw new Error("Bundled avatar catalog is empty");
  const sources: string[] = [];
  vi.stubGlobal(
    "Image",
    class {
      crossOrigin = "";
      set src(value: string) {
        if (value) sources.push(value);
      }
      decode = () => Promise.reject(new Error("not drawn in jsdom"));
    },
  );
  share(community().session, { picture: `${pack.url}#buzz-anim=x` });
  fireEvent.click(exportButton());
  expect(
    await screen.findByText("Saved an agent card for Ada."),
  ).toBeInTheDocument();
  expect(sources).toEqual([pack.preview]);
});

it("saves an .agent.png natively on desktop, never through a blob link", async () => {
  const user = userEvent.setup();
  desktop.tauri = true;
  desktop.invoke.mockResolvedValueOnce("/Users/ada/Downloads/Ada.agent.png");
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
  try {
    share(community().session);
    await user.click(exportButton());
    // Desktop says where the file went.
    expect(
      await screen.findByText(
        "Saved an agent card for Ada to /Users/ada/Downloads/Ada.agent.png.",
      ),
    ).toBeInTheDocument();
    expect(click).not.toHaveBeenCalled();
    expect(desktop.invoke).toHaveBeenCalledOnce();
    const [command, bytes, options] = desktop.invoke.mock.calls[0] ?? [];
    expect(command).toBe("file_download");
    expect(options).toEqual({
      headers: { "x-buzz-file-name": "Ada.agent.png" },
    });
    expect(await readSnapshot(new Blob([bytes]))).toEqual({
      name: "Ada",
      instructions: "Review pull requests.",
      runtime: "echo",
      model: "echo-1",
    });
  } finally {
    desktop.tauri = false;
    click.mockRestore();
  }
});

it("updates a listing older than the agent, keeping it listed", async () => {
  const user = userEvent.setup();
  const { session, heads, outbox, accept } = community();
  heads.push({
    id: "9".repeat(64),
    pubkey: owner,
    created_at: 0,
    kind: 30175,
    tags: [
      ["d", agent.pubkey],
      ["shared", "true"],
    ],
    content: JSON.stringify({ display_name: "Ada", system_prompt: "Old." }),
  });
  share(session);
  expect(
    await screen.findByText(
      "Your latest changes aren’t in the Marketplace yet.",
    ),
  ).toBeInTheDocument();
  await user.click(
    await screen.findByRole("button", { name: "Update Marketplace" }),
  );
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  expect(outbox.send).toHaveBeenLastCalledWith(
    {
      kind: 30175,
      content: sharedContent,
      tags: [
        ["d", agent.pubkey],
        ["shared", "true"],
      ],
      supersedes: 0,
    },
    undefined,
    expect.any(Function),
  );
  accept();
  expect(
    await screen.findByText("Published Ada to the Marketplace."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Update Marketplace" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("switch", { name: "Post to Marketplace" }),
  ).toBeChecked();
});

it("says an update failed when the listed head is not what it sent", async () => {
  const user = userEvent.setup();
  const { session, heads, outbox, lose } = community();
  heads.push({
    id: "9".repeat(64),
    pubkey: owner,
    created_at: 0,
    kind: 30175,
    tags: [
      ["d", agent.pubkey],
      ["shared", "true"],
    ],
    content: JSON.stringify({ display_name: "Ada", system_prompt: "Old." }),
  });
  share(session);
  await user.click(
    await screen.findByRole("button", { name: "Update Marketplace" }),
  );
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  // It never landed, and the old listing is still shared.
  lose(false);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t publish Ada. Try again.",
  );
  expect(
    await screen.findByText(
      "Your latest changes aren’t in the Marketplace yet.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Update Marketplace" }),
  ).toBeEnabled();
  expect(toggle()).toBeChecked();
});

it("sends each person a message with one uploaded copy of the agent", async () => {
  const user = userEvent.setup();
  const { session, directMessages, attachments, messages } = community();
  share(session);
  // With nobody chosen, the window just closes.
  expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  await user.click(await choice("Bea"));
  await user.click(await choice("Cy"));
  expect(
    screen.queryByRole("button", { name: "Done" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(
    await screen.findByText("Sent Ada to Bea and Cy."),
  ).toBeInTheDocument();
  expect(directMessages.open.mock.calls.map(([people]) => people)).toEqual([
    [bea.pubkey],
    [cy.pubkey],
  ]);
  // Community media is readable from any conversation, so one upload serves.
  expect(attachments.upload).toHaveBeenCalledOnce();
  const [file, channel] = attachments.upload.mock.calls[0] ?? [];
  expect(channel).toBe("dm-b");
  expect(file?.name).toBe("Ada.agent.png");
  expect(await readSnapshot(file as File)).toMatchObject({
    name: "Ada",
    instructions: "Review pull requests.",
  });
  expect(messages.send.mock.calls.map(([to]) => to)).toEqual(["dm-b", "dm-c"]);
  expect(messages.send.mock.calls[0]?.[1]).toContain("Choose the card");
  expect((messages.send.mock.calls[0] as unknown[] | undefined)?.[3]).toEqual([
    expect.objectContaining({ name: "Ada.agent.png" }),
  ]);
  expect(directMessages.delivered).toHaveBeenCalledWith(
    "sent-dm-c",
    "dm-c",
    expect.any(AbortSignal),
  );
  // Everyone was reached, so the window is ready to close.
  expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  expect(
    screen.queryByRole("region", { name: /^Sending to/ }),
  ).not.toBeInTheDocument();
});

it("keeps who it couldn't reach, then confirms their message instead of resending it", async () => {
  const user = userEvent.setup();
  const { session, directMessages, messages } = community();
  directMessages.delivered.mockImplementation(async (id) => {
    if (id === "sent-dm-c") throw new Error("Not delivered");
  });
  share(session);
  await user.click(await choice("Bea"));
  await user.click(await choice("Cy"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Cy. Not delivered.",
  );
  expect(screen.getByText("Sent Ada to Bea.")).toBeInTheDocument();
  const chosen = screen.getByRole("region", { name: "Sending to · 1" });
  expect(
    within(chosen).getByRole("button", { name: "Cy", pressed: true }),
  ).toBeInTheDocument();
  // The relay may still have it, so trying again waits on the same message.
  directMessages.delivered.mockResolvedValue(undefined);
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Cy.")).toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("sends to the rest when one upload fails, and reuses the next upload", async () => {
  const user = userEvent.setup();
  const { session, attachments, messages } = community();
  attachments.upload.mockRejectedValueOnce(new Error("Upload refused"));
  share(session);
  await user.click(await choice("Bea"));
  await user.click(await choice("Cy"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Bea. Upload refused.",
  );
  expect(screen.getByText("Sent Ada to Cy.")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Bea.")).toBeInTheDocument();
  expect(attachments.upload).toHaveBeenCalledTimes(2);
  expect(messages.send.mock.calls.map(([to]) => to)).toEqual(["dm-c", "dm-b"]);
  // With everyone reached, focus lands on Done.
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Done" })).toHaveFocus(),
  );
});

it("remembers an unconfirmed message after the window closes", async () => {
  const user = userEvent.setup();
  const { session, directMessages, messages } = community();
  directMessages.delivered.mockRejectedValueOnce(new Error("Offline"));
  share(session);
  await user.click(await choice("Bea"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t send to Bea. Offline.",
  );
  cleanup();
  share(session);
  await user.click(await choice("Bea"));
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to Bea.")).toBeInTheDocument();
  expect(messages.send).toHaveBeenCalledOnce();
  expect(directMessages.delivered).toHaveBeenCalledTimes(2);
});

it("posts to a channel the viewer belongs to, and never offers agents", async () => {
  const user = userEvent.setup();
  const { session, directMessages, attachments, messages } = community();
  share(session);
  // Search opens ready to type, and narrows people and channels together.
  const field = screen.getByRole("searchbox", {
    name: "Search people and channels",
  });
  await vi.waitFor(() => expect(field).toHaveFocus());
  await choice("Bea");
  expect(
    screen.queryByRole("button", { name: "Echo" }),
  ).not.toBeInTheDocument();
  await user.type(field, "#des");
  await user.click(await choice("#design"));
  await vi.waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Bea" }),
    ).not.toBeInTheDocument(),
  );
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(await screen.findByText("Sent Ada to #design.")).toBeInTheDocument();
  // A channel gets one message in it, not a direct message to each member.
  expect(directMessages.open).not.toHaveBeenCalled();
  expect(attachments.upload.mock.calls[0]?.[1]).toBe(design.id);
  expect(messages.send.mock.calls.map(([to]) => to)).toEqual([design.id]);
});
