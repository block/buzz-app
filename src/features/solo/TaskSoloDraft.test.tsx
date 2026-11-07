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
import { MAX_PENDING, type Outbox, type OutgoingEvent } from "../relay/outbox";
import { createMessages } from "../relay/messages";
import { createChannelWrites } from "../relay/channel-writes";
import type { UploadedAttachment } from "../relay/attachments";
import { keypair, signed } from "../relay/testing";
import { profileTarget } from "../profiles/target";
import { AgentsContext } from "../agents/react";
import type { Agents } from "../agents/service";
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { MentionPicker } from "../../bundled/mentions/MentionPicker";
import type {
  ComposerToolProps,
  ConversationExtensions,
} from "../conversation/contracts";
import type { AgentChoicesSnapshot } from "../agents/choices";
import { stubAvatarBrowserApis } from "../agents/avatar-testing";
import { createSoloRegionFixture } from "../channel-navigation/solo-navigation-testing";
import type { SoloTaskMode } from "../channel-navigation/solo-navigation-contract";
import { composerDOMFixture } from "../messages/composer-testing";
import type { MentionDraft } from "../messages/mention-draft";
import { readView, writeView } from "../../shared/view-state";
import { TaskSoloDraft } from "./TaskSoloDraft";

vi.mock(
  "../messages/solo-model-picks-storage",
  () => import("../messages/solo-model-picks-storage-testing"),
);

composerDOMFixture();
stubAvatarBrowserApis();
const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposals.splice(0)) await dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const agent = "b".repeat(64);
const draftId = "33333333-3333-4333-8333-333333333333";
const channelId = "22222222-2222-4222-8222-222222222222";
const empty: readonly never[] = [];
const tools = [
  {
    id: "picker",
    order: -10,
    key: "mentions/picker",
    pluginId: "mentions",
    revision: "1",
    title: "Mentions",
    component: (props: ComposerToolProps) => (
      <MentionPicker {...props} select={props.insertMention} />
    ),
  },
];
const extensions = {
  inline: { snapshot: () => empty, subscribe: () => () => {} },
  tools: { snapshot: () => tools, subscribe: () => () => {} },
} as unknown as ConversationExtensions;

