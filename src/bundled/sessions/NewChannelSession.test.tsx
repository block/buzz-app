// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { NewChannelSession } from "./NewChannelSession";
import {
  channelSessionDraftKey,
  readChannelSessionDraft,
  saveChannelSessionDraft,
  readChannelSessionEditorGeneration,
  saveChannelSessionEditorGeneration,
} from "./channel-session-draft";
import type { ComposerInputElement } from "../../features/messages/composer-dom";
import { readView, writeView } from "../../shared/view-state";
import { mentionDraft } from "../../features/messages/mention-draft";
const owners: ReturnType<typeof sessionsData>[] = [];
const scope = "sessions-fixture";
beforeEach(() => {
  localStorage.clear();
  // FIFO lock fake; deferred tests below control acquisition, never wall time.
  let tail = Promise.resolve();
  vi.stubGlobal(
    "navigator",
    Object.assign(Object.create(navigator), {
      locks: {
        request: vi.fn((_name, _options, work) => {
          const result = tail.then(work);
          tail = result.catch(() => {});
          return result;
        }),
      },
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  for (const h of owners.splice(0)) h.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function setup(
  outboxStorage?: import("../../features/relay/outbox").OutboxStorage,
) {
  const h = sessionsData({
    rowCount: 0,
    ...(outboxStorage ? { outboxStorage } : {}),
  });
  owners.push(h);
  h.session.channels.ensureList();
  await waitFor(() => expect(h.session.channels.list().status).toBe("ready"));
  await h.session.profiles.ensure([h.member]);
  const selected = mentionDraft({
    text: "@Fixture member help",
    recipients: [
      { pubkey: h.member, name: "Fixture member", start: 0, end: 15 },
    ],
  });
  const openThread = vi.fn(() => true),
    back = vi.fn(() => true);
  const props = {
    session: h.session,
    scope,
    channelId: "general",
    channelName: "General",
    openThread,
    back,
  };
  return {
    ...h,
    selected,
    props,
    mount: () =>
      render(<NewChannelSession {...props} />, { reactStrictMode: true }),
  };
}
const ready = async () => {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled(),
  );
};
const send = async () => {
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
};
it("blank or typed @prose stays local; the separate channel draft survives back/remount", async () => {
  const h = await setup();
  writeView(scope, "draft:general", "ordinary channel draft");
  const view = h.mount();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  view.unmount();
  writeView(scope, channelSessionDraftKey("general"), "@Fixture member help");
  const next = h.mount();
  await send();
  await screen.findByRole("alert");
  expect(h.report.published).toHaveLength(0);
  expect(readChannelSessionDraft(scope, "general")).toBeUndefined();
  expect(readView(scope, "draft:general", "")).toBe("ordinary channel draft");
  next.unmount();
  h.mount();
  expect(
    screen.getByRole("textbox", { name: "Message this session" }),
  ).toHaveTextContent("@Fixture member help");
});
it("requires an explicit known current agent; selected human and removed agent never publish", async () => {
  const h = await setup();
  h.agentHint(false);
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  const view = h.mount();
  await send();
  await screen.findByRole("alert");
  expect(h.report.published).toHaveLength(0);
  view.unmount();
  h.agentHint(true);
  h.revoke();
  h.mount();
  await send();
  await screen.findByRole("alert");
  expect(h.report.published).toHaveLength(0);
});
it("default production props record immutable intent, open only the exact accepted root and clear only the new draft", async () => {
  const h = await setup();
  writeView(scope, "draft:general", "keep me");
  writeView(scope, channelSessionDraftKey("general"), h.selected);

  h.mount();
  await send();
  await waitFor(() => expect(h.props.openThread).toHaveBeenCalledTimes(1));
  const root = h.report.published[0];
  expect(root?.tags).toContainEqual(["buzz-session", "1", "quiet"]);
  expect(root?.tags).toContainEqual(["p", h.member]);
  expect(root?.tags.some((tag) => tag[0] === "e")).toBe(false);
  expect(h.props.openThread).toHaveBeenCalledWith(root?.id);
  expect(h.report.published).toHaveLength(1);
  expect(readChannelSessionDraft(scope, "general")).toBeUndefined();
  expect(readView(scope, "draft:general", "")).toBe("keep me");
});
it("durable record storage rejection prevents any outbox publication and stays visibly recoverable", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  h.mount();
  await ready();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage unavailable");
  });
  await send();
  await screen.findByText("storage unavailable");
  expect(h.report.published).toHaveLength(0);
  expect(h.session.outbox?.snapshot()).toHaveLength(0);
  expect(
    screen.getByRole("textbox", { name: "Message this session" }),
  ).not.toHaveAttribute("aria-disabled", "true");
});
it("restored creation without a retained journal entry stays uncertain and never silently creates a replacement", async () => {
  const h = await setup();
  saveChannelSessionDraft(scope, "general", {
    id: crypto.randomUUID(),
    createdAt: Math.floor(Date.now() / 1000),
    draft: h.selected,
  });
  h.mount();
  await screen.findByText(/Saved intent is uncertain/);
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "Retry same prompt" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Check saved session" }));
  await screen.findByText(/No accepted session was confirmed/);
  expect(h.report.published).toHaveLength(0);
});
it("restored intent without an outbox is unconfirmed, not checking; read-only check and back remain available", async () => {
  const h = await setup();
  const saved = {
    id: crypto.randomUUID(),
    createdAt: Math.floor(Date.now() / 1000),
    draft: h.selected,
  };
  saveChannelSessionDraft(scope, "general", saved);
  const read = vi.spyOn(h.session, "read");
  render(
    <NewChannelSession
      {...h.props}
      session={{ ...h.session, outbox: undefined }}
    />,
    { reactStrictMode: true },
  );
  expect(
    screen.getByText(
      /Saved intent is unconfirmed.*Outbox recovery is unavailable/,
    ),
  ).toBeInTheDocument();
  expect(screen.queryByText("Checking saved intent…")).not.toBeInTheDocument();
  expect(screen.queryByText("Sending session prompt…")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Send message" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("This relay connection supports reading only."),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Retry same prompt" }),
  ).not.toBeInTheDocument();
  const check = screen.getByRole("button", { name: "Check saved session" });
  expect(check).toBeEnabled();
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(check);
  await screen.findByText(/absence is not proof it was never sent/);
  expect(read).toHaveBeenCalledTimes(1);
  expect(check).toBeEnabled();
  expect(readChannelSessionDraft(scope, "general")).toEqual(saved);
  expect(h.props.openThread).not.toHaveBeenCalled();
  expect(h.report.published).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Back to Sessions" }));
  expect(h.props.back).toHaveBeenCalledTimes(1);
});
it("restored accepted intent opens without another send; a missing local journal can recover a verified root by exact draft evidence", async () => {
  const h = await setup();
  const saved = {
    id: crypto.randomUUID(),
    createdAt: Math.floor(Date.now() / 1000),
    draft: h.selected,
  };
  saveChannelSessionDraft(scope, "general", saved);
  const rootId = await h.session.messages.startChannelSession(
    "general",
    saved.draft.text,
    [h.member],
    saved,
  );
  await waitFor(() => expect(h.report.published).toHaveLength(1));
  h.revoke();
  h.regrant();
  await waitFor(async () =>
    expect(await h.session.outbox?.findDraft(saved.id)).toBeUndefined(),
  );
  const view = h.mount();
  await screen.findByText(/Saved intent is uncertain/);
  fireEvent.click(screen.getByRole("button", { name: "Check saved session" }));
  await waitFor(() => expect(h.props.openThread).toHaveBeenCalledWith(rootId));
  expect(h.report.published).toHaveLength(1);
  view.unmount();
  h.mount();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(h.report.published).toHaveLength(1);
});
it("retired UI ownership prevents late completion from reopening while preserving committed intent", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  const gate = h.holdPublication();
  const view = h.mount();
  try {
    await send();
    await gate.started;
    expect(readChannelSessionDraft(scope, "general")).toMatchObject({
      draft: h.selected,
    });
    view.unmount();
  } finally {
    await act(async () => {
      gate.release();
    });
  }
  await waitFor(() => expect(h.report.published).toHaveLength(1));
  expect(h.props.openThread).not.toHaveBeenCalled();
  expect(readChannelSessionDraft(scope, "general")).toBeDefined();
  h.mount();
  await waitFor(() =>
    expect(h.props.openThread).toHaveBeenCalledWith(h.report.published[0]?.id),
  );
  expect(h.report.published).toHaveLength(1);
});
it("unknown delivery remains locked after remount and explicit retry keeps the same signed id", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  h.failPublication(true);
  const view = h.mount();
  await send();
  await screen.findByText("Fixture publication unknown");
  const before = readChannelSessionDraft(scope, "general");
  expect(before?.messageId).toBeDefined();
  view.unmount();
  const next = h.mount();
  await screen.findByText("Fixture publication unknown");
  expect(h.report.published).toHaveLength(0);
  h.failPublication(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry same prompt" }));
  await waitFor(() =>
    expect(h.props.openThread).toHaveBeenCalledWith(before?.messageId),
  );
  expect(h.report.published).toHaveLength(1);
  expect(h.report.published[0]?.id).toBe(before?.messageId);
  next.unmount();
});

