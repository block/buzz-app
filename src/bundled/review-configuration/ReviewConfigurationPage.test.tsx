// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { EventTemplate } from "nostr-tools";
import type { RelaySession } from "../../features/relay/session";
import type { ChannelSummary } from "../../features/relay/contracts";
import type { EventData } from "../../features/relay/events";
import { keypair, signed } from "../../features/relay/testing";
import type { PageNavigation } from "../../features/navigation/service";
import type { RelayData } from "../../features/relay/service";
import {
  ReviewConfigurationPage,
  ReviewConfigurationCommunity,
} from "./ReviewConfigurationPage";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const channel = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const key = keypair();
  let events: EventData[] = [];
  let list = {
    status: "ready",
    channels: [
      { id: channel, name: "Reviews", channelType: "stream" } as ChannelSummary,
    ],
  };
  const listeners = new Set<() => void>();
  const agents = [
    {
      pubkey: "a".repeat(64),
      name: "Backend reviewer",
      managed: true,
      avatar: "https://example.org/agent.png",
    },
    { pubkey: "b".repeat(64), name: "UI reviewer", managed: true },
  ];
  let choices = {
    error: undefined as string | undefined,
    status: "ready",
    pending: false,
    complete: true,
    identities: agents,
    selectable: agents,
    archives: {
      status: "ready",
      archived: [],
      error: undefined as string | undefined,
    },
    definitions: [],
  };
  const snapshotRead = vi.fn(async () => events);
  const publish = vi.fn(async (event: EventData) => {
    events = [event];
    return event.id;
  });
  const session = {
    scope: "review-test-scope",
    agentChoices: {
      snapshot: () => choices,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      ensure() {},
      refresh: vi.fn(async () => {
        choices = {
          ...choices,
          error: undefined,
          selectable: agents,
          archives: { ...choices.archives, error: undefined },
        };
        for (const listener of listeners) listener();
      }),
      retain: () => () => {},
    },
    channels: {
      ensureList() {},
      list: () => list,
      subscribeList: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    snapshotRead,
    configArtifactWriter: {
      sign: async (template: EventTemplate) => signed(key, template),
      publish,
    },
  } as unknown as RelaySession;
  return {
    session,
    publish,
    snapshotRead,
    setChannels(channels: ChannelSummary[]) {
      list = { ...list, channels };
      for (const listener of listeners) listener();
    },
    failAgents() {
      choices = {
        ...choices,
        error: "Inventory unavailable",
        selectable: [],
        archives: { ...choices.archives, error: "Archive read failed" },
      };
      for (const listener of listeners) listener();
    },
    hideAgents() {
      choices = { ...choices, selectable: [] };
      for (const listener of listeners) listener();
    },
    metadataCached(cached: boolean) {
      list = {
        ...list,
        channels: [
          {
            id: channel,
            name: "Reviews",
            channelType: "stream",
            ...(cached ? { metadataCached: true } : {}),
          },
        ],
      };
      for (const listener of listeners) listener();
    },
  };
}

async function openDraft() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Review channel" }));
  await user.click(await screen.findByRole("option", { name: "Reviews" }));
  await screen.findByText(
    "No repositories configured in this channel. Register one to save its review lanes.",
  );
  await user.click(screen.getByRole("button", { name: "Register repository" }));
  await user.type(
    screen.getByRole("textbox", { name: "GitHub repository" }),
    "example-org/project",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Check authorization and keyboard navigation.",
  );
  await user.type(screen.getByRole("textbox", { name: "Value" }), "review");
  return user;
}

it("registers, reloads and edits a repository through the real form and artifact writer", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  await user.click(screen.getByRole("button", { name: "Reload" }));
  await screen.findByRole("button", { name: "Edit General lane" });
  await user.click(screen.getByRole("button", { name: "Edit General lane" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Instructions",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Check authorization and keyboard navigation.");
  await user.clear(screen.getByRole("textbox", { name: "Instructions" }));
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Check database migrations.",
  );
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  expect(test.publish).toHaveBeenCalledTimes(2);
  expect(test.publish.mock.calls[1]?.[0].tags).toContainEqual([
    "prev",
    test.publish.mock.calls[0]?.[0].id,
  ]);
});

