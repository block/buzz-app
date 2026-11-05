// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { noteKey } from "../../features/notes/model";
import { notesFixture } from "../../features/notes/testing";
import { createNotesWorkspace } from "../../features/notes/workspace";
import { readView } from "../../shared/view-state";
import { NewNoteDocument, type NewDraft } from "./NewNoteDocument";

const disposers: (() => void)[] = [];
beforeEach(() => {
  localStorage.clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
async function fixture(initial: Partial<NewDraft> = {}) {
  const f = await notesFixture();
  const workspace = createNotesWorkspace(f.session);
  disposers.push(() => {
    workspace.dispose();
    f.dispose();
  });
  const realCreate = workspace.create;
  const create = vi.spyOn(workspace, "create");
  const onCreated = vi.fn();
  const onDraftChange = vi.fn();
  const props = {
    workspace,
    catalogue: [],
    active: true,
    initial: {
      id: crypto.randomUUID(),
      title: "",
      markdown: "",
      ...initial,
    },
    onCreated,
    onDraftChange,
  };
  vi.useFakeTimers();
  const view = render(
    <StrictMode>
      <NewNoteDocument {...props} />
    </StrictMode>,
  );
  return {
    ...f,
    workspace,
    create,
    realCreate,
    onCreated,
    onDraftChange,
    props,
    view,
    title: screen.getByRole("textbox", { name: "Title" }),
  };
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("opens a fresh editor without allocating storage, then auto-saves after idle", async () => {
  const f = await fixture();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await advance(16);
  expect(f.title).toHaveFocus();
  expect(screen.getByRole("textbox", { name: "Page body" })).toBeVisible();
  expect(screen.getByRole("group", { name: "Page formatting" })).toBeVisible();
  await advance(15_000);
  expect(f.create).not.toHaveBeenCalled();
  fireEvent.change(f.title, { target: { value: "New plan" } });
  await advance(1499);
  expect(f.create).not.toHaveBeenCalled();
  fireEvent.change(f.title, { target: { value: "Final plan" } });
  await advance(1499);
  expect(f.create).not.toHaveBeenCalled();
  await advance(1);
  await act(async () => {
    await f.create.mock.results[0]?.value;
  });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({
    title: "Final plan",
    id: f.props.initial.id,
  });
  expect(f.onCreated).toHaveBeenCalledOnce();
  expect(f.onDraftChange).toHaveBeenLastCalledWith(
    expect.objectContaining({ title: "Final plan" }),
  );
});

it("saves body-only pages with an untitled fallback and honors manual saving", async () => {
  const f = await fixture({ markdown: "First thought" });
  fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
  await advance(0);
  expect(
    screen.queryByRole("menuitem", { name: "Disable auto-save" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Revision history" }));
  await advance(0);
  expect(
    screen.getByRole("menu", { name: "Revision history" }),
  ).toHaveTextContent("No saved revisions yet.");
  expect(f.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitem", { name: "Disable auto-save" }));
  await advance(15_000);
  expect(f.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
  await act(async () => {
    await f.create.mock.results[0]?.value;
  });
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({
    title: "Untitled page",
    markdown: "First thought",
  });
  const note = f.onCreated.mock.calls[0]?.[0];
  expect(
    readView(f.session.scope, `note-auto-save:${noteKey(note)}`, true),
  ).toBe(false);
});

it("retains edits and selection while creating and waits for IME before handing off", async () => {
  const f = await fixture({ title: "First title" });
  const pending = gate();
  f.create.mockImplementationOnce(async (...args) => {
    await pending.promise;
    return f.realCreate(...args);
  });
  try {
    await advance(1500);
    expect(f.create).toHaveBeenCalledOnce();
    fireEvent.compositionStart(f.title);
    fireEvent.change(f.title, { target: { value: "Newer title" } });
    f.title.focus();
    if (!(f.title instanceof HTMLInputElement))
      throw new Error("Missing title input");
    f.title.setSelectionRange(2, 5);
    expect(f.title).toBeEnabled();
    pending.release();
    await act(async () => {
      await f.create.mock.results[0]?.value;
    });
    expect(f.onCreated).not.toHaveBeenCalled();
    fireEvent.compositionEnd(f.title);
    expect(f.onCreated).toHaveBeenCalledOnce();
    const [note, presentation] = f.onCreated.mock.calls[0] ?? [];
    const focus = presentation.focus;
    expect(f.workspace.drafts.get(noteKey(note))?.title).toBe("Newer title");
    expect(focus).toMatchObject({ target: "title", start: 2, end: 5 });
  } finally {
    pending.release();
  }
});

it("pauses on an uncertain receipt and retries the original identity and payload", async () => {
  const f = await fixture({ title: "First title" });
  f.create.mockImplementationOnce(async (...args) => {
    await f.realCreate(...args);
    throw new Error("Receipt lost");
  });
  await advance(1500);
  await act(async () => {
    await f.create.mock.results[0]?.value.catch(() => {});
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Receipt lost");
  fireEvent.change(f.title, { target: { value: "Edited after failure" } });
  await advance(15_000);
  expect(f.create).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await act(async () => {
    await f.create.mock.results[1]?.value;
  });
  expect(f.create.mock.calls[1]?.[0]).toEqual(f.create.mock.calls[0]?.[0]);
  const note = f.onCreated.mock.calls[0]?.[0];
  expect(f.workspace.drafts.get(noteKey(note))?.title).toBe(
    "Edited after failure",
  );
  expect(f.heads.size).toBe(1);
});

it("defers hidden drafts and saves by the maximum interval during continuous typing", async () => {
  const f = await fixture();
  fireEvent.change(f.title, { target: { value: "Hidden draft" } });
  f.view.rerender(
    <StrictMode>
      <NewNoteDocument {...f.props} active={false} />
    </StrictMode>,
  );
  await advance(15_000);
  expect(f.create).not.toHaveBeenCalled();
  f.view.rerender(
    <StrictMode>
      <NewNoteDocument {...f.props} active />
    </StrictMode>,
  );
  const title = screen.getByRole("textbox", { name: "Title" });
  for (let index = 0; index < 10; index++) {
    fireEvent.change(title, { target: { value: `Plan ${index}` } });
    await advance(1000);
  }
  await act(async () => {
    await f.create.mock.results[0]?.value;
  });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.create.mock.calls[0]?.[0].title).toBe("Plan 9");
});

it("creates a private empty page when Share is explicitly requested", async () => {
  const f = await fixture();
  f.unavailableInventory();
  fireEvent.click(screen.getByRole("button", { name: "Share page" }));
  await act(async () => {
    await f.create.mock.results[0]?.value;
  });
  const [note, presentation] = f.onCreated.mock.calls[0] ?? [];
  expect(presentation).toMatchObject({ share: true, autoSave: true });
  expect(f.channels.get(note.channel)?.roles).toEqual({
    [f.viewer.pubkey]: "owner",
  });
  expect(f.create.mock.calls[0]?.[0]).toMatchObject({
    title: "Untitled page",
    markdown: "",
  });
});

it("cancels first-save authority when the creation surface unmounts", async () => {
  const f = await fixture({ title: "Scoped draft" });
  const pending = gate();
  f.create.mockImplementationOnce(async (input, signal) => {
    await pending.promise;
    signal?.throwIfAborted();
    return f.realCreate(input, signal);
  });
  try {
    await advance(1500);
    expect(f.create).toHaveBeenCalledOnce();
    f.view.unmount();
    expect(f.create.mock.calls[0]?.[1]?.aborted).toBe(true);
    pending.release();
    await act(async () => {
      await f.create.mock.results[0]?.value.catch(() => {});
    });
    expect(f.heads.size).toBe(0);
    expect(f.onCreated).not.toHaveBeenCalled();
  } finally {
    pending.release();
  }
});
