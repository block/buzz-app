// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StrictMode,
  useRef,
  createContext,
  useContext,
  type ReactElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ConversationPresentation } from "../conversation/ConversationPresentation";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
import {
  MessageActionBar,
  MessageActionOwner,
  useAfterMessageMenuClose,
} from "./MessageActionBar";
import { MenuItem } from "../../shared/design-system/ui/Menu";
import { createPortal } from "react-dom";
import { MessageLink } from "../conversation/MessageLink";
import { LinkThreadTabContext } from "../conversation/LinkLabelContext";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Row(props: ComponentProps<typeof MessageActionBar>) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} data-testid="message">
      <span>Message author</span>
      <div data-message-action-anchor>
        <span>Message bubble</span>
      </div>
      <div data-message-attachments>
        <span>Message attachment</span>
      </div>
      <MessageActionBar {...props} rowRef={rowRef} />
    </div>
  );
}

function KeyboardModality({ children }: { children: ReactNode }) {
  useKeyboardFocusVisibility();
  return children;
}

function pointerMedia(matches = true) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const listeners = new Set<() => void>();
  const query = {
    matches,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", () => query);
  return (next: boolean) =>
    act(() => {
      query.matches = next;
      for (const listener of listeners) listener();
    });
}

it("leaves portalled message content outside its context-menu target", () => {
  render(
    <MessageActionBar copyText={() => "Message"}>
      <div>
        <button type="button">Expand coordination</button>
        {createPortal(
          <button type="button">Viewer content</button>,
          document.body,
        )}
      </div>
    </MessageActionBar>,
  );
  const viewer = screen.getByRole("button", { name: "Viewer content" });
  expect(
    fireEvent.contextMenu(viewer, { clientX: 20, clientY: 20, button: 2 }),
  ).toBe(true);
  fireEvent.keyDown(viewer, { key: "F10", shiftKey: true });
  expect(screen.queryByRole("menu")).toBeNull();
});

it.each([
  ["external", "{Shift>}{F10}{/Shift}"],
  ["external", "{ContextMenu}"],
  ["thread", "{Shift>}{F10}{/Shift}"],
  ["thread", "{ContextMenu}"],
])(
  "leaves a nested %s link's %s menu to the link owner",
  async (kind, keys) => {
    const user = userEvent.setup();
    render(
      <LinkThreadTabContext value={() => true}>
        <MessageActionBar copyText={() => "Message"}>
          <div>
            <button type="button">Coordination</button>
            <MessageLink
              url={
                kind === "external"
                  ? "https://example.com/context"
                  : `buzz://message?channel=alpha&id=${"a".repeat(64)}`
              }
              label="Nested destination"
              registry={undefined}
              onOpenLink={() => true}
            />
          </div>
        </MessageActionBar>
      </LinkThreadTabContext>,
    );
    const link = screen.getByRole("link", { name: "Nested destination" });
    link.focus();
    await user.keyboard(keys);
    await screen.findByRole("menuitem", {
      name: kind === "external" ? "Open in browser" : "Open link",
    });
    expect(screen.getAllByRole("menu", { hidden: true })).toHaveLength(1);
    expect(screen.queryByRole("menuitem", { name: "Copy message" })).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(link));
    const row = screen.getByRole("button", { name: "Coordination" });
    row.focus();
    await user.keyboard(keys);
    await screen.findByRole("menuitem", { name: "Copy message" });
    expect(screen.getAllByRole("menu", { hidden: true })).toHaveLength(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(row));
  },
);

it("defers desktop controls until row interaction and retains them after leaving", () => {
  pointerMedia();
  render(
    <StrictMode>
      <Row copyText={() => "Hello"} />
    </StrictMode>,
  );
  expect(
    screen.queryByRole("button", {
      name: "More message actions",
      hidden: true,
    }),
  ).toBeNull();
  fireEvent.pointerEnter(screen.getByTestId("message"));
  const trigger = screen.getByRole("button", {
    name: "More message actions",
    hidden: true,
  });
  fireEvent.pointerLeave(screen.getByTestId("message"));
  expect(
    screen.getByRole("button", { name: "More message actions", hidden: true }),
  ).toBe(trigger);
});