it("keeps the draft on rejection, prevents duplicate submissions, and recovers", async () => {
  const test = fixture();
  let reject: (error: Error) => void = () => {};
  test.publish.mockImplementationOnce(
    () =>
      new Promise((_resolve, rejectSave) => {
        reject = rejectSave;
      }),
  );
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  await user.dblClick(screen.getByRole("button", { name: "Save lane" }));
  await waitFor(() => expect(test.publish).toHaveBeenCalledTimes(1));
  expect(
    (screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => reject(new Error("conflict: artifact head changed")));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Your draft is still here",
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Instructions",
      }) as HTMLTextAreaElement
    ).value,
  ).toContain("keyboard navigation");
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
});

it("preserves the draft while channel authorization reconfirms, but gates Save", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  await openDraft();
  act(() => test.metadataCached(true));
  expect(
    (screen.getByRole("button", { name: "Save lane" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Instructions",
      }) as HTMLTextAreaElement
    ).value,
  ).toContain("keyboard navigation");
  act(() => test.metadataCached(false));
  expect(
    (screen.getByRole("button", { name: "Save lane" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(
    (
      screen.getByRole("textbox", {
        name: "Instructions",
      }) as HTMLTextAreaElement
    ).value,
  ).toContain("keyboard navigation");
  expect(test.publish).not.toHaveBeenCalled();
});

it("aborts an unfinished write when the page leaves its session", async () => {
  const test = fixture();
  const publish = vi.fn(
    (_event: EventData, signal: AbortSignal) =>
      new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      ),
  );
  const session = {
    ...test.session,
    configArtifactWriter: { ...test.session.configArtifactWriter, publish },
  } as RelaySession;
  const view = render(<ReviewConfigurationCommunity session={session} />);
  const user = await openDraft();
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(1));
  view.unmount();
  expect(publish.mock.calls[0]?.[1].aborted).toBe(true);
});

it("counts unreadable records toward the limit when a new repository is saved", async () => {
  const test = fixture();
  test.snapshotRead.mockResolvedValue(
    Array.from({ length: 99 }, () => ({
      kind: 45010,
      id: "a".repeat(64),
      pubkey: "b".repeat(64),
      sig: "",
      created_at: 1,
      tags: [
        ["h", channel],
        ["type", "buzz.review.config"],
      ],
      content: "{broken",
    })),
  );
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Review channel" }));
  await user.click(await screen.findByRole("option", { name: "Reviews" }));
  await screen.findByText("No readable configurations in this channel.");
  await user.click(screen.getByRole("button", { name: "Register repository" }));
  await user.type(
    screen.getByRole("textbox", { name: "GitHub repository" }),
    "example-org/project",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Check tests.",
  );
  await user.type(screen.getByRole("textbox", { name: "Value" }), "review");
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  await user.click(
    screen.getByRole("button", { name: "Back to repositories" }),
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Register repository",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("saves multiple lane reviewers, reloads their identities, and preserves unavailable selections", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  await user.click(screen.getByRole("combobox", { name: "Agents" }));
  await user.click(
    await screen.findByRole("option", { name: "Backend reviewer (aaaaaaaa)" }),
  );
  await user.click(screen.getByRole("combobox", { name: "Agents" }));
  await user.click(
    await screen.findByRole("option", { name: "UI reviewer (bbbbbbbb)" }),
  );
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  const content = test.publish.mock.calls[0]?.[0].content;
  expect(JSON.parse(content ?? "{}").lanes[0].reviewers).toEqual([
    "a".repeat(64),
    "b".repeat(64),
  ]);
  await user.click(screen.getByRole("button", { name: "Reload" }));
  await user.click(
    await screen.findByRole("button", { name: "Edit General lane" }),
  );
  await screen.findByRole("button", {
    name: "Remove Backend reviewer from lane 1",
  });
  act(() => test.hideAgents());
  await screen.findByText("Backend reviewer — unavailable in this session");
  await user.click(
    screen.getByRole("button", { name: "Remove Backend reviewer from lane 1" }),
  );
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  expect(
    JSON.parse(test.publish.mock.calls[1]?.[0].content ?? "{}").lanes[0]
      .reviewers,
  ).toEqual(["b".repeat(64)]);
});

it("refreshes failed agent and archive reads without discarding the draft", async () => {
  const test = fixture();
  test.failAgents();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  expect(screen.getByText(/Inventory unavailable/)).toBeTruthy();
  expect(screen.getByText(/Archive read failed/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Refresh agents" }));
  expect(test.session.agentChoices.refresh).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole("combobox", { name: "Agents" }));
  await user.click(
    await screen.findByRole("option", { name: "Backend reviewer (aaaaaaaa)" }),
  );
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  expect(
    JSON.parse(test.publish.mock.calls[0]?.[0].content ?? "null").lanes[0]
      .reviewers,
  ).toEqual(["a".repeat(64)]);
});

it("selects the only channel, remembers another selection, and scopes it to the session", async () => {
  const test = fixture();
  const view = render(<ReviewConfigurationCommunity session={test.session} />);
  await screen.findByRole("button", { name: "Register repository" });
  expect(localStorage.getItem("buzz.review.channel:review-test-scope")).toBe(
    channel,
  );
  const second = "22222222-2222-4222-8222-222222222222";
  act(() =>
    test.setChannels([
      { id: channel, name: "Reviews", channelType: "stream" } as ChannelSummary,
      {
        id: second,
        name: "Other reviews",
        channelType: "stream",
      } as ChannelSummary,
    ]),
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name: "Review channel" }));
  await user.click(
    await screen.findByRole("option", { name: "Other reviews" }),
  );
  expect(localStorage.getItem("buzz.review.channel:review-test-scope")).toBe(
    second,
  );
  view.unmount();
  const restored = render(
    <ReviewConfigurationCommunity session={test.session} />,
  );
  expect(
    screen.getByRole("combobox", { name: "Review channel" }).textContent,
  ).toContain("Other reviews");
  restored.unmount();
  render(
    <ReviewConfigurationCommunity
      session={{ ...test.session, scope: "another-scope" } as RelaySession}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "Register repository" }),
  ).toBeNull();
  expect(localStorage.getItem("buzz.review.channel:review-test-scope")).toBe(
    second,
  );
});