it.each(["scope", "session", "channel"] as const)(
  "%s replacement fences pending completion and keeps drafts partitioned",
  async (change) => {
    const h = await setup();
    writeView(scope, channelSessionDraftKey("general"), h.selected);
    const gate = h.holdPublication();
    const view = h.mount();
    try {
      await send();
      await gate.started;
      const next = change === "session" ? (await setup()).session : h.session;
      view.rerender(
        <NewChannelSession
          {...h.props}
          session={next}
          scope={change === "scope" ? "other-scope" : scope}
          channelId={change === "channel" ? "other" : "general"}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
    } finally {
      await act(async () => {
        gate.release();
      });
    }
    await waitFor(() => expect(h.report.published).toHaveLength(1));
    expect(h.props.openThread).not.toHaveBeenCalled();
    expect(readChannelSessionDraft(scope, "general")).toBeDefined();
  },
);
it("corrupt creation storage is visibly blocked, not treated as a blank new draft", async () => {
  const h = await setup();
  localStorage.setItem(
    `buzz-channel-session.v1:${JSON.stringify([scope, "general"])}`,
    "not json",
  );
  h.mount();
  expect(screen.getByRole("alert")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(h.report.published).toHaveLength(0);
});

it("a restored local correlation ID cannot authorize retrying conflicting retained input", async () => {
  const h = await setup();
  const saved = {
    id: crypto.randomUUID(),
    createdAt: Math.floor(Date.now() / 1000),
    draft: h.selected,
  };
  h.failPublication(true);
  const id = await h.session.messages.startChannelSession(
    "general",
    "different prompt",
    [h.member],
    saved,
  );
  await waitFor(() =>
    expect(
      h.session.outbox?.snapshot().find((item) => item.event.id === id)
        ?.delivery,
    ).toBe("unknown"),
  );
  saveChannelSessionDraft(scope, "general", saved);
  h.mount();
  await screen.findByRole("button", { name: "Retry same prompt" });
  h.failPublication(false);
  fireEvent.click(screen.getByRole("button", { name: "Retry same prompt" }));
  await screen.findByText(/Saved draft inputs conflict/);
  expect(h.report.published).toHaveLength(0);
  expect(
    h.session.outbox?.snapshot().find((item) => item.event.id === id)?.delivery,
  ).toBe("unknown");
});
it("accepted root cleanup failure is visible and cannot leave a silently reusable draft", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  const remove = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(() => {
      throw new Error("cleanup unavailable");
    });
  h.mount();
  await send();
  await screen.findByText(/Session accepted, but local draft cleanup failed/);
  expect(h.props.openThread).not.toHaveBeenCalled();
  expect(readChannelSessionDraft(scope, "general")).toBeDefined();
  remove.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Check saved session" }));
  await waitFor(() => expect(h.props.openThread).toHaveBeenCalledTimes(1));
  expect(h.report.published).toHaveLength(1);
});

it("missing Web Locks fails closed and leaves the editor recoverable", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  vi.stubGlobal("navigator", { locks: undefined });
  h.mount();
  await screen.findByText(/requires browser Web Locks/);
  expect(h.report.published).toHaveLength(0);
  expect(readChannelSessionDraft(scope, "general")).toBeUndefined();
});
function holdLock() {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  void navigator.locks.request("test", { mode: "exclusive" }, async () => {
    started();
    await gate;
  });
  return { entered, release };
}
it.each(["unmount", "membership"])(
  "rechecks %s after waiting for the creation lock",
  async (change) => {
    const h = await setup();
    writeView(scope, channelSessionDraftKey("general"), h.selected);
    const view = h.mount();
    await ready();
    const lock = holdLock();
    const before = vi.mocked(navigator.locks.request).mock.calls.length;
    await lock.entered;
    try {
      await send();
      expect(navigator.locks.request).toHaveBeenCalledTimes(before + 1);
      if (change === "unmount") view.unmount();
      else act(() => h.revoke());
    } finally {
      await act(async () => lock.release());
    }
    if (change === "membership")
      await screen.findByText(/Select at least one current channel agent/);
    expect(readChannelSessionDraft(scope, "general")).toBeUndefined();
    expect(h.report.published).toHaveLength(0);
  },
);
it("two mounted contenders claim one intent and only the fresh claimant sends", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  h.mount();
  h.mount();
  await waitFor(() =>
    screen
      .getAllByRole("button", { name: "Send message" })
      .forEach((button) => {
        expect(button).toBeEnabled();
      }),
  );
  const publication = h.holdPublication(),
    lock = holdLock();
  const before = vi.mocked(navigator.locks.request).mock.calls.length;
  await lock.entered;
  try {
    for (const button of screen.getAllByRole("button", {
      name: "Send message",
    }))
      fireEvent.click(button);
    expect(navigator.locks.request).toHaveBeenCalledTimes(before + 2);
    await act(async () => lock.release());
    await publication.started;
    await screen.findByText(/Recover the saved session prompt/);
    expect(h.session.outbox?.snapshot()).toHaveLength(1);
  } finally {
    await act(async () => {
      lock.release();
      publication.release();
    });
  }
  await waitFor(() => expect(h.report.published).toHaveLength(1));
});
it("stale acceptance cannot clear a newer creation record", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  const gate = h.holdPublication();
  h.mount();
  await send();
  await gate.started;
  const next = { id: crypto.randomUUID(), createdAt: 123, draft: h.selected };
  const lock = holdLock();
  await lock.entered;
  try {
    await act(async () => gate.release());
    saveChannelSessionDraft(scope, "general", next);
  } finally {
    await act(async () => lock.release());
  }
  expect(readChannelSessionDraft(scope, "general")).toEqual(next);
  expect(h.props.openThread).not.toHaveBeenCalled();
});