it("reveals actions only over message content or the toolbar, not the row's empty space", () => {
  pointerMedia();
  render(
    <StrictMode>
      <Row copyText={() => "Hello"} />
    </StrictMode>,
  );
  const row = screen.getByTestId("message");
  // First entry prepares the lazy controls without revealing them over whitespace.
  fireEvent.pointerEnter(row);
  const bar = screen.getByRole("group", { hidden: true });
  fireEvent.pointerLeave(row);
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(row);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  for (const content of ["Message bubble", "Message attachment"]) {
    const target = screen.getByText(content);
    fireEvent.pointerOver(target, { relatedTarget: row });
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
    fireEvent.pointerOut(target, { relatedTarget: bar });
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
    fireEvent.pointerOver(bar, { relatedTarget: target });
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
    fireEvent.pointerOut(bar, { relatedTarget: row });
    expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  }
  fireEvent.pointerOver(screen.getByText("Message author"));
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
});

it("keeps timestamp hover and keyboard focus separate from message actions", () => {
  pointerMedia();
  function TimeRow() {
    const rowRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={rowRef} data-testid="message">
        <div data-message-action-anchor>
          <button type="button" data-media-timecode>
            0:18
          </button>
          <span>Comment body</span>
        </div>
        <MessageActionBar rowRef={rowRef} copyText={() => "Comment body"} />
      </div>
    );
  }
  render(<TimeRow />);
  const row = screen.getByTestId("message");
  const time = screen.getByRole("button", { name: "0:18" });
  const body = screen.getByText("Comment body");
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(body);
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOut(body, { relatedTarget: time });
  fireEvent.pointerOver(time);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  document.documentElement.setAttribute("data-keyboard-navigation", "");
  try {
    act(() => time.focus());
    expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  } finally {
    document.documentElement.removeAttribute("data-keyboard-navigation");
  }
  act(() => time.blur());
  fireEvent.pointerOver(body);
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
});

it("keeps reaction hover separate from message actions without losing keyboard access", async () => {
  pointerMedia();
  function ReactionRow() {
    const rowRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={rowRef} data-testid="message">
        <div data-message-action-anchor>
          <span>Message body</span>
          <div data-message-reactions>
            <button type="button">Existing reaction</button>
            <button type="button">Add reaction</button>
          </div>
        </div>
        <MessageActionBar rowRef={rowRef} copyText={() => "Message body"} />
        <div>
          <span data-message-reactions>
            <button type="button">First reaction</button>
          </span>
          <span>Unused reaction space</span>
        </div>
      </div>
    );
  }
  render(<ReactionRow />);
  const row = screen.getByTestId("message");
  const body = screen.getByText("Message body");
  const reaction = screen.getByRole("button", { name: "Existing reaction" });
  const plus = screen.getByRole("button", { name: "Add reaction" });
  // The first entry mounts deferred controls; jsdom cannot retain native :hover.
  fireEvent.pointerEnter(row);
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(body);
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOut(body, { relatedTarget: reaction });
  fireEvent.pointerOver(reaction, { relatedTarget: body });
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOut(reaction, { relatedTarget: plus });
  fireEvent.pointerOver(plus, { relatedTarget: reaction });
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOut(plus, { relatedTarget: body });
  fireEvent.pointerOver(body, { relatedTarget: plus });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  const actions = screen.getByRole("group", { hidden: true });
  fireEvent.pointerOut(body, { relatedTarget: actions });
  fireEvent.pointerOver(actions, { relatedTarget: body });
  expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  fireEvent.pointerOut(actions, { relatedTarget: document.body });
  fireEvent.pointerLeave(row);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerEnter(row);
  fireEvent.pointerOver(reaction);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOver(screen.getByRole("button", { name: "First reaction" }));
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOver(screen.getByText("Unused reaction space"));
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  fireEvent.pointerOver(reaction);
  expect(row.hasAttribute("data-actions-revealed")).toBe(false);
  document.documentElement.setAttribute("data-keyboard-navigation", "");
  try {
    act(() => reaction.focus());
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
    fireEvent.click(
      screen.getByRole("button", {
        name: "More message actions",
        hidden: true,
      }),
    );
    await screen.findByRole("menu");
    fireEvent.pointerOver(reaction);
    expect(row.hasAttribute("data-actions-revealed")).toBe(true);
  } finally {
    document.documentElement.removeAttribute("data-keyboard-navigation");
  }
});

