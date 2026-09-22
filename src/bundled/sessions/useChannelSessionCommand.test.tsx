// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { sessionsData } from "../../../tests/fixtures/channel-sessions-data";
import { MessageComposer } from "../../features/messages/MessageComposer";
import { useChannelSessionCommand } from "./useChannelSessionCommand";
import {
  readChannelSessionDraft,
  channelSessionDraftKey,
} from "./channel-session-draft";
import { writeView, readView } from "../../shared/view-state";
import { MentionPicker } from "../mentions/MentionPicker";
import type { ComposerToolProps } from "../../features/conversation/contracts";
import { keypair, signed } from "../../features/relay/testing";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
import type { OutboxStorage } from "../../features/relay/outbox";
const owners: ReturnType<typeof sessionsData>[] = [];
const scope = "command-fixture";
beforeEach(() => {
  localStorage.clear();
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
async function setup(outboxStorage?: OutboxStorage) {
  const identities = [keypair(), keypair(), keypair(), keypair()] as const;
  const viewer = identities[0];
  const h = sessionsData({
    rowCount: 0,
    identities,
    ...(outboxStorage ? { outboxStorage } : {}),
  });
  owners.push(h);
  h.session.channels.ensureList();
  await waitFor(() => expect(h.session.channels.list().status).toBe("ready"));
  await h.session.profiles.ensure([h.member]);
  const raw = {
    text: "/session @Fixture member help",
    recipients: [
      { pubkey: h.member, name: "Fixture member", start: 9, end: 24 },
    ],
  };
  let available = true;
  const open = vi.fn(() => true);
  const tools = [
    {
      id: "mentions",
      key: "test/mentions",
      pluginId: "test",
      revision: "one",
      title: "Mentions",
      component: (props: ComposerToolProps) => (
        <MentionPicker
          session={props.session}
          scope={props.scope}
          channelId={props.channelId}
          disabled={props.disabled}
          select={props.insertMention}
        />
      ),
    },
  ];
  const extensions = {
    inline: { snapshot: () => [], subscribe: () => () => {} },
    tools: { snapshot: () => tools, subscribe: () => () => {} },
  };
  function Host() {
    const command = useChannelSessionCommand({
      session: h.session,
      scope,
      channelId: "general",
      lease: () =>
        available ? { valid: () => available, open, dispose() {} } : undefined,
    });
    return (
      <MessageComposer
        session={h.session}
        scope={scope}
        channelId="general"
        channelName="General"
        extensions={extensions}
        startCommand={command}
      />
    );
  }
  writeView(scope, "draft:general", raw);
  return {
    ...h,
    identities,
    viewerKey: viewer,
    raw,
    open,
    unavailable: () => {
      available = false;
    },
    mount: () => render(<Host />, { reactStrictMode: true }),
  };
}
const send = () =>
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
it("mount never sends; explicit Send commits one chip root with stripped prompt, leaves the quiet draft and opens only after acceptance", async () => {
  const h = await setup();
  writeView(
    scope,
    channelSessionDraftKey("general"),
    "independent blank-page draft",
  );
  const gate = h.holdPublication();
  h.mount();
  await act(async () => {});
  expect(h.report.published).toHaveLength(0);
  send();
  await act(async () => gate.started);
  expect(h.open).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  const root = h.session.outbox?.snapshot()[0]?.event;
  expect(root).toMatchObject({ kind: 9, content: "@Fixture member help" });
  expect(root?.tags).toContainEqual(["buzz-session", "1", "chip"]);
  expect(root?.tags).toContainEqual(["p", h.member]);
  expect(root?.tags).toContainEqual(["h", "general"]);
  expect(root?.tags.some(([name]) => name === "e")).toBe(false);
  await act(async () => gate.release());
  await waitFor(() => expect(h.open).toHaveBeenCalledWith(root?.id));
  expect(readChannelSessionDraft(scope, "general", "command")).toBeUndefined();
  expect(readView(scope, "draft:general", "")).toBe("");
  expect(readView(scope, channelSessionDraftKey("general"), "")).toBe(
    "independent blank-page draft",
  );
  expect(h.report.published).toHaveLength(1);
});
it.each(["unavailable", "typed", "bare", "human", "removed"])(
  "%s command fails visibly, never falls through to ordinary send",
  async (mode) => {
    const h = await setup();
    if (mode === "unavailable") h.unavailable();
    if (mode === "typed") writeView(scope, "draft:general", h.raw.text);
    if (mode === "bare") writeView(scope, "draft:general", "/session");
    if (mode === "human") h.agentHint(false);
    if (mode === "removed") h.revoke();
    h.mount();
    await act(async () => {});
    send();
    await screen.findByRole("alert");
    expect(h.report.published).toHaveLength(0);
    expect(h.open).not.toHaveBeenCalled();
  },
);
it("ordinary non-prefix messages retain their ordinary envelope", async () => {
  const h = await setup();
  writeView(scope, "draft:general", "Use /session later");
  h.mount();
  send();
  await waitFor(() => expect(h.report.published).toHaveLength(1));
  expect(h.report.published[0]?.content).toBe("Use /session later");
  expect(
    h.report.published[0]?.tags.some(([name]) => name === "buzz-session"),
  ).toBe(false);
});
it("late acceptance never clears another window's text or reopens a retired destination", async () => {
  const h = await setup();
  const gate = h.holdPublication();
  h.mount();
  await act(async () => {});
  send();
  await act(async () => gate.started);
  writeView(scope, "draft:general", "newer channel input");
  h.unavailable();
  await act(async () => gate.release());
  await screen.findByRole("button", { name: "Open accepted session" });
  expect(readChannelSessionDraft(scope, "general", "command")).toBeDefined();
  expect(h.open).not.toHaveBeenCalled();
  expect(readView(scope, "draft:general", "")).toBe("newer channel input");
});
it("a failed outbox save retains the immutable candidate and explicit retry uses its ID", async () => {
  let failing = true;
  const h = await setup({
    load: () => [],
    save() {
      if (failing) throw new Error("save unavailable");
    },
  });
  h.mount();
  await act(async () => {});
  send();
  await screen.findByText("save unavailable");
  const before = h.session.outbox?.snapshot()[0];
  expect(before?.delivery).toBe("failed");
  expect(h.report.published).toHaveLength(0);
  failing = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry same prompt" }));
  await waitFor(() => expect(h.open).toHaveBeenCalledWith(before?.event.id));
  expect(h.report.published).toHaveLength(1);
  expect(h.report.published[0]?.id).toBe(before?.event.id);
});
it("two mounted editors cannot create another root after accepted cleanup", async () => {
  const h = await setup();
  const first = h.mount();
  h.mount();
  await act(async () => {});
  const button = screen.getAllByRole("button", { name: "Send message" })[0];
  assert.exists(button);
  fireEvent.click(button);
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
  first.unmount();
  send();
  await screen.findByText(/command editor is stale/);
  expect(h.report.published).toHaveLength(1);
});

it("echo retires the outbox during findDraft; one retained ID view still finishes exactly once without a fresh read", async () => {
  const h = await setup();
  const lookup = deferred();
  const started = deferred();
  assert.exists(h.session.outbox);
  const original = h.session.outbox.findDraft;
  h.session.outbox = {
    ...h.session.outbox,
    async findDraft(id) {
      const result = await original(id);
      started.resolve();
      await lookup.promise;
      return result;
    },
  };
  const observe = vi.spyOn(h.session, "observe");
  const read = vi.spyOn(h.session, "read");
  const gate = h.holdPublication();
  h.mount();
  await act(async () => {});
  send();
  try {
    await act(async () => gate.started);
    await act(async () => started.promise);
    await act(async () => gate.release());
    await waitFor(() => expect(h.session.outbox?.snapshot()).toHaveLength(0));
    expect(h.open).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      lookup.resolve();
      gate.release();
    });
  }
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
  expect(read).not.toHaveBeenCalled();
  expect(observe).toHaveBeenCalledTimes(1);
  expect(h.report.published).toHaveLength(1);
});
it("a returned receipt reconnects after an empty initial lookup without another outbox notification", async () => {
  const h = await setup();
  const lookup = deferred();
  const lookupStarted = deferred();
  const receipt = deferred();
  assert.exists(h.session.outbox);
  h.session.outbox = {
    ...h.session.outbox,
    subscribe: () => () => {},
    async findDraft() {
      lookupStarted.resolve();
      await lookup.promise;
      return undefined;
    },
  };
  const start = h.session.messages.startChannelSession;
  h.session.messages = {
    ...h.session.messages,
    async startChannelSession(...args) {
      const id = await start(...args);
      await receipt.promise;
      return id;
    },
  };
  const observe = vi.spyOn(h.session, "observe");
  const read = vi.spyOn(h.session, "read");
  h.mount();
  await act(async () => {});
  send();
  try {
    await act(async () => lookupStarted.promise);
    await act(async () => lookup.resolve());
    await waitFor(() => {
      expect(h.report.published).toHaveLength(1);
      expect(h.session.outbox?.snapshot()).toHaveLength(0);
    });
    expect(observe).not.toHaveBeenCalled();
    expect(h.open).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      lookup.resolve();
      receipt.resolve();
    });
  }
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
  expect(h.open).toHaveBeenCalledWith(h.report.published[0]?.id);
  expect(readChannelSessionDraft(scope, "general", "command")).toBeUndefined();
  expect(readView(scope, "draft:general", "")).toBe("");
  expect(observe).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
  expect(h.report.published).toHaveLength(1);
});
it("the subscribed pending ID view observes a later echo, and disposal rejects late results", async () => {
  const h = await setup();
  const gate = h.holdPublication();
  const mounted = h.mount();
  const lookup = deferred();
  assert.exists(h.session.outbox);
  const original = h.session.outbox.findDraft;
  h.session.outbox = {
    ...h.session.outbox,
    async findDraft(id) {
      await lookup.promise;
      return original(id);
    },
  };
  const observe = vi.spyOn(h.session, "observe");
  await act(async () => {});
  send();
  try {
    await act(async () => gate.started);
    await waitFor(() =>
      expect(
        readChannelSessionDraft(scope, "general", "command")?.messageId,
      ).toBeDefined(),
    );
    await act(async () => lookup.resolve());
    await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    mounted.unmount();
  } finally {
    await act(async () => {
      lookup.resolve();
      gate.release();
    });
  }
  expect(h.open).not.toHaveBeenCalled();
  expect(readChannelSessionDraft(scope, "general", "command")).toBeDefined();
  h.mount();
  await screen.findByRole("button", { name: "Finish accepted session" });
  expect(h.open).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Finish accepted session" }),
  );
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
  expect(readView(scope, "draft:general", "")).toBe("");
  expect(h.report.published).toHaveLength(1);
});
it("failed compare-and-clear retains accepted correlation across reload, preserves newer ordinary text, and never republishes", async () => {
  const h = await setup();
  const gate = h.holdPublication();
  const mounted = h.mount();
  await act(async () => {});
  send();
  await act(async () => gate.started);
  writeView(scope, "draft:general", "newer ordinary text");
  await act(async () => gate.release());
  await screen.findByText(/Session accepted, but local draft cleanup failed/);
  const saved = readChannelSessionDraft(scope, "general", "command");
  expect(saved?.accepted).toBe(true);
  expect(h.open).not.toHaveBeenCalled();
  mounted.unmount();
  const reloaded = h.mount();
  await screen.findByRole("button", { name: "Finish accepted session" });
  expect(screen.getByRole("textbox")).toHaveTextContent("newer ordinary text");
  expect(
    screen.getByRole("button", { name: "Send message" }),
  ).not.toBeDisabled();
  fireEvent.click(
    screen.getByRole("button", { name: "Finish accepted session" }),
  );
  await screen.findByText(/Session accepted, but local draft cleanup failed/);
  expect(readView(scope, "draft:general", "")).toBe("newer ordinary text");
  fireEvent.click(
    screen.getByRole("button", { name: "Open accepted session" }),
  );
  expect(h.open).toHaveBeenCalledWith(saved?.messageId);
  expect(readChannelSessionDraft(scope, "general", "command")?.id).toBe(
    saved?.id,
  );
  reloaded.unmount();
  writeView(scope, "draft:general", h.raw);
  h.mount();
  await act(async () => {});
  fireEvent.click(
    screen.getByRole("button", { name: "Finish accepted session" }),
  );
  await waitFor(() =>
    expect(
      readChannelSessionDraft(scope, "general", "command"),
    ).toBeUndefined(),
  );
  expect(h.report.published).toHaveLength(1);
});
it("storage clear throwing is visible and recoverable with the same accepted root", async () => {
  const h = await setup();
  const gate = h.holdPublication();
  h.mount();
  await act(async () => {});
  send();
  await act(async () => gate.started);
  const remove = Storage.prototype.removeItem;
  const failure = vi
    .spyOn(Storage.prototype, "removeItem")
    .mockImplementation(function (this: Storage, key) {
      if (key.includes("buzz-view.v1")) throw new Error("storage unavailable");
      return remove.call(this, key);
    });
  await act(async () => gate.release());
  await screen.findByText(
    /Session accepted, but local draft cleanup failed: storage unavailable/,
  );
  expect(readChannelSessionDraft(scope, "general", "command")?.accepted).toBe(
    true,
  );
  expect(h.open).not.toHaveBeenCalled();
  failure.mockRestore();
  fireEvent.click(
    screen.getByRole("button", { name: "Finish accepted session" }),
  );
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
  expect(h.report.published).toHaveLength(1);
});
it("a passive second window sees the echo first without clearing the publisher's shared intent", async () => {
  const h = await setup();
  const gate = h.holdPublication();
  h.mount();
  await act(async () => {});
  send();
  await act(async () => gate.started);
  const observer = sessionsData({ rowCount: 0, identities: h.identities });
  owners.push(observer);
  function Passive() {
    const command = useChannelSessionCommand({
      session: observer.session,
      scope,
      channelId: "general",
      lease: () => undefined,
    });
    return <>{command.notice}</>;
  }
  render(<Passive />, { reactStrictMode: true });
  await act(async () => {});
  const retained = h.session.outbox?.snapshot()[0];
  assert.exists(retained);
  await act(async () => observer.ingest([signed(h.viewerKey, retained.event)]));
  await screen.findByRole("button", { name: "Open accepted session" });
  expect(readChannelSessionDraft(scope, "general", "command")?.messageId).toBe(
    retained.event.id,
  );
  expect(readView(scope, "draft:general", "")).toEqual(h.raw);
  expect(h.open).not.toHaveBeenCalled();
  await act(async () => gate.release());
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
  expect(readChannelSessionDraft(scope, "general", "command")).toBeUndefined();
  expect(h.report.published).toHaveLength(1);
  expect(observer.report.published).toHaveLength(0);
});
it("the same current editor can create a second command after owner-confirmed cleanup", async () => {
  const h = await setup();
  h.mount();
  await act(async () => {});
  send();
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
  const input = screen.getByRole("textbox");
  expect(input).toHaveProperty("value", "");
  act(() => input.focus());
  (input as HTMLTextAreaElement).value = "/session ";
  (input as HTMLTextAreaElement).setSelectionRange(9, 9);
  fireEvent.input(input);
  fireEvent.click(screen.getByRole("button", { name: "Mention a member" }));
  fireEvent.click(
    await screen.findByRole("button", { name: `Fixture member ${h.member}` }),
  );
  send();
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(2));
  expect(h.report.published).toHaveLength(2);
  expect(h.report.published[0]?.id).not.toBe(h.report.published[1]?.id);
});

