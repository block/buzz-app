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
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, assert, expect, it, vi } from "vitest";
import { useState } from "react";
import { createRelaySession } from "../../features/relay/session";
import { createAgentControl } from "../../features/agents/control";
import { controlFixture } from "../../features/agents/control-testing";
import { keypair, signed, roster } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import type { KitRecord } from "../../features/channel-templates/model";
import {
  coordinate,
  emptyLineup,
  KIT_TAG,
} from "../../features/channel-templates/model";
import type {
  TemplateDraft,
  TemplateProvider,
  TemplateProviders,
} from "../../features/channel-templates/provider";
import type { Contribution } from "../../plugins/contributions";
import { CreateChannelDialog } from "../channels/CreateChannelDialog";
import { TemplateEditor } from "./TemplateEditor";
import { SaveAsTemplate } from "./TemplateSettings";
import { MentionPicker } from "../mentions/MentionPicker";
import { MentionCompletion } from "../mentions/MentionCompletion";
import type { CompletionResult } from "../../features/conversation/contracts";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async (
        _key: string,
        _options: unknown,
        run: (lock: object) => unknown,
      ) => run({}),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "locks");
});

function harness(
  legacy?: () => Promise<{
    definitions: [];
    identities: { pubkey: string; name: string }[];
  }>,
  beforeChannelRead?: () => Promise<void>,
) {
  const viewer = keypair(),
    relay = keypair();
  const fixture = controlFixture();
  fixture.agent.name = "Calvin";
  fixture.agent.status = "stopped";
  fixture.agent.enabled = false;
  const native = createAgentControl(fixture.host);
  const stored = new Map<string, KitRecord>();
  const published: RelayEvent[] = [];
  const channels = new Map<string, string[]>([
    ["11111111-1111-4111-8111-111111111111", [viewer.pubkey]],
  ]);
  let record: KitRecord | undefined;
  let clock = 1_700_000_000;
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      archiveAuthority: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      readAgentLibrary:
        legacy ??
        (async () => {
          throw new Error("Old Buzz unavailable");
        }),
      channelKit: {
        prepare: async (value) => {
          stored.set("fixture", value);
          return "fixture";
        },
        decode: async (events) =>
          events.map((event) => {
            assert.exists(record);
            return { eventId: event.id, record };
          }),
      },
      writer: {
        kinds: [9007, 9000, 30078, 40100, 9],
        sign: async (value) => signed(viewer, value),
        publish: async (event) => {
          published.push(event);
          const id = event.tags.find(([tag]) => tag === "h")?.[1];
          if (id && event.kind === 9007) channels.set(id, [viewer.pubkey]);
          if (id && event.kind === 9000) {
            const member = event.tags.find(([tag]) => tag === "p")?.[1];
            assert.exists(member);
            channels.get(id)?.push(member);
          }
          clock++;
        },
      },
      query: async (filters) => {
        if (
          filters.some((filter) =>
            filter.kinds?.some((kind) => [39000, 39002].includes(kind)),
          )
        )
          await beforeChannelRead?.();
        const events = [
          signed(relay, { kind: 13535, tags: [["-"]], content: "" }),
          ...[...channels].flatMap(([id, members]) => [
            signed(relay, {
              kind: 39000,
              content: "",
              created_at: clock,
              tags: [
                ["d", id],
                ["name", "Test"],
                ["t", "stream"],
              ],
            }),
            roster(relay, id, members, clock),
          ]),
          ...published,
          ...(record
            ? [
                signed(viewer, {
                  kind: 30078,
                  content: "fixture",
                  tags: [
                    ["d", coordinate(record)],
                    ["t", KIT_TAG],
                  ],
                }),
              ]
            : []),
        ];
        return events.filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      },
    },
    {
      agentChoices: native,
      outboxStorage: { load: () => [], save: () => {} },
      warm: false,
    },
  );
  return {
    owner,
    native,
    fixture,
    published,
    channels,
    setRecord: (next: KitRecord) => {
      record = next;
    },
    dispose: () => {
      owner.dispose();
      native.dispose();
    },
  };
}

