// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installComposerClickFocus } from "./focus-navigation";

let uninstall: (() => void) | undefined;

beforeEach(() => {
  // jsdom has no layout: every pane is visible and in front of its content.
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return new DOMRect(
        this.closest("[data-panel-workspace]") ? 200 : 0,
        0,
        100,
        100,
      );
    },
  );
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: (x: number) => [
      document.querySelector(
        x < 200 ? "[data-main-workspace]" : "[data-panel-workspace]",
      ),
    ],
  });
  uninstall = installComposerClickFocus();
});

afterEach(() => {
  uninstall?.();
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "elementsFromPoint");
});

const settle = () =>
  act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );

function Shell(props: { menuOpen?: boolean }) {
  return (
    <>
      <nav aria-label="Sidebar">
        <p>Channels</p>
        <button type="button">Open channel</button>
      </nav>
      <main id="main-content">
        <div data-main-workspace="">
          <div role="tablist">
            <button type="button" role="tab" aria-selected="true">
              Main tab
            </button>
          </div>
          <section data-message-scroller="">
            <div data-message-id="a" tabIndex={-1}>
              Main message
            </div>
            <button type="button">React</button>
            <input aria-label="Search history" />
          </section>
          <textarea data-tab-focus="" aria-label="Main draft" />
        </div>
        <div data-panel-workspace="">
          <section data-message-scroller="">
            <div data-message-id="b" tabIndex={-1}>
              Thread message
            </div>
          </section>
          <textarea data-tab-focus="" aria-label="Thread draft" />
        </div>
      </main>
      <search>
        <input aria-label="Find" />
        <button type="button">Next match</button>
      </search>
      {props.menuOpen && (
        <div role="menu" tabIndex={-1} aria-label="Actions">
          <span>Menu item</span>
        </div>
      )}
    </>
  );
}

it("a click in a conversation resumes typing in its message box", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByText("Main message"));
  await settle();
  expect(screen.getByRole("textbox", { name: "Main draft" })).toHaveFocus();
  // A control that takes focus from its click keeps it.
  const react = screen.getByRole("button", { name: "React" });
  await user.click(react);
  await settle();
  expect(react).toHaveFocus();
});

it("a click in a thread tab resumes typing in the thread's own message box", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByText("Thread message"));
  await settle();
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toHaveFocus();
});

it("shared chrome returns focus to the pane typed in last, else main", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  await user.click(screen.getByText("Channels"));
  await settle();
  expect(screen.getByRole("textbox", { name: "Main draft" })).toHaveFocus();
  await user.click(screen.getByRole("textbox", { name: "Thread draft" }));
  await user.click(screen.getByText("Channels"));
  await settle();
  expect(screen.getByRole("textbox", { name: "Thread draft" })).toHaveFocus();
});

it("leaves fields, tab strips, overlays and text selections alone", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Shell />);
  const search = screen.getByRole("textbox", { name: "Search history" });
  await user.click(search);
  await settle();
  expect(search).toHaveFocus();

  // Stepping through find results keeps Enter in the find bar.
  const next = screen.getByRole("button", { name: "Next match" });
  next.focus();
  await user.click(next);
  await settle();
  expect(next).toHaveFocus();

  const tab = screen.getByRole("tab", { name: "Main tab" });
  await user.click(tab);
  await settle();
  expect(tab).toHaveFocus();

  rerender(<Shell menuOpen />);
  const menu = screen.getByRole("menu", { name: "Actions" });
  menu.focus();
  await user.click(screen.getByText("Menu item"));
  await settle();
  expect(menu).toHaveFocus();
  rerender(<Shell />);

  // A drag that selects message text keeps it selected for copying.
  const message = screen.getByText("Main message");
  await user.pointer({ keys: "[MouseLeft]", target: message });
  const range = document.createRange();
  range.selectNodeContents(message);
  document.getSelection()?.removeAllRanges();
  document.getSelection()?.addRange(range);
  await settle();
  expect(message).toHaveFocus();
});

it("a pane without a message box keeps its focus", async () => {
  const user = userEvent.setup();
  render(
    <main id="main-content">
      <div data-main-workspace="">
        <textarea data-tab-focus="" aria-label="Main draft" />
      </div>
      <div data-panel-workspace="">
        <div tabIndex={-1}>Tool output</div>
      </div>
    </main>,
  );
  await user.click(screen.getByText("Tool output"));
  await settle();
  expect(screen.getByText("Tool output")).toHaveFocus();
});

it("keyboard activation and touch taps keep their focus", async () => {
  const user = userEvent.setup();
  render(<Shell />);
  const react = screen.getByRole("button", { name: "React" });
  react.focus();
  await user.keyboard("[Space]");
  await settle();
  expect(react).toHaveFocus();
  const message = screen.getByText("Main message");
  await user.pointer({
    keys: "[TouchA]",
    target: message,
    pointerName: "touch",
  } as never);
  await settle();
  expect(screen.getByRole("textbox", { name: "Main draft" })).not.toHaveFocus();
});

it("a click that dismisses a modal leaves focus to the modal's own return", async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <>
      <Shell />
      <div role="dialog" aria-modal="true" aria-label="Confirm">
        Confirm
      </div>
    </>,
  );
  // The modal closes on this click and restores its opener's focus later.
  document.addEventListener("click", () => rerender(<Shell />), {
    once: true,
  });
  await user.click(screen.getByText("Channels"));
  await settle();
  expect(screen.getByRole("textbox", { name: "Main draft" })).not.toHaveFocus();
});

it("a modal still closing does not hold back the click after it", async () => {
  const user = userEvent.setup();
  render(
    <>
      <Shell />
      <div role="dialog" aria-modal="true" aria-label="Search" data-closed="">
        Search
      </div>
    </>,
  );
  await user.click(screen.getByText("Main message"));
  await settle();
  expect(screen.getByRole("textbox", { name: "Main draft" })).toHaveFocus();
});

it("a link click leaves focus to what the link opens", async () => {
  const user = userEvent.setup();
  render(
    <main id="main-content">
      <div data-main-workspace="">
        <section data-message-scroller="">
          <div data-message-id="a" tabIndex={-1}>
            <a
              href="https://example.test/photo.png"
              onClick={(event) => event.preventDefault()}
            >
              <span>Open image attachment</span>
            </a>
          </div>
        </section>
        <textarea data-tab-focus="" aria-label="Main draft" />
      </div>
    </main>,
  );
  const tile = screen.getByRole("link", { name: "Open image attachment" });
  // WebKit focuses the row, not the link, when a pointer activates it.
  tile.addEventListener("mousedown", (event) => {
    event.preventDefault();
    tile.closest<HTMLElement>("[data-message-id]")?.focus();
  });
  await user.click(screen.getByText("Open image attachment"));
  await settle();
  expect(screen.getByRole("textbox", { name: "Main draft" })).not.toHaveFocus();
});