function gate() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture(
  models?: Agents,
  initialDraft?: MentionDraft,
  upload?: (file: File) => Promise<UploadedAttachment>,
) {
  const viewer = keypair();
  const region = createSoloRegionFixture(viewer.pubkey);
  disposals.push(region.dispose);
  const rows = [{ pubkey: agent, name: "Task agent", managed: false }];
  const original = region.session.agentChoices.snapshot();
  let choices: AgentChoicesSnapshot = {
    ...original,
    status: "ready",
    complete: true,
    pending: false,
    identities: rows,
    selectable: rows,
    archives: { status: "ready", archived: [] },
  };
  const listeners = new Set<() => void>();
  const profiles = new Map([[agent, { name: "Task agent" }]]);
  const ready = gate(),
    sent = gate();
  const outboxReady = vi.fn(() => ready.promise);
  let operations: readonly OutgoingEvent[] = [];
  const whenPrepared = vi.fn(async (id: string) => {
    await sent.promise;
    const item = operations.find((row) => row.event.id === id);
    if (!item) throw new Error("Missing staged message");
    return signed(viewer, item.event);
  });
  const resumeStart = vi.fn((create: string) => ({
    create,
    ready: Promise.resolve(),
  }));
  const stageChat = vi.fn<Outbox["stageChat"]>(
    async (create, message, recovery) => {
      operations = [create, message].map((input, index) => ({
        event: {
          ...input,
          id: (index ? "d" : "c").repeat(64),
          pubkey: region.session.viewer,
          created_at: 1,
        },
        recovery: index
          ? recovery
          : { key: `create:${recovery.key}`, value: recovery.value },
        delivery: "unknown",
        guarded: true,
      }));
    },
  );
  const outbox = {
    ...region.session.outbox,
    supports: () => true,
    subscribe: () => () => {},
    ready: outboxReady,
    snapshot: () => operations,
    whenPrepared,
    withChat: async (_key, run) => run(() => true),
    stageChat,
    resume: async (id, active) => {
      if (!active()) throw new Error("Submission cancelled");
      const event = await whenPrepared(id);
      if (!active()) throw new Error("Submission cancelled");
      operations = operations.map((item) =>
        item.event.id === id
          ? { ...item, signed: event, delivery: "accepted" }
          : item,
      );
      return event;
    },
    acknowledge: async (id) => {
      operations = operations.map((item) =>
        item.event.id === id ? { ...item, recovery: undefined } : item,
      );
    },
    send: () => {
      throw new Error("Unexpected unstaged send");
    },
  } as Outbox;
  const writes = createChannelWrites(
    outbox,
    region.session.channels,
    {} as Parameters<typeof createChannelWrites>[2],
    new AbortController().signal,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  Object.assign(region.session, {
    agentChoices: {
      ...region.session.agentChoices,
      snapshot: () => choices,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      retain: () => () => {},
      ensure: () => {},
    },
    profiles: {
      ...region.session.profiles,
      snapshot: () => profiles,
      ensure: async () => {},
    },
    channelWrites: {
      ...region.session.channelWrites,
      available: true,
      prepareStart: writes.prepareStart,
      resumeStart,
    },
    messages: createMessages(
      outbox,
      region.session.viewer,
      () => undefined,
      () => [],
      () => {},
      () => true,
      "https://relay.example.org",
    ),
    outbox,
  });
  if (upload)
    Object.assign(region.session, {
      attachments: { uploadForNewChat: upload },
    });
  let allowed = true;
  const prepare = vi.fn<SoloTaskMode["prepare"]>(async (input) => ({
    ok: true,
    channelId,
    members: input.recipients,
    revision: input.revision,
    preparationId: "prepared",
  }));
  const claim = vi.fn<SoloTaskMode["markChannelStarted"]>(async () => "start");
  const source = await region.register({
    task: {
      prepare,
      markChannelStarted: claim,
      recordFirstEvent: async () => {},
      participants: {
        eligible: (key) => allowed && key === agent,
        defaultRecipient: () => agent,
        makePrimary: async () => {},
      },
    },
  });
  const started = vi.fn();
  const view = (focusRequest?: number | AbortSignal) => (
    <StrictMode>
      <TaskSoloDraft
        session={region.session}
        scope={region.scope}
        {...(focusRequest === undefined ? {} : { focusRequest })}
        route={{ region: source.handle.label, draftId }}
        agent={agent}
        extensions={extensions}
        onStarted={started}
      />
    </StrictMode>
  );
  const wrapped = (request?: number | AbortSignal) =>
    models ? (
      <AgentsContext.Provider value={models}>
        {view(request)}
      </AgentsContext.Provider>
    ) : (
      view(request)
    );
  if (initialDraft)
    writeView(region.scope, `solo:task:${draftId}:new-draft`, initialDraft);
  const mounted = render(wrapped());
  return {
    claim,
    pending(next: readonly OutgoingEvent[]) {
      operations = next;
    },
    focus(request?: number | AbortSignal) {
      mounted.rerender(wrapped(request));
    },
    ...region,
    ready,
    sent,
    outboxReady,
    whenPrepared,
    resumeStart,
    stageChat,
    prepare,
    started,
    mounted,
    refresh(selectable: boolean) {
      act(() => {
        choices = {
          ...choices,
          pending: !selectable,
          complete: selectable,
          selectable: selectable ? rows : [],
        };
        for (const listener of listeners) listener();
      });
    },
    revoke() {
      allowed = false;
    },
  };
}
const selected = () =>
  screen.getByRole("button", {
    name: "Choose primary agent, current recipient Task agent",
  });

it.each(["accepted", "rejected"] as const)(
  "keeps the selected task agent through Enter, refresh and a held first message (%s)",
  async (outcome) => {
    const f = await fixture();
    const user = userEvent.setup();
    try {
      await waitFor(() => expect(selected()).toBeEnabled());
      await user.type(screen.getByRole("textbox"), "Review the task");
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Send message" }),
        ).toBeEnabled(),
      );
      await user.keyboard("{Enter}");
      await waitFor(() => expect(f.outboxReady).toHaveBeenCalledOnce());
      expect(selected()).toBeDisabled();
      f.refresh(false);
      expect(selected()).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled();
      f.refresh(true);
      await act(async () => f.ready.resolve());
      await waitFor(() =>
        expect(f.whenPrepared).toHaveBeenCalledWith("d".repeat(64)),
      );
      expect(selected()).toBeDisabled();
      f.refresh(false);
      expect(selected()).toBeDisabled();
      expect(f.started).not.toHaveBeenCalled();
      expect(f.prepare.mock.calls[0]?.[0]).toMatchObject({
        primary: agent,
        recipients: [agent],
        text: "Review the task",
      });
      expect(f.stageChat).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 9007 }),
        {
          kind: 9,
          content: "Review the task",
          tags: [
            ["h", channelId],
            ["p", agent],
          ],
        },
        expect.any(Object),
      );
      f.refresh(true);
      if (outcome === "accepted") {
        await act(async () => f.sent.resolve());
        await waitFor(() =>
          expect(f.started).toHaveBeenCalledExactlyOnceWith(channelId),
        );
        expect(readView(f.scope, `solo:task:${draftId}:new-draft`, null)).toBe(
          "",
        );
      } else {
        await act(async () =>
          f.sent.reject(new Error("First message refused")),
        );
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "First message refused",
        );
        expect(screen.getByRole("textbox")).toHaveTextContent(
          "Review the task",
        );
        expect(f.started).not.toHaveBeenCalled();
      }
      f.refresh(true);
      await waitFor(() => expect(selected()).toBeEnabled());
      expect(f.resumeStart).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        f.ready.resolve();
        f.sent.resolve();
      });
      f.mounted.unmount();
    }
  },
);

