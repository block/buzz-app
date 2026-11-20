// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { afterEach, expect, it } from "vitest";
import type { DetailTab } from "./DetailTabContext";
import { DetailsSheet } from "./DetailsSheet";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

it("opens what it reads as a tab and closes, leaving the composer's text", async () => {
  const pane = document.createElement("div");
  const composer = document.createElement("form");
  const editor = document.createElement("textarea");
  editor.value = "Unsent reply";
  composer.append(editor);
  pane.append(composer);
  document.body.append(pane);
  const host = { pane, composer, viewport: pane, container: pane };
  function Reader() {
    const [count, setCount] = useState(0);
    return (
      <button type="button" onClick={() => setCount(count + 1)}>
        Pressed {count}
      </button>
    );
  }
  function Workspace() {
    const [open, setOpen] = useState(true);
    const [tab, setTab] = useState<DetailTab>();
    return (
      <>
        <DetailsSheet
          open={open}
          onOpenChange={setOpen}
          onOpenAsTab={() => {
            setTab({ id: "diff:1", title: "Diff", content: <Reader /> });
            setOpen(false);
          }}
          title="Diff"
          host={host}
          readerOnly
        >
          <Reader />
        </DetailsSheet>
        {tab && <section aria-label="Reader tab">{tab.content}</section>}
      </>
    );
  }
  render(<Workspace />);
  const dialog = await screen.findByRole("dialog", { name: "Diff" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Pressed 0" }));
  expect(composer.inert).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Open as tab" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // The tab mounts its own reader; it carries no state from the sheet.
  expect(
    within(screen.getByRole("region", { name: "Reader tab" })).getByRole(
      "button",
      { name: "Pressed 0" },
    ),
  ).toBeInTheDocument();
  expect(composer.inert).not.toBe(true);
  expect(editor).toHaveValue("Unsent reply");
});

it("offers no Open as tab without a tab to open", async () => {
  const pane = document.createElement("div");
  const composer = document.createElement("form");
  pane.append(composer);
  document.body.append(pane);
  const host = { pane, composer, viewport: pane, container: pane };
  render(
    <DetailsSheet open onOpenChange={() => {}} title="Media" host={host}>
      <p>Media</p>
    </DetailsSheet>,
  );
  await screen.findByRole("dialog", { name: "Media" });
  expect(screen.queryByRole("button", { name: "Open as tab" })).toBeNull();
});

it("mounts its content in the document, so content effects see the page", async () => {
  const pane = document.createElement("div");
  const composer = document.createElement("form");
  pane.append(composer);
  document.body.append(pane);
  const host = { pane, composer, viewport: pane, container: pane };
  // StrictMode replays effects at mount; a video that sees itself detached
  // then pauses for good, and layout reads measure nothing.
  const seen: boolean[] = [];
  function Content() {
    const ref = useRef<HTMLParagraphElement>(null);
    useEffect(() => {
      seen.push(!!ref.current?.isConnected);
    }, []);
    return <p ref={ref}>Reader body</p>;
  }
  render(
    <StrictMode>
      <DetailsSheet
        open
        onOpenChange={() => {}}
        title="Reader"
        host={host}
        readerOnly
      >
        <Content />
      </DetailsSheet>
    </StrictMode>,
  );
  expect(await screen.findByText("Reader body")).toBeInTheDocument();
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).not.toContain(false);
});

it("hands a thread to its tab only after its composer finishes sending", async () => {
  const pane = document.createElement("div");
  const composer = document.createElement("form");
  pane.append(composer);
  document.body.append(pane);
  const host = { pane, composer, viewport: pane, container: pane };
  const handoffs: string[] = [];
  render(
    <DetailsSheet
      open
      onOpenChange={() => {}}
      title="Thread"
      host={host}
      containsComposer
      onOpenAsTab={() => handoffs.push("tab")}
    >
      <form data-message-composer="" aria-busy="true" aria-label="Reply" />
    </DetailsSheet>,
  );
  const reply = await screen.findByRole("form", { name: "Reply" });
  const openAsTab = screen.getByRole("button", { name: "Open as tab" });
  fireEvent.click(openAsTab);
  // A second press while it waits must not hand off twice.
  fireEvent.click(openAsTab);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(handoffs).toEqual([]);
  reply.setAttribute("aria-busy", "false");
  await waitFor(() => expect(handoffs).toEqual(["tab"]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(handoffs).toEqual(["tab"]);
});
