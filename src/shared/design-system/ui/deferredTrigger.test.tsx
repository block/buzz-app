// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { PreviewCard as BasePreviewCard } from "@base-ui/react/preview-card";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HELPFUL_HINT_REST_MS, PREVIEW_REST_MS } from "./hoverIntent";
import { MenuItem, MenuPopup, MenuRoot, MenuTrigger } from "./Menu";
import { PreviewCard } from "./PreviewCard";
import { Tooltip } from "./Tooltip";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});
const rest = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Attributes as rendered, with generated IDs reduced to their owner. */
function attributes(element: Element) {
  return Object.fromEntries(
    Array.from(element.attributes, ({ name, value }) => [
      name,
      name === "id" ? value.replace(/^(base-ui)-.*$/, "$1") : value,
    ]),
  );
}

/** Real input reaches an element with pointer events before mouse events. */
function enter(element: Element) {
  for (const type of ["pointerover", "pointerenter"])
    element.dispatchEvent(
      new PointerEvent(type, {
        bubbles: type === "pointerover",
        pointerType: "mouse",
      }),
    );
  for (const type of ["mouseover", "mouseenter"])
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: type === "mouseover" }),
    );
  fireEvent.mouseMove(element, { movementX: 4 });
}

it("renders a resting hint trigger exactly as Base UI's closed trigger", () => {
  render(
    <>
      <BaseTooltip.Root>
        <BaseTooltip.Trigger
          render={<button type="button" aria-label="Base" />}
        />
      </BaseTooltip.Root>
      <Tooltip content="A hint">
        <button type="button" aria-label="Deferred" />
      </Tooltip>
    </>,
  );
  const base = attributes(screen.getByRole("button", { name: "Base" }));
  const deferred = attributes(screen.getByRole("button", { name: "Deferred" }));
  expect({ ...deferred, "aria-label": "Base" }).toEqual(base);
});

it("renders a resting preview trigger exactly as Base UI's closed trigger", () => {
  render(
    <>
      <BasePreviewCard.Root>
        <BasePreviewCard.Trigger render={<a href="#base">Base</a>} />
      </BasePreviewCard.Root>
      <PreviewCard trigger={<a href="#base">Deferred</a>}>Body</PreviewCard>
    </>,
  );
  expect(attributes(screen.getByRole("link", { name: "Deferred" }))).toEqual(
    attributes(screen.getByRole("link", { name: "Base" })),
  );
});

it("keeps the trigger element and its ref when its hint mounts", async () => {
  const refs: (HTMLButtonElement | null)[] = [];
  render(
    <Tooltip content="A hint">
      <button type="button" ref={(element) => void refs.push(element)}>
        Action
      </button>
    </Tooltip>,
  );
  const action = screen.getByRole("button", { name: "Action" });
  enter(action);
  await rest(HELPFUL_HINT_REST_MS);
  expect(screen.getByRole("tooltip")).toHaveTextContent("A hint");
  expect(screen.getByRole("button", { name: "Action" })).toBe(action);
  expect(refs).toEqual([action]);
  expect(action).toHaveAccessibleDescription("A hint");
});

it("hands a hint the hover that mounted it within the same event", async () => {
  render(
    <Tooltip content="A hint">
      <button type="button">Action</button>
    </Tooltip>,
  );
  const action = screen.getByRole("button", { name: "Action" });
  // No task runs between entering and resting, so nothing may wait for one.
  enter(action);
  await rest(HELPFUL_HINT_REST_MS - 1);
  expect(screen.queryByRole("tooltip")).toBeNull();
  await rest(1);
  expect(screen.getByRole("tooltip")).toHaveTextContent("A hint");
});

