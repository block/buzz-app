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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ClientSnapshot,
  CommunityReader,
} from "../../features/communities/service";
import type { MessageAction } from "../../features/conversation/contracts";
import type { Navigation } from "../../features/navigation/controller";
import type { ChannelMessage } from "../../features/relay/contracts";
import type { RelayData, RelaySnapshot } from "../../features/relay/service";
import type { RelaySession } from "../../features/relay/session";
import {
  clearViewScope,
  viewScopeLockName,
  viewRevision,
  writeView,
} from "../../shared/view-state";
import { installTestLocks } from "../../shared/test-locks";
import { DecisionInboxPage } from "./DecisionInboxPage";
import { clearDrafts, draftFor } from "./drafts";
import { apply } from "./index";
import { key, readList } from "./model";

const viewer = "a".repeat(64);
const scope = `https://one.test:${viewer}`;
const second = `https://two.test:${viewer}`;
const message = {
  id: "e".repeat(64),
  channelId: "room",
  content: "Please decide whether to ship.",
} as ChannelMessage;

function fixture() {
  const session = { viewer, scope } as RelaySession;
  let state = { status: "ready", viewer, scope, session } as RelaySnapshot;
  const listeners = new Set<() => void>();
  let membershipIds = ["https://one.test"];
  const communityListeners = new Set<() => void>();
  const communityReader = {
    snapshot: () =>
      ({
        status: "ready",
        viewer,
        memberships: membershipIds.map((id) => ({ id, name: id })),
      }) as ClientSnapshot,
    subscribe(listener: () => void) {
      communityListeners.add(listener);
      return () => void communityListeners.delete(listener);
    },
  } satisfies CommunityReader;
  const relay = {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry() {},
    disconnect() {},
    clearCache: async () => {},
  } satisfies RelayData;
  const navigator = {
    open: vi.fn(async () => ({ status: "opened" })),
  } as unknown as Navigation;
  const actions: MessageAction[] = [];
  apply({
    relay,
    communityReader,
    navigation: navigator,
    pages: { register: vi.fn() },
    conversation: {
      registerMessageAction: (action: MessageAction) => actions.push(action),
    },
  } as unknown as Parameters<typeof apply>[0]);
  const action = actions[0];
  if (!action) throw new Error("Decision action was not registered");
  return {
    relay,
    navigator,
    session,
    action,
    leaveCommunity() {
      membershipIds = [];
      for (const listener of communityListeners) listener();
    },
    cached() {
      state = { ...state, status: "error", cached: true } as RelaySnapshot;
      for (const listener of listeners) listener();
    },
    switchScope() {
      state = {
        status: "ready",
        viewer,
        scope: second,
        session: { viewer, scope: second } as RelaySession,
      } as RelaySnapshot;
      for (const listener of listeners) listener();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      onmessage = null;
      postMessage() {}
    },
  );
  clearDrafts(scope);
  clearDrafts(second);
  localStorage.clear();
  installTestLocks();
});
afterEach(() => {
  cleanup();
  clearDrafts(scope);
  clearDrafts(second);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
});

it("captures a message, records the decision and handoff, and opens its source", async () => {
  const h = fixture();
  const user = userEvent.setup();
  expect(h.action.matches(message, h.session)).toBe(true);
  const Action = h.action.component;
  const close = vi.fn();
  const actionView = render(
    <Action
      message={message}
      session={h.session}
      close={close}
      canOpen={() => false}
      open={() => false}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    "Ship now?",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Next actor" }),
    "Morgan",
  );
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(close).toHaveBeenCalledOnce();
  expect(readList(viewRevision(scope, key))).toMatchObject({
    status: "ready",
    records: [{ stage: "decision", question: "Ship now?" }],
  });
  actionView.unmount();

  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  expect(screen.getByText("Ship now?")).toBeVisible();
  expect(screen.getByText("Next: You decide · Then: Morgan")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Update" }));
  await user.type(
    screen.getByRole("textbox", { name: "Decision Optional" }),
    "Ship tomorrow",
  );
  await user.click(screen.getByRole("combobox", { name: "Status" }));
  await user.click(
    await screen.findByRole("option", {
      name: "Decision made · awaiting handoff",
    }),
  );
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
  );
  expect(screen.getByText("Decision: Ship tomorrow")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Update" }));
  await user.click(screen.getByRole("combobox", { name: "Status" }));
  await user.click(
    await screen.findByRole("option", { name: "Handed off · done" }),
  );
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
  );
  expect(readList(viewRevision(scope, key))).toMatchObject({
    status: "ready",
    records: [{ stage: "done", nextActor: "Morgan" }],
  });
  await user.click(screen.getByRole("button", { name: "Open source" }));
  expect(h.navigator.open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    scope: { communityOrigin: "https://one.test", viewer },
    channelId: "room",
    messageId: message.id,
  });
});

