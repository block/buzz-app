// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { keypair, signed } from "../../features/relay/testing";
import { publicKeyLabels } from "../../shared/identity/public-key";
import { readView } from "../../shared/view-state";
import type { ChannelList } from "../../features/relay/contracts";
import { createRelaySession } from "../../features/relay/session";
import { bindNames } from "../../features/identity-names/service";
import { assignTodo, readTodos } from "./model";
import { TodosPanel } from "./TodosPanel";
const context = {
  scope: "todos-test",
  channelId: "11111111-1111-4111-8111-111111111111",
  channelName: "Team",
  viewer: "viewer",
  relayUrl: "",
};
const original =
  "# Instructions\nLeave this alone.\n\n## Todos\n\n- [ ] First\n- [x] Done\n\n## Decisions\nKeep this too.\n";
const head = signed(keypair(), {
  kind: 40100,
  content: original,
  tags: [["h", context.channelId]],
});
const session = createRelaySession(null).session;
const list = {
  status: "ready" as const,
  channels: [{ id: context.channelId, name: "Team", members: [] as string[] }],
};
const people = {
  ...session,
  channels: { ...session.channels, list: () => list },
};
function fixture() {
  let current = head;
  const canvas = {
    available: true,
    read: vi.fn(async () => current),
    save: vi.fn(
      async (_channel: string, content: string, base: string | undefined) => {
        if (base !== current.id) throw new Error("Canvas changed");
        current = { ...head, content, id: "b".repeat(64) };
        return current;
      },
    ),
  };
  let active = true;
  const props = {
    canvas,
    people,
    context,
    close: vi.fn(),
    active: () => active,
  };
  return {
    canvas,
    props,
    retire: () => {
      active = false;
    },
    external: () => {
      current = {
        ...head,
        id: "c".repeat(64),
        content: `${original}\nRemote edit.`,
      };
    },
  };
}
beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const save = () => screen.getByRole("button", { name: /^Save$/ });
it("adds and checks tasks, saves exact base, preserves other Markdown and restores saved content", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  expect(save()).toBeDisabled();
  const input = screen.getByRole("textbox", { name: "New todo" });
  await user.type(input, "New item{Enter}");
  expect(input).toHaveFocus();
  await user.click(screen.getByRole("checkbox", { name: "New item" }));
  expect(screen.getByRole("checkbox", { name: "New item" })).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  await user.click(save());
  await waitFor(() => expect(save()).toBeDisabled());
  expect(f.canvas.save).toHaveBeenCalledWith(
    context.channelId,
    original.replace("## Todos", "## Todos\n\n- [x] New item\n"),
    head.id,
  );
  expect(
    readView(context.scope, `todos-draft-v1:${context.channelId}`, null),
  ).toBeNull();
  view.unmount();
  render(<TodosPanel {...f.props} />);
  expect(
    await screen.findByRole("checkbox", { name: "New item" }),
  ).toBeChecked();
});
it("keeps failed save changes through close/reopen and confirms destructive refresh", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await user.click(await screen.findByRole("checkbox", { name: "First" }));
  f.external();
  await user.click(save());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your changes are still here",
  );
  view.unmount();
  render(<TodosPanel {...f.props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Canvas changed elsewhere",
  );
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  expect(save()).toBeDisabled();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  confirm.mockReturnValue(true);
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(screen.getByRole("checkbox", { name: "First" })).not.toBeChecked(),
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
it("retrying a failed read preserves a restored draft without asking to discard", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await user.click(await screen.findByRole("checkbox", { name: "First" }));
  view.unmount();
  f.canvas.read.mockRejectedValueOnce(new Error("Offline"));
  render(<TodosPanel {...f.props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  const confirm = vi.spyOn(window, "confirm");
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(save()).toBeEnabled());
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  expect(confirm).not.toHaveBeenCalled();
});
it("ignores retired reads and reconciles a save completed after unmount without resubmission", async () => {
  const f = fixture(),
    user = userEvent.setup();
  let release!: (value: typeof head) => void;
  const pending = new Promise<typeof head>((resolve) => {
    release = resolve;
  });
  f.canvas.read.mockReturnValueOnce(pending);
  const view = render(
    <StrictMode>
      <TodosPanel {...f.props} />
    </StrictMode>,
  );
  await user.click(await screen.findByRole("checkbox", { name: "First" }));
  await act(async () => {
    release({ ...head, content: "Old read" });
    await pending;
  });
  expect(screen.getByRole("checkbox", { name: "First" })).toBeChecked();
  const actualSave = f.canvas.save.getMockImplementation();
  if (!actualSave) throw new Error("Expected fixture save");
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.canvas.save.mockImplementationOnce(async (...args) => {
    await gate;
    return actualSave(...args);
  });
  await user.click(save());
  expect(save()).toBeDisabled();
  view.unmount();
  await act(async () => {
    finish();
    await gate;
  });
  render(<TodosPanel {...f.props} />);
  expect(await screen.findByRole("checkbox", { name: "First" })).toBeChecked();
  expect(save()).toBeDisabled();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(f.canvas.save).toHaveBeenCalledTimes(1);
});
it("fences new writes after plugin retirement and isolates channel drafts", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await user.click(await screen.findByRole("checkbox", { name: "First" }));
  f.retire();
  await user.click(save());
  expect(f.canvas.save).not.toHaveBeenCalled();
  view.unmount();
  render(
    <TodosPanel
      {...fixture().props}
      context={{ ...context, channelId: "different" }}
    />,
  );
  expect(
    await screen.findByRole("checkbox", { name: "First" }),
  ).not.toBeChecked();
  expect(save()).toBeDisabled();
});
it("exposes malformed sections and unavailable hosts without permitting writes", async () => {
  const f = fixture();
  f.canvas.available = false;
  f.canvas.read.mockResolvedValue({ ...head, content: "## Todos\n\n## Todos" });
  render(<TodosPanel {...f.props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "more than one Todos",
  );
  expect(screen.getByRole("textbox", { name: "New todo" })).toBeDisabled();
  expect(save()).toBeDisabled();
});

it("rebases an input-only recovery draft without discarding the typed item", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const view = render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  await user.type(
    screen.getByRole("textbox", { name: "New todo" }),
    "Still typing",
  );
  view.unmount();
  f.external();
  render(<TodosPanel {...f.props} />);
  await screen.findByRole("checkbox", { name: "First" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "New todo" })).toHaveValue(
    "Still typing",
  );
  await user.click(screen.getByRole("button", { name: /^Add$/ }));
  await user.click(save());
  expect(f.canvas.save).toHaveBeenCalledWith(
    context.channelId,
    expect.stringContaining("Remote edit."),
    "c".repeat(64),
  );
});
it("keeps the editor usable when local recovery storage is unavailable", async () => {
  const f = fixture(),
    user = userEvent.setup();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage full");
  });
  render(<TodosPanel {...f.props} />);
  await user.click(await screen.findByRole("checkbox", { name: "First" }));
  await user.click(save());
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("Saved in Canvas"),
  );
  expect(f.canvas.save).toHaveBeenCalledTimes(1);
});