it("first outbox save failure remains explicitly retryable with the exact immutable candidate after remount", async () => {
  let fail = true;
  const h = await setup({
    load: () => [],
    save() {
      if (fail) throw new Error("outbox unavailable");
    },
  });
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  const view = h.mount();
  await send();
  await screen.findByRole("button", { name: "Retry same prompt" });
  const candidate = h.session.outbox?.snapshot()[0]?.event;
  expect(candidate).toBeDefined();
  expect(h.session.outbox?.snapshot()[0]?.delivery).toBe("failed");
  expect(h.report.published).toHaveLength(0);
  view.unmount();
  h.mount();
  await screen.findByRole("button", { name: "Retry same prompt" });
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry same prompt" }));
  await waitFor(() =>
    expect(h.props.openThread).toHaveBeenCalledWith(candidate?.id),
  );
  if (!candidate) throw new Error("Missing retained candidate");
  expect(h.report.published[0]).toMatchObject(candidate);
});

it("message-ID save failure keeps the committed candidate recoverable without a second root", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  const realSet = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (
      key.startsWith("buzz-channel-session.v1:") &&
      JSON.parse(value).messageId
    )
      throw new Error("message ID receipt unavailable");
    realSet.call(this, key, value);
  });
  const gate = h.holdPublication();
  const view = h.mount();
  await send();
  try {
    await gate.started;
    await screen.findByText("message ID receipt unavailable");
    expect(
      readChannelSessionDraft(scope, "general")?.messageId,
    ).toBeUndefined();
    view.unmount();
    h.mount();
    await screen.findByRole("button", { name: "Retry same prompt" });
  } finally {
    await act(async () => gate.release());
  }
  await waitFor(() =>
    expect(h.props.openThread).toHaveBeenCalledWith(h.report.published[0]?.id),
  );
  expect(h.report.published).toHaveLength(1);
});

