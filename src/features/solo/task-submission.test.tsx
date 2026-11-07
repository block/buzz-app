// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, assert, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import type { OutboxStorage, OutgoingEvent } from "../relay/outbox";
import { keypair, metadata, roster, signed } from "../relay/testing";
import { composerDOMFixture } from "../messages/composer-testing";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { createSoloRegionFixture } from "../channel-navigation/solo-navigation-testing";
import * as soloNavigation from "../channel-navigation/solo-navigation";
import { attachmentDraft } from "../messages/attachment-draft";
import { readView, writeView } from "../../shared/view-state";
import { SoloDraft } from "./SoloDraft";
import { SOLO_LABEL } from "./labels";

vi.mock(
  "../messages/solo-model-picks-storage",
  () => import("../messages/solo-model-picks-storage-testing"),
);
composerDOMFixture();
stubAvatarBrowserApis();
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const channelId = "22222222-2222-4222-8222-222222222222";
const draftId = "33333333-3333-4333-8333-333333333333";
const scope = "task-restart";
const draftKey = `solo:task:${draftId}:new-draft`;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(multiple = false) {
  const viewer = keypair(),
    agent = keypair(),
    peer = keypair(),
    authority = keypair();
  const participants = multiple ? [agent.pubkey, peer.pubkey] : [agent.pubkey];
  const region = createSoloRegionFixture(viewer.pubkey);
  let records: readonly OutgoingEvent[] = [];
  let serial = Promise.resolve();
  let created = false,
    claimed = false,
    eligible = true,
    rejectSave = false,
    rejectCleanup: "create" | "first" | undefined;
  let firstId: string | undefined;
  let beforePublish = async () => {};
  let creator = viewer.pubkey;
  let channelRegion: string | undefined;
  const signedEvents: number[] = [];
  const publications: string[] = [];
  const storage: OutboxStorage = {
    load: () => structuredClone(records),
    save: (next, options) => {
      if (
        rejectSave ||
        (rejectCleanup &&
          next.some(
            (row) =>
              row.event.kind === (rejectCleanup === "create" ? 9007 : 9) &&
              !row.recovery,
          ))
      )
        throw new Error("Disk full");
      const skip = new Set(options?.skip);
      records = structuredClone([
        ...next.filter((item) => !skip.has(item.event.id)),
        ...records.filter((item) => skip.has(item.event.id)),
      ]);
    },
    lock: async (_key, run) => {
      const previous = serial;
      const released = gate();
      serial = previous.then(() => released.promise);
      await previous;
      try {
        return await run();
      } finally {
        released.resolve();
      }
    },
  };
  const mark = vi.fn(async () => {
    const response = claimed ? ("resume" as const) : ("start" as const);
    claimed = true;
    return response;
  });
  const prepare = vi.fn(
    async (draft: { revision: number; recipients: readonly string[] }) =>
      claimed
        ? firstId
          ? { ok: false as const, reason: "already_sent", channelId }
          : { ok: false as const, reason: "Claim is not complete" }
        : {
            ok: true as const,
            channelId,
            revision: draft.revision,
            preparationId: "prepared",
            members: [viewer.pubkey, ...draft.recipients],
          },
  );
  const record = vi.fn(async (input: { eventId: string }) => {
    if (firstId && firstId !== input.eventId)
      throw new Error("First event changed");
    firstId = input.eventId;
  });
  const source = await region.register({
    task: {
      prepare,
      markChannelStarted: mark,
      recordFirstEvent: record,
      participants: {
        eligible: (key) => eligible && participants.includes(key),
        maxRecipients: multiple ? 2 : 1,
        defaultRecipient: () => agent.pubkey,
        makePrimary: async () => {},
      },
    },
  });
  vi.spyOn(soloNavigation, "soloNavigationFor").mockReturnValue(region.service);
  const owners: ReturnType<typeof createRelaySession>[] = [];
  async function owner() {
    let beforeQuery = async () => {};
    const native = {
      status: "ready" as const,
      agents: participants.map((pubkey, index) => ({
        pubkey,
        name: index ? "Other agent" : "Task agent",
        owner: viewer.pubkey,
        relayUrl: "https://relay.example.org",
      })),
    };
    const value = createRelaySession(
      {
        viewer: viewer.pubkey,
        scope: "https://relay.example.org",
        relayAuthor: authority.pubkey,
        archiveAuthority: authority.pubkey,
        channelIdentity: true,
        media: () => undefined,
        uploadAttachment: async () => {
          throw new Error("Unexpected upload");
        },
        query: async (filters) => {
          await beforeQuery();
          return !created
            ? []
            : [
                roster(authority, channelId, [viewer.pubkey, ...participants]),
                metadata(authority, channelId, "Task", undefined, [
                  ["t", "stream"],
                  ["private"],
                  ["t", SOLO_LABEL],
                  ["t", channelRegion ?? source.handle.label],
                  ["t", "solo-task-mode:v1"],
                  ["P", creator],
                ]),
              ].filter((event) =>
                filters.some((filter) => filter.kinds?.includes(event.kind)),
              );
        },
        writer: {
          kinds: [9, 9007],
          sign: async (template) => {
            signedEvents.push(template.kind);
            return signed(viewer, template);
          },
          publish: async (event) => {
            await beforePublish();
            publications.push(event.id);
            if (event.kind === 9007) created = true;
          },
        },
      },
      {
        outboxStorage: storage,
        agentChoices: {
          snapshot: () => native,
          subscribe: () => () => {},
          refresh: async () => {},
        },
      },
    );
    owners.push(value);
    assert.exists(value.session.outbox);
    await value.session.outbox.ready();
    value.session.channels.ensureList();
    await waitFor(() =>
      expect(value.session.channels.list().status).toBe("ready"),
    );
    await value.session.agentChoices.refresh("templates", { fresh: true });
    return {
      ...value,
      beforeQuery: (run: () => Promise<void>) => {
        beforeQuery = run;
      },
    };
  }
  function draft(text: string) {
    return {
      text: `@Task agent ${text}`,
      recipients: [
        { pubkey: agent.pubkey, name: "Task agent", start: 0, end: 11 },
      ],
    };
  }
  function mount(
    value: Awaited<ReturnType<typeof owner>>,
    started = vi.fn(),
    viewScope = scope,
  ) {
    return {
      ...render(
        <SoloDraft
          session={value.session}
          scope={viewScope}
          task={{ region: source.handle.label, draftId }}
          onStarted={started}
        />,
      ),
      started,
    };
  }
  return {
    participants,
    owner,
    mount,
    draft,
    mark,
    prepare,
    record,
    source,
    region,
    storage,
    rows: () => records,
    publications,
    signedEvents,
    setRegion: (value: string) => {
      channelRegion = value;
    },
    setCreator: (value: string) => {
      creator = value;
    },
    holdPublish: (run: () => Promise<void>) => {
      beforePublish = run;
    },
    setClaimed: (value: boolean) => {
      claimed = value;
    },
    setEligible: (value: boolean) => {
      act(() => {
        eligible = value;
        source.update({
          status: "ready",
          binding: source.binding(),
          revision: value ? 3 : 2,
        });
      });
    },
    failSave: (value: boolean) => {
      rejectSave = value;
    },
    failCleanup: (value: "create" | "first" | undefined) => {
      rejectCleanup = value;
    },
    dispose: async () => {
      for (const value of owners) value.dispose();
      await region.dispose();
    },
  };
}