it("prepares untouched rows synchronously for Tab navigation and leaves new pointer rows deferred", () => {
  pointerMedia();
  const view = (extra = false) => (
    <KeyboardModality>
      <Row copyText={() => "First"} />
      <Row copyText={() => "Second"} />
      {extra && <Row copyText={() => "Third"} />}
    </KeyboardModality>
  );
  const { rerender } = render(view());
  fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
  expect(screen.queryAllByRole("button", { hidden: true })).toHaveLength(0);
  const atDefaultAction = vi.fn(() => {
    expect(
      screen.getAllByRole("button", {
        name: "More message actions",
        hidden: true,
      }),
    ).toHaveLength(2);
  });
  window.addEventListener("keydown", atDefaultAction, { once: true });
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(atDefaultAction).toHaveBeenCalledOnce();
  fireEvent.pointerDown(window);
  rerender(view(true));
  expect(
    screen.getAllByRole("button", {
      name: "More message actions",
      hidden: true,
    }),
  ).toHaveLength(2);
  fireEvent.keyDown(window, { key: "Tab" });
  expect(
    screen.getAllByRole("button", {
      name: "More message actions",
      hidden: true,
    }),
  ).toHaveLength(3);
});

it("renders coarse-pointer controls immediately and activates when pointer capability changes", () => {
  const changePointer = pointerMedia(false);
  const { rerender } = render(<Row key="touch" copyText={() => "Touch"} />);
  expect(
    screen.getByRole("button", { name: "More message actions", hidden: true }),
  ).toBeTruthy();
  changePointer(true);
  rerender(<Row key="desktop" copyText={() => "Desktop"} />);
  expect(
    screen.queryByRole("button", {
      name: "More message actions",
      hidden: true,
    }),
  ).toBeNull();
  changePointer(false);
  expect(
    screen.getByRole("button", { name: "More message actions", hidden: true }),
  ).toBeTruthy();
});
it("replies and exposes real sibling controls without placeholders", () => {
  const reply = vi.fn();
  render(<MessageActionBar onReply={reply} copyText={() => "Hello"} />);
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
  expect(reply).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: "Copy link" }).hasAttribute("disabled"),
  ).toBe(true);
});
it("opens with keyboard, invokes a sibling action, and returns focus on Escape", async () => {
  const user = userEvent.setup();
  const action = vi.fn();
  render(
    <MessageActionBar
      copyText={() => "Hello"}
      overflowItems={<MenuItem onClick={action}>Edit message</MenuItem>}
    />,
  );
  const trigger = screen.getByRole("button", { name: "More message actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  await user.click(
    await screen.findByRole("menuitem", { name: "Edit message" }),
  );
  expect(action).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  trigger.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it.each(["{Escape}", "{ArrowDown}{Escape}"])(
  "returns focus after pointer open then keyboard close: %s",
  async (keys) => {
    const user = userEvent.setup();
    render(<MessageActionBar copyText={() => "Hello"} />);
    const trigger = screen.getByRole("button", {
      name: "More message actions",
    });
    await user.click(trigger);
    const menu = await screen.findByRole("menu");
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(true),
    );
    await user.keyboard(keys);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard("{Enter}");
    await screen.findByRole("menu");
  },
);
it("keeps keyboard retry reachable after pointer open and a failed copy", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  render(<MessageActionBar copyText={() => "Hello"} />);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
  await user.keyboard("{ArrowDown}");
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Copy message" }),
  );
  await user.keyboard("{Enter}");
  await screen.findByText("Couldn’t copy. Try again from the message menu.");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  await user.keyboard("{Enter}");
  const retry = await screen.findByRole("menuitem", { name: "Copy message" });
  await waitFor(() => expect(document.activeElement).toBe(retry));
  await user.keyboard("{Enter}");
  await screen.findByText("Message copied");
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith("Hello");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it("copies the message, shows failure, and allows retry", async () => {
  const user = userEvent.setup();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValueOnce();
  render(<MessageActionBar copyText={() => "Hello"} />);
  const trigger = screen.getByRole("button", { name: "More message actions" });
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  await screen.findByText("Couldn’t copy. Try again from the message menu.");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).not.toBe(trigger);
  await user.click(trigger);
  await user.click(
    await screen.findByRole("menuitem", { name: "Copy message" }),
  );
  const copied = await screen.findByText("Message copied");
  expect(copied.closest(".buzz-toast")).not.toBeNull();
  expect(write).toHaveBeenLastCalledWith("Hello");
});
it("prevents duplicate clipboard writes until the first settles", async () => {
  userEvent.setup();
  let finish!: () => void;
  const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <MessageActionBar
      link="buzz://link"
      copyText={() => "Hello"}
      replyDisabled
      onReply={() => {}}
    />,
  );
  const link = screen.getByRole("button", { name: "Copy link" });
  fireEvent.click(link);
  try {
    expect(link.hasAttribute("disabled")).toBe(true);
    fireEvent.click(link);
    expect(write).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Reply" }).hasAttribute("disabled"),
    ).toBe(true);
  } finally {
    finish();
  }
  await screen.findByText("Link copied");
  expect(link.hasAttribute("disabled")).toBe(false);
});