it("does not show or save the old community after switching", async () => {
  const h = fixture();
  const user = userEvent.setup();
  writeView(scope, key, [
    {
      channelId: "room",
      messageId: message.id,
      preview: "source",
      question: "Old decision",
      nextActor: "Morgan",
      decision: "",
      stage: "decision",
      createdAt: 1,
    },
  ]);
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  expect(screen.getByText("Old decision")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove" }));
  expect(
    screen.getByRole("dialog", { name: "Remove saved decision?" }),
  ).toBeVisible();
  act(() => h.switchScope());
  expect(
    screen.queryByRole("dialog", { name: "Remove saved decision?" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Old decision")).not.toBeInTheDocument();
  expect(screen.getByText("No decisions saved")).toBeVisible();
  expect(h.action.matches(message, h.session)).toBe(false);
  const Action = h.action.component;
  render(
    <Action
      message={{ ...message, id: "f".repeat(64) }}
      session={h.session}
      close={() => {}}
      canOpen={() => false}
      open={() => false}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    "Stale question",
  );
  await user.type(screen.getByRole("textbox", { name: "Next actor" }), "Laura");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "account or community changed",
  );
  expect(readList(viewRevision(scope, key))).toMatchObject({
    status: "ready",
    records: [{ question: "Old decision" }],
  });
});

it("keeps an unsaved capture when dismissal is cancelled", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const Action = h.action.component;
  const close = vi.fn();
  render(
    <Action
      message={message}
      session={h.session}
      close={close}
      canOpen={() => false}
      open={() => false}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    "Decide this",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(
    screen.getByRole("dialog", { name: "Discard changes?" }),
  ).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
  ).toHaveValue("Decide this");
  expect(close).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(close).toHaveBeenCalledOnce();
});

it("restores an unsaved capture after its message row unmounts on navigation", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const Action = h.action.component;
  const props = {
    message,
    session: h.session,
    close: vi.fn(),
    canOpen: () => false,
    open: () => false,
  };
  const first = render(<Action {...props} />);
  await user.type(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    "Decide after navigation",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Next actor" }),
    "Morgan",
  );
  first.unmount();

  const secondView = render(<Action {...props} />);
  expect(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
  ).toHaveValue("Decide after navigation");
  expect(screen.getByRole("textbox", { name: "Next actor" })).toHaveValue(
    "Morgan",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Discard changes" }));
  secondView.unmount();

  render(<Action {...props} />);
  expect(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
  ).toHaveValue("");
});

it("reads the identified cached scope but blocks edits until reconnect", async () => {
  const h = fixture();
  const user = userEvent.setup();
  writeView(scope, key, [
    {
      channelId: "room",
      messageId: message.id,
      preview: "source",
      question: "Cached decision",
      nextActor: "Morgan",
      decision: "",
      stage: "decision",
      createdAt: 1,
    },
  ]);
  act(() => h.cached());
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  expect(screen.getByText("Cached decision")).toBeVisible();
  expect(
    screen.getByText("Saved decisions are read-only until you reconnect."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
  expect(h.action.matches(message, h.session)).toBe(false);
  await user.click(screen.getByRole("button", { name: "Open source" }));
  expect(h.navigator.open).toHaveBeenCalledOnce();
  act(() => h.switchScope());
  expect(screen.queryByText("Cached decision")).not.toBeInTheDocument();
});

it("restores an unsaved update after navigating away from the page", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const item = {
    channelId: "room",
    messageId: message.id,
    preview: "source",
    question: "Ship?",
    nextActor: "Morgan",
    decision: "",
    stage: "decision" as const,
    createdAt: 1,
  };
  writeView(scope, key, [item]);
  const first = render(
    <DecisionInboxPage relay={h.relay} navigator={h.navigator} />,
  );
  await user.click(screen.getByRole("button", { name: "Update" }));
  await user.type(
    screen.getByRole("textbox", { name: "Decision Optional" }),
    "Ship tomorrow",
  );
  first.unmount();

  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  await user.click(screen.getByRole("button", { name: "Update" }));
  expect(
    screen.getByRole("textbox", { name: "Decision Optional" }),
  ).toHaveValue("Ship tomorrow");
  expect(readList(viewRevision(scope, key))).toMatchObject({ records: [item] });
});

it("clears retained drafts with community data and protects them after navigation", async () => {
  const h = fixture();
  const Action = h.action.component;
  const props = {
    message,
    session: h.session,
    close: vi.fn(),
    canOpen: () => false,
    open: () => false,
  };
  const view = render(<Action {...props} />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    {
      target: { value: "Keep this draft" },
    },
  );
  const draftKey = JSON.stringify([scope, "capture", "room", message.id]);
  expect(draftFor(draftKey)?.question).toBe("Keep this draft");
  view.unmount();
  const pendingUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(pendingUnload);
  expect(pendingUnload.defaultPrevented).toBe(true);

  await act(() => clearViewScope(scope));
  expect(draftFor(draftKey)).toBeUndefined();
  const clearedUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clearedUnload);
  expect(clearedUnload.defaultPrevented).toBe(false);
  render(<Action {...props} />);
  expect(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
  ).toHaveValue("");
});

it("closes a mounted editor when its community is removed", async () => {
  const h = fixture();
  const Action = h.action.component;
  const close = vi.fn();
  render(
    <Action
      message={message}
      session={h.session}
      close={close}
      canOpen={() => false}
      open={() => false}
    />,
  );
  const input = screen.getByRole("textbox", {
    name: "Question or decision needed",
  });
  fireEvent.change(input, { target: { value: "Remove with community" } });
  const draftKey = JSON.stringify([scope, "capture", "room", message.id]);
  await act(() => clearViewScope(scope));
  expect(close).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { value: "Cannot restore this" } });
  expect(draftFor(draftKey)).toBeUndefined();
});