function Editor({
  test,
  initial,
  chosen,
}: {
  test: ReturnType<typeof harness>;
  initial?: TemplateDraft;
  chosen(value: TemplateDraft): void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <TemplateEditor
      session={test.owner.session}
      value={value}
      initialDefault={initial?.templateId ?? ""}
      group={undefined}
      active={() => true}
      onChange={(next) => {
        setValue(next);
        chosen(next);
      }}
    />
  );
}

it("reloads invalidated archive evidence when channel discovery completes after the mounted editor's archive read", async () => {
  let release = () => {};
  const discovery = new Promise<void>((resolve) => {
    release = resolve;
  });
  const readingChannels = vi.fn(() => discovery);
  const test = harness(
    async () => ({ definitions: [], identities: [] }),
    readingChannels,
  );
  const states: string[] = [];
  const archives = test.owner.session.archives;
  const stop = archives.subscribe(() =>
    states.push(archives.snapshot().status),
  );
  let draft: TemplateDraft | undefined;
  try {
    render(
      <Editor
        test={test}
        chosen={(next) => {
          draft = next;
        }}
      />,
    );
    await waitFor(() => {
      expect(readingChannels).toHaveBeenCalled();
      expect(archives.snapshot().status).toBe("ready");
    });
    states.length = 0;
    await act(async () => {
      release();
    });
    await waitFor(() => {
      expect(test.owner.session.channels.list().status).toBe("ready");
      expect(archives.snapshot().status).toBe("ready");
    });
    expect(states).toContain("idle");
    expect(states.slice(states.lastIndexOf("idle"))).toEqual([
      "idle",
      "loading",
      "ready",
    ]);
    await userEvent.click(
      screen.getByRole("button", {
        name: "Review / customize teams, agents & Canvas",
      }),
    );
    await userEvent.click(
      await screen.findByRole("checkbox", {
        name: `Calvin · ${test.fixture.agent.pubkey.slice(0, 10)}`,
      }),
    );
    expect(draft?.agents).toEqual([test.fixture.agent.pubkey]);
    expect(draft?.problem).toBeUndefined();
  } finally {
    release();
    stop();
    test.dispose();
  }
});

it("offers native-only stopped Calvin in real template/mention UI and creates with the same exact identity while old Buzz fails", async () => {
  const test = harness(),
    user = userEvent.setup();
  let draft: TemplateDraft | undefined;
  try {
    const view = render(
      <Editor
        test={test}
        chosen={(next) => {
          draft = next;
        }}
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Review / customize teams, agents & Canvas",
      }),
    );
    const checkbox = await screen.findByRole("checkbox", {
      name: `Calvin · ${test.fixture.agent.pubkey.slice(0, 10)}`,
    });
    await waitFor(() =>
      expect(test.owner.session.archives.snapshot().status).toBe("ready"),
    );
    await user.click(checkbox);
    expect(draft?.agents).toEqual([test.fixture.agent.pubkey]);
    expect(draft?.problem).toBeUndefined();
    expect(
      screen.getByRole("button", { name: "Reload templates and agents" }),
    ).toBeInTheDocument();
    view.unmount();
    assert.exists(draft);
    const id = await test.owner.session.channelCreation.create({
      name: "Calvin test",
      visibility: "private",
      setup: { agents: draft.agents, canvas: "", groupId: "", templateId: "" },
    });
    expect(test.channels.get(id)).toContain(test.fixture.agent.pubkey);
    expect(test.published.filter((e) => e.kind === 9000)).toHaveLength(1);
    expect(test.published.some((e) => e.kind === 9)).toBe(false);
    expect(test.fixture.calls.every((call) => call.action === "snapshot")).toBe(
      true,
    );
    const parent = "11111111-1111-4111-8111-111111111111";
    const select = vi.fn(() => true);
    const picker = render(
      <MentionPicker
        session={test.owner.session}
        scope={test.owner.session.scope}
        channelId={parent}
        disabled={false}
        select={select}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Mention a member" }));
    await user.click(
      await screen.findByRole("button", {
        name: `Calvin ${test.fixture.agent.pubkey}`,
      }),
    );
    expect(select).toHaveBeenCalledWith({
      pubkey: test.fixture.agent.pubkey,
      name: "Calvin",
    });
    picker.unmount();
    let result: CompletionResult | undefined;
    const publish = (next: CompletionResult) => {
      result = next;
      return () => {};
    };
    render(
      <MentionCompletion
        session={test.owner.session}
        scope={test.owner.session.scope}
        channelId={parent}
        query={{ query: "Calvin", start: 0, end: 7 }}
        observation={{ revision: 1, text: "@Calvin", start: 7, end: 7 }}
        publish={publish}
      />,
    );
    await waitFor(() =>
      expect(result?.items[0]?.id).toBe(test.fixture.agent.pubkey),
    );
  } finally {
    cleanup();
    test.dispose();
  }
});

