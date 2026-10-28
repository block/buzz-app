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
import { AgentShareDialog } from "./AgentShareDialog";

const desktop = vi.hoisted(() => ({ tauri: false, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => desktop.tauri,
  invoke: desktop.invoke,
}));

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
  return {
    session: {
      read,
      outbox,
      media: (url: string) => url,
    } as unknown as RelaySession,
    heads,
    outbox,
    accept,
    lose,
    read,
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
  );
}

/** The Marketplace row's action, once the listing has been read. */
async function listingAction(name: string) {
  const button = await screen.findByRole("button", { name });
  await vi.waitFor(() => expect(button).toBeEnabled());
  return button;
}

const sharedContent = JSON.stringify({
  display_name: "Ada",
  system_prompt: "Review pull requests.",
  acp_command: "buzz-acp",
  runtime: "echo",
  model: "echo-1",
});

it("publishes what the review shows, then removes what it published", async () => {
  const user = userEvent.setup();
  const { session, outbox, accept } = community();
  share(session);
  expect(
    await within(screen.getByRole("dialog", { name: "Share Ada" })).findByText(
      "Not listed",
    ),
  ).toBeInTheDocument();
  await user.click(await listingAction("Publish Ada to the Marketplace"));
  const review = screen.getByRole("dialog", {
    name: "Publish Ada to the Marketplace",
  });
  expect(
    within(review).getByRole("region", { name: "Instructions" }),
  ).toHaveTextContent("Review pull requests.");
  expect(review).toHaveTextContent(
    "Memories, chats, and saved logins aren’t included.",
  );
  // Nothing is published until the review is confirmed.
  expect(outbox.send).not.toHaveBeenCalled();
  await user.click(within(review).getByRole("button", { name: "Publish" }));
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  expect(within(review).getByRole("button", { name: "Cancel" })).toBeDisabled();
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
  accept();
  expect(
    await screen.findByText("Published to the Marketplace."),
  ).toBeInTheDocument();
  const remove = screen.getByRole("button", {
    name: "Remove Ada from the Marketplace",
  });
  // Returning lands on the row's action that replaced Publish.
  expect(remove).toHaveFocus();

  await user.click(remove);
  const confirm = screen.getByRole("dialog", {
    name: "Remove Ada from the Marketplace?",
  });
  expect(confirm).toHaveTextContent("People who already added a copy keep it.");
  await user.click(within(confirm).getByRole("button", { name: "Remove" }));
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
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
    await screen.findByText("Removed from the Marketplace."),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Publish Ada to the Marketplace" }),
  ).toBeInTheDocument();
});

it("goes back from the review without publishing", async () => {
  const user = userEvent.setup();
  const { session, outbox } = community();
  share(session);
  const publish = await listingAction("Publish Ada to the Marketplace");
  await user.click(publish);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("dialog", { name: "Share Ada" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Publish Ada to the Marketplace" }),
  ).toHaveFocus();
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
  await screen.findByText("Not listed");
  expect(
    screen.getByRole("button", { name: "Publish Ada to the Marketplace" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Export Ada" })).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Export as JSON instead" }),
  ).toBeDisabled();
  expect(outbox.send).not.toHaveBeenCalled();
});

it("asks the relay what an unanswered publish did before saying it failed", async () => {
  const user = userEvent.setup();
  const { session, outbox, lose } = community();
  share(session);
  await user.click(await listingAction("Publish Ada to the Marketplace"));
  await user.click(screen.getByRole("button", { name: "Publish" }));
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  lose(true);
  expect(
    await screen.findByText("Published to the Marketplace."),
  ).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  await user.click(
    screen.getByRole("button", { name: "Remove Ada from the Marketplace" }),
  );
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
  lose(false);
  // The failure stays with the confirmation, ready to try again.
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Listed")).toBeInTheDocument();
});

/** Publishes Ada, then opens the confirmation to remove it. */
async function publishThenConfirmRemove(
  user: ReturnType<typeof userEvent.setup>,
  { outbox, accept }: ReturnType<typeof community>,
) {
  await user.click(await listingAction("Publish Ada to the Marketplace"));
  await user.click(screen.getByRole("button", { name: "Publish" }));
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  accept();
  await user.click(
    await screen.findByRole("button", {
      name: "Remove Ada from the Marketplace",
    }),
  );
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(2));
}