it("closes an untouched editor on an explicit scope purge", async () => {
  const h = fixture();
  const close = vi.fn();
  const Action = h.action.component;
  render(
    <Action
      message={message}
      session={h.session}
      close={close}
      canOpen={() => false}
      open={() => false}
    />,
  );
  const input = screen.getByRole("textbox", {
    name: "Question or decision needed",
  });
  await act(() => clearViewScope(scope));
  expect(close).toHaveBeenCalledOnce();
  fireEvent.change(input, { target: { value: "Cannot restore this" } });
  expect(
    draftFor(JSON.stringify([scope, "capture", "room", message.id])),
  ).toBeUndefined();
});

it("keeps a draft when device view reads are temporarily unavailable", () => {
  const h = fixture();
  const Action = h.action.component;
  const view = render(
    <Action
      message={message}
      session={h.session}
      close={() => {}}
      canOpen={() => false}
      open={() => false}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    {
      target: { value: "Keep while storage fails" },
    },
  );
  view.unmount();
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  act(() => {
    writeView(scope, "another-view", true);
  });
  read.mockRestore();
  expect(
    draftFor(JSON.stringify([scope, "capture", "room", message.id]))?.question,
  ).toBe("Keep while storage fails");
});

it("warns and drops an unsafe draft if cross-window purge is unavailable", () => {
  vi.stubGlobal("BroadcastChannel", undefined);
  const h = fixture();
  const Action = h.action.component;
  const view = render(
    <Action
      message={message}
      session={h.session}
      close={() => {}}
      canOpen={() => false}
      open={() => false}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    { target: { value: "Unsaved decision" } },
  );
  const draftKey = JSON.stringify([scope, "capture", "room", message.id]);
  expect(draftFor(draftKey)).toBeUndefined();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Copy them before leaving",
  );
  view.unmount();
  expect(draftFor(draftKey)).toBeUndefined();
  const pendingUnload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(pendingUnload);
  expect(pendingUnload.defaultPrevented).toBe(false);
});