it("sends a fresh multi-participant task only to its primary and clears its draft and files", async () => {
  const f = await fixture(true);
  try {
    const owner = await f.owner();
    const [primary, peer] = f.participants;
    assert.exists(primary);
    assert.exists(peer);
    const draft = {
      text: "@Task agent @Other agent Review the attachment",
      recipients: [
        { pubkey: primary, name: "Task agent", start: 0, end: 11 },
        { pubkey: peer, name: "Other agent", start: 12, end: 24 },
      ],
    };
    writeView(scope, draftKey, draft);
    const files = attachmentDraft(
      owner.session,
      `${scope}:${draftKey}`,
      draftId,
    );
    const upload = {
      name: "notes.txt",
      type: "text/plain",
      size: 5,
      sha256: "a".repeat(64),
      url: `https://relay.example.org/media/${"a".repeat(64)}.txt`,
    };
    files.addUploaded(upload);
    const view = f.mount(owner);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(view.started).toHaveBeenCalledExactlyOnceWith(channelId),
    );
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.prepare.mock.calls[0]?.[0].recipients).toEqual(f.participants);
    expect(f.mark).toHaveBeenCalledOnce();
    expect(f.publications).toHaveLength(2);
    const creates = f.rows().filter((row) => row.event.kind === 9007);
    expect(creates).toHaveLength(1);
    expect(creates[0]?.signed?.tags.filter(([key]) => key === "p")).toEqual([
      ["p", owner.session.viewer],
      ...f.participants.map((pubkey) => ["p", pubkey]),
    ]);
    expect(f.publications).toContain(creates[0]?.signed?.id);
    const first = f.rows().filter((row) => row.event.kind === 9);
    expect(first).toHaveLength(1);
    expect(first[0]?.delivery).toBe("accepted");
    expect(first[0]?.event.tags.filter(([key]) => key === "p")).toEqual([
      ["p", f.participants[0]],
    ]);
    expect(first[0]?.event.content).toBe(
      `${draft.text}\n\n[notes.txt](<${upload.url}>)`,
    );
    expect(readView(scope, draftKey, null)).toBe("");
    expect(readView(scope, `draft:${channelId}`, null)).toBeNull();
    expect(files.snapshot()).toHaveLength(0);
    expect(
      attachmentDraft(
        owner.session,
        `${scope}:draft:${channelId}`,
        channelId,
      ).snapshot(),
    ).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

it.each(["before", "after"] as const)(
  "resumes the staged identity after exit %s the source claim commits",
  async (boundary) => {
    const f = await fixture();
    const held = gate(),
      entered = gate();
    const responses: string[] = [];
    const originalMark = f.mark.getMockImplementation();
    assert.exists(originalMark);
    f.mark
      .mockImplementationOnce(async () => {
        expect(f.rows().map((row) => row.event.kind)).toEqual([9007, 9]);
        expect(f.rows().every((row) => !row.signed)).toBe(true);
        entered.resolve();
        if (boundary === "after") f.setClaimed(true);
        await held.promise;
        return "start";
      })
      .mockImplementation(async () => {
        const response = await originalMark();
        responses.push(response);
        return response;
      });
    let view: ReturnType<typeof f.mount> | undefined;
    try {
      const a = await f.owner();
      writeView(scope, draftKey, f.draft("Original request"));
      view = f.mount(a);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(f.mark).toHaveBeenCalledOnce());
      await entered.promise;
      const saved = structuredClone(f.rows());
      expect(f.publications).toEqual([]);
      view.unmount();
      a.dispose();
      held.resolve();
      assert.exists(f.storage.lock);
      await f.storage.lock("barrier", async () => {});
      f.region.reconnect();
      const b = await f.owner();
      writeView(scope, draftKey, f.draft("Edited after restart"));
      view = f.mount(b);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(view?.started).toHaveBeenCalledWith(channelId),
      );
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(responses).toEqual([boundary === "after" ? "resume" : "start"]);
      expect(f.publications).toEqual(saved.map((row) => row.event.id));
      expect(
        f.record.mock.calls.every(
          ([input]) => input.eventId === saved[1]?.event.id,
        ),
      ).toBe(true);
      expect(readView(scope, `draft:${channelId}`, null)).toMatchObject({
        text: "@Task agent Edited after restart",
      });
      expect(f.rows().every((row) => !row.recovery)).toBe(true);
    } finally {
      held.resolve();
      view?.unmount();
      await f.dispose();
    }
  },
);