it("says removing failed when a newer shared head wins over the accepted one", async () => {
  const user = userEvent.setup();
  const fixture = community();
  share(fixture.session);
  await publishThenConfirmRemove(user, fixture);
  // Another device shared it again, later, before this removal landed.
  const shared = fixture.heads[0];
  if (shared)
    fixture.heads.push({ ...shared, id: "9".repeat(64), created_at: 99 });
  fixture.accept();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Listed")).toBeInTheDocument();
});

it("keeps the confirmed state when the relay cannot say which head won", async () => {
  const user = userEvent.setup();
  const fixture = community();
  share(fixture.session);
  await publishThenConfirmRemove(user, fixture);
  fixture.read.mockRejectedValueOnce(new Error("offline"));
  fixture.accept();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t remove Ada. Try again.",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Listed")).toBeInTheDocument();
});

it("reads the listing again after the first read fails, leaving Export usable", async () => {
  const user = userEvent.setup();
  const { session, read } = community();
  read.mockRejectedValueOnce(new Error("offline"));
  share(session);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t check the Marketplace.",
  );
  expect(screen.getByRole("button", { name: "Export Ada" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Try again" }));
  await listingAction("Publish Ada to the Marketplace");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
  render(
    <AgentShareDialog
      agent={agent}
      type={echo}
      session={community().session}
      onClose={() => {}}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Export as JSON instead" }),
  );
  expect(await screen.findByText("Exported.")).toBeInTheDocument();
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
      render(
        <AgentShareDialog
          agent={{ ...agent, name }}
          type={echo}
          session={community().session}
          onClose={() => {}}
        />,
      );
      await user.click(screen.getByRole("button", { name: `Export ${name}` }));
      expect(await screen.findByText("Exported.")).toBeInTheDocument();
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
    render(
      <AgentShareDialog
        agent={{ ...agent, picture: "https://media.example/ada.png" }}
        type={echo}
        session={community().session}
        onClose={() => {}}
      />,
    );
    // Only the wait for the picture runs on a controlled clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.click(screen.getByRole("button", { name: "Export Ada" }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(desktop.invoke).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    expect(await screen.findByText("Exported.")).toBeInTheDocument();
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
  render(
    <AgentShareDialog
      agent={{ ...agent, picture: `${pack.url}#buzz-anim=x` }}
      type={echo}
      session={community().session}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Export Ada" }));
  expect(await screen.findByText("Exported.")).toBeInTheDocument();
  expect(sources).toEqual([pack.preview]);
});

it("saves an .agent.png natively on desktop, never through a blob link", async () => {
  const user = userEvent.setup();
  desktop.tauri = true;
  desktop.invoke.mockResolvedValueOnce("/Users/ada/Downloads/Ada.agent.png");
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
  try {
    render(
      <AgentShareDialog
        agent={agent}
        type={echo}
        session={community().session}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Export Ada" }));
    // Desktop says where the file went.
    expect(
      await screen.findByText("Saved to /Users/ada/Downloads/Ada.agent.png."),
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
  await user.click(await listingAction("Update Ada in the Marketplace"));
  const review = screen.getByRole("dialog", {
    name: "Update Ada in the Marketplace",
  });
  expect(
    within(review).getByRole("region", { name: "Instructions" }),
  ).toHaveTextContent("Review pull requests.");
  await user.click(within(review).getByRole("button", { name: "Update" }));
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
    await screen.findByText("Published to the Marketplace."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Update Ada in the Marketplace" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Remove Ada from the Marketplace" }),
  ).toBeInTheDocument();
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
  await user.click(await listingAction("Update Ada in the Marketplace"));
  await user.click(screen.getByRole("button", { name: "Update" }));
  await vi.waitFor(() => expect(outbox.send).toHaveBeenCalledTimes(1));
  // It never landed, and the old listing is still shared.
  lose(false);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t publish Ada. Try again.",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByText("Your latest changes aren’t in the Marketplace yet."),
  ).toBeInTheDocument();
  // Back on the row, focus returns to the button that opened the step.
  expect(
    screen.getByRole("button", { name: "Update Ada in the Marketplace" }),
  ).toHaveFocus();
  await user.click(
    screen.getByRole("button", { name: "Remove Ada from the Marketplace" }),
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  // Escape in a step goes back rather than closing the window.
  await user.keyboard("{Escape}");
  expect(screen.getByRole("dialog", { name: "Share Ada" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Remove Ada from the Marketplace" }),
  ).toHaveFocus();
});
