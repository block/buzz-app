// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, workspaceFixture, advance, gate } from "./ui-testing";
import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi, type MockInstance } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { noteKey, noteTemplate, noteUrl } from "./model";
import type { RelaySession } from "../../features/relay/session";
import { ReadError } from "../../features/relay/errors";
import { eventDto } from "../../features/relay/events";
import { noteTools } from "./tools";
import type { NotesWorkspace } from "./workspace";
import { writeView } from "../../shared/view-state";
import { NoteDocument } from "./NoteDocument";
import { NoteMarkdown } from "./NoteMarkdown";

composerDOMFixture();

it.each([false, true])(
  "keeps controls in place while loading a doc (cached draft: %s)",
  async (cachedDraft) => {
    const f = await workspaceFixture();
    const note = f.seed("Plan", "Body");
    if (cachedDraft) {
      f.workspace.drafts.set(noteKey(note), {
        base: note,
        title: note.title,
        markdown: "Unsaved draft",
      });
    }
    const read = gate();
    const open = f.workspace.open;
    vi.spyOn(f.workspace, "open").mockImplementation(async (...args) => {
      await read.promise;
      return open(...args);
    });
    render(
      <NoteDocument address={note} workspace={f.workspace} onOpen={vi.fn()} />,
    );
    try {
      const article = screen.getByRole("article", { name: "Loading doc" });
      expect(within(article).queryByRole("heading")).not.toBeInTheDocument();
      const mode = screen.getByRole("combobox", { name: "Doc mode" });
      expect(mode).toBeDisabled();
      expect(mode).toHaveTextContent(/^$/);
      expect(screen.queryByRole("button", { name: "Refresh doc" })).toBeNull();
      for (const name of ["Share doc", "Doc actions"]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
    } finally {
      read.release();
    }
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Doc actions" })).toBeEnabled(),
    );
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Plan");
    expect(screen.getByRole("status")).toHaveTextContent(
      cachedDraft ? "Unsaved changes" : /^Saved /,
    );
  },
);

async function fixture(legacyAutoSaveDisabled = false) {
  const followers = new Set<
    Parameters<RelaySession["artifacts"]["follow"]>[1]
  >();
  const f = await workspaceFixture({ live: true }, (session) => ({
    ...session,
    artifacts: {
      ...session.artifacts,
      follow(ids, listener, revoked) {
        followers.add(listener);
        const stop = session.artifacts.follow(ids, listener, revoked);
        return () => {
          followers.delete(listener);
          stop();
        };
      },
    },
  }));
  const { workspace } = f;
  const note = f.seed("Plan", "Original body");
  if (legacyAutoSaveDisabled)
    writeView(f.session.scope, `note-auto-save:${noteKey(note)}`, false);
  const realSave = workspace.save;
  const save = vi.spyOn(workspace, "save");
  const onChange = vi.fn();
  const view = render(
    <StrictMode>
      <NoteDocument
        address={note}
        workspace={workspace}
        onOpen={vi.fn()}
        onChange={onChange}
      />
    </StrictMode>,
  );
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
    save,
    realSave,
    view,
    title,
    change,
    onChange,
    echo(event: unknown) {
      for (const listener of followers) listener([eventDto(event)]);
    },
  };
}
async function saved(save: MockInstance<NotesWorkspace["save"]>) {
  await act(async () => {
    await Promise.allSettled([save.mock.results.at(-1)?.value]);
  });
}