it("does not consume a legacy group default while its required identity is still loading", async () => {
  const key = "cd".repeat(32);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const test = harness(async () => {
    await gate;
    return { definitions: [], identities: [{ pubkey: key, name: "Legacy" }] };
  });
  const members = test.channels.get("11111111-1111-4111-8111-111111111111");
  assert.exists(members);
  members.push(key);
  test.setRecord({
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: {
      type: "template",
      id: "saved",
      name: "Saved",
      description: "",
      agents: [key],
      teamIds: [],
      canvas: "",
    },
  });
  const initial = {
    templateId: "saved",
    lineup: emptyLineup(),
    agents: [],
    problem: "Group default is awaiting selection.",
  };
  const chosen = vi.fn();
  try {
    render(<Editor test={test} initial={initial} chosen={chosen} />);
    await waitFor(() => {
      expect(test.owner.session.channelKit.snapshot().status).toBe("ready");
      expect(test.native.snapshot().status).toBe("ready");
      expect(test.owner.session.archives.snapshot().status).toBe("ready");
    });
    expect(chosen).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await test.owner.session.agentChoices.refresh();
    });
    await waitFor(() =>
      expect(chosen).toHaveBeenCalledWith(
        expect.objectContaining({ agents: [key], problem: undefined }),
      ),
    );
  } finally {
    release();
    cleanup();
    test.dispose();
  }
});

it("discloses an incomplete save-as lineup when another source fails", async () => {
  const test = harness(),
    user = userEvent.setup();
  try {
    await test.owner.session.agentChoices.refresh();
    await test.owner.session.archives.ensure();
    render(
      <SaveAsTemplate
        session={test.owner.session}
        channel={{
          id: "11111111-1111-4111-8111-111111111111",
          name: "Partial",
          members: [test.fixture.agent.pubkey, "cd".repeat(32)],
        }}
        active={() => true}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Save as template…" }),
    );
    expect(
      await screen.findByText(/Incomplete agent inventory/),
    ).toBeInTheDocument();
    expect(test.published).toEqual([]);
  } finally {
    cleanup();
    test.dispose();
  }
});

function providerFixture() {
  const listeners = new Set<() => void>();
  const entry = (): Contribution<TemplateProvider> => ({
    id: "templates",
    key: "buzz.channel-templates/templates",
    title: "Templates",
    pluginId: "buzz.channel-templates",
    revision: "bundled",
    editor: TemplateEditor,
    groupDefault: () => null,
    saveAs: SaveAsTemplate,
  });
  let entries: readonly Contribution<TemplateProvider>[] = [entry()];
  const providers: TemplateProviders = {
    snapshot: () => entries,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register: () => {},
  };
  return {
    providers,
    toggle(enabled: boolean) {
      entries = enabled ? [entry()] : [];
      listeners.forEach((listener) => {
        listener();
      });
    },
  };
}