it("keeps the pending label without granting a revoked agent permission to start", async () => {
  const f = await fixture();
  const user = userEvent.setup();
  try {
    await waitFor(() => expect(selected()).toBeEnabled());
    await user.type(screen.getByRole("textbox"), "Keep this request");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeEnabled(),
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(f.outboxReady).toHaveBeenCalledOnce());
    f.revoke();
    f.refresh(false);
    expect(selected()).toBeDisabled();
    await act(async () => f.ready.resolve());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A selected task agent is no longer eligible",
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.resumeStart).not.toHaveBeenCalled();
    expect(f.stageChat).not.toHaveBeenCalled();
    expect(f.started).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this request");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  } finally {
    await act(async () => {
      f.ready.resolve();
      f.sent.resolve();
    });
    f.mounted.unmount();
  }
});

it("focuses a new task navigation request and preserves user focus between requests", async () => {
  const f = await fixture();
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  try {
    await waitFor(() => expect(selected()).toBeEnabled());
    elsewhere.focus();
    f.focus();
    expect(elsewhere).toHaveFocus();
    const first = new AbortController().signal;
    f.focus(first);
    expect(screen.getByRole("textbox")).toHaveFocus();
    elsewhere.focus();
    f.focus(first);
    expect(elsewhere).toHaveFocus();
    f.focus(new AbortController().signal);
    expect(screen.getByRole("textbox")).toHaveFocus();
  } finally {
    elsewhere.remove();
    f.mounted.unmount();
  }
});

it("refuses a task before claiming its marker when fewer than two outbox slots remain, then retries", async () => {
  const f = await fixture();
  const user = userEvent.setup();
  const viewer = keypair();
  const operations = Array.from({ length: MAX_PENDING - 1 }, (_, index) => ({
    event: signed(viewer, {
      kind: 7,
      content: "+",
      tags: [],
      created_at: index,
    }),
    delivery: "failed" as const,
  }));
  f.pending(operations);
  try {
    f.ready.resolve();
    f.sent.resolve();
    await user.type(screen.getByRole("textbox"), "Keep the full queue draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Resolve or dismiss pending operations",
    );
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.resumeStart).not.toHaveBeenCalled();
    expect(f.stageChat).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveTextContent(
      "Keep the full queue draft",
    );
    f.pending(operations.slice(1));
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(f.started).toHaveBeenCalledWith(channelId));
    expect(f.claim).toHaveBeenCalledOnce();
    expect(f.resumeStart).toHaveBeenCalledOnce();
    expect(f.stageChat).toHaveBeenCalledOnce();
  } finally {
    f.ready.resolve();
    f.sent.resolve();
    f.mounted.unmount();
  }
});