it("keeps a retained draft after plugin UI unmount and a leave without purge", async () => {
  const h = fixture();
  const Action = h.action.component;
  const view = render(
    <Action
      message={message}
      session={h.session}
      close={() => {}}
      canOpen={() => false}
      open={() => false}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    { target: { value: "Keep when banned" } },
  );
  view.unmount();
  const draftKey = JSON.stringify([scope, "capture", "room", message.id]);
  act(() => h.leaveCommunity());
  act(() => writeView(scope, "other-view", true));
  expect(draftFor(draftKey)?.question).toBe("Keep when banned");
  await act(() => clearViewScope(scope));
  expect(draftFor(draftKey)).toBeUndefined();
});

it("evicts a draft whose changes were undone before closing", async () => {
  const h = fixture();
  const Action = h.action.component;
  const close = vi.fn();
  render(
    <Action
      message={message}
      session={h.session}
      close={close}
      canOpen={() => false}
      open={() => false}
    />,
  );
  const input = screen.getByRole("textbox", {
    name: "Question or decision needed",
  });
  fireEvent.change(input, { target: { value: "Temporary" } });
  fireEvent.change(input, { target: { value: "" } });
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(close).toHaveBeenCalledOnce();
  expect(
    draftFor(JSON.stringify([scope, "capture", "room", message.id])),
  ).toBeUndefined();
});

it("freezes fields while a save waits for another window", async () => {
  const h = fixture();
  const Action = h.action.component;
  let entered = () => {};
  let release = () => {};
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = navigator.locks.request(
    viewScopeLockName(scope),
    { mode: "exclusive" },
    async () => {
      entered();
      await held;
    },
  );
  await acquired;
  const close = vi.fn();
  render(
    <Action
      message={message}
      session={h.session}
      close={close}
      canOpen={() => false}
      open={() => false}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    {
      target: { value: "Ship?" },
    },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Next actor" }), {
    target: { value: "Morgan" },
  });
  try {
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    expect(
      screen.getByRole("textbox", { name: "Question or decision needed" }),
    ).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Next actor" })).toBeDisabled();
  } finally {
    release();
    await blocker;
  }
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(readList(viewRevision(scope, key))).toMatchObject({
    records: [{ question: "Ship?" }],
  });
});

it("does not save a queued edit after its community data is purged", async () => {
  const h = fixture();
  const Action = h.action.component;
  let entered = () => {};
  let release = () => {};
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = navigator.locks.request(
    viewScopeLockName(scope),
    { mode: "exclusive" },
    async () => {
      entered();
      await held;
    },
  );
  await acquired;
  const close = vi.fn();
  render(
    <Action
      message={message}
      session={h.session}
      close={close}
      canOpen={() => false}
      open={() => false}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    { target: { value: "Purge before save" } },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Next actor" }), {
    target: { value: "Morgan" },
  });
  const purge = clearViewScope(scope);
  try {
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
  } finally {
    release();
    await blocker;
  }
  await act(() => purge);
  expect(close).toHaveBeenCalledOnce();
  await act(async () => {
    await navigator.locks.request(
      viewScopeLockName(scope),
      { mode: "exclusive" },
      () => {},
    );
  });
  await waitFor(() => expect(viewRevision(scope, key)).toBeNull());
});