it("keeps failed staging editable and retries without consuming a source claim", async () => {
  const f = await fixture();
  try {
    const a = await f.owner();
    writeView(scope, draftKey, f.draft("Keep this request"));
    const view = f.mount(a);
    f.failSave(true);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
    expect(f.mark).not.toHaveBeenCalled();
    expect(f.rows()).toEqual([]);
    expect(f.publications).toEqual([]);
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this request");
    f.failSave(false);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(view.started).toHaveBeenCalledWith(channelId));
    expect(f.mark).toHaveBeenCalledOnce();
    expect(new Set(f.publications).size).toBe(2);
  } finally {
    await f.dispose();
  }
});

it.each(["create", "first"] as const)(
  "keeps accepted first delivery recoverable through failed %s cleanup",
  async (boundary) => {
    const f = await fixture();
    let view: ReturnType<typeof f.mount> | undefined;
    try {
      const a = await f.owner();
      writeView(scope, draftKey, f.draft("Finish this request"));
      f.failCleanup(boundary);
      view = f.mount(a);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
      const delivered = [...f.publications];
      expect(delivered).toHaveLength(2);
      expect(f.rows().map((row) => row.delivery)).toEqual([
        "accepted",
        "accepted",
      ]);
      expect(f.rows().map((row) => !!row.recovery)).toEqual([
        boundary === "create",
        true,
      ]);
      view.unmount();
      a.dispose();
      assert.exists(f.storage.lock);
      await f.storage.lock("barrier", async () => {});
      f.failCleanup(undefined);
      const b = await f.owner();
      expect(f.rows().map((row) => row.delivery)).toEqual([
        "accepted",
        "accepted",
      ]);
      view = f.mount(b);
      expect(f.rows().map((row) => row.delivery)).toEqual([
        "accepted",
        "accepted",
      ]);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(view?.started).toHaveBeenCalledWith(channelId),
      );
      expect(f.publications).toEqual(delivered);
      expect(f.rows().every((row) => !row.recovery)).toBe(true);
    } finally {
      view?.unmount();
      await f.dispose();
    }
  },
);