it("keeps exact assignees through rename, failed-save recovery and member removal, then clears", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const a = "a".repeat(64),
    b = "b".repeat(64);
  let roster: ChannelList = {
    status: "ready" as const,
    channels: [{ id: context.channelId, name: "Team", members: [a, b] }],
  };
  let profiles = new Map([
    [a, { name: "Alex" }],
    [b, { name: "Alex" }],
  ]);
  const labels = publicKeyLabels([a, b]);
  const rosterListeners = new Set<() => void>(),
    profileListeners = new Set<() => void>();
  const directory = {
    snapshot: () => profiles,
    subscribe: (listener: () => void) => {
      profileListeners.add(listener);
      return () => {
        profileListeners.delete(listener);
      };
    },
    ensure: vi.fn(async () => {}),
  };
  const names = bindNames({
    profiles: directory,
    agentLibrary: session.agentLibrary,
  });
  const users = {
    profiles: directory,
    names,
    channels: {
      ...people.channels,
      list: () => roster,
      subscribeList: (listener: () => void) => {
        rosterListeners.add(listener);
        return () => {
          rosterListeners.delete(listener);
        };
      },
    },
  };
  const select = () =>
    within(screen.getByRole("group", { name: "Assignee for First" })).getByRole(
      "combobox",
    );
  const view = render(<TodosPanel {...f.props} people={users} />);
  await screen.findByRole("checkbox", { name: "First" });
  await user.click(select());
  expect(
    screen.getByRole("option", { name: `Alex · ${labels.get(a)}` }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("option", { name: `Alex · ${labels.get(b)}` }),
  ).toBeInTheDocument();
  await user.click(
    screen.getByRole("option", { name: `Alex · ${labels.get(a)}` }),
  );
  const expected = assignTodo(
    original,
    readTodos(original).items[0]?.offset ?? -1,
    {
      pubkey: a,
      name: "Alex",
    },
  );
  f.canvas.save.mockRejectedValueOnce(new Error("Offline"));
  await user.click(save());
  await screen.findByRole("alert");
  view.unmount();
  const restored = render(<TodosPanel {...f.props} people={users} />);
  await screen.findByRole("checkbox", { name: "First" });
  expect(select()).toHaveTextContent(`Alex · ${labels.get(a)}`);
  act(() => {
    profiles = new Map([
      [a, { name: "Renamed" }],
      [b, { name: "Alex" }],
    ]);
    for (const listener of profileListeners) listener();
  });
  expect(select()).toHaveTextContent("Renamed");
  await user.click(save());
  await waitFor(() => expect(save()).toBeDisabled());
  expect(f.canvas.save).toHaveBeenLastCalledWith(
    context.channelId,
    expected,
    head.id,
  );
  act(() => {
    roster = {
      ...roster,
      channels: [{ id: context.channelId, name: "Team", members: [b] }],
    };
    for (const listener of rosterListeners) listener();
  });
  expect(select()).toHaveTextContent("not in channel");
  expect(save()).toBeDisabled();
  act(() => select().focus());
  await user.keyboard("{ArrowDown}");
  await user.click(await screen.findByRole("option", { name: "Unassigned" }));
  await user.click(save());
  expect(f.canvas.save).toHaveBeenLastCalledWith(
    context.channelId,
    original,
    "b".repeat(64),
  );
  restored.unmount();
  names.dispose();
  expect(rosterListeners.size).toBe(0);
  expect(profileListeners.size).toBe(0);
});
it("shows saved identity when profiles fail, disables missing-roster assignments and rejects stale membership selections", async () => {
  const f = fixture(),
    user = userEvent.setup();
  const a = "a".repeat(64);
  let roster: ChannelList = {
    status: "ready" as const,
    channels: [
      {
        id: context.channelId,
        name: "Team",
        members: [a, "b".repeat(64)],
      },
    ],
  };
  const users = {
    ...people,
    channels: { ...people.channels, list: () => roster },
    profiles: {
      ...people.profiles,
      ensure: vi.fn(async () => {
        throw new Error("Offline");
      }),
    },
  };
  const saved = assignTodo(
    original,
    readTodos(original).items[0]?.offset ?? -1,
    {
      pubkey: a,
      name: "Saved name",
    },
  );
  f.canvas.read.mockResolvedValue({ ...head, content: saved });
  const view = render(<TodosPanel {...f.props} people={users} />);
  const select = () =>
    within(screen.getByRole("group", { name: "Assignee for First" })).getByRole(
      "combobox",
    );
  await screen.findByRole("checkbox", { name: "First" });
  expect(select()).toHaveTextContent("Saved name");
  await screen.findByText(/Names unavailable/);
  await user.click(screen.getByRole("button", { name: "Retry users" }));
  await waitFor(() => expect(users.profiles.ensure).toHaveBeenCalledTimes(2));
  // Captured option is stale; the click must read the current authoritative roster.
  act(() => select().focus());
  await user.keyboard("{ArrowDown}");
  const stale = await screen.findByRole("option", {
    name:
      publicKeyLabels([a, "b".repeat(64)]).get("b".repeat(64)) ??
      "missing fixture label",
  });
  roster = {
    ...roster,
    channels: [{ id: context.channelId, name: "Team", members: [] }],
  };
  await user.click(stale);
  expect(save()).toBeDisabled();
  roster = {
    ...roster,
    channels: [{ id: context.channelId, name: "Team" }],
  };
  view.rerender(<TodosPanel {...f.props} people={users} />);
  expect(select()).toBeDisabled();
  expect(select()).toHaveTextContent("membership unavailable");
});