it("keeps an ineligible identity link in a new task without claiming or sending", async () => {
  const f = await fixture();
  const link = `[@Unavailable](${profileTarget("c".repeat(64))}) Help `;
  try {
    f.ready.resolve();
    f.sent.resolve();
    await waitFor(() => expect(selected()).toBeEnabled());
    screen.getByRole("textbox").focus();
    fireEvent.paste(screen.getByRole("textbox"), {
      clipboardData: {
        items: [],
        getData: (format: string) => (format === "text/plain" ? link : ""),
        types: ["text/plain"],
      },
    });
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Select an eligible task agent",
    );
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.stageChat).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveTextContent("Unavailable");
  } finally {
    f.ready.resolve();
    f.sent.resolve();
    f.mounted.unmount();
  }
});

it("sends the selected model and effort to the first task primary", async () => {
  const entry = {
    pubkey: agent,
    key: agent,
    name: "Task agent",
    type: "test/agent",
  };
  const snapshot = { status: "ready", agents: [entry], teams: [] };
  const types = [
    {
      key: "test/agent",
      models: () => ({
        current: "fast",
        sendDefaults: true,
        models: [
          { id: "fast", label: "Fast", efforts: [] },
          {
            id: "deep",
            label: "Deep",
            efforts: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
      }),
    },
  ];
  const f = await fixture(
    {
      find: (key: string) => (key === agent ? entry : undefined),
      joinable: () => [],
      sessionState: () => "unavailable",
      subscribe: () => () => {},
      snapshot: () => snapshot,
      types: () => types,
    } as unknown as Agents,
    {
      text: "@Task agent Use the selected model",
      recipients: [{ pubkey: agent, name: "Task agent", start: 0, end: 11 }],
    },
  );
  const user = userEvent.setup();
  try {
    f.ready.resolve();
    f.sent.resolve();
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveTextContent("Task agent"),
    );
    await user.click(
      await screen.findByRole("button", { name: /Model.*effort/ }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Model for Task agent in this chat",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Deep" }),
    );
    const effort = await screen.findByLabelText(
      "Effort for Task agent in this chat",
    );
    effort.focus();
    await user.keyboard("{ArrowRight}");
    expect(effort).toHaveAttribute("aria-valuetext", "High");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(f.started).toHaveBeenCalledWith(channelId));
    expect(f.stageChat).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: 9007 }),
      {
        kind: 9,
        content: "@Task agent Use the selected model",
        tags: [
          ["h", channelId],
          ["p", agent],
          ["model", agent, "deep"],
          ["effort", agent, "high"],
        ],
      },
      expect.any(Object),
    );
  } finally {
    f.ready.resolve();
    f.sent.resolve();
    f.mounted.unmount();
  }
});

const attachment: UploadedAttachment = {
  name: "notes.txt",
  url: `https://relay.example.org/media/${"f".repeat(64)}.txt`,
  type: "text/plain",
  size: 5,
  sha256: "f".repeat(64),
};