it("refuses live eligibility revoked while the staged claim is pending", async () => {
  const f = await fixture();
  const held = gate(),
    entered = gate();
  f.mark.mockImplementation(async () => {
    f.setClaimed(true);
    entered.resolve();
    await held.promise;
    return "start";
  });
  try {
    const a = await f.owner();
    writeView(scope, draftKey, f.draft("Keep this request"));
    const view = f.mount(a);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(f.mark).toHaveBeenCalledOnce());
    await entered.promise;
    f.setEligible(false);
    held.resolve();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /cancelled|eligible/,
    );
    expect(f.publications).toEqual([]);
    expect(f.signedEvents).toEqual([]);
    expect(f.rows()).toHaveLength(2);
    expect(view.started).not.toHaveBeenCalled();
    f.setEligible(true);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(view.started).toHaveBeenCalledWith(channelId));
  } finally {
    held.resolve();
    await f.dispose();
  }
});

it.each(["matching", "edited"] as const)(
  "hands off a %s draft after a shared submission completes",
  async (draft) => {
    const f = await fixture();
    const held = gate(),
      entered = gate();
    f.holdPublish(async () => {
      entered.resolve();
      await held.promise;
    });
    const a = await f.owner(),
      b = await f.owner();
    writeView("window-a", draftKey, f.draft("First request"));
    const otherText = draft === "matching" ? "First request" : "Other request";
    writeView("window-b", draftKey, f.draft(otherText));
    const files = attachmentDraft(b.session, `window-b:${draftKey}`, draftId);
    const upload = {
      name: "notes.txt",
      type: "text/plain",
      size: 5,
      sha256: "a".repeat(64),
      url: `https://relay.example.org/media/${"a".repeat(64)}.txt`,
    };
    files.addUploaded(upload);
    attachmentDraft(a.session, `window-a:${draftKey}`, draftId).addUploaded(
      upload,
    );
    const first = f.mount(a, vi.fn(), "window-a");
    const second = f.mount(b, vi.fn(), "window-b");
    try {
      await userEvent
        .setup()
        .click(
          within(first.container).getByRole("button", { name: "Send message" }),
        );
      await entered.promise;
      await userEvent.setup().click(
        within(second.container).getByRole("button", {
          name: "Send message",
        }),
      );
      expect(second.started).not.toHaveBeenCalled();
      held.resolve();
      await waitFor(() =>
        expect(first.started).toHaveBeenCalledWith(channelId),
      );
      await waitFor(() =>
        expect(second.started).toHaveBeenCalledWith(channelId),
      );
      expect(f.publications).toHaveLength(2);
      expect(f.mark).toHaveBeenCalledOnce();
      expect(readView("window-b", draftKey, null)).toBe("");
      expect(readView("window-b", `draft:${channelId}`, null)).toMatchObject({
        text: `@Task agent ${otherText}`,
      });
      expect(readView("window-a", draftKey, null)).toBe("");
      expect(files.snapshot()).toHaveLength(0);
      expect(
        attachmentDraft(b.session, `window-b:draft:${channelId}`, channelId)
          .snapshot()
          .map((item) => item.uploaded),
      ).toEqual([upload]);
    } finally {
      held.resolve();
      first.unmount();
      second.unmount();
      await f.dispose();
    }
  },
);

