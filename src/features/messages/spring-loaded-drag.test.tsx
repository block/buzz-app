// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  SPRING_LOAD_ATTRIBUTE,
  SPRING_LOAD_BLINK_MS,
  SPRING_LOAD_DELAY_MS,
  useSpringLoaded,
} from "./spring-loaded-drag";
import { useRejectUnclaimedDrops } from "./use-file-drop";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function Target({
  name,
  open,
  active,
}: {
  name: string;
  open(name: string): void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={name}
      {...useSpringLoaded(() => open(name), active)}
    >
      <span>{name} icon</span>
      <span>{name} label</span>
    </button>
  );
}
function Targets({
  open,
  active,
  names = ["General", "Random"],
}: {
  open(name: string): void;
  active?: string;
  names?: string[];
}) {
  useRejectUnclaimedDrops();
  return (
    <StrictMode>
      {names.map((name) => (
        <Target key={name} name={name} open={open} active={active === name} />
      ))}
      <p>Elsewhere</p>
    </StrictMode>
  );
}

function drag(
  target: Element | Window,
  kind: "dragEnter" | "dragOver" | "dragLeave" | "drop" | "dragEnd",
  type = "Files",
) {
  const event = createEvent[kind](target, {
    dataTransfer: { types: [type], files: [], dropEffect: "uninitialized" },
    bubbles: true,
    cancelable: true,
  });
  fireEvent(target, event);
  return event;
}
/** Browsers report the node entered before the node left. */
function move(from: Element, to: Element) {
  drag(to, "dragEnter");
  drag(from, "dragLeave");
  drag(to, "dragOver");
}
const row = (name: string) => screen.getByRole("button", { name });
const state = (name: string) => row(name).getAttribute(SPRING_LOAD_ATTRIBUTE);
const rest = (ms: number) => vi.advanceTimersByTime(ms);
const beforeBlink = SPRING_LOAD_DELAY_MS - SPRING_LOAD_BLINK_MS;

it("highlights at once, blinks, then opens once after the delay", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  expect(state("General")).toBe("hover");
  rest(beforeBlink - 1);
  expect(state("General")).toBe("hover");
  rest(1);
  expect(state("General")).toBe("blink");
  rest(SPRING_LOAD_BLINK_MS - 1);
  expect(open).not.toHaveBeenCalled();
  rest(1);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
  expect(state("General")).toBeNull();
  // The drag keeps resting there without opening it again.
  drag(row("General"), "dragOver");
  rest(SPRING_LOAD_DELAY_MS * 2);
  expect(open).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("reduced motion keeps the highlight and skips the blink", () => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
  }));
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  rest(SPRING_LOAD_DELAY_MS - 1);
  expect(state("General")).toBe("hover");
  expect(open).not.toHaveBeenCalled();
  rest(1);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
});

it("moving within one target neither restarts nor cancels the delay", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  const icon = screen.getByText("General icon");
  const label = screen.getByText("General label");
  drag(row("General"), "dragEnter");
  rest(200);
  move(row("General"), icon);
  rest(200);
  move(icon, label);
  expect(open).not.toHaveBeenCalled();
  rest(SPRING_LOAD_DELAY_MS - 400);
  expect(open).toHaveBeenCalledExactlyOnceWith("General");
});

it("leaving the target cancels the delay and the highlight", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  const label = screen.getByText("General label");
  drag(row("General"), "dragEnter");
  move(row("General"), label);
  rest(beforeBlink);
  expect(state("General")).toBe("blink");
  move(label, screen.getByText("Elsewhere"));
  expect(state("General")).toBeNull();
  expect(row("General").style.length).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("leaving the window or cancelling the drag reports only a leave", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  drag(row("General"), "dragLeave");
  expect(state("General")).toBeNull();
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("moving to another target restarts the delay there", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  rest(SPRING_LOAD_DELAY_MS - 1);
  move(row("General"), row("Random"));
  expect(state("General")).toBeNull();
  expect(state("Random")).toBe("hover");
  rest(SPRING_LOAD_DELAY_MS - 1);
  expect(open).not.toHaveBeenCalled();
  rest(1);
  expect(open).toHaveBeenCalledExactlyOnceWith("Random");
});

it.each(["drop", "dragEnd"] as const)(
  "%s ends the delay without opening or navigating",
  (kind) => {
    const open = vi.fn();
    render(<Targets open={open} />);
    drag(row("General"), "dragEnter");
    const over = drag(row("General"), "dragOver");
    expect(over.defaultPrevented).toBe(true);
    const end = drag(kind === "drop" ? row("General") : window, kind);
    if (kind === "drop") expect(end.defaultPrevented).toBe(true);
    expect(state("General")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    rest(SPRING_LOAD_DELAY_MS);
    expect(open).not.toHaveBeenCalled();
  },
);

it("a drop claimed and stopped by a drop zone still ends the delay", () => {
  const open = vi.fn();
  const view = render(<Targets open={open} />);
  view.container.addEventListener("drop", (event) => event.stopPropagation());
  drag(row("General"), "dragEnter");
  drag(row("General"), "drop");
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("ignores drags that carry no files", () => {
  const open = vi.fn();
  render(<Targets open={open} />);
  for (const type of ["text/plain", "text/uri-list"]) {
    drag(row("General"), "dragEnter", type);
    drag(row("General"), "dragOver", type);
    expect(state("General")).toBeNull();
  }
  expect(vi.getTimerCount()).toBe(0);
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("does nothing on the target that is already open", () => {
  const open = vi.fn();
  render(<Targets open={open} active="General" />);
  drag(row("General"), "dragEnter");
  drag(row("General"), "dragOver");
  expect(state("General")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
});

it("the same drag opens one target after another", () => {
  const open = vi.fn();
  const view = render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  rest(SPRING_LOAD_DELAY_MS);
  view.rerender(<Targets open={open} active="General" />);
  move(row("General"), row("Random"));
  rest(SPRING_LOAD_DELAY_MS);
  view.rerender(<Targets open={open} active="Random" />);
  // Leaving and coming back arms the first target again.
  move(row("Random"), row("General"));
  rest(SPRING_LOAD_DELAY_MS);
  expect(open.mock.calls).toEqual([["General"], ["Random"], ["General"]]);
});

it("opens with the latest callback", () => {
  const first = vi.fn();
  const latest = vi.fn();
  const view = render(<Targets open={first} />);
  drag(row("General"), "dragEnter");
  view.rerender(<Targets open={latest} />);
  drag(row("General"), "dragOver");
  rest(SPRING_LOAD_DELAY_MS);
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledExactlyOnceWith("General");
});

it("unmounting the hovered target leaves no timer or listener behind", () => {
  const open = vi.fn();
  const remove = vi.spyOn(window, "removeEventListener");
  const view = render(<Targets open={open} />);
  drag(row("General"), "dragEnter");
  expect(vi.getTimerCount()).toBe(1);
  view.rerender(<Targets open={open} names={["Random"]} />);
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("drop", expect.any(Function), true);
  rest(SPRING_LOAD_DELAY_MS);
  expect(open).not.toHaveBeenCalled();
  // Another target's unmount leaves the hovered one armed.
  drag(row("Random"), "dragEnter");
  view.rerender(<Targets open={open} names={["Random"]} />);
  expect(vi.getTimerCount()).toBe(1);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  remove.mockRestore();
});