it.each([32_000, 32_001])(
  "checks the serialized task limit before source intent with an attachment (%i characters)",
  async (length) => {
    const link = `\n\n[notes.txt](<${attachment.url}>)`;
    const text = "a".repeat(length - link.length);
    const upload = vi.fn(async () => attachment);
    const f = await fixture(undefined, { text, recipients: [] }, upload);
    const user = userEvent.setup();
    try {
      f.ready.resolve();
      f.sent.resolve();
      await user.upload(
        screen.getByLabelText("Choose attachments"),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      );
      await waitFor(() => expect(upload).toHaveBeenCalledOnce());
      await user.click(screen.getByRole("button", { name: "Send message" }));
      if (length > 32_000) {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "The task message exceeds 32,000 characters",
        );
        expect(f.prepare).not.toHaveBeenCalled();
        expect(f.claim).not.toHaveBeenCalled();
        expect(f.resumeStart).not.toHaveBeenCalled();
        expect(f.stageChat).not.toHaveBeenCalled();
        expect(screen.getByRole("textbox")).toHaveTextContent(text);
        await user.clear(screen.getByRole("textbox"));
        await user.type(screen.getByRole("textbox"), "Read the file");
        await user.click(screen.getByRole("button", { name: "Send message" }));
      }
      await waitFor(() => expect(f.started).toHaveBeenCalledWith(channelId));
      expect(f.prepare).toHaveBeenCalledOnce();
      expect(f.claim).toHaveBeenCalledOnce();
      expect(f.stageChat).toHaveBeenCalledOnce();
      const event = f.stageChat.mock.calls[0]?.[1];
      expect(event?.content).toBe(
        `${length > 32_000 ? "Read the file" : text}${link}`,
      );
      expect(event?.tags).toContainEqual([
        "imeta",
        `url ${attachment.url}`,
        "m text/plain",
        "size 5",
        `x ${attachment.sha256}`,
        "filename notes.txt",
      ]);
      expect(upload).toHaveBeenCalledOnce();
    } finally {
      f.ready.resolve();
      f.sent.resolve();
      f.mounted.unmount();
    }
  },
);

const metadataFiles = ["a", "b"].map((letter) => ({
  ...attachment,
  name: `${letter.repeat(251)}.txt`,
}));
const metadataLinks = metadataFiles
  .map((file) => `\n\n[${file.name}](<${file.url}>)`)
  .join("");
it.each([
  {
    kind: "multibyte text",
    text: "😀".repeat(8192),
    files: [] as UploadedAttachment[],
  },
  {
    kind: "attachment metadata",
    text: "a".repeat(32_000 - metadataLinks.length),
    files: metadataFiles,
  },
])(
  "refuses $kind before source intent and keeps the task editable",
  async ({ text, files }) => {
    const upload = vi.fn(async (file: File) => {
      const uploaded = files.find((item) => item.name === file.name);
      if (!uploaded) throw new Error("Unexpected fixture attachment");
      return uploaded;
    });
    const f = await fixture(undefined, { text, recipients: [] }, upload);
    const user = userEvent.setup();
    try {
      f.ready.resolve();
      f.sent.resolve();
      if (files.length) {
        await user.upload(
          screen.getByLabelText("Choose attachments"),
          files.map(
            (item) => new File(["notes"], item.name, { type: "text/plain" }),
          ),
        );
        await waitFor(() => expect(upload).toHaveBeenCalledTimes(files.length));
      }
      await user.click(screen.getByRole("button", { name: "Send message" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Message is empty or too large",
      );
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.claim).not.toHaveBeenCalled();
      expect(f.resumeStart).not.toHaveBeenCalled();
      expect(f.stageChat).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox")).toHaveTextContent(text);
      await user.clear(screen.getByRole("textbox"));
      await user.type(screen.getByRole("textbox"), "A smaller request 😀");
      await user.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(f.started).toHaveBeenCalledWith(channelId));
      expect(f.stageChat.mock.calls[0]?.[1].content).toBe(
        `A smaller request 😀${files.length ? metadataLinks : ""}`,
      );
      expect(
        f.stageChat.mock.calls[0]?.[1].tags.filter(
          ([name]) => name === "imeta",
        ),
      ).toHaveLength(files.length);
      expect(f.claim).toHaveBeenCalledOnce();
    } finally {
      f.ready.resolve();
      f.sent.resolve();
      f.mounted.unmount();
    }
  },
);

it("refuses a prepared channel that cannot preserve the UUID event budget", async () => {
  const f = await fixture();
  const user = userEvent.setup();
  f.prepare.mockImplementation(async (input) => ({
    ok: true,
    channelId: "channel-without-a-uuid",
    members: input.recipients,
    revision: input.revision,
    preparationId: "prepared",
  }));
  try {
    f.ready.resolve();
    f.sent.resolve();
    await user.type(screen.getByRole("textbox"), "Keep this task");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The prepared task has changed",
    );
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.resumeStart).not.toHaveBeenCalled();
    expect(f.stageChat).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveTextContent("Keep this task");
  } finally {
    f.ready.resolve();
    f.sent.resolve();
    f.mounted.unmount();
  }
});
