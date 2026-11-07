// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { apply } from "../dist/plugin.js";
import { readBookmarks } from "./model";

afterEach(cleanup);
// jsdom supplies popover's hidden default but not its native opening API.
const nativeShowPopover = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "showPopover",
);
beforeAll(() => {
  if (!nativeShowPopover)
    Object.defineProperty(HTMLElement.prototype, "showPopover", {
      configurable: true,
      value() {
        this.style.display = "block";
      },
    });
});
afterAll(() => {
  if (!nativeShowPopover) delete HTMLElement.prototype.showPopover;
});
function fixture(extraLinks = "") {
  let registration;
  let dispose;
  let head = {
    id: "one",
    content:
      "# Notes\nKeep me.\n\n## Channel bookmarks\n- [Docs](https://example.com/docs)\n" +
      extraLinks,
  };
  let list = {
    channels: [
      { id: "alpha", members: ["viewer"], cached: false, readOnly: false },
    ],
  };
  const listeners = new Set();
  const canvas = {
    available: true,
    read: vi.fn(async () => head),
    save: vi.fn(async (_id, content, expected) => {
      if (head.id !== expected) {
        const error = new Error("Conflict");
        error.name = "CanvasConflictError";
        throw error;
      }
      head = { id: `${head.id}-next`, content };
      return head;
    }),
  };
  const state = {
    status: "ready",
    scope: "primary:viewer",
    generation: 1,
    session: {
      viewer: "viewer",
      canvas,
      channels: {
        list: () => list,
        subscribeList: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  };
  apply({
    react: React,
    effect: (effect) => {
      dispose = effect();
    },
    panels: {
      register: (panel) => {
        registration = panel;
      },
    },
    relay: { snapshot: () => state, subscribe: () => () => {} },
  });
  const Panel = registration.component;
  render(<Panel channelContext={{ scope: state.scope, channelId: "alpha" }} />);
  return {
    canvas,
    registration,
    dispose: () => dispose(),
    head: () => head,
    changeHead: (
      transform = (content) => `${content}\n## Other\nConcurrent notes.\n`,
    ) => {
      head = { ...head, id: "external", content: transform(head.content) };
    },
    access: (change) =>
      act(() => {
        list = {
          channels: list.channels.map((channel) => ({ ...channel, ...change })),
        };
        for (const listener of listeners) listener();
      }),
  };
}
async function fill(user, label, url) {
  if (!screen.queryByRole("textbox", { name: "Bookmark name" }))
    await user.click(screen.getByRole("button", { name: "Add bookmark" }));
  await user.clear(screen.getByRole("textbox", { name: "Bookmark name" }));
  await user.type(
    screen.getByRole("textbox", { name: "Bookmark name" }),
    label,
  );
  await user.clear(screen.getByRole("textbox", { name: "Bookmark URL" }));
  await user.type(screen.getByRole("textbox", { name: "Bookmark URL" }), url);
}
it("registers only an existing channel panel and fences its launcher after disposal", async () => {
  const f = fixture();
  expect(f.registration.channelPlacement).toBe("side");
  const toggle = vi.fn();
  const Launcher = f.registration.channelLauncher;
  render(
    <Launcher
      context={{ channelId: "alpha" }}
      toggle={toggle}
      pressed={false}
      available={() => true}
    />,
  );
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Toggle channel bookmarks" }),
  );
  expect(toggle).toHaveBeenCalledWith("alpha");
  f.dispose();
  await user.click(
    screen.getByRole("button", { name: "Toggle channel bookmarks" }),
  );
  expect(toggle).toHaveBeenCalledTimes(1);
});
it("adds, edits, reorders, and removes shared links while preserving other Canvas sections", async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByRole("link", { name: "Docs" });
  await fill(user, "API", "https://example.com/api");
  await user.click(screen.getByRole("button", { name: "Add bookmark" }));
  await screen.findByRole("link", { name: "API" });
  await user.click(screen.getByRole("button", { name: "Actions for API" }));
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  await fill(user, "Reference", "https://example.com/ref");
  await user.click(screen.getByRole("button", { name: "Save bookmark" }));
  await screen.findByRole("link", { name: "Reference" });
  screen.getByRole("button", { name: "Reorder Reference" }).focus();
  await user.keyboard("{ArrowUp}");
  await waitFor(() =>
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(
      ["Reference", "Docs"],
    ),
  );
  await user.click(screen.getByRole("button", { name: "Actions for Docs" }));
  await user.click(screen.getByRole("menuitem", { name: "Remove" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("link", { name: "Docs" }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Add bookmark" })).toHaveFocus();
  expect(readBookmarks(f.head().content).items).toEqual([
    { label: "Reference", url: "https://example.com/ref" },
  ]);
  expect(f.head().content).toContain("# Notes\nKeep me.");
  for (const call of f.canvas.save.mock.calls) {
    expect(call[3]).toEqual({ preserveApproval: true });
  }
});
it("preserves typed input on conflict and reloads the latest Canvas before resubmission", async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByRole("link", { name: "Docs" });
  await fill(user, "API", "https://example.com/api");
  f.changeHead();
  await user.click(screen.getByRole("button", { name: "Add bookmark" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Bookmarks changed elsewhere",
  );
  expect(screen.getByRole("textbox", { name: "Bookmark name" })).toHaveValue(
    "API",
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add bookmark" })).toBeEnabled(),
  );
  await user.click(screen.getByRole("button", { name: "Add bookmark" }));
  await screen.findByRole("link", { name: "API" });
  expect(f.head().content).toContain("## Other\nConcurrent notes.");
});
it("keeps read-only links but hides editing and revoked data", async () => {
  const f = fixture();
  await screen.findByRole("link", { name: "Docs" });
  f.access({ readOnly: true });
  expect(screen.getByRole("link", { name: "Docs" })).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  f.access({ members: [] });
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(f.canvas.save).not.toHaveBeenCalled();
});
it("keeps failed input after a save failure", async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByRole("link", { name: "Docs" });
  f.canvas.save.mockRejectedValueOnce(new Error("Offline"));
  await fill(user, "API", "https://example.com/api");
  await user.click(screen.getByRole("button", { name: "Add bookmark" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  expect(screen.getByRole("textbox", { name: "Bookmark name" })).toHaveValue(
    "API",
  );
});

it("uses the host tooltip bubble and dismisses it on leave, Escape, click, and unmount", async () => {
  const f = fixture();
  const Launcher = f.registration.channelLauncher;
  const toggle = vi.fn();
  const view = render(
    <Launcher
      context={{ channelId: "alpha" }}
      toggle={toggle}
      pressed={false}
      available={() => true}
    />,
  );
  const user = userEvent.setup();
  const button = screen.getByRole("button", {
    name: "Toggle channel bookmarks",
  });
  expect(button).not.toHaveAttribute("title");
  await user.hover(button);
  const hint = await screen.findByRole("tooltip", { name: "Bookmarks" });
  expect(hint).toHaveClass("buzz-tooltip");
  expect(button).toHaveAttribute("aria-describedby", hint.id);
  await user.unhover(button);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  act(() => button.focus());
  expect(screen.getByRole("tooltip")).toHaveTextContent("Bookmarks");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  fireEvent.pointerEnter(button);
  await screen.findByRole("tooltip");
  await user.click(button);
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  expect(toggle).toHaveBeenCalledWith("alpha");
  await user.unhover(button);
  await user.hover(button);
  await screen.findByRole("tooltip");
  view.unmount();
  expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
});
it("cancels a pending hint when its launcher unmounts", () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const Launcher = f.registration.channelLauncher;
    const view = render(
      <Launcher
        context={{ channelId: "alpha" }}
        toggle={() => {}}
        pressed={false}
        available={() => true}
      />,
    );
    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Toggle channel bookmarks" }),
    );
    view.unmount();
    act(() => vi.runAllTimers());
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

it("reloads on reopening, supports retry after a failed load, and ignores a detached read", async () => {
  const f = fixture();
  await screen.findByRole("link", { name: "Docs" });
  expect(
    screen.queryByRole("button", { name: "Refresh bookmarks" }),
  ).not.toBeInTheDocument();
  const Panel = f.registration.component;
  cleanup();
  f.canvas.read.mockRejectedValueOnce(new Error("Offline"));
  const props = {
    channelContext: { scope: "primary:viewer", channelId: "alpha" },
  };
  render(<Panel {...props} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", { name: "Retry loading bookmarks" }),
  );
  await screen.findByRole("link", { name: "Docs" });
  expect(f.canvas.read).toHaveBeenCalledTimes(3);
  cleanup();
  let release;
  f.canvas.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  render(<Panel {...props} />);
  expect(f.canvas.read).toHaveBeenCalledTimes(4);
  cleanup();
  await act(async () => release(f.head()));
  expect(screen.queryByRole("region")).not.toBeInTheDocument();
});

it("drops across positions once and cancels Escape, pointer cancellation, and outside drops", async () => {
  const f = fixture(
    "- [API](https://example.com/api)\n- [Guide](https://example.com/guide)\n",
  );
  await screen.findByRole("link", { name: "Guide" });
  const handle = screen.getByRole("button", { name: "Reorder Docs" });
  handle.setPointerCapture = vi.fn();
  const original = document.elementFromPoint;
  const hit = vi.fn(() => screen.getByRole("link", { name: "Guide" }));
  document.elementFromPoint = hit;
  const start = () => {
    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, button: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 20, clientY: 30 });
  };
  try {
    start();
    const cancelKey = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(handle, cancelKey);
    expect(cancelKey.defaultPrevented).toBe(true);
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(f.canvas.save).not.toHaveBeenCalled();
    start();
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(f.canvas.save).not.toHaveBeenCalled();
    start();
    hit.mockReturnValueOnce(null);
    fireEvent.pointerMove(handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(f.canvas.save).not.toHaveBeenCalled();
    start();
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() =>
      expect(readBookmarks(f.head().content).items.map((x) => x.label)).toEqual(
        ["API", "Guide", "Docs"],
      ),
    );
    expect(f.canvas.save).toHaveBeenCalledTimes(1);
  } finally {
    document.elementFromPoint = original;
  }
});

it("keeps the editor collapsed, displays domains, and restores focus after cancelling and closing actions", async () => {
  fixture();
  await screen.findByRole("link", { name: "Docs" });
  expect(screen.getByText("example.com")).toBeVisible();
  expect(
    screen.queryByText("https://example.com/docs"),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByText(/Drag a handle/)).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Add bookmark" }));
  expect(screen.getByRole("textbox", { name: "Bookmark name" })).toHaveFocus();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Add bookmark" })).toHaveFocus();
  const actions = screen.getByRole("button", { name: "Actions for Docs" });
  await user.click(actions);
  expect(screen.getByRole("menuitem", { name: "Edit" })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveFocus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(actions).toHaveFocus();
});

it("preserves edit identity and changed URL after a conflicting reorder", async () => {
  const f = fixture("- [Guide](https://example.com/guide)\n");
  const user = userEvent.setup();
  await screen.findByRole("link", { name: "Docs" });
  await user.click(screen.getByRole("button", { name: "Actions for Docs" }));
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  await fill(user, "Reference", "https://example.com/reference");
  f.changeHead(
    () =>
      "# Notes\nConcurrent notes.\n\n## Channel bookmarks\n- [Guide](https://example.com/guide)\n- [Docs](https://example.com/docs)\n",
  );
  await user.click(screen.getByRole("button", { name: "Save bookmark" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("latest links");
  expect(screen.getByRole("textbox", { name: "Bookmark name" })).toHaveValue(
    "Reference",
  );
  await user.click(screen.getByRole("button", { name: "Save bookmark" }));
  await screen.findByRole("link", { name: "Reference" });
  expect(readBookmarks(f.head().content).items.map((x) => x.label)).toEqual([
    "Guide",
    "Reference",
  ]);
  expect(f.head().content).toContain("Concurrent notes.");
});
it("keeps a removed edit as an edit and prevents adding it accidentally", async () => {
  const f = fixture();
  const user = userEvent.setup();
  await screen.findByRole("link", { name: "Docs" });
  await user.click(screen.getByRole("button", { name: "Actions for Docs" }));
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  await fill(user, "Reference", "https://example.com/reference");
  f.changeHead(() => "# Notes\nConcurrent removal.\n");
  await user.click(screen.getByRole("button", { name: "Save bookmark" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "no longer exists",
  );
  await user.click(screen.getByRole("button", { name: "Save bookmark" }));
  expect(f.canvas.save).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("textbox", { name: "Bookmark name" })).toHaveValue(
    "Reference",
  );
});
it("supplies the shared disabled marker during a held save", async () => {
  const f = fixture("- [Guide](https://example.com/guide)\n");
  const user = userEvent.setup();
  await screen.findByRole("link", { name: "Docs" });
  await fill(user, "API", "https://example.com/api");
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const save = f.canvas.save.getMockImplementation();
  f.canvas.save.mockImplementationOnce(async (...args) => {
    await pending;
    return save(...args);
  });
  try {
    await user.click(screen.getByRole("button", { name: "Add bookmark" }));
    expect(f.canvas.save).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Add bookmark" }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("button", { name: "Actions for Docs" }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.getByRole("button", { name: "Reorder Docs" }),
    ).toHaveAttribute("data-disabled");
  } finally {
    release();
  }
  await screen.findByRole("link", { name: "API" });
});
it("always exposes the host close action, including disconnected panes", async () => {
  const f = fixture();
  await screen.findByRole("link", { name: "Docs" });
  cleanup();
  const close = vi.fn();
  const Panel = f.registration.component;
  render(<Panel close={close} />);
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Close bookmarks" }));
  expect(close).toHaveBeenCalledTimes(1);
});
