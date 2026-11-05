// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ShareApp } from "./ShareApp";
import type { JoinedCommunity } from "./communities";

afterEach(cleanup);

const URL = "https://demo--bpsites.apps.example/";
const HERE: JoinedCommunity = {
  id: "here",
  name: "Alpha",
  address: "wss://alpha.example.com",
};
const OTHER: JoinedCommunity = {
  id: "other",
  name: "Beta",
  address: "wss://beta.example.com",
};

function setup({
  owned = "demo",
  shared = [] as string[],
  joined = [OTHER, HERE],
} = {}) {
  let held: ((value: Record<string, unknown>) => void) | undefined;
  const client = {
    find: vi.fn(async () => owned),
    shared: vi.fn(async () => shared),
    community: vi.fn(
      () =>
        new Promise<Record<string, unknown>>((resolve) => {
          held = resolve;
        }),
    ),
  };
  const apps = () => client;
  const communities = vi.fn(async () => joined);
  const relay = {
    subscribe: () => () => {},
    snapshot: () => ({ origin: "wss://Alpha.example.com" }) as never,
  };
  render(
    <ShareApp url={URL} apps={apps} communities={communities} relay={relay} />,
  );
  return {
    client,
    communities,
    release: (body: Record<string, unknown>) => held?.(body),
  };
}

it("shows nothing for an app the account doesn't own", async () => {
  const { client } = setup({ owned: "" });
  await waitFor(() => expect(client.find).toHaveBeenCalledWith(URL));
  expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
});

it("puts this community first and shares with it in one switch", async () => {
  const user = userEvent.setup();
  const { client, release } = setup({ shared: ["other"] });
  await user.click(await screen.findByRole("button", { name: "Share" }));
  const here = await screen.findByRole("switch", {
    name: "Share with Alpha",
  });
  expect(here).not.toBeChecked();
  expect(screen.getByRole("switch", { name: "Beta" })).toBeChecked();
  expect(screen.getByText("Other communities")).toBeInTheDocument();

  await user.click(here);
  expect(client.community).toHaveBeenCalledWith("demo", "here", "grant");
  expect(await screen.findByText("Saving…")).toBeInTheDocument();
  expect(screen.getByRole("switch", { name: "Beta" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  release({ shared_community_ids: ["other", "here"] });
  await waitFor(() => expect(here).toBeChecked());
  expect(screen.queryByText("Saving…")).toBeNull();
});

it("turns the last shared community off when Compose omits the empty list", async () => {
  const user = userEvent.setup();
  const { client, release } = setup({ shared: ["here"] });
  await user.click(await screen.findByRole("button", { name: "Share" }));
  const here = await screen.findByRole("switch", { name: "Share with Alpha" });
  expect(here).toBeChecked();
  await user.click(here);
  expect(client.community).toHaveBeenCalledWith("demo", "here", "revoke");
  release({ ok: true, community_grant_revision: 4 });
  await waitFor(() => expect(here).not.toBeChecked());
});

it("keeps a failed change off and says why beside it", async () => {
  const user = userEvent.setup();
  const { client } = setup();
  client.community.mockRejectedValueOnce(
    new Error("Sharing failed (HTTP 403)"),
  );
  await user.click(await screen.findByRole("button", { name: "Share" }));
  const beta = await screen.findByRole("switch", { name: "Beta" });
  await user.click(beta);
  expect(
    await screen.findByText("Sharing failed (HTTP 403)"),
  ).toBeInTheDocument();
  expect(beta).not.toBeChecked();
  expect(beta).not.toHaveAttribute("aria-disabled");
});

it("explains an empty or unreadable community list", async () => {
  const user = userEvent.setup();
  setup({ joined: [] });
  await user.click(await screen.findByRole("button", { name: "Share" }));
  expect(
    await screen.findByText(
      "You haven’t joined any communities you can share with.",
    ),
  ).toBeInTheDocument();
  cleanup();

  const { communities } = setup();
  communities.mockRejectedValueOnce(
    new Error("Couldn’t load your communities (HTTP 500)."),
  );
  await user.click(await screen.findByRole("button", { name: "Share" }));
  expect(
    await screen.findByText("Couldn’t load your communities (HTTP 500)."),
  ).toBeInTheDocument();
});