it("cancels an unmounted queued save and retains the newer draft", async () => {
  const h = fixture();
  const Action = h.action.component;
  let entered = () => {};
  let release = () => {};
  const acquired = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = navigator.locks.request(
    viewScopeLockName(scope),
    { mode: "exclusive" },
    async () => {
      entered();
      await held;
    },
  );
  await acquired;
  const close = vi.fn();
  const props = {
    message,
    session: h.session,
    close,
    canOpen: () => false,
    open: () => false,
  };
  const first = render(<Action {...props} />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    { target: { value: "First decision" } },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Next actor" }), {
    target: { value: "Morgan" },
  });
  try {
    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));
    first.unmount();
    render(<Action {...props} />);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Question or decision needed" }),
      { target: { value: "Newer draft" } },
    );
  } finally {
    release();
    await blocker;
  }
  await act(async () => {
    await navigator.locks.request(
      viewScopeLockName(scope),
      { mode: "exclusive" },
      () => {},
    );
  });
  expect(readList(viewRevision(scope, key))).toEqual({
    status: "ready",
    records: [],
  });
  expect(
    draftFor(JSON.stringify([scope, "capture", "room", message.id]))?.question,
  ).toBe("Newer draft");
  expect(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
  ).toHaveValue("Newer draft");
  expect(close).not.toHaveBeenCalled();
});

it("lets a removed decision's unsaved edit be copied or explicitly discarded", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const item = {
    channelId: "room",
    messageId: message.id,
    preview: "source",
    question: "Ship?",
    nextActor: "Morgan",
    decision: "",
    stage: "decision" as const,
    createdAt: 1,
  };
  writeView(scope, key, [item]);
  const first = render(
    <DecisionInboxPage relay={h.relay} navigator={h.navigator} />,
  );
  await user.click(screen.getByRole("button", { name: "Update" }));
  await user.type(
    screen.getByRole("textbox", { name: "Decision Optional" }),
    "Ship tomorrow",
  );
  first.unmount();

  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  const storageKey = `buzz-view.v1:${JSON.stringify([scope, key])}`;
  act(() => {
    localStorage.setItem(storageKey, "[]");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        storageArea: localStorage,
      }),
    );
  });
  const edits = screen.getByRole("region", { name: "Unsaved drafts" });
  expect(within(edits).getByText("Decision: Ship tomorrow")).toBeVisible();
  await user.click(within(edits).getByRole("button", { name: "Open source" }));
  expect(h.navigator.open).toHaveBeenCalled();
  await user.click(
    within(edits).getByRole("button", { name: "Discard draft" }),
  );
  await user.click(screen.getByRole("button", { name: "Keep draft" }));
  expect(within(edits).getByText("Decision: Ship tomorrow")).toBeVisible();
  await user.click(
    within(edits).getByRole("button", { name: "Discard draft" }),
  );
  await user.click(
    within(
      screen.getByRole("dialog", { name: "Discard unsaved draft?" }),
    ).getByRole("button", {
      name: "Discard draft",
    }),
  );
  expect(
    screen.queryByRole("region", { name: "Unsaved drafts" }),
  ).not.toBeInTheDocument();
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);
});

it("shows a retained capture even after its source message disappears", async () => {
  const h = fixture();
  const Action = h.action.component;
  const actionView = render(
    <Action
      message={message}
      session={h.session}
      close={() => {}}
      canOpen={() => false}
      open={() => false}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    { target: { value: "Decide after source removal" } },
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Next actor" }), {
    target: { value: "Morgan" },
  });
  actionView.unmount();
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  const drafts = screen.getByRole("region", { name: "Unsaved drafts" });
  expect(within(drafts).getByText("Unsaved capture")).toBeVisible();
  expect(within(drafts).getByText("Decide after source removal")).toBeVisible();
  await userEvent
    .setup()
    .click(within(drafts).getByRole("button", { name: "Discard draft" }));
  await userEvent
    .setup()
    .click(
      within(
        screen.getByRole("dialog", { name: "Discard unsaved draft?" }),
      ).getByRole("button", { name: "Discard draft" }),
    );
  expect(
    screen.queryByRole("region", { name: "Unsaved drafts" }),
  ).not.toBeInTheDocument();
});