it("auto-saves after idle even with a legacy disabled preference and skips unchanged content", async () => {
  const f = await fixture(true);
  await advance(10_000);
  expect(f.save).not.toHaveBeenCalled();
  f.change("Final plan");
  expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
  expect(
    screen.queryByRole("button", { name: "Discard changes" }),
  ).not.toBeInTheDocument();
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

it("waits for idle throughout continuous typing and composition", async () => {
  const f = await fixture();
  for (let index = 0; index < 12; index++) {
    f.change(`Plan ${index}`);
    await advance(1000);
    expect(f.save).not.toHaveBeenCalled();
  }
  fireEvent.compositionStart(f.title);
  f.change("Composing");
  await advance(15_000);
  expect(f.save).not.toHaveBeenCalled();
  fireEvent.compositionEnd(f.title);
  await advance(1499);
  expect(f.save).not.toHaveBeenCalled();
  await advance(1);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.save.mock.calls[0]?.[1].title).toBe("Composing");
});

it("saves a trimmed title once while preserving the text in the active field", async () => {
  const f = await fixture();
  f.change("New plan ");
  await advance(1500);
  await saved(f.save);
  expect((await f.workspace.open(f.note)).title).toBe("New plan");
  expect(f.title).toHaveValue("New plan ");
  expect(screen.getByRole("status")).toHaveTextContent(/^Saved/);
  await advance(15_000);
  expect(f.save).toHaveBeenCalledOnce();
});

it("pauses after a failed save, retains the draft, and retries only on request", async () => {
  const f = await fixture();
  f.failNextArtifact();
  f.change("Unsaved plan");
  await advance(1500);
  await saved(f.save);
  expect(screen.getByRole("alert")).toHaveTextContent("Auto-save is paused");
  expect(f.workspace.drafts.get(noteKey(f.note))?.title).toBe("Unsaved plan");
  await advance(30_000);
  expect(f.save).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps typing through a pending receipt and reconciles its live echo against the accepted base", async () => {
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
  expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  await act(async () => {
    await accepted.promise;
  });
  const event = f.heads.get(f.note.id);
  if (!event) throw new Error("Missing accepted head");
  expect(f.title).toBeEnabled();
  f.change("Newer draft");
  expect(f.title).toHaveValue("Newer draft");
  await advance(15_000);
  expect(f.save).toHaveBeenCalledOnce();
  const refresh = gate();
  const open = f.workspace.open;
  const read = vi
    .spyOn(f.workspace, "open")
    .mockImplementationOnce(async (...args) => {
      await refresh.promise;
      return open(...args);
    });
  await act(async () => f.echo(event));
  expect(read).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  try {
    f.title.focus();
    receipt.release();
    await saved(f.save);
    expect(read).toHaveBeenCalledOnce();
    expect(f.title).toBeEnabled();
    expect(f.title).toHaveFocus();
    expect(
      screen.getByRole("textbox", { name: "Doc body" }),
    ).not.toHaveAttribute("aria-disabled", "true");
    f.change("Typing during reconciliation");
  } finally {
    receipt.release();
    await act(async () => {
      refresh.release();
      await read.mock.results[0]?.value;
    });
  }
  expect(f.title).toHaveValue("Typing during reconciliation");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await advance(1500);
  await saved(f.save);
  expect(f.save).toHaveBeenCalledTimes(2);
  expect(f.save.mock.calls[1]?.[0].revision).toBe(event.id);
  expect(f.save.mock.calls[1]?.[1].title).toBe("Typing during reconciliation");
  expect(f.workspace.drafts.size).toBe(0);
});

it("accepts a remote revision while clean and editing, then preserves a dirty draft on a later remote edit", async () => {
  const f = await fixture();
  const markdown = "## Risks\n- First item\n- Second item\n";
  const next = await f.edit(f.carl, f.note, {
    title: "Remote title",
    markdown,
  });
  await act(async () => {
    f.echo(next);
  });
  expect(f.title).toHaveValue("Remote title");
  expect(screen.getByRole("textbox", { name: "Doc body" })).toHaveTextContent(
    "First item",
  );
  await advance(10_000);
  expect(f.save).not.toHaveBeenCalled();
  expect((await f.workspace.open(f.note)).markdown).toBe(markdown);
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
    screen.getByRole("dialog", { name: "This doc has a newer revision" }),
  ).toBeVisible();
  await advance(15_000);
  expect(f.save).not.toHaveBeenCalled();
});

it("offers a quiet refresh after a transient update error and hides it after recovery", async () => {
  const f = await fixture();
  vi.useRealTimers();
  const refresh = () => screen.queryByRole("button", { name: "Refresh doc" });
  expect(refresh()).toBeNull();
  const next = await f.edit(f.carl, f.note, {
    title: "Remote plan",
    markdown: "Another edit",
  });
  vi.spyOn(f.workspace, "open").mockRejectedValueOnce(
    new ReadError("unavailable", "Relay read failed (503)", 503),
  );
  await act(async () => f.echo(next));
  expect(f.title).toHaveValue("Plan");
  expect(f.title).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh doc" }));
  await waitFor(() => {
    expect(f.title).toHaveValue("Remote plan");
    expect(refresh()).toBeNull();
  });
});