it.each([false, true])(
  "sends from the overflow menu and keeps feedback after it closes (failure=%s)",
  async (failure) => {
    const user = userEvent.setup();
    const send = vi.fn(() => {
      if (failure) throw new Error("Join the conversation before posting");
    });
    render(
      <MessageActionBar copyText={() => "Reply"} onSendToChannel={send} />,
    );
    await user.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Send to channel" }),
    );
    expect(send).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(
      await screen.findByText(
        failure ? "Join the conversation before posting" : "Sending to channel",
      ),
    ).toBeTruthy();
  },
);

it("retires the native top-layer bar and its open menu with the source", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  const show = vi.fn(function (this: HTMLElement) {
      this.style.display = "block";
    }),
    hide = vi.fn(function (this: HTMLElement) {
      this.style.display = "";
    });
  HTMLElement.prototype.showPopover = show;
  HTMLElement.prototype.hidePopover = hide;
  function Visit({ active }: { active: boolean }) {
    const row = useRef<HTMLDivElement>(null);
    return (
      <ConversationPresentation value={active}>
        <div ref={row} data-testid="row" hidden={!active} inert={!active}>
          <MessageActionBar rowRef={row} copyText={() => "Source"} />
        </div>
      </ConversationPresentation>
    );
  }
  try {
    const view = render(<Visit active />);
    fireEvent.pointerEnter(screen.getByTestId("row"));
    // The first interaction now mounts lazy controls. jsdom has no real hover;
    // opening their menu supplies the floating owner's retained-open evidence.
    fireEvent.click(
      screen.getByRole("button", {
        name: "More message actions",
        hidden: true,
      }),
    );
    expect(await screen.findByRole("menu")).toBeTruthy();
    expect(show).toHaveBeenCalled();
    view.rerender(<Visit active={false} />);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.body.querySelector('[popover="manual"]')).toBeNull();
    expect(hide).toHaveBeenCalled();
    view.rerender(<Visit active />);
    await act(() => Promise.resolve());
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  } finally {
    cleanup();
    Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
    Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
    vi.unstubAllGlobals();
  }
});