it("removes rendered draft text as soon as a purge clears the draft store", async () => {
  const h = fixture();
  const Action = h.action.component;
  const actionView = render(
    <Action
      message={message}
      session={h.session}
      close={() => {}}
      canOpen={() => false}
      open={() => false}
    />,
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    { target: { value: "Sensitive draft" } },
  );
  actionView.unmount();
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  expect(screen.getByText("Sensitive draft")).toBeVisible();
  act(() => clearDrafts(scope));
  expect(screen.queryByText("Sensitive draft")).not.toBeInTheDocument();
});

it("closes a pending removal confirmation when its scope is purged", async () => {
  const h = fixture();
  writeView(scope, key, [
    {
      channelId: "room",
      messageId: message.id,
      preview: "source",
      question: "Purge this decision",
      nextActor: "Morgan",
      decision: "",
      stage: "decision",
      createdAt: 1,
    },
  ]);
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  await userEvent.setup().click(screen.getByRole("button", { name: "Remove" }));
  expect(
    screen.getByRole("dialog", { name: "Remove saved decision?" }),
  ).toHaveTextContent("Purge this decision");
  await act(() => clearViewScope(scope));
  expect(
    screen.queryByRole("dialog", { name: "Remove saved decision?" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText("Purge this decision")).not.toBeInTheDocument();
});

it("keeps the capture form and explains a failed device save", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const Action = h.action.component;
  const close = vi.fn();
  render(
    <Action
      message={message}
      session={h.session}
      close={close}
      canOpen={() => false}
      open={() => false}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    "Choose a date",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Next actor" }),
    "Morgan",
  );
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not save on this device",
  );
  expect(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
  ).toHaveValue("Choose a date");
  expect(close).not.toHaveBeenCalled();
});

it("shows malformed data and resets only after confirmation", async () => {
  const h = fixture();
  const user = userEvent.setup();
  localStorage.setItem(`buzz-view.v1:${JSON.stringify([scope, key])}`, "{bad");
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  expect(screen.getByText("Saved decisions cannot be read")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Reset saved list" }));
  expect(viewRevision(scope, key)).toBe("{bad");
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Reset list",
    }),
  );
  expect(screen.getByText("No decisions saved")).toBeVisible();
  expect(readList(viewRevision(scope, key))).toEqual({
    status: "ready",
    records: [],
  });
});

it("can reset an empty serialized saved list", async () => {
  const h = fixture();
  const user = userEvent.setup();
  localStorage.setItem(`buzz-view.v1:${JSON.stringify([scope, key])}`, "");
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  expect(screen.getByText("Saved decisions cannot be read")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Reset saved list" }));
  expect(
    screen.getByRole("dialog", { name: "Reset saved decisions?" }),
  ).toBeVisible();
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Reset list",
    }),
  );
  expect(screen.getByText("No decisions saved")).toBeVisible();
});

it("does not reset data repaired in another window while confirmation is open", async () => {
  const h = fixture();
  const user = userEvent.setup();
  localStorage.setItem(`buzz-view.v1:${JSON.stringify([scope, key])}`, "{bad");
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  await user.click(screen.getByRole("button", { name: "Reset saved list" }));
  const repaired = [
    {
      channelId: "room",
      messageId: message.id,
      preview: "source",
      question: "Recovered",
      nextActor: "Morgan",
      decision: "",
      stage: "decision",
      createdAt: 1,
    },
  ];
  act(() => {
    writeView(scope, key, repaired);
  });
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Reset list",
    }),
  );
  expect(readList(viewRevision(scope, key))).toEqual({
    status: "ready",
    records: repaired,
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "changed in another window",
  );
});

