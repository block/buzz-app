// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { composerDOMFixture } from "../../features/messages/composer-testing";
import { deferred } from "../builderlab/test-helpers";
import type { Agent } from "../../features/agents/service";
import type { ChannelMessage } from "../../features/relay/contracts";
import {
  chooseDefaultAgent,
  clearDefaultAgent,
} from "../../features/solo/default-agent";
import { bestieFixture, cleanups, COMMUNITY } from "./testing";

const native = vi.hoisted(() => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => native);
composerDOMFixture();
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

beforeEach(() => {
  vi.stubEnv("VITE_BUZZ_BUILDERLAB_URL", "https://builderlab.example");
});
afterEach(async () => {
  cleanup();
  for (const dispose of cleanups.splice(0).reverse()) await dispose();
  localStorage.clear();
  native.invoke.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const renderPage = (h: Awaited<ReturnType<typeof bestieFixture>>) => {
  const Page = h.pages.snapshot()[0]?.component;
  if (!Page) throw new Error("Missing Bestie page");
  return render(<Page />);
};

it("waits for the account choice before showing the chooser", async () => {
  const choice = deferred<string | undefined>();
  const h = await bestieFixture(native.invoke, {
    mainAgent: {
      read: () => choice.promise,
      write: async () => {},
    },
  });
  renderPage(h);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Reading your saved choice.",
  );
  expect(
    screen.queryByRole("button", { name: "Create an agent" }),
  ).not.toBeInTheDocument();
  await act(async () => choice.resolve(undefined));
  expect(
    await screen.findByRole("button", { name: "Create an agent" }),
  ).toBeVisible();
});

it("offers first-agent creation without automatically opening its dialog", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  expect(
    await screen.findByRole("heading", {
      name: "Create your first agent",
    }),
  ).toBeVisible();
  expect(
    screen.getByText(
      "Buzz is better with your agents. Create one to get started.",
    ),
  ).toBeVisible();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Set up Bestie" }),
  ).not.toBeInTheDocument();
});

it("keeps the registered Bestie tab in sync with the account choice", async () => {
  const h = await bestieFixture(native.invoke, {
    mainAgent: { read: async () => undefined, write: async () => {} },
  });
  const tab = h.agents.addedTabs().find((item) => item.id === "bestie");
  expect(tab).toBeDefined();
  const agent = {
    pubkey: h.agent,
    relay: COMMUNITY,
    owner: h.viewer,
    place: "here",
  } as Agent;
  expect(tab?.when?.(agent)).toBe(false);
  await chooseDefaultAgent(h.session(), h.session().scope, h.agent);
  expect(tab?.when?.(agent)).toBe(true);
  await clearDefaultAgent(h.session(), h.session().scope);
  expect(tab?.when?.(agent)).toBe(false);
});

it("registers the compact catch-up renderer only for the owner's generated request", async () => {
  const h = await bestieFixture(native.invoke);
  const renderer = h.conversation.messages
    .snapshot()
    .find((item) => item.key === "buzz.bestie/catch-up-request");
  expect(renderer).toBeDefined();
  const source = `buzz://message?channel=design&id=${"c".repeat(64)}`;
  const content = `@Pollen Read the entire [thread](${source}), including its root and every reply, then catch me up. Lead with the few things most relevant to me based on what you know about my priorities, work, and people, and briefly say why. If you lack that context, prioritize decisions, direct asks, risks, blockers, and meaningful changes. Summarize everything else at a very high level. Link the important sources, and skip the play-by-play unless I ask.`;
  const request = {
    id: "d".repeat(64),
    channelId: "solo",
    authorId: h.viewer,
    createdAt: 1,
    content,
    mentions: [h.agent],
    attachments: [],
    reactions: [],
    participants: [],
    replyCount: 0,
  } satisfies ChannelMessage;
  expect(renderer?.matches(request)).toBe(true);
  expect(renderer?.matches({ ...request, authorId: h.agent })).toBe(false);
  expect(renderer?.matches({ ...request, mentions: [] })).toBe(false);
  expect(renderer?.matches({ ...request, content: "Catch me up" })).toBe(false);
});

it("opens the existing new-agent dialog from the chooser", async () => {
  const h = await bestieFixture(native.invoke);
  renderPage(h);
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("button", { name: "Create an agent" }),
  );
  expect(screen.getByRole("dialog", { name: "Create agent" })).toBeVisible();
});