it("keeps native row controls, payloads and provider context under one conversation owner", async () => {
  const user = userEvent.setup();
  const write = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const replyA = vi.fn(),
    replyB = vi.fn();
  const RowIdentity = createContext("");
  function LeadingItem() {
    return <MenuItem>{useContext(RowIdentity)} action</MenuItem>;
  }
  render(
    <MessageActionOwner>
      <RowIdentity value="Alpha">
        <Row
          messageId="a"
          onReply={replyA}
          link="buzz://message/a"
          copyText={() => "Alpha body"}
          leadingItems={<LeadingItem />}
        />
      </RowIdentity>
      <RowIdentity value="Beta">
        <Row
          messageId="b"
          onReply={replyB}
          link="buzz://message/b"
          copyText={() => "Beta body"}
          leadingItems={<LeadingItem />}
        />
      </RowIdentity>
    </MessageActionOwner>,
  );
  const more = screen.getAllByRole("button", { name: "More message actions" });
  more[0]?.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("menuitem", { name: "Alpha action" }),
  ).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Beta action" })).toBeNull();
  await user.click(screen.getByRole("menuitem", { name: "Copy message" }));
  await waitFor(() => expect(write).toHaveBeenCalledWith("Alpha body"));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  more[1]?.focus();
  await user.keyboard("{Enter}");
  expect(
    await screen.findByRole("menuitem", { name: "Beta action" }),
  ).toBeTruthy();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(document.activeElement).toBe(more[1]);
  await user.click(
    screen
      .getAllByRole("button", { name: "Copy link" })
      .at(1) as HTMLButtonElement,
  );
  await waitFor(() => expect(write).toHaveBeenCalledWith("buzz://message/b"));
  await user.click(
    screen.getAllByRole("button", { name: "Reply" }).at(1) as HTMLButtonElement,
  );
  expect(replyA).not.toHaveBeenCalled();
  expect(replyB).toHaveBeenCalledOnce();
});

it.each(["channel", "session"] as const)(
  "retires the action surface without remounting conversation content on %s replacement",
  async (replacement) => {
    const user = userEvent.setup();
    const session = {},
      nextSession = {};
    const children = (
      <>
        <input aria-label="Unsent draft" defaultValue="" />
        <Row messageId="a" copyText={() => "Alpha"} />
      </>
    );
    const view = render(
      <MessageActionOwner session={session} channelId="alpha">
        {children}
      </MessageActionOwner>,
    );
    const draft = screen.getByRole("textbox", {
      name: "Unsent draft",
    }) as HTMLInputElement;
    await user.type(draft, "Keep this unsent draft");
    await user.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    await screen.findByRole("menu");
    view.rerender(
      <MessageActionOwner
        session={replacement === "session" ? nextSession : session}
        channelId={replacement === "channel" ? "beta" : "alpha"}
      >
        {children}
      </MessageActionOwner>,
    );
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("textbox", { name: "Unsent draft" })).toBe(draft);
    expect(draft.value).toBe("Keep this unsent draft");
  },
);