it("accepted cleanup queued before a stale editor claim cannot create a second root, even after same-text ABA", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  h.mount();
  h.mount();
  const buttons = screen.getAllByRole("button", { name: "Send message" });
  const [winner, stale] = buttons;
  if (!winner || !stale) throw new Error("Missing mounted contenders");
  await waitFor(() =>
    buttons.forEach((button) => {
      expect(button).toBeEnabled();
    }),
  );
  const publication = h.holdPublication();
  fireEvent.click(winner);
  await publication.started;
  await waitFor(() =>
    expect(readChannelSessionDraft(scope, "general")?.messageId).toBeDefined(),
  );
  const lock = holdLock();
  await lock.entered;
  const before = vi.mocked(navigator.locks.request).mock.calls.length;
  try {
    await act(async () => publication.release());
    // The winner's acceptance cleanup is queued first, behind our held lock.
    await waitFor(() =>
      expect(
        vi.mocked(navigator.locks.request).mock.calls.length,
      ).toBeGreaterThan(before),
    );
    const cleanupQueued = vi.mocked(navigator.locks.request).mock.calls.length;
    fireEvent.click(stale);
    expect(vi.mocked(navigator.locks.request).mock.calls.length).toBe(
      cleanupQueued + 1,
    );
  } finally {
    await act(async () => {
      lock.release();
      publication.release();
    });
  }
  // Drain every queued claimant and acceptance callback, not a negative snapshot.
  await act(async () => {
    await navigator.locks.request("barrier", () => {});
  });
  await waitFor(() => expect(h.props.openThread).toHaveBeenCalledTimes(1));
  expect(h.report.published).toHaveLength(1);
  expect(readChannelSessionDraft(scope, "general")).toBeUndefined();
  expect(screen.getByRole("alert")).toHaveTextContent(/editor is stale/);
  // Clearing and retyping identical input does not refresh the mounted generation.
  const editor = screen.getAllByRole("textbox", {
    name: "Message this session",
  })[1];
  if (!editor) throw new Error("Missing stale editor");
  fill(editor, "");
  fill(editor, h.selected.text);
  fireEvent.click(stale);
  await act(async () => {
    await navigator.locks.request("barrier", () => {});
  });
  expect(screen.getByRole("alert")).toHaveTextContent(/editor is stale/);
  expect(h.report.published).toHaveLength(1);
  cleanup();
  // A genuinely new opening is allowed, with a newly chosen recipient/prompt.
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  h.mount();
  await send();
  await waitFor(() => expect(h.props.openThread).toHaveBeenCalledTimes(2));
  expect(h.report.published).toHaveLength(2);
  expect(new Set(h.report.published.map((event) => event.id)).size).toBe(2);
});

