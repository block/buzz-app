// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useRef } from "react";
import type { ChannelMessage } from "../relay/contracts";
import type { RelaySession } from "../relay/session";
import type { Contribution } from "../../plugins/contributions";
import type {
  SelectionPreview,
  SelectionPreviewProps,
} from "../conversation/contracts";
import { selectionPreviews } from "../conversation/selection-preview";
import { SelectionPreviews, selectedMessageText } from "./SelectionPreviews";

const row: ChannelMessage = {
  id: "one",
  channelId: "alpha",
  authorId: "author",
  content: "EX-42",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 0,
};
const session = {} as RelaySession; // The selection host only passes this capability to the plugin.
const rect = () => ({
  top: 10,
  left: 10,
  right: 80,
  bottom: 30,
  width: 70,
  height: 20,
  x: 10,
  y: 10,
  toJSON() {},
});
const entry = (id: string, order = 0): Contribution<SelectionPreview> => ({
  id,
  title: id,
  pluginId: `example.${id}`,
  revision: "one",
  key: `example.${id}/${id}`,
  order,
  matches: ({ text }) => text === "EX-42",
  component: ({ text }) => (
    <p>
      {id}: {text}
    </p>
  ),
});
afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});
function registry(initial = [entry("first")]) {
  let entries = initial;
  const listeners = new Set<() => void>();
  return {
    snapshot: () => entries,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    set(next: typeof entries) {
      entries = next;
      for (const fn of listeners) fn();
    },
  };
}
function setup(initial = [entry("first")]) {
  // jsdom does not measure ranges; layout and native selection are browser-tested.
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: rect,
  });
  const store = registry(initial);
  function Example({ channelId = "alpha" }: { channelId?: string }) {
    const list = useRef<HTMLElement>(null);
    return (
      <>
        <section ref={list} data-message-scroller>
          <div data-message-id="one">
            <div data-message-action-anchor>
              <p>EX-42</p>
            </div>
          </div>
          <div data-message-id="two">
            <div data-message-action-anchor>
              <p>ordinary words</p>
            </div>
          </div>
          <textarea aria-label="Draft" />
        </section>
        <SelectionPreviews
          list={list}
          rows={[row]}
          session={session}
          channelId={channelId}
          scope="example"
          registry={store}
        />
      </>
    );
  }
  const view = render(
    <StrictMode>
      <Example />
    </StrictMode>,
  );
  const select = (text = "EX-42") => {
    const element = screen.getByText(text, { exact: true });
    act(() => {
      const range = document.createRange();
      range.selectNodeContents(element);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      fireEvent(document, new Event("selectionchange"));
    });
  };
  return { store, view, select, Example };
}
it("keeps all matches in stable order and isolates throwing matchers", () => {
  const bad = {
    ...entry("broken"),
    matches: () => {
      throw Error("broken");
    },
  };
  const a = entry("a"),
    b = entry("b", -10);
  expect(
    selectionPreviews([a, bad, b], { text: "EX-42", message: row }),
  ).toEqual([b, a]);
  expect(selectionPreviews([b, a], { text: "ordinary", message: row })).toEqual(
    [],
  );
});
it("offers only a valid body selection, never an editor, another message, or another list", () => {
  const h = setup([]);
  h.select();
  const list = document.querySelector<HTMLElement>("section");
  if (!list) throw Error("No list");
  expect(selectedMessageText(list, [row])?.text).toBe("EX-42");
  expect(
    selectedMessageText(document.createElement("section"), [row]),
  ).toBeUndefined();
  const selection = document.getSelection();
  const range = document.createRange();
  const start = screen.getByText("EX-42").firstChild;
  const end = screen.getByText("ordinary words").firstChild;
  if (!start || !end) throw Error("No message text");
  range.setStart(start, 0);
  range.setEnd(end, 5);
  selection?.removeAllRanges();
  selection?.addRange(range);
  expect(selectedMessageText(list, [row])).toBeUndefined();
  range.selectNodeContents(screen.getByRole("textbox"));
  selection?.removeAllRanges();
  selection?.addRange(range);
  expect(selectedMessageText(list, [row])).toBeUndefined();
});
it("shows one preview without moving focus, dismisses without changing selection, and revokes on disable", async () => {
  const h = setup();
  h.select();
  expect(await screen.findByText("first: EX-42")).toBeVisible();
  expect(document.activeElement).toBe(document.body);
  expect(document.getSelection()?.toString()).toBe("EX-42");
  fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  fireEvent(document, new Event("selectionchange"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => document.getSelection()?.removeAllRanges());
  fireEvent(document, new Event("selectionchange"));
  await act(
    async () => new Promise((done) => requestAnimationFrame(() => done())),
  );
  h.select();
  expect(await screen.findByText("first: EX-42")).toBeVisible();
  act(() => h.store.set([]));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
it("uses a chooser for competing plugins and revokes a stale plugin callback on a new selection", async () => {
  let previousClose: (() => void) | undefined;
  const first = {
    ...entry("first"),
    component: ({ text, close }: SelectionPreviewProps) => {
      previousClose = close;
      return <p>First {text}</p>;
    },
  };
  const h = setup([first, entry("second", -10)]);
  h.select();
  expect(
    await screen.findByRole("dialog", { name: "Selected text previews" }),
  ).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: /^first$/ }));
  expect(await screen.findByText("First EX-42")).toBeVisible();
  const staleClose = previousClose;
  act(() => h.store.set([entry("replacement")]));
  expect(await screen.findByText("replacement: EX-42")).toBeVisible();
  // Disable/reload retires this component and its callbacks; close must not affect a later selection.
  act(() => {
    document.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
  });
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  h.select();
  expect(await screen.findByText("replacement: EX-42")).toBeVisible();
  act(() => staleClose?.());
  expect(screen.getByText("replacement: EX-42")).toBeVisible();
});

it("dismisses on an outside press even if the browser retains the old selection, and rejects another channel", async () => {
  const h = setup();
  h.select();
  expect(await screen.findByText("first: EX-42")).toBeVisible();
  fireEvent.pointerDown(document.body);
  fireEvent.pointerUp(document.body);
  await act(
    async () =>
      new Promise<void>((done) => requestAnimationFrame(() => done())),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(document.getSelection()?.toString()).toBe("EX-42");
  h.view.rerender(
    <StrictMode>
      <h.Example channelId="beta" />
    </StrictMode>,
  );
  await act(
    async () =>
      new Promise<void>((done) => requestAnimationFrame(() => done())),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