it("shows refresh during a live update interruption", async () => {
  let status: ReturnType<RelaySession["live"]["snapshot"]>["status"] =
    "connected";
  let notify = () => {};
  const f = await workspaceFixture({ live: true }, (session) => ({
    ...session,
    live: {
      ...session.live,
      snapshot: () => ({ ...session.live.snapshot(), status }),
      subscribe(listener) {
        notify = listener;
        return session.live.subscribe(listener);
      },
    },
  }));
  const note = f.seed("Plan", "Body");
  render(
    <NoteDocument address={note} workspace={f.workspace} onOpen={vi.fn()} />,
  );
  await screen.findByRole("article", { name: "Plan" });
  const refresh = () => screen.queryByRole("button", { name: "Refresh doc" });
  expect(refresh()).toBeNull();
  act(() => {
    status = "retrying";
    notify();
  });
  expect(refresh()).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
  act(() => {
    status = "connected";
    notify();
  });
  expect(refresh()).toBeNull();
});

it("preserves a concurrent draft and does not overwrite until the user resolves the conflict", async () => {
  const f = await fixture();
  f.change("My draft");
  await f.edit(f.carl, f.note, {
    title: "Agent plan",
    markdown: "Another edit",
  });
  await advance(1500);
  await saved(f.save);
  expect(
    screen.getByRole("dialog", { name: "This doc has a newer revision" }),
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

async function historyFixture(deleted = false) {
  const f = await fixture();
  vi.useRealTimers();
  const current = await f.realSave(
    f.note,
    { title: "New plan", markdown: deleted ? "" : "New body" },
    deleted ? "delete" : "update",
  );
  await act(async () => f.echo(current.event));
  if (deleted) await screen.findByRole("heading", { name: "Plan (in Trash)" });
  else await waitFor(() => expect(f.title).toHaveValue("New plan"));
  return { ...f, current };
}
async function previewOriginal() {
  fireEvent.click(screen.getByRole("button", { name: "Doc actions" }));
  fireEvent.click(
    await screen.findByRole("menuitem", { name: "Revision history" }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: /^Plan/ }));
  const preview = await screen.findByRole("dialog", {
    name: "Revision preview",
  });
  await within(preview).findByRole("region", { name: "Selected revision" });
  return preview;
}
it("restores immediately as a new head and keeps history", async () => {
  const f = await historyFixture();
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
});
it("confirms pending edits, cancels without saving, and keeps the draft on restore failure", async () => {
  const f = await historyFixture();
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
  await screen.findByRole("dialog", { name: "This doc has a newer revision" });
  expect(f.title).toHaveValue("My pending draft");
  expect((await f.workspace.open(f.note)).title).toBe("Remote winner");
});
it("keeps a deleted doc hidden and restores a selected revision after a failed write", async () => {
  const f = await historyFixture(true);
  expect(screen.getByRole("status")).toHaveTextContent("Moved to Trash");
  expect(screen.getByText("This doc is in Trash.")).toBeVisible();
  expect(screen.queryByText("Original body")).toBeNull();
  expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
  const preview = await previewOriginal();
  const restore = within(preview).getByRole("button", {
    name: "Restore this version",
  });
  f.save.mockRejectedValueOnce(new Error("Offline"));
  fireEvent.click(restore);
  await within(preview).findByText("Offline");
  expect(within(preview).getByText("Original body")).toBeVisible();
  fireEvent.click(restore);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect((await f.workspace.open(f.note)).markdown).toBe("Original body");
  expect(f.save.mock.calls[0]?.[2]).toBe("restore");
  expect(f.save.mock.calls[0]?.[1].restoreFrom?.revision).toBe(f.note.revision);
});

it("shows the retained title to a reader and keeps the body in revision history", async () => {
  const f = await workspaceFixture();
  const note = f.seed("Plan", "# Earlier draft\n\nOriginal **body**");
  const storage = f.channels.get(note.channel);
  if (!storage) throw new Error("Missing doc storage");
  storage.creator = f.sam.pubkey;
  storage.roles = { [f.sam.pubkey]: "owner", [f.viewer.pubkey]: "guest" };
  await f
    .client(f.sam)
    .publish(
      noteTemplate(note, { title: note.title, markdown: "" }, note, "delete"),
    );
  render(
    <NoteDocument address={note} workspace={f.workspace} onOpen={vi.fn()} />,
  );
  await screen.findByRole("heading", { name: "Plan (in Trash)" });
  expect(screen.queryByRole("heading", { name: "Earlier draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  const preview = await previewOriginal();
  expect(
    within(preview).getByRole("heading", { name: "Earlier draft" }),
  ).toBeVisible();
  expect(
    within(preview).getByText("body", { selector: "strong" }),
  ).toBeVisible();
  expect(
    within(preview).queryByRole("button", { name: "Restore this version" }),
  ).toBeNull();
});

it("keeps formatted Buzz conversation links and Page navigation through the shared Markdown owner", async () => {
  const f = await workspaceFixture();
  const note = f.seed("Target", "Body");
  const openPage = vi.fn();
  const openLink = vi.fn(() => true);
  const message = `buzz://message?channel=${note.channel}&id=${"a".repeat(64)}`;
  const view = render(
    <NoteMarkdown
      text={`[the **thread**](${message}) and [target page](<${noteUrl(note, f.origin)}>) and [unsafe](javascript:alert(1))\n\n| Item | Status |\n| --- | --- |\n| Plan | Ready |`}
      community={f.origin}
      session={f.session}
      onOpen={openPage}
      openLink={openLink}
    />,
  );
  try {
    expect(
      within(screen.getByRole("table")).getByRole("cell", { name: "Ready" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "the thread" }));
    expect(openLink).toHaveBeenCalledWith(message);
    fireEvent.click(screen.getByRole("link", { name: "target page" }));
    expect(openPage).toHaveBeenCalledWith(
      expect.objectContaining({ id: note.id, channel: note.channel }),
    );
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
  } finally {
    view.unmount();
  }
});

it("reports access loss to the tab before its refresh finishes", async () => {
  let revoke: (() => void) | undefined;
  const f = await workspaceFixture({ live: true }, (session) => ({
    ...session,
    artifacts: {
      ...session.artifacts,
      follow(ids, listener, revoked) {
        revoke = () => revoked?.(ids);
        return session.artifacts.follow(ids, listener, revoked);
      },
    },
  }));
  const note = f.seed("Live document", "Original body");
  const onUnavailable = vi.fn();
  render(
    <NoteDocument
      address={note}
      workspace={f.workspace}
      onOpen={vi.fn()}
      onUnavailable={onUnavailable}
    />,
  );
  await screen.findByRole("article", { name: "Live document" });
  const pending = gate();
  const refresh = vi
    .spyOn(f.workspace, "open")
    .mockImplementationOnce(async () => {
      await pending.promise;
      throw new Error("Access removed");
    });
  try {
    act(() => revoke?.());
    expect(refresh).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith(note);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  } finally {
    pending.release();
  }
  expect(await screen.findByRole("alert")).toHaveTextContent("Access removed");
});

it("keeps only the mounted Page channel live and receives a tool save through its transport", async () => {
  const f = await workspaceFixture({ live: true });
  const { workspace } = f;
  const note = f.seed("Live document", "Original body");
  const view = render(
    <NoteDocument
      address={note}
      workspace={workspace}
      onOpen={vi.fn()}
      onChange={vi.fn()}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(
      "Live document",
    ),
  );
  expect(f.liveChannels()).toContain(note.channel);
  const set = noteTools(() => workspace).find(
    (tool) => tool.name === "page_set",
  );
  if (!set) throw new Error("Missing page_set");
  await act(async () => {
    await set.call(
      f.client(),
      {},
      {
        id: note.id,
        channel: note.channel,
        revision: note.revision,
        title: note.title,
        text: "Updated by the agent",
      },
    );
    const event = f.heads.get(note.id);
    if (!event) throw new Error("Missing accepted revision");
    f.deliver(event);
  });
  await waitFor(() =>
    expect(
      screen.getByRole("textbox", { name: /^Doc body$/ }),
    ).toHaveTextContent("Updated by the agent"),
  );
  view.unmount();
  expect(f.liveChannels()).not.toContain(note.channel);
});