it("does not overwrite a newer decision when a stale row opens the editor", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const original = {
    channelId: "room",
    messageId: message.id,
    preview: "source",
    question: "Original",
    nextActor: "Morgan",
    decision: "",
    stage: "decision",
    createdAt: 1,
  };
  writeView(scope, key, [original]);
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  expect(screen.getByText("Original")).toBeVisible();
  const newer = { ...original, question: "Newer" };
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, key])}`,
    JSON.stringify([newer]),
  );
  await user.click(screen.getByRole("button", { name: "Update" }));
  await user.clear(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    "Stale edit",
  );
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "changed in another window",
  );
  expect(readList(viewRevision(scope, key))).toEqual({
    status: "ready",
    records: [newer],
  });
});

it("removes a saved decision only after confirmation", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const item = {
    channelId: "room",
    messageId: message.id,
    preview: "source",
    question: "Decision to remove",
    nextActor: "Morgan",
    decision: "Ship tomorrow",
    stage: "done",
    createdAt: 1,
  };
  writeView(scope, key, [item]);
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  await user.click(screen.getByRole("button", { name: "Remove" }));
  const dialog = screen.getByRole("dialog", { name: "Remove saved decision?" });
  expect(dialog).toHaveTextContent("The source message stays in Buzz.");
  expect(readList(viewRevision(scope, key))).toMatchObject({
    records: [item],
  });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(screen.getByText("Decision to remove")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Remove decision",
    }),
  );
  expect(screen.getByText("No decisions saved")).toBeVisible();
  expect(readList(viewRevision(scope, key))).toEqual({
    status: "ready",
    records: [],
  });
});

it("forgets a retained edit draft when its saved decision is removed", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const item = {
    channelId: "room",
    messageId: message.id,
    preview: "source",
    question: "Decision to remove",
    nextActor: "Morgan",
    decision: "",
    stage: "decision",
    createdAt: 1,
  };
  writeView(scope, key, [item]);
  const first = render(
    <DecisionInboxPage relay={h.relay} navigator={h.navigator} />,
  );
  await user.click(screen.getByRole("button", { name: "Update" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Question or decision needed" }),
    { target: { value: "Unsaved edit" } },
  );
  const draftKey = JSON.stringify([scope, "edit", "room", message.id]);
  expect(draftFor(draftKey)?.question).toBe("Unsaved edit");
  first.unmount();

  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  await user.click(screen.getByRole("button", { name: "Remove" }));
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Remove decision",
    }),
  );
  expect(screen.getByText("No decisions saved")).toBeVisible();
  expect(draftFor(draftKey)).toBeUndefined();
});

it("keeps a newer saved decision when removal was opened from a stale list", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const item = {
    channelId: "room",
    messageId: message.id,
    preview: "source",
    question: "Original",
    nextActor: "Morgan",
    decision: "",
    stage: "decision",
    createdAt: 1,
  };
  writeView(scope, key, [item]);
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  await user.click(screen.getByRole("button", { name: "Remove" }));
  const newer = [{ ...item, question: "Changed in another window" }];
  localStorage.setItem(
    `buzz-view.v1:${JSON.stringify([scope, key])}`,
    JSON.stringify(newer),
  );
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Remove decision",
    }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "changed in another window",
  );
  expect(readList(viewRevision(scope, key))).toEqual({
    status: "ready",
    records: newer,
  });
});

it("explains a failed removal and leaves the saved item in place", async () => {
  const h = fixture();
  const user = userEvent.setup();
  const item = {
    channelId: "room",
    messageId: message.id,
    preview: "source",
    question: "Keep this decision",
    nextActor: "Morgan",
    decision: "",
    stage: "decision",
    createdAt: 1,
  };
  writeView(scope, key, [item]);
  render(<DecisionInboxPage relay={h.relay} navigator={h.navigator} />);
  await user.click(screen.getByRole("button", { name: "Remove" }));
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  await user.click(
    within(screen.getByRole("dialog")).getByRole("button", {
      name: "Remove decision",
    }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not remove this decision on this device",
  );
  expect(readList(viewRevision(scope, key))).toMatchObject({ records: [item] });
});