it.each([false, true])(
  "a late receipt preserves prior accepted cleanup (changed editor=%s)",
  async (changed) => {
    const h = await setup();
    const receipt = deferred();
    const start = h.session.messages.startChannelSession;
    h.session.messages = {
      ...h.session.messages,
      async startChannelSession(...args) {
        const id = await start(...args);
        await receipt.promise;
        return id;
      },
    };
    const gate = h.holdPublication();
    h.mount();
    await act(async () => {});
    send();
    try {
      await act(async () => gate.started);
      if (changed) writeView(scope, "draft:general", "newer ordinary text");
      await act(async () => gate.release());
      if (changed) {
        await screen.findByText(
          /Session accepted, but local draft cleanup failed/,
        );
        expect(
          readChannelSessionDraft(scope, "general", "command")?.accepted,
        ).toBe(true);
      } else await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
    } finally {
      await act(async () => {
        gate.release();
        receipt.resolve();
      });
    }
    if (changed) {
      expect(
        readChannelSessionDraft(scope, "general", "command")?.accepted,
      ).toBe(true);
      expect(readView(scope, "draft:general", "")).toBe("newer ordinary text");
      expect(h.open).not.toHaveBeenCalled();
    } else {
      expect(
        readChannelSessionDraft(scope, "general", "command"),
      ).toBeUndefined();
      expect(h.open).toHaveBeenCalledTimes(1);
    }
    expect(h.report.published).toHaveLength(1);
  },
);
it("two editors queued behind the command lock claim only one root", async () => {
  const h = await setup();
  h.mount();
  h.mount();
  await act(async () => {});
  const held = deferred();
  const started = deferred();
  const lock = navigator.locks.request.bind(navigator.locks);
  vi.mocked(navigator.locks.request).mockImplementationOnce(
    (name, options, work) =>
      lock(name, options, async (lease) => {
        started.resolve();
        await held.promise;
        assert.exists(work);
        return work(lease);
      }),
  );
  const publication = h.holdPublication();
  const buttons = screen.getAllByRole("button", { name: "Send message" });
  const [first, second] = buttons;
  assert.exists(first);
  assert.exists(second);
  fireEvent.click(first);
  try {
    await act(async () => started.promise);
    fireEvent.click(second);
    expect(h.report.published).toHaveLength(0);
    await act(async () => held.resolve());
    await screen.findByText(/Recover the saved command/);
    await act(async () => publication.started);
  } finally {
    await act(async () => {
      held.resolve();
      publication.release();
    });
  }
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));
  expect(h.report.published).toHaveLength(1);
});