it("saves path rules through field changes and preserves them after reload", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  await user.click(screen.getByRole("combobox", { name: "Field" }));
  await user.click(
    await screen.findByRole("option", { name: "Changed file path" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Value" }),
    "src/**/*.tsx",
  );
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  const saved = JSON.parse(test.publish.mock.calls[0]?.[0].content ?? "{}")
    .lanes[0].routing;
  expect(saved.rules[0]).toMatchObject({
    field: "path",
    operator: "matches",
    value: "src/**/*.tsx",
    id: expect.any(String),
  });
  await user.click(screen.getByRole("button", { name: "Reload" }));
  await user.click(
    await screen.findByRole("button", { name: "Edit General lane" }),
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Value",
      }) as HTMLInputElement
    ).value,
  ).toBe("src/**/*.tsx");
  expect(
    (
      screen.getByRole("button", {
        name: "Remove rule 1 from lane 1",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(test.publish).toHaveBeenCalledTimes(1);
});

it("preserves the remembered channel until pending metadata finishes", async () => {
  const test = fixture();
  const second = "22222222-2222-4222-8222-222222222222";
  localStorage.setItem("buzz.review.channel:review-test-scope", second);
  test.setChannels([
    { id: channel, name: "Reviews", channelType: "stream" } as ChannelSummary,
    { id: second, metadataPending: true } as ChannelSummary,
  ]);
  render(<ReviewConfigurationCommunity session={test.session} />);
  expect(localStorage.getItem("buzz.review.channel:review-test-scope")).toBe(
    second,
  );
  act(() =>
    test.setChannels([
      { id: channel, name: "Reviews", channelType: "stream" } as ChannelSummary,
      {
        id: second,
        name: "Remembered reviews",
        channelType: "stream",
      } as ChannelSummary,
    ]),
  );
  await screen.findByRole("button", { name: "Register repository" });
  expect(
    screen.getByRole("combobox", { name: "Review channel" }).textContent,
  ).toContain("Remembered reviews");
  expect(localStorage.getItem("buzz.review.channel:review-test-scope")).toBe(
    second,
  );
});

it("opens dedicated pages from configuration and blocks leaving lane drafts", async () => {
  const test = fixture();
  const onNavigate = vi.fn(async () => {});
  render(
    <ReviewConfigurationCommunity
      session={test.session}
      onNavigate={onNavigate}
    />,
  );
  const user = await openDraft();
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  expect(screen.queryByRole("region", { name: "PR submissions" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Edit General lane" }));
  expect(
    screen.queryByRole("button", { name: "Back to repositories" }),
  ).toBeNull();
  const field = screen.getByRole("textbox", { name: "Instructions" });
  await user.clear(field);
  await user.type(field, "Preserve draft");
  expect(screen.queryByRole("button", { name: "Submit PR" })).toBeNull();
  expect((field as HTMLTextAreaElement).value).toBe("Preserve draft");
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(
    screen.getByRole("button", { name: "Back to repositories" }),
  );
  await user.click(screen.getByRole("button", { name: "Submit PR" }));
  expect(onNavigate).toHaveBeenCalledWith("submit");
  await user.click(
    screen.getByRole("button", { name: "Open example-org/project" }),
  );
  expect(
    screen.getByRole("button", { name: "Edit General lane" }),
  ).toBeTruthy();
});

it("blocks editor entry while a reload can replace the repository", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  let finish!: (events: EventData[]) => void;
  test.snapshotRead.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Reload" }));
  try {
    expect(
      (
        screen.getByRole("button", {
          name: "Edit General lane",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  } finally {
    await act(async () => finish([]));
  }
  await screen.findByRole("button", { name: "Register repository" });
  expect(
    (
      screen.getByRole("combobox", {
        name: "Review channel",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("opens the separate submit page without repository or lane configuration", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} page="submit" />);
  await screen.findByRole("textbox", { name: "GitHub PR URL" });
  expect(screen.getByRole("button", { name: "Submit PR" })).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Register repository" }),
  ).toBeNull();
  expect(screen.queryByText("Repositories")).toBeNull();
});

it("opens Submit PR directly from Pull requests and preserves configuration navigation", async () => {
  const test = fixture();
  const onNavigate = vi.fn(async () => {});
  render(
    <ReviewConfigurationCommunity
      session={test.session}
      page="all"
      onNavigate={onNavigate}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Submit PR" }));
  expect(onNavigate).toHaveBeenCalledWith("submit");
  await user.click(
    screen.getByRole("button", { name: "Back to Review Configuration" }),
  );
  expect(onNavigate).toHaveBeenCalledWith("configuration");
});

it("requires a routing value and saves each lane before allowing another", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  const value = screen.getByRole("textbox", { name: "Value" });
  await user.clear(value);
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Each routing rule needs",
  );
  expect(test.publish).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "Add lane" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.type(value, "review");
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  await user.click(screen.getByRole("button", { name: "Add lane" }));
  await user.type(
    screen.getByRole("textbox", { name: "Lane name" }),
    "Backend",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Check quantity validation.",
  );
  await user.type(screen.getByRole("textbox", { name: "Value" }), "backend");
  expect(
    (screen.getByRole("button", { name: "Add lane" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await user.click(screen.getByRole("combobox", { name: "Agents" }));
  await user.click(
    await screen.findByRole("option", { name: "Backend reviewer (aaaaaaaa)" }),
  );
  expect(
    screen.getByRole("img", { name: "Backend reviewer avatar" }),
  ).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByRole("region", { name: "Backend lane" });
  const saved = JSON.parse(test.publish.mock.calls[1]?.[0].content ?? "{}");
  expect(saved.lanes.map((lane: { name: string }) => lane.name)).toEqual([
    "General",
    "Backend",
  ]);
  expect(test.publish.mock.calls[1]?.[0].tags).toContainEqual([
    "prev",
    test.publish.mock.calls[0]?.[0].id,
  ]);
  await user.click(screen.getByRole("button", { name: "Edit Backend lane" }));
  expect(
    (screen.getByRole("textbox", { name: "Value" }) as HTMLInputElement).value,
  ).toBe("backend");
  await user.click(screen.getByRole("button", { name: "Back to lanes" }));
  expect(screen.getByRole("button", { name: "Edit Backend lane" })).toBe(
    document.activeElement,
  );
  expect(test.publish).toHaveBeenCalledTimes(2);
});

it("returns focus to the lane region after removing the edited lane", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  await user.click(screen.getByRole("button", { name: "Add lane" }));
  await user.type(screen.getByRole("textbox", { name: "Lane name" }), "Second");
  await user.type(
    screen.getByRole("textbox", { name: "Instructions" }),
    "Review tests",
  );
  await user.type(screen.getByRole("textbox", { name: "Value" }), "tests");
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await user.click(
    await screen.findByRole("button", { name: "Edit Second lane" }),
  );
  await user.click(screen.getByRole("button", { name: "Remove lane" }));
  expect(test.publish).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole("button", { name: "Confirm remove lane" }));
  await waitFor(() =>
    expect(
      screen.getByRole("region", { name: "Repository configuration" }),
    ).toBe(document.activeElement),
  );
  expect(
    JSON.parse(test.publish.mock.calls[2]?.[0].content ?? "{}").lanes.map(
      (lane: { name: string }) => lane.name,
    ),
  ).toEqual(["General"]);
});

it("opens the PR table from the home page action", async () => {
  const test = fixture();
  const onNavigate = vi.fn(async () => {});
  render(
    <ReviewConfigurationCommunity
      session={test.session}
      onNavigate={onNavigate}
    />,
  );
  const user = userEvent.setup();
  await screen.findByRole("button", { name: "Register repository" });
  expect(screen.queryByRole("region", { name: "Pull requests" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Pull requests" }));
  expect(onNavigate).toHaveBeenCalledWith("all");
  await user.click(screen.getByRole("button", { name: "Submit PR" }));
  expect(onNavigate).toHaveBeenCalledWith("submit");
});

it("saves independent admission checkboxes and preserves them through lane edits", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  const ready = await screen.findByRole("checkbox", {
    name: "Require ready for review (non-draft)",
  });
  expect(ready.getAttribute("aria-checked")).toBe("false");
  await user.click(ready);
  expect(
    screen.getByRole("button", { name: "Edit General lane" }),
  ).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Back to repositories" }),
  ).toHaveProperty("disabled", true);
  await user.click(
    screen.getByRole("checkbox", { name: "Enable agent triage" }),
  );
  await user.click(
    screen.getByRole("button", { name: "Save admission checks" }),
  );
  await screen.findByRole("alert");
  await user.click(screen.getByRole("combobox", { name: "Triage agent" }));
  await user.click(
    await screen.findByRole("option", { name: "Backend reviewer" }),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Triage instructions" }),
    "Reject duplicate PRs.",
  );
  await user.click(
    screen.getByRole("button", { name: "Save admission checks" }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Edit General lane" }),
    ).toHaveProperty("disabled", false),
  );
  const admission = JSON.parse(
    test.publish.mock.calls[1]?.[0].content ?? "{}",
  ).admission;
  expect(admission).toMatchObject({
    ready: true,
    ci: false,
    conflicts: false,
    triage: true,
    agent: "a".repeat(64),
    instructions: "Reject duplicate PRs.",
  });
  await user.click(screen.getByRole("button", { name: "Edit General lane" }));
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await waitFor(() => expect(test.publish).toHaveBeenCalledTimes(3));
  expect(
    JSON.parse(test.publish.mock.calls[2]?.[0].content ?? "{}").admission,
  ).toEqual(admission);
});

it("starts approval unchecked and persists an explicit opt-in", async () => {
  const test = fixture();
  render(<ReviewConfigurationCommunity session={test.session} />);
  const user = await openDraft();
  const checkbox = screen.getByRole("checkbox", {
    name: "Allow automatic approval",
  });
  expect(checkbox.getAttribute("aria-checked")).toBe("false");
  await user.click(checkbox);
  await user.click(screen.getByRole("button", { name: "Save lane" }));
  await screen.findByText("Saved example-org/project.");
  const saved = JSON.parse(test.publish.mock.calls[0]?.[0].content ?? "{}");
  expect(saved.lanes[0].autoApprove).toBe(true);
});

it("keeps the addressed detail during a transient navigation handoff, then returns to the list", async () => {
  const test = fixture();
  const snapshot = {
    status: "ready",
    scope: test.session.scope,
    generation: 1,
    session: test.session,
  };
  const relay = {
    snapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as RelayData;
  const target = {
    version: 1,
    kind: "page",
    pluginId: "buzz.review-configuration",
    pageId: "all",
    route: { version: 1, params: { channel, submission: "submission" } },
  } as const;
  const detail = { target } as unknown as PageNavigation;
  const content = (navigation?: PageNavigation) => (
    <ReviewConfigurationPage relay={relay} page="all" navigation={navigation} />
  );
  const view = render(content(detail));
  await screen.findByRole("button", { name: "Back to Pull requests" });
  view.rerender(content());
  expect(
    screen.getByRole("button", { name: "Back to Pull requests" }),
  ).toBeTruthy();
  expect(screen.queryByText("Submitted pull requests")).toBeNull();
  view.rerender(
    content({
      target: { ...target, route: undefined },
    } as unknown as PageNavigation),
  );
  expect(screen.getByText("Submitted pull requests")).toBeTruthy();
});
