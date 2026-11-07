// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  DocumentEditor,
  type DocumentEditorHandle,
  type DocumentEditorProps,
} from "./DocumentEditor";
import type { ComposerInputElement } from "./composer-dom";
import { composerDOMFixture } from "./composer-testing";

composerDOMFixture();
afterEach(cleanup);

function mount(
  overrides: Partial<DocumentEditorProps> = {},
  {
    initialValue = "Hello world",
    accept = (_next: string): boolean => true,
  } = {},
) {
  const ref = createRef<DocumentEditorHandle>();
  const change = vi.fn();
  const save = vi.fn();
  function Editor(props: Partial<DocumentEditorProps>) {
    const [value, setValue] = useState(initialValue);
    const [source, setSource] = useState(false);
    const [linkOpen, setLinkOpen] = useState(false);
    return (
      <DocumentEditor
        ref={ref}
        value={value}
        onChange={(next) => {
          change(next);
          if (accept(next)) setValue(next);
        }}
        editing
        maxLength={32768}
        source={source}
        onSourceChange={setSource}
        linkOpen={linkOpen}
        onLinkOpenChange={setLinkOpen}
        onSave={save}
        {...props}
      />
    );
  }
  const view = render(<Editor {...overrides} />);
  return {
    ref,
    change,
    save,
    rerender: (props: Partial<DocumentEditorProps>) =>
      view.rerender(<Editor {...props} />),
  };
}

it("round-trips rich formatting into controlled source and accepts external replacements", async () => {
  const h = mount();
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", {
    name: "Document body",
  }) as ComposerInputElement;
  act(() => {
    input.focus();
    input.setSelectionRange(0, 5);
  });
  await user.click(screen.getByRole("button", { name: /^Bold$/ }));
  expect(h.change).toHaveBeenLastCalledWith("**Hello** world");
  expect(
    screen.queryByRole("button", { name: "Close formatting" }),
  ).not.toBeInTheDocument();
  h.rerender({ source: true });
  const source = screen.getByRole("textbox", { name: "Markdown" });
  expect(source).toHaveValue("**Hello** world");
  fireEvent.change(source, { target: { value: "# Literal heading\n\nNext" } });
  expect(h.change).toHaveBeenLastCalledWith("# Literal heading\n\nNext");
  h.rerender({ source: false, value: "External **replacement**" });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: "Document body" }),
    ).toHaveTextContent("External replacement"),
  );
  expect(
    screen
      .getByRole("textbox", { name: "Document body" })
      .querySelector("strong"),
  ).toHaveTextContent("replacement");
});

it("restores a declined rich edit to the controlled value", async () => {
  const change = vi.fn();
  const h = mount({ onChange: change });
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", {
    name: "Document body",
  }) as ComposerInputElement;
  act(() => {
    input.focus();
    input.setSelectionRange(0, 5);
  });
  await user.click(screen.getByRole("button", { name: /^Bold$/ }));
  expect(change).toHaveBeenLastCalledWith("**Hello** world");
  expect(change).toHaveBeenCalledTimes(1);
  expect(input).toHaveTextContent("Hello world");
  expect(input.querySelector("strong")).toBeNull();
  h.rerender({ onChange: change, source: true });
  expect(screen.getByRole("textbox", { name: "Markdown" })).toHaveValue(
    "Hello world",
  );
});

it("keeps a declined source edit out of rich mode", () => {
  const change = vi.fn();
  const h = mount({ onChange: change, source: true });
  const source = screen.getByRole("textbox", { name: "Markdown" });
  fireEvent.change(source, { target: { value: "Rejected text" } });
  expect(change).toHaveBeenLastCalledWith("Rejected text");
  expect(source).toHaveValue("Hello world");
  h.rerender({ onChange: change, source: false });
  expect(
    screen.getByRole("textbox", { name: "Document body" }),
  ).toHaveTextContent("Hello world");
  expect(change).toHaveBeenCalledTimes(1);
});

it("loads accepted source content when returning to rich mode", () => {
  const h = mount({ source: true });
  fireEvent.change(screen.getByRole("textbox", { name: "Markdown" }), {
    target: { value: "**Accepted** source" },
  });
  h.rerender({ source: false });
  const input = screen.getByRole("textbox", { name: "Document body" });
  expect(input).toHaveTextContent("Accepted source");
  expect(input.querySelector("strong")).toHaveTextContent("Accepted");
});

