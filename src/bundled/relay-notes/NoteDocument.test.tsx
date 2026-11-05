// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { noteKey, noteUrl } from "../../features/notes/model";
import { eventDto } from "../../features/relay/events";
import { notesFixture } from "../../features/notes/testing";
import {
  createNotesWorkspace,
  type NotesWorkspace,
} from "../../features/notes/workspace";
import { readView, writeView } from "../../shared/view-state";
import { NoteDocument, NoteMarkdown } from "./NoteDocument";

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
composerDOMFixture();
async function fixture(automatic = true) {
  const f = await notesFixture();
  const listeners = new Set<Parameters<typeof f.session.subscribeLive>[0]>();
  const workspace = createNotesWorkspace({
    ...f.session,
    subscribeLive(listener, options) {
      listeners.add(listener);
      const stop = f.session.subscribeLive(listener, options);
      return () => {
        listeners.delete(listener);
        stop();
      };
    },
  });
  disposers.push(() => {
    workspace.dispose();
    f.dispose();
  });
  const note = f.seed("Plan", "Original body");
  const preference = `note-auto-save:${noteKey(note)}`;
  if (!automatic) writeView(f.session.scope, preference, false);
  const realSave = workspace.save;
  const save = vi.spyOn(workspace, "save");
  const onChange = vi.fn();
  const mount = () =>
    render(
      <StrictMode>
        <NoteDocument
          address={note}
          workspace={workspace}
          onOpen={vi.fn()}
          onChange={onChange}
        />
      </StrictMode>,
    );
  const view = mount();
  const title = await screen.findByRole("textbox", { name: "Title" });
  await waitFor(() => {
    expect(title).toHaveValue("Plan");
    expect(title).toBeEnabled();
  });
  vi.useFakeTimers();
  const change = (value: string) =>
    fireEvent.change(title, { target: { value } });
  return {
    ...f,
    workspace,
    note,
    preference,
    save,
    realSave,
    view,
    mount,
    title,
    change,
    onChange,
    echo(event: unknown) {
      for (const listener of listeners)
        listener({ events: [eventDto(event)], channelId: note.channel });
    },
  };
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function saved(save: MockInstance<NotesWorkspace["save"]>) {
  await act(async () => {
    await Promise.allSettled([save.mock.results.at(-1)?.value]);
  });
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it("saves changed content after idle, stays in Editing and skips unchanged content", async () => {
  const f = await fixture();
  await advance(10_000);
  expect(f.save).not.toHaveBeenCalled();
  f.change("New plan");
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  expect(
    screen.queryByRole("button", { name: "Discard changes" }),
  ).not.toBeInTheDocument();
  expect(
    screen
      .getByRole("status")
      .parentElement?.querySelector("[data-avatar-shape]"),
  ).toHaveAttribute("data-avatar-shape", "circle");
  await advance(1499);
  expect(f.save).not.toHaveBeenCalled();
  f.change("Final plan");
  await advance(1499);
  expect(f.save).not.toHaveBeenCalled();
  await advance(1);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.title).toHaveValue("Final plan");
  expect(f.title).not.toHaveAttribute("readonly");
  expect(screen.getByRole("status")).toHaveTextContent("Saved");
  expect(
    screen.queryByRole("button", { name: /^Save$/ }),
  ).not.toBeInTheDocument();
  expect(f.workspace.drafts.size).toBe(0);
  f.change("Final plan");
  await advance(10_000);
  expect(f.save).toHaveBeenCalledOnce();
});

it("saves by ten seconds during continuous typing and waits for composition to finish", async () => {
  const f = await fixture();
  for (let index = 0; index < 10; index++) {
    f.change(`Plan ${index}`);
    await advance(1000);
  }
  await saved(f.save);
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.save.mock.calls[0]?.[1].title).toBe("Plan 9");
  fireEvent.compositionStart(f.title);
  f.change("Composing");
  await advance(15_000);
  expect(f.save).toHaveBeenCalledOnce();
  fireEvent.compositionEnd(f.title);
  await advance(1500);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
});