it("lets a first press without hover cancel a hint as Base UI does", async () => {
  render(
    <Tooltip content="A hint">
      <button type="button">Action</button>
    </Tooltip>,
  );
  const action = screen.getByRole("button", { name: "Action" });
  // A touch press: the root mounts on pointerdown, before mousedown and click.
  fireEvent.pointerDown(action, { pointerType: "touch" });
  fireEvent.mouseDown(action);
  act(() => action.focus());
  fireEvent.pointerUp(action, { pointerType: "touch" });
  fireEvent.click(action);
  await rest(HELPFUL_HINT_REST_MS);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("opens a preview from the focus that mounted it", async () => {
  render(
    <PreviewCard trigger={<a href="#profile">Profile</a>} aria-label="Preview">
      Preview body
    </PreviewCard>,
  );
  const trigger = screen.getByRole("link", { name: "Profile" });
  act(() => trigger.focus());
  await rest(0);
  expect(screen.getByText("Preview body")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Profile" })).toBe(trigger);
});

it("opens a preview from the hover that mounted it", async () => {
  render(
    <PreviewCard trigger={<a href="#profile">Profile</a>} aria-label="Preview">
      Preview body
    </PreviewCard>,
  );
  const trigger = screen.getByRole("link", { name: "Profile" });
  enter(trigger);
  await rest(PREVIEW_REST_MS);
  expect(screen.getByText("Preview body")).toBeInTheDocument();
});

it("leaves the updates of a handler that focuses a hint trigger to that handler", async () => {
  const seen: number[] = [];
  function Closer() {
    const [count, setCount] = useState(0);
    const committed = useRef(count);
    const action = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => {
      committed.current = count;
    });
    return (
      <>
        <button
          type="button"
          onClick={() => {
            setCount(1);
            action.current?.focus();
            // A flushed mount would already have committed the count.
            seen.push(committed.current);
          }}
        >
          Close
        </button>
        <Tooltip content="A hint">
          <button type="button" ref={action}>
            Action
          </button>
        </Tooltip>
      </>
    );
  }
  render(<Closer />);
  fireEvent.keyDown(document.body, { key: "Tab" });
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(seen).toEqual([0]);
  await rest(0);
  const action = screen.getByRole("button", { name: "Action" });
  expect(action).toHaveFocus();
  expect(action).toHaveAccessibleDescription("A hint");
});

function RowMenu({ deferred }: { deferred: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <MenuRoot deferred={deferred} open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <button type="button" aria-label={deferred ? "Deferred" : "Base"} />
        }
      />
      <MenuPopup>
        <MenuItem>Copy message</MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
}

it("renders a resting deferred menu trigger exactly as Base UI's closed trigger", () => {
  render(
    <>
      <RowMenu deferred={false} />
      <RowMenu deferred />
    </>,
  );
  const base = attributes(screen.getByRole("button", { name: "Base" }));
  const deferred = attributes(screen.getByRole("button", { name: "Deferred" }));
  expect({ ...deferred, "aria-label": "Base" }).toEqual(base);
});

it.each([
  ["a mouse click", { skipHover: false }],
  ["a click that skips hover", { skipHover: true }],
] as const)(
  "opens a deferred menu on %s within one task",
  async (_, options) => {
    vi.useRealTimers();
    const deferred = !process.env.EAGER;
    // No delay: every event of the click is dispatched before any task runs.
    const user = userEvent.setup({ delay: null });
    render(<RowMenu deferred={deferred} />);
    const name = deferred ? "Deferred" : "Base";
    const trigger = screen.getByRole("button", { name });
    if (options.skipHover)
      await user.pointer({ keys: "[MouseLeft]", target: trigger });
    else await user.click(trigger);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name })).toBe(trigger);
  },
);

it("opens a deferred menu on an assistive click", async () => {
  render(<RowMenu deferred />);
  const trigger = screen.getByRole("button", { name: "Deferred" });
  fireEvent.click(trigger, { detail: 0 });
  await rest(50);
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(trigger).toHaveAttribute("aria-expanded", "true");
});

it("opens a deferred menu from the keyboard once its trigger is focused", async () => {
  render(<RowMenu deferred />);
  const trigger = screen.getByRole("button", { name: "Deferred" });
  act(() => trigger.focus());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  await rest(0);
  expect(screen.getByRole("menu")).toBeInTheDocument();
});
