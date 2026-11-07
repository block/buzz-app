// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { readView } from "../../shared/view-state";
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

async function fixture() {
  const region = createSoloRegionFixture();
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
  const whenPrepared = vi.fn(() => sent.promise);
  const start = vi.fn(() => ({
    create: "create-event",
    ready: Promise.resolve(),
  }));
  const send = vi.fn(() => "first-event");
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
    channelWrites: { ...region.session.channelWrites, available: true, start },
    messages: { ...region.session.messages, send },
    outbox: {
      ...region.session.outbox,
      supports: () => true,
      subscribe: () => () => {},
      ready: outboxReady,
      snapshot: () => empty,
      whenPrepared,
    },
  });
  let allowed = true;
  const prepare = vi.fn<SoloTaskMode["prepare"]>(async (input) => ({
    ok: true,
    channelId,
    members: input.recipients,
    revision: input.revision,
    preparationId: "prepared",
  }));
  const source = await region.register({
    task: {
      prepare,
      markChannelStarted: async () => "start",
      recordFirstEvent: async () => {},
      participants: {
        eligible: (key) => allowed && key === agent,
        defaultRecipient: () => agent,
        makePrimary: async () => {},
      },
    },
  });
  const started = vi.fn();
  const mounted = render(
    <StrictMode>
      <TaskSoloDraft
        session={region.session}
        scope={region.scope}
        route={{ region: source.handle.label, draftId }}
        agent={agent}
        extensions={extensions}
        onStarted={started}
      />
    </StrictMode>,
  );
  return {
    ...region,
    ready,
    sent,
    outboxReady,
    whenPrepared,
    start,
    send,
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
        expect(f.whenPrepared).toHaveBeenCalledWith("first-event"),
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
      expect(f.send).toHaveBeenCalledWith(
        channelId,
        "Review the task",
        [agent],
        [],
        expect.any(Object),
      );
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
      expect(f.start).toHaveBeenCalledOnce();
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
    expect(f.start).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
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