it("keeps the caret through a declined insertion and the next Backspace", async () => {
  const initialValue = "Intro paragraph.\n\nClosing line.";
  const h = mount(
    {},
    {
      initialValue,
      accept: (next) => next.length <= initialValue.length,
    },
  );
  const input = screen.getByRole("textbox", {
    name: "Document body",
  }) as ComposerInputElement;
  act(() => {
    input.focus();
    input.setSelectionRange(5, 5);
    input.insertText("Z");
  });
  expect(h.change).toHaveBeenCalledTimes(1);
  expect(input.selectionStart).toBe(5);
  expect(input.selectionEnd).toBe(5);
  expect(input).toHaveFocus();
  await userEvent.setup().keyboard("{Backspace}");
  await waitFor(() =>
    expect(h.change).toHaveBeenLastCalledWith(
      "Intr paragraph.\n\nClosing line.",
    ),
  );
});

it.each(["*italic*", "__bold__", "+ item", "1) item"])(
  "does not emit a normalized rollback for %j",
  (initialValue) => {
    const h = mount(
      {},
      { initialValue, accept: (next) => next.length <= initialValue.length },
    );
    const input = screen.getByRole("textbox", {
      name: "Document body",
    }) as ComposerInputElement;
    act(() => {
      input.focus();
      input.setSelectionRange(1, 1);
      input.insertText("Z");
    });
    expect(h.change).toHaveBeenCalledTimes(1);
    h.rerender({ source: true });
    expect(screen.getByRole("textbox", { name: "Markdown" })).toHaveValue(
      initialValue,
    );
  },
);

it("keeps save shortcuts and selection restoration at the controlled editor boundary", () => {
  const h = mount();
  const input = screen.getByRole("textbox", {
    name: "Document body",
  }) as ComposerInputElement;
  act(() => h.ref.current?.focusEnd());
  expect(input).toHaveFocus();
  expect(h.ref.current?.selection()).toEqual({
    start: 11,
    end: 11,
    source: false,
  });
  act(() => h.ref.current?.focusSelection({ start: 0, end: 5, source: false }));
  expect(h.ref.current?.selection()).toEqual({
    start: 0,
    end: 5,
    source: false,
  });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(h.save).toHaveBeenCalledTimes(1);
  h.rerender({ source: true });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Markdown" }), {
    key: "Enter",
    metaKey: true,
  });
  expect(h.save).toHaveBeenCalledTimes(2);
});

it("uses the existing link validator and retains the selected document text", async () => {
  const h = mount();
  const user = userEvent.setup();
  const input = screen.getByRole("textbox", {
    name: "Document body",
  }) as ComposerInputElement;
  act(() => {
    input.focus();
    input.setSelectionRange(0, 5);
  });
  await user.click(screen.getByRole("button", { name: /^Link$/ }));
  expect(await screen.findByRole("dialog", { name: "Add link" })).toBeVisible();
  await user.type(
    screen.getByRole("textbox", { name: "URL" }),
    "javascript:alert(1)",
  );
  await user.click(screen.getByRole("button", { name: /^Save$/ }));
  expect(
    await screen.findByText("Use an HTTP(S) URL or a valid buzz:// link."),
  ).toBeVisible();
  expect(h.change).not.toHaveBeenCalled();
  await user.clear(screen.getByRole("textbox", { name: "URL" }));
  await user.type(
    screen.getByRole("textbox", { name: "URL" }),
    "buzz://plugin?id=example.records&record=reference",
  );
  await user.click(screen.getByRole("button", { name: /^Save$/ }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(h.change).toHaveBeenLastCalledWith(
    String.raw`[Hello](buzz://plugin?id=example.records\&record=reference) world`,
  );
});

it("disables editing controls and leaves read-mode content with the plugin", () => {
  const h = mount({ disabled: true });
  expect(screen.getByRole("button", { name: /^Bold$/ })).toBeDisabled();
  expect(
    screen.getByRole("textbox", { name: "Document body" }),
  ).toHaveAttribute("contenteditable", "false");
  act(() => h.ref.current?.focusEnd());
  expect(
    screen.getByRole("textbox", { name: "Document body" }),
  ).not.toHaveFocus();
  h.rerender({ editing: false, children: <p>Plugin read view</p> });
  expect(screen.getByText("Plugin read view")).toBeVisible();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("group", { name: "Document formatting" }),
  ).not.toBeInTheDocument();
});