it("keeps typing during a pending save and bases the next save on its accepted revision", async () => {
  const f = await fixture();
  const pending = gate();
  f.save.mockImplementationOnce(async (...args) => {
    await pending.promise;
    return f.realSave(...args);
  });
  f.change("First edit");
  await advance(1500);
  expect(screen.getByRole("status")).toHaveTextContent("Saving");
  expect(f.title).toBeEnabled();
  f.change("Typed during save");
  expect(f.title).toHaveValue("Typed during save");
  await advance(15_000);
  expect(f.save).toHaveBeenCalledOnce();
  pending.release();
  await saved(f.save);
  expect(f.title).toHaveValue("Typed during save");
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  const first = await f.save.mock.results[0]?.value;
  await advance(1500);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.save.mock.calls[1]?.[0].revision).toBe(first.revision);
  expect(f.save.mock.calls[1]?.[1].title).toBe("Typed during save");
  expect(f.workspace.drafts.size).toBe(0);
});

it("pauses after a failed save, retains the draft, and retries only on request", async () => {
  const f = await fixture();
  f.failNextArtifact();
  f.change("Unsaved plan");
  await advance(1500);
  await saved(f.save).catch(() => {});
  expect(screen.getByRole("alert")).toHaveTextContent("Auto-save is paused");
  expect(f.workspace.drafts.get(noteKey(f.note))?.title).toBe("Unsaved plan");
  await advance(30_000);
  expect(f.save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("reconciles a live echo after the save receipt without conflicting with edits made in flight", async () => {
  const f = await fixture();
  const receipt = gate();
  const accepted = gate();
  f.save.mockImplementationOnce(async (...args) => {
    const next = await f.realSave(...args);
    accepted.release();
    await receipt.promise;
    return next;
  });
  f.change("First revision");
  await advance(1500);
  await act(async () => {
    await accepted.promise;
  });
  const event = f.heads.get(f.note.id);
  if (!event) throw new Error("Missing accepted head");
  f.change("Newer draft");
  act(() => f.echo(event));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  receipt.release();
  await saved(f.save);
  expect(f.title).toHaveValue("Newer draft");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await advance(1500);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.save.mock.calls[1]?.[0].revision).toBe(event.id);
});

it("accepts a remote revision while clean and editing, then preserves a dirty draft on a later remote edit", async () => {
  const f = await fixture();
  const next = await f.edit(f.carl, f.note, {
    title: "Remote title",
    markdown: "Remote body",
  });
  await act(async () => {
    f.echo(next);
  });
  expect(f.title).toHaveValue("Remote title");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  f.change("My newer draft");
  const later = await f.edit(f.carl, f.note, {
    title: "Later remote title",
    markdown: "Later body",
  });
  await act(async () => {
    f.echo(later);
  });
  expect(f.title).toHaveValue("My newer draft");
  expect(
    screen.getByRole("dialog", { name: "This page has a newer revision" }),
  ).toBeVisible();
  await advance(15_000);
  expect(f.save).not.toHaveBeenCalled();
});

it("persists Disable auto-save per page and account, cancels the timer, and keeps manual Save in action order", async () => {
  const f = await fixture();
  f.change("Manual plan");
  await advance(1000);
  fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
  await advance(0);
  expect(
    screen.queryByRole("menuitem", { name: "Disable auto-save" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("menuitem", { name: "Revision history" }));
  await advance(0);
  fireEvent.click(screen.getByRole("menuitem", { name: "Disable auto-save" }));
  await advance(10_000);
  expect(f.save).not.toHaveBeenCalled();
  expect(readView(f.session.scope, f.preference, true)).toBe(false);
  const manual = screen.getByRole("button", { name: /^Save$/ });
  const mode = screen.getByRole("combobox", { name: "Page mode" });
  const refresh = screen.getByRole("button", { name: "Refresh page" });
  expect(
    mode.compareDocumentPosition(manual) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    manual.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(manual);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledOnce();
  f.view.unmount();
  vi.useRealTimers();
  f.mount();
  await screen.findByRole("button", { name: "Page actions" });
  fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Revision history" }),
  );
  expect(
    await screen.findByRole("menuitem", { name: "Enable auto-save" }),
  ).toBeVisible();
  const other = f.seed("Other page", "Body");
  expect(
    readView(f.session.scope, `note-auto-save:${noteKey(other)}`, true),
  ).toBe(true);
  expect(readView("other-account", f.preference, true)).toBe(true);
});

it("preserves a concurrent draft and does not overwrite until the user resolves the conflict", async () => {
  const f = await fixture();
  f.change("My draft");
  await f.edit(f.carl, f.note, {
    title: "Agent plan",
    markdown: "Another edit",
  });
  await advance(1500);
  await saved(f.save).catch(() => {});
  expect(
    screen.getByRole("dialog", { name: "This page has a newer revision" }),
  ).toBeVisible();
  expect(f.title).toHaveValue("My draft");
  await advance(30_000);
  expect(f.save).toHaveBeenCalledOnce();
  fireEvent.click(
    screen.getByRole("button", { name: "I’ve compared; keep my draft" }),
  );
  await advance(1500);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.title).toHaveValue("My draft");
  expect(f.save.mock.calls[1]?.[0].title).toBe("Agent plan");
});

it("cancels idle saves on unmount while retaining the workspace draft", async () => {
  const f = await fixture();
  f.change("Keep this draft");
  f.view.unmount();
  await advance(10_000);
  expect(f.save).not.toHaveBeenCalled();
  expect(f.workspace.drafts.get(noteKey(f.note))?.title).toBe(
    "Keep this draft",
  );
});

async function historyFixture(automatic = false, deleted = false) {
  const f = await fixture(automatic);
  vi.useRealTimers();
  const current = await f.realSave(
    f.note,
    { title: "New plan", markdown: deleted ? "" : "New body" },
    deleted ? "delete" : "update",
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh page" }));
  if (deleted) await screen.findByRole("button", { name: "Restore" });
  else await waitFor(() => expect(f.title).toHaveValue("New plan"));
  return { ...f, current };
}
async function previewOriginal() {
  fireEvent.click(screen.getByRole("button", { name: "Page actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Revision history" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Plan/ }));
  const preview = await screen.findByRole("dialog", {
    name: "Revision preview",
  });
  await within(preview).findByRole("button", { name: "Restore this version" });
  return preview;
}
it.each([false, true])(
  "restores immediately as a new head and keeps history (auto-save=%s)",
  async (automatic) => {
    const f = await historyFixture(automatic);
    const preview = await previewOriginal();
    fireEvent.click(
      within(preview).getByRole("button", { name: "Restore this version" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(f.title).toHaveValue("Plan");
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.save.mock.calls[0]?.[0].revision).toBe(f.current.revision);
    expect(f.save.mock.calls[0]?.[2]).toBe("update");
    const history = await f.workspace.history(f.note);
    expect(history.revisions.map((note) => note.markdown)).toEqual([
      "Original body",
      "New body",
      "Original body",
    ]);
    expect(history.revisions[0]?.revision).not.toBe(f.note.revision);
    expect(f.workspace.drafts.size).toBe(0);
  },
);
it("confirms pending edits, cancels without saving, and keeps the draft on restore failure", async () => {
  const f = await historyFixture(true);
  f.change("Keep my draft");
  const preview = await previewOriginal();
  vi.useFakeTimers();
  await advance(15_000);
  expect(f.save).not.toHaveBeenCalled();
  vi.useRealTimers();
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  const confirm = await screen.findByRole("alertdialog", {
    name: "Replace unsaved changes?",
  });
  fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(f.title).toHaveValue("Keep my draft");
  expect(f.save).not.toHaveBeenCalled();
  f.failNextArtifact();
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Replace and restore" }),
  );
  await within(preview).findByRole("alert");
  expect(f.title).toHaveValue("Keep my draft");
  expect(f.workspace.drafts.get(noteKey(f.note))?.title).toBe("Keep my draft");
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Replace and restore" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(f.title).toHaveValue("Plan");
});
it("protects a pending restoration and reconciles its live echo", async () => {
  const f = await historyFixture();
  const pending = gate();
  const accepted = gate();
  f.save.mockImplementationOnce(async (...args) => {
    const next = await f.realSave(...args);
    accepted.release();
    await pending.promise;
    return next;
  });
  const preview = await previewOriginal();
  try {
    fireEvent.click(
      within(preview).getByRole("button", { name: "Restore this version" }),
    );
    await act(async () => {
      await accepted.promise;
    });
    expect(
      within(preview).getByRole("button", { name: "Restore this version" }),
    ).toBeDisabled();
    expect(
      within(preview).getByRole("button", { name: "Close" }),
    ).toBeDisabled();
    fireEvent.click(within(preview).getByRole("button", { name: "Close" }));
    expect(preview).toBeInTheDocument();
    act(() => f.echo(f.heads.get(f.note.id)));
  } finally {
    pending.release();
  }
  await saved(f.save);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(f.title).toHaveValue("Plan");
});
it("preserves a draft when another author wins before restore", async () => {
  const f = await historyFixture();
  f.change("My pending draft");
  const preview = await previewOriginal();
  await f.edit(f.carl, f.current, {
    title: "Remote winner",
    markdown: "Keep remote",
  });
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Replace and restore" }),
  );
  await screen.findByRole("dialog", { name: "This page has a newer revision" });
  expect(f.title).toHaveValue("My pending draft");
  expect((await f.workspace.open(f.note)).title).toBe("Remote winner");
});
it("restores a deleted page directly from a retained version", async () => {
  const f = await historyFixture(false, true);
  const preview = await previewOriginal();
  fireEvent.click(
    within(preview).getByRole("button", { name: "Restore this version" }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect((await f.workspace.open(f.note)).markdown).toBe("Original body");
  expect(f.save.mock.calls[0]?.[2]).toBe("restore");
  expect(f.save.mock.calls[0]?.[1].restoreFrom?.revision).toBe(f.note.revision);
});

it("previews the last content of a deleted page and restores it in one click after a failed write", async () => {
  const f = await historyFixture(false, true);
  await screen.findByText("Original body");
  expect(screen.getByRole("status")).toHaveTextContent("Deleted");
  expect(screen.getByRole("status")).not.toHaveTextContent("Saved");
  const restore = await screen.findByRole("button", {
    name: "Restore",
  });
  await waitFor(() => expect(restore).toBeEnabled());
  f.save.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(restore);
  await screen.findByText(/Your draft is kept/);
  expect(screen.getByText("Original body")).toBeVisible();
  fireEvent.click(restore);
  await screen.findByRole("textbox", { name: "Title" });
  expect((await f.workspace.open(f.note)).markdown).toBe("Original body");
  expect(f.save.mock.calls.at(-1)?.[2]).toBe("restore");
});

it("keeps formatted Buzz conversation links and Page navigation through the shared Markdown owner", async () => {
  const f = await notesFixture();
  const note = f.seed("Target", "Body");
  const openPage = vi.fn();
  const openLink = vi.fn(() => true);
  const message = `buzz://message?channel=${note.channel}&id=${"a".repeat(64)}`;
  const view = render(
    <NoteMarkdown
      text={`[the **thread**](${message}) and [target page](<${noteUrl(note, f.origin)}>) and [unsafe](javascript:alert(1))`}
      community={f.origin}
      session={f.session}
      onOpen={openPage}
      openLink={openLink}
    />,
  );
  try {
    fireEvent.click(screen.getByRole("link", { name: "the thread" }));
    expect(openLink).toHaveBeenCalledWith(message);
    fireEvent.click(screen.getByRole("link", { name: "target page" }));
    expect(openPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: note.id, channel: note.channel }),
    );
    expect(
      screen.queryByRole("link", { name: "unsafe" }),
    ).not.toBeInTheDocument();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
  } finally {
    view.unmount();
    f.dispose();
  }
});
