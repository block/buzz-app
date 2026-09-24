// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { npubEncode } from "nostr-tools/nip19";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, profile, roster, signed } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import { PublishRejected } from "../../features/relay/outbox";
import { ChannelMembersButton } from "./ChannelMembersDialog";
const stops: (() => void)[] = [];
afterEach(() => {
  cleanup();
  for (const stop of stops.splice(0)) stop();
});
async function setup(type = "stream") {
  const viewer = keypair(),
    relay = keypair(),
    person = keypair();
  const id = "11111111-1111-4111-8111-111111111111";
  const members = [viewer.pubkey];
  let clock = 1700000000;
  let failure = "";
  let searchFailure = false;
  let release: (() => void) | undefined;
  const publish = vi.fn(async () => {
    if (failure) throw new PublishRejected(failure);
    if (release)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    members.push(person.pubkey);
    clock++;
  });
  const query = vi.fn(async (filters: Parameters<typeof matchesEvent>[1][]) => {
    if (filters.some((filter) => filter.search)) {
      if (searchFailure) throw new Error("Search offline");
      return [profile(person, { name: "Morgan" })];
    }
    return [
      roster(relay, id, members, clock),
      signed(relay, {
        kind: 39000,
        content: "",
        tags: [["d", id], ["t", type], ["private"], ["name", "Design"]],
      }),
      profile(viewer, { name: "Carl" }),
      profile(person, { name: "Morgan" }),
    ].filter((event) => filters.some((filter) => matchesEvent(event, filter)));
  });
  const owner = createRelaySession(
    {
      viewer: viewer.pubkey,
      relayAuthor: relay.pubkey,
      media: () => undefined,
      query,
      readAgentLibrary: async () => ({ definitions: [], identities: [] }),
      writer: {
        kinds: [9, 9000, 9007],
        sign: async (template) => signed(viewer, template),
        publish,
      },
    },
    { outboxStorage: { load: () => [], save: () => {} } },
  );
  stops.push(owner.dispose);
  owner.session.channels.ensureList();
  await vi.waitFor(() =>
    expect(owner.session.channels.list().status).toBe("ready"),
  );
  render(<ChannelMembersButton session={owner.session} channelId={id} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Channel members" }));
  await screen.findByText("Carl (you)");
  return {
    user,
    publish,
    query,
    session: owner.session,
    person,
    viewer,
    fail: (value: string) => {
      failure = value;
    },
    failSearch: () => {
      searchFailure = true;
    },
    hold: () => {
      release = () => {};
    },
    release: () => release?.(),
    async search() {
      await user.type(screen.getByRole("searchbox"), "Morgan");
      return screen.findByRole("button", { name: /Add Morgan/ });
    },
  };
}
it("searches outside the roster, prevents double submission, and moves confirmed additions into Members", async () => {
  const t = await setup();
  const add = await t.search();
  t.hold();
  await t.user.click(add);
  await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
  expect(add).toBeDisabled();
  await t.user.click(add);
  expect(t.publish).toHaveBeenCalledOnce();
  await act(async () => t.release());
  await screen.findByText("Morgan is in the channel.");
  expect(
    screen.queryByRole("button", { name: /Add Morgan/ }),
  ).not.toBeInTheDocument();
  expect(t.session.channels.list().channels[0]?.members).toContain(
    t.person.pubkey,
  );
});
it("shows the real rejection and retries without discarding the query", async () => {
  const t = await setup();
  t.fail("Only the owner can add this agent");
  await t.user.click(await t.search());
  await screen.findByText(/Only the owner/);
  expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
  t.fail("");
  await t.user.click(
    screen.getByRole("button", { name: "Retry", exact: true }),
  );
  await screen.findByText("Morgan is in the channel.");
});
it("DMs are view-only and never search outside their members", async () => {
  const t = await setup("dm");
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  expect(
    screen.getByText("DM membership cannot be changed here."),
  ).toBeVisible();
  expect(
    screen.queryByRole("region", { name: "Not in this channel" }),
  ).not.toBeInTheDocument();
  expect(
    t.query.mock.calls.some(([filters]) =>
      filters.some((filter) => filter.search),
    ),
  ).toBe(false);
});
it("Escape closes the dialog and restores focus to its header button", async () => {
  const t = await setup();
  expect(screen.getByRole("searchbox")).toHaveFocus();
  await t.user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("button", { name: "Channel members" })).toHaveFocus();
});
it("failed directory searches show retry, not a false empty result", async () => {
  const t = await setup();
  t.failSearch();
  await t.user.type(screen.getByRole("searchbox"), "Morgan");
  const section = screen.getByRole("region", { name: "Not in this channel" });
  await within(section).findByRole("button", { name: "Retry search" });
  expect(
    within(section).queryByText("No other matching people or agents."),
  ).not.toBeInTheDocument();
});

it("finds an existing member by their canonical public key", async () => {
  const t = await setup("dm");
  await t.user.type(screen.getByRole("searchbox"), npubEncode(t.viewer.pubkey));
  expect(screen.getByText("Carl (you)")).toBeVisible();
});