it("generation initialization keeps local editing usable but Send disabled until its lock completes", async () => {
  const h = await setup();
  const lock = holdLock();
  await lock.entered;
  try {
    h.mount();
    const editor = screen.getByRole("textbox", {
      name: "Message this session",
    });
    expect(editor).not.toHaveAttribute("aria-disabled", "true");
    fill(editor, "draft while loading");
    expect(editor).toHaveTextContent("draft while loading");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  } finally {
    await act(async () => lock.release());
  }
  await ready();
  expect(h.report.published).toHaveLength(0);
});
it("generation persistence failure stays visible and cannot send", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("generation storage unavailable");
  });
  h.mount();
  await screen.findByText("generation storage unavailable");
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(h.report.published).toHaveLength(0);
});
it("a pending record created during opening is recovered before a generation is allocated", async () => {
  const h = await setup();
  const lock = holdLock();
  await lock.entered;
  try {
    h.mount();
    saveChannelSessionDraft(scope, "general", {
      id: crypto.randomUUID(),
      createdAt: 123,
      draft: h.selected,
    });
  } finally {
    await act(async () => lock.release());
  }
  await screen.findByText(/Saved intent is uncertain/);
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(h.report.published).toHaveLength(0);
});

function fill(element: HTMLElement, text: string) {
  const field = element as ComposerInputElement;
  act(() => field.focus());
  field.value = text;
  field.setSelectionRange(text.length, text.length);
  fireEvent.input(field);
}

it("failed generation invalidation preserves the accepted record until explicit cleanup succeeds", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  h.mount();
  await ready();
  const realSet = Storage.prototype.setItem;
  const fail = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("buzz-channel-session-editor.v1:"))
        throw new Error("generation cleanup unavailable");
      realSet.call(this, key, value);
    });
  await send();
  await screen.findByText(/Session accepted, but local draft cleanup failed/);
  expect(readChannelSessionDraft(scope, "general")).toBeDefined();
  expect(h.report.published).toHaveLength(1);
  fail.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Check saved session" }));
  await waitFor(() => expect(h.props.openThread).toHaveBeenCalledTimes(1));
  expect(readChannelSessionDraft(scope, "general")).toBeUndefined();
  expect(h.report.published).toHaveLength(1);
});

it("an opening cannot bind pre-cleanup editor input to a generation advanced while it waits", async () => {
  const h = await setup();
  writeView(scope, channelSessionDraftKey("general"), h.selected);
  const lock = holdLock();
  await lock.entered;
  try {
    h.mount();
    // Model the earlier lock holder's accepted cleanup, before initialization acquires.
    localStorage.removeItem(
      `buzz-view.v1:${JSON.stringify([scope, channelSessionDraftKey("general")])}`,
    );
    saveChannelSessionEditorGeneration(scope, "general", h.session.viewer, 1);
  } finally {
    await act(async () => lock.release());
  }
  await screen.findByText(/editor is stale/);
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  expect(
    readChannelSessionEditorGeneration(scope, "general", h.session.viewer),
  ).toBe(1);
  expect(h.report.published).toHaveLength(0);
});
