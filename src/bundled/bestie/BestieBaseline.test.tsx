// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { MemoryListing } from "../../features/agents/memory";
import { createRelaySession } from "../../features/relay/session";
import {
  keypair,
  roster,
  metadata,
  signed,
} from "../../features/relay/testing";
import { JourneyState } from "./BestieBaseline";
import { baselineFixture } from "./baseline-testing";
import { parseBaseline } from "./baseline";

const viewer = keypair(),
  agent = keypair(),
  relay = keypair();
const channel = "11111111-1111-4111-8111-111111111111";
const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
});
const entry = () => ({
  slug: "mem/bestie",
  eventId: "e".repeat(64),
  createdAt: 1790000002,
  body: JSON.stringify(baselineFixture(viewer.pubkey, channel)),
});
function setup(
  read: () => Promise<MemoryListing> = async () => ({
    entries: [entry()],
    partial: false,
  }),
) {
  const publish = vi.fn(async () => {});
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      scope: "https://relay.example.test",
      media: () => undefined,
      readAgentMemories: read,
      query: async (filters) =>
        filters.flatMap((filter) =>
          filter.kinds?.includes(39002)
            ? [roster(relay, channel, [viewer.pubkey, agent.pubkey])]
            : filter.kinds?.includes(39000)
              ? [metadata(relay, channel, "Private home")]
              : [],
        ),
      writer: {
        kinds: [9],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save() {} } },
  );
  owners.push(owner);
  return { owner, publish };
}
it("renders private records, sends an exact recipient request, and waits for state readback", async () => {
  const { owner, publish } = setup();
  const user = userEvent.setup();
  owner.session.channels.ensureList();
  owner.session.channels.ensure(channel);
  await waitFor(() =>
    expect(
      owner.session.channels.list().channels.some((row) => row.id === channel),
    ).toBe(true),
  );
  render(
    <StrictMode>
      <JourneyState
        session={owner.session}
        channelId={channel}
        pubkey={agent.pubkey}
        name="Bestie"
      />
    </StrictMode>,
  );
  await screen.findByText(/Saved revision 3/);
  await user.click(screen.getByText("Alex"));
  expect(screen.getAllByText("Alex is my brother").length).toBeGreaterThan(0);
  await user.click(
    screen.getByRole("button", { name: "Run dream reflection now" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "No state change is confirmed yet",
  );
  await waitFor(() => expect(publish).toHaveBeenCalledOnce());
  const sent = owner.session.outbox
    ?.snapshot()
    .find((row) => row.event.kind === 9);
  expect(sent?.event.tags).toContainEqual(["p", agent.pubkey]);
  expect(sent?.event.content).toContain("Run the dream operation now");
  expect(screen.getByText(/Saved revision 3/)).toBeVisible();
  await act(() => owner.clearCache());
  expect(screen.queryByText("Alex")).toBeNull();
});
it("does not expose another home or enable partial-snapshot controls", async () => {
  const wrong = setup();
  const page = render(
    <JourneyState
      session={wrong.owner.session}
      channelId="other"
      pubkey={agent.pubkey}
      name="Bestie"
    />,
  );
  await screen.findByRole("alert");
  expect(screen.queryByText("Alex")).toBeNull();
  const partial = setup(async () => ({ entries: [entry()], partial: true }));
  page.rerender(
    <JourneyState
      session={partial.owner.session}
      channelId={channel}
      pubkey={agent.pubkey}
      name="Bestie"
    />,
  );
  await screen.findByText(/Partial memory snapshot/);
  expect(
    screen.getByRole("button", { name: "Run dream reflection now" }),
  ).toBeDisabled();
});
it("clears sensitive data while refreshing and rejects late reads after unmount", async () => {
  let release: ((value: MemoryListing) => void) | undefined;
  let hold = false;
  const read = vi.fn(async () =>
    hold
      ? await new Promise<MemoryListing>((resolve) => {
          release = resolve;
        })
      : { entries: [entry()], partial: false },
  );
  const { owner } = setup(read);
  const page = render(
    <JourneyState
      session={owner.session}
      channelId={channel}
      pubkey={agent.pubkey}
      name="Bestie"
    />,
  );
  await screen.findByText("Alex");
  hold = true;
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Refresh journey" }));
  await waitFor(() => expect(release).toBeDefined());
  expect(screen.queryByText("Alex")).toBeNull();
  expect(screen.getByRole("status")).toHaveTextContent("Loading journey");
  page.unmount();
  await act(async () => release?.({ entries: [entry()], partial: false }));
  expect(screen.queryByText("Alex")).toBeNull();
});
it("rejects malformed model-produced memory before rendering controls", () => {
  expect(
    parseBaseline({
      ...entry(),
      body: '{"version":1,"memory":{"people":null}}',
    }),
  ).toBeUndefined();
  const state = baselineFixture(viewer.pubkey, channel);
  state.memory.people = {
    invalid: { title: "Invalid", links: [], revisions: [] },
  };
  expect(
    parseBaseline({ ...entry(), body: JSON.stringify(state) }),
  ).toBeUndefined();
});
