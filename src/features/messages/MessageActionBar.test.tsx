// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StrictMode,
  useRef,
  type ReactElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { ToastProvider } from "../../shared/design-system/ui/Toast";
import { useKeyboardFocusVisibility } from "../../shared/design-system/useKeyboardFocusVisibility";
const render = (ui: ReactElement) => rtlRender(ui, { wrapper: ToastProvider });
import { MessageActionBar } from "./MessageActionBar";
import { MenuItem } from "../../shared/design-system/ui/Menu";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Row(props: ComponentProps<typeof MessageActionBar>) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} data-testid="message">
      <MessageActionBar {...props} rowRef={rowRef} />
    </div>
  );
}

function KeyboardModality({ children }: { children: ReactNode }) {
  useKeyboardFocusVisibility();
  return children;
}

function pointerMedia(matches = true) {
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