it("submits the actual create dialog through host preflight/outbox and retains accepted team expansion across provider replacement", async () => {
  const test = harness(),
    registry = providerFixture(),
    user = userEvent.setup();
  const team = (agents: string[]): KitRecord => ({
    version: 1,
    community: "https://relay.example.test",
    deleted: false,
    value: { type: "team", id: "crew", name: "Crew", agents },
  });
  test.setRecord(team([test.fixture.agent.pubkey]));
  const created = vi.fn(async (input) => {
    await test.owner.session.channelCreation.create(input);
  });
  try {
    render(
      <CreateChannelDialog
        open
        onOpenChange={() => {}}
        onCreate={created}
        session={test.owner.session}
        providers={registry.providers}
        groups={undefined}
        initialGroup=""
        groupsReady
      />,
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Team test");
    await user.click(
      screen.getByRole("button", {
        name: "Review / customize teams, agents & Canvas",
      }),
    );
    await waitFor(() =>
      expect(test.owner.session.archives.snapshot().status).toBe("ready"),
    );
    await user.click(await screen.findByRole("checkbox", { name: "Crew (1)" }));
    expect(
      screen.getByRole("region", { name: "Channel setup summary" }),
    ).toHaveTextContent(test.fixture.agent.pubkey);
    act(() => registry.toggle(false));
    expect(
      screen.queryByRole("checkbox", { name: "Crew (1)" }),
    ).not.toBeInTheDocument();
    test.setRecord(team([]));
    await act(async () => {
      await test.owner.session.channelKit.refresh();
      registry.toggle(true);
    });
    await user.click(
      screen.getByRole("button", {
        name: "Review / customize teams, agents & Canvas",
      }),
    );
    expect(
      await screen.findByRole("checkbox", { name: "Crew (0)" }),
    ).toBeChecked();
    fireEvent.change(
      screen.getByRole("textbox", { name: "Starting Canvas (Markdown)" }),
      { target: { value: "# Preserved team" } },
    );
    expect(screen.getByText(/Access preview:/)).toHaveTextContent("Calvin");
    act(() => registry.toggle(false));
    await user.click(screen.getByRole("button", { name: "Create channel" }));
    await waitFor(() =>
      expect(test.published.filter((e) => e.kind === 9000)).toHaveLength(1),
    );
    await waitFor(() =>
      expect(test.owner.session.channelCreation.snapshot()).toBeUndefined(),
    );
    expect(created).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: {
          agents: [test.fixture.agent.pubkey],
          canvas: "# Preserved team",
          groupId: "",
          templateId: "",
        },
      }),
    );
    expect(test.published.map((e) => e.kind)).toEqual([9007, 40100, 9000]);
    expect(test.fixture.calls.every((call) => call.action === "snapshot")).toBe(
      true,
    );
  } finally {
    cleanup();
    test.dispose();
  }
});

it("copies the saved Canvas and eligible member keys without silently creating a linked team", async () => {
  const test = harness(async () => ({ definitions: [], identities: [] })),
    user = userEvent.setup();
  const channel = "11111111-1111-4111-8111-111111111111";
  test.published.push(
    signed(keypair(), {
      kind: 40100,
      tags: [["h", channel]],
      content: "# Saved plan",
    }),
  );
  try {
    await test.owner.session.agentChoices.refresh();
    await test.owner.session.archives.ensure();
    render(
      <SaveAsTemplate
        session={test.owner.session}
        channel={{
          id: channel,
          name: "Copy me",
          members: [test.fixture.agent.pubkey, "ef".repeat(32)],
        }}
        active={() => true}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save as template…" }),
      ).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Save as template…" }));
    expect(
      await screen.findByRole("textbox", {
        name: "Starting Canvas (Markdown)",
      }),
    ).toHaveValue("# Saved plan");
    expect(
      screen.getByRole("checkbox", {
        name: `Calvin · ${test.fixture.agent.pubkey.slice(0, 10)}`,
      }),
    ).toBeChecked();
    expect(
      within(screen.getByRole("group", { name: "Saved teams" })).queryAllByRole(
        "checkbox",
      ),
    ).toEqual([]);
    expect(test.published).toHaveLength(1);
  } finally {
    cleanup();
    test.dispose();
  }
});