it("refuses a corrupt saved pair before another source claim", async () => {
  const f = await fixture();
  const held = gate(),
    entered = gate();
  f.mark.mockImplementationOnce(async () => {
    entered.resolve();
    await held.promise;
    return "start";
  });
  let view: ReturnType<typeof f.mount> | undefined;
  try {
    const a = await f.owner();
    writeView(scope, draftKey, f.draft("Keep this request"));
    view = f.mount(a);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    await entered.promise;
    view.unmount();
    a.dispose();
    held.resolve();
    assert.exists(f.storage.lock);
    await f.storage.lock("barrier", async () => {});
    await f.storage.save(
      f.rows().map((row) =>
        row.event.kind === 9007
          ? {
              ...row,
              recovery: {
                key: `create:solo-task:${draftId}`,
                value: "another submission",
              },
            }
          : row,
      ),
    );
    const b = await f.owner();
    view = f.mount(b);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The saved task pair does not match",
    );
    expect(f.mark).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.publications).toEqual([]);
    expect(f.signedEvents).toEqual([]);
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this request");
  } finally {
    held.resolve();
    view?.unmount();
    await f.dispose();
  }
});

it.each([
  "owner",
  "binding",
  "region",
  "participant",
  "target draft",
  "target revision",
] as const)(
  "keeps a completed task draft when its %s changes during handoff",
  async (change) => {
    const f = await fixture();
    const a = await f.owner(),
      b = await f.owner();
    writeView("first", draftKey, f.draft("First request"));
    const first = f.mount(a, vi.fn(), "first");
    const entered = gate(),
      held = gate();
    let second: ReturnType<typeof f.mount> | undefined;
    try {
      await userEvent
        .setup()
        .click(
          within(first.container).getByRole("button", { name: "Send message" }),
        );
      await waitFor(() =>
        expect(first.started).toHaveBeenCalledWith(channelId),
      );
      first.unmount();
      expect(f.rows().every((row) => !row.recovery)).toBe(true);
      writeView("second", draftKey, f.draft("Later edit"));
      second = f.mount(b, vi.fn(), "second");
      b.beforeQuery(async () => {
        entered.resolve();
        await held.promise;
      });
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Send message" }));
      await entered.promise;
      if (change === "owner") f.setCreator("b".repeat(64));
      if (change === "binding") f.region.reconnect();
      if (change === "region") f.setRegion("buzz.region:other:work");
      if (change === "participant") f.setEligible(false);
      if (change === "target draft")
        writeView("second", `draft:${channelId}`, {
          text: "New target edit",
          recipients: [],
        });
      if (change === "target revision") {
        writeView("second", `draft:${channelId}`, "Temporary edit");
        writeView("second", `draft:${channelId}`, "");
      }
      held.resolve();
      expect(await screen.findByRole("alert")).toHaveTextContent(
        change === "owner" || change === "region"
          ? "unavailable"
          : change === "binding"
            ? /abort/i
            : change === "participant"
              ? "participant"
              : change === "target revision"
                ? "The task draft changed"
                : "already has a draft",
      );
      expect(second.started).not.toHaveBeenCalled();
      expect(readView("second", draftKey, null)).toMatchObject({
        text: "@Task agent Later edit",
      });
      expect(f.mark).toHaveBeenCalledOnce();
      expect(f.publications).toHaveLength(2);
      expect(f.rows().every((row) => !row.recovery)).toBe(true);
      if (change === "target draft")
        expect(readView("second", `draft:${channelId}`, null)).toEqual({
          text: "New target edit",
          recipients: [],
        });
    } finally {
      held.resolve();
      first.unmount();
      second?.unmount();
      await f.dispose();
    }
  },
);

it("keeps an incomplete claim in its draft without a saved pair", async () => {
  const f = await fixture(),
    a = await f.owner();
  f.setClaimed(true);
  writeView(scope, draftKey, f.draft("Keep this request"));
  const view = f.mount(a);
  try {
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Claim is not complete",
    );
    expect(view.started).not.toHaveBeenCalled();
    expect(f.mark).not.toHaveBeenCalled();
    expect(f.rows()).toEqual([]);
    expect(f.publications).toEqual([]);
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this request");
  } finally {
    view.unmount();
    await f.dispose();
  }
});