function pendingClipboard() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("keeps concurrent clipboard results with each source instance while the menu target switches", async () => {
  const user = userEvent.setup();
  const first = pendingClipboard(),
    second = pendingClipboard();
  const write = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockResolvedValue();
  render(
    <MessageActionOwner>
      <Row
        messageId="same-message"
        link="buzz://source/alpha"
        copyText={() => "Alpha body"}
      />
      <Row
        messageId="same-message"
        link="buzz://source/beta"
        copyText={() => "Beta body"}
      />
    </MessageActionOwner>,
  );
  const links = screen.getAllByRole("button", { name: "Copy link" });
  const more = screen.getAllByRole("button", { name: "More message actions" });
  const alpha = links.at(0) as HTMLButtonElement,
    beta = links.at(1) as HTMLButtonElement;
  try {
    fireEvent.click(alpha);
    expect(alpha.disabled).toBe(true);
    expect(beta.disabled).toBe(false);
    more.at(1)?.focus();
    await user.keyboard("{Enter}");
    const copy = await screen.findByRole("menuitem", { name: "Copy message" });
    copy.focus();
    await user.keyboard("{Enter}");
    expect(write).toHaveBeenNthCalledWith(1, "buzz://source/alpha");
    expect(write).toHaveBeenNthCalledWith(2, "Beta body");
    expect(beta.disabled).toBe(true);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(more.at(1)));
    await act(async () => first.resolve());
    await screen.findByText("Link copied");
    expect(alpha.disabled).toBe(false);
    expect(beta.disabled).toBe(true);
    expect(document.activeElement).toBe(more.at(1));
    await act(async () => second.reject(new Error("clipboard denied")));
    await screen.findByText("Couldn’t copy. Try again from the message menu.");
    expect(beta.disabled).toBe(false);
    expect(screen.getByText("Link copied")).toBeTruthy();
    more.at(1)?.focus();
    await user.keyboard("{Enter}");
    const retry = await screen.findByRole("menuitem", { name: "Copy message" });
    retry.focus();
    await user.keyboard("{Enter}");
    await screen.findByText("Message copied");
    expect(write).toHaveBeenLastCalledWith("Beta body");
    expect(screen.getByText("Link copied")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(more.at(1)));
  } finally {
    await act(async () => {
      first.resolve();
      second.resolve();
    });
  }
});

it("revokes pending clipboard results on row recycling and covered conversation retirement", async () => {
  userEvent.setup();
  const first = pendingClipboard(),
    replacement = pendingClipboard();
  vi.spyOn(navigator.clipboard, "writeText")
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => replacement.promise);
  const content = (id: string, active: boolean) => (
    <ConversationPresentation value={active}>
      <MessageActionOwner>
        <Row messageId={id} link={`buzz://source/${id}`} copyText={() => id} />
      </MessageActionOwner>
    </ConversationPresentation>
  );
  const view = render(content("alpha", true));
  try {
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    view.rerender(content("replacement", true));
    const link = screen.getByRole("button", {
      name: "Copy link",
    }) as HTMLButtonElement;
    expect(link.disabled).toBe(false);
    await act(async () => first.resolve());
    expect(screen.queryByText("Link copied")).toBeNull();
    expect(link.disabled).toBe(false);
    fireEvent.click(link);
    expect(link.disabled).toBe(true);
    view.rerender(content("replacement", false));
    await act(async () => replacement.resolve());
    expect(screen.queryByText("Link copied")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    view.rerender(content("replacement", true));
    expect(
      (screen.getByRole("button", { name: "Copy link" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText("Link copied")).toBeNull();
  } finally {
    await act(async () => {
      first.resolve();
      replacement.resolve();
    });
  }
});

it("returns keyboard focus when the after-close consumer rejects a revoked handoff", async () => {
  const user = userEvent.setup();
  function RevokedAction() {
    const afterClose = useAfterMessageMenuClose();
    return (
      <MenuItem onClick={() => afterClose?.(() => false)}>
        Unavailable action
      </MenuItem>
    );
  }
  render(
    <MessageActionOwner>
      <Row
        messageId="a"
        copyText={() => "Alpha"}
        overflowItems={<RevokedAction />}
      />
    </MessageActionOwner>,
  );
  const trigger = screen.getByRole("button", { name: "More message actions" });
  trigger.focus();
  await user.keyboard("{Enter}");
  const action = await screen.findByRole("menuitem", {
    name: "Unavailable action",
  });
  action.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
