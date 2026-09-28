// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Context } from "@deepseek-ai/cordis";
import { invoke } from "@tauri-apps/api/core";
import type { EventTemplate } from "nostr-tools";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommunityDialog } from "./CommunityDialog";
import { createCommunities } from "./service";
import { createJoinJournal } from "./join-journal";
import { connectNativeTransport } from "../relay/native";
import { keypair, signed } from "../relay/testing";
import type { RelayEvent } from "../relay/events";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
const viewer = keypair(),
  relay = keypair();
const community = "https://native-join.test";
const roots: Context[] = [];
const calls: Array<{ path: string; body: unknown }> = [];
let admitted: boolean;
let profile: RelayEvent | undefined;
let claim: () => Promise<void>;
let publish: () => Promise<void>;
const journal = () => createJoinJournal(viewer.pubkey);
beforeEach(() => {
  localStorage.clear();
  admitted = false;
  profile = undefined;
  calls.length = 0;
  claim = async () => {};
  publish = async () => {};
  vi.stubEnv("VITE_BUZZ_LIVE", "0");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No development broker");
    }),
  );
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return viewer.pubkey;
    if (command === "relay_sign")
      return signed(viewer, (args as { event: EventTemplate }).event);
    if (command !== "relay_http")
      throw new Error(`Unexpected command ${command}`);
    const request = args as {
      community: string;
      path: string;
      body: string | null;
    };
    expect(request.community).toBe(community);
    const body = request.body ? JSON.parse(request.body) : undefined;
    calls.push({ path: request.path, body });
    const response = (value: unknown, status = 200) => ({
      status,
      headers: {},
      body: JSON.stringify(value),
    });
    switch (request.path) {
      case "/":
        return response({
          self: relay.pubkey,
          pubkey: viewer.pubkey,
          name: "Native community",
        });
      case "/api/join-policy":
        return response({
          policy: {
            version: "v1",
            terms_markdown: "Terms",
            privacy_markdown: null,
            age_attestation_required: true,
          },
        });
      case "/api/invites/accept-policy":
        return response({ receipt: "fixture-receipt" });
      case "/api/invites/claim":
        expect(journal().get(community)).toBeDefined();
        admitted = true;
        await claim();
        return response({ status: "joined" });
      case "/query":
        if (!admitted) return response({ error: "membership required" }, 403);
        return response(
          body.some((filter: { kinds?: number[] }) =>
            filter.kinds?.includes(0),
          ) && profile
            ? [profile]
            : [],
        );
      case "/events":
        expect(journal().get(community)?.profile).toBeDefined();
        profile = body;
        await publish();
        return response({ accepted: true, event_id: profile?.id });
      default:
        throw new Error(`Unexpected path ${request.path}`);
    }
  });
});
afterEach(async () => {
  cleanup();
  for (const root of roots.splice(0)) await root.fiber.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function open() {
  const ctx = new Context();
  roots.push(ctx);
  const communities = createCommunities(
    ctx,
    false,
    undefined,
    "",
    undefined,
    Promise.resolve(viewer.pubkey),
    connectNativeTransport,
  );
  await waitFor(() => expect(communities.snapshot().status).toBe("ready"));
  const close = vi.fn();
  const view = render(
    <CommunityDialog communities={communities} mode="join" close={close} />,
  );
  return {
    communities,
    close,
    async stop() {
      view.unmount();
      await ctx.fiber.dispose();
    },
  };
}
async function start(user: ReturnType<typeof userEvent.setup>) {
  await user.clear(screen.getByLabelText("Relay URL"));
  await user.type(screen.getByLabelText("Relay URL"), community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(
    await screen.findByLabelText("Invite code (if required)"),
    "v2.fixture",
  );
  await user.click(screen.getByRole("checkbox", { name: /I agree/ }));
  await user.click(screen.getByRole("checkbox", { name: /at least 18/ }));
}

it("resumes after an uncertain claim, saves the profile, and restores only the selected native session", async () => {
  const user = userEvent.setup();
  claim = async () => {
    throw new Error("Claim receipt lost");
  };
  const first = await open();
  await start(user);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Claim receipt lost",
  );
  expect(first.communities.snapshot().memberships).toEqual([]);
  const saved = localStorage.getItem(
    `buzz-community-joins.v1:${viewer.pubkey}`,
  );
  expect(saved).toContain(community);
  expect(saved).not.toMatch(/v2.fixture|fixture-receipt/);
  await first.stop();
  const second = await open();
  expect(screen.getByLabelText("Relay URL")).toHaveValue(community);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(
    await screen.findByLabelText("Display name"),
    "Recovered identity",
  );
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  await waitFor(() => expect(second.close).toHaveBeenCalledOnce());
  expect(second.communities.snapshot().selected).toBe(community);
  expect(journal().latest()).toBeUndefined();
  expect(
    calls.filter((call) => call.path === "/api/invites/claim"),
  ).toHaveLength(1);
  expect(
    calls.find((call) => call.path === "/api/invites/claim")?.body,
  ).toEqual({ code: "v2.fixture", policy_receipt: "fixture-receipt" });
  expect(calls.filter((call) => call.path === "/events")).toHaveLength(1);
  await second.stop();
  calls.length = 0;
  const stored = JSON.parse(
    localStorage.getItem(`buzz-client.v1:${viewer.pubkey}`) ?? "null",
  );
  stored.memberships.push({ id: "https://unopened.test", name: "Unopened" });
  localStorage.setItem(
    `buzz-client.v1:${viewer.pubkey}`,
    JSON.stringify(stored),
  );
  const third = await open();
  await waitFor(() =>
    expect(third.communities.relay.snapshot().status).toBe("ready"),
  );
  expect(third.communities.relay.snapshot().viewer).toBe(viewer.pubkey);
  expect(third.communities.relay.snapshot().scope).toBe(
    `${community}:${viewer.pubkey}`,
  );
  expect(third.communities.snapshot().memberships).toHaveLength(2);
  expect(fetch).not.toHaveBeenCalled();
});

it("retains submitted profile progress through publication and local membership-save failures", async () => {
  admitted = true;
  journal().begin(community);
  const user = userEvent.setup();
  const first = await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.type(
    await screen.findByLabelText("Display name"),
    "Durable draft",
  );
  publish = async () => {
    throw new Error("Profile receipt lost");
  };
  await user.click(
    screen.getByRole("button", { name: "Publish profile & open" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Profile receipt lost",
  );
  await first.stop();
  const second = await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByLabelText("Display name")).toHaveValue(
    "Durable draft",
  );
  const setItem = Storage.prototype.setItem;
  const writes = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(function (this: Storage, key, value) {
      if (key.startsWith("buzz-client.v1:")) throw new Error("Full disk");
      setItem.call(this, key, value);
    });
  await user.click(screen.getByRole("button", { name: "Open community" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save this community",
  );
  expect(second.close).not.toHaveBeenCalled();
  expect(second.communities.snapshot().memberships).toEqual([]);
  expect(journal().get(community)?.profile?.name).toBe("Durable draft");
  writes.mockRestore();
  await second.stop();
  const third = await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await user.click(
    await screen.findByRole("button", { name: "Open community" }),
  );
  await waitFor(() => expect(third.close).toHaveBeenCalledOnce());
  expect(calls.filter((call) => call.path === "/events")).toHaveLength(1);
  expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(false);
});

it("does not dispatch admission when its recovery record cannot be persisted", async () => {
  const user = userEvent.setup();
  await open();
  await start(user);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Full disk");
  });
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not save community setup",
  );
  expect(calls.some((call) => call.path.startsWith("/api/invites/"))).toBe(
    false,
  );
});

it("restores a configured alias as a usable relay URL", async () => {
  journal().begin("primary");
  await open();
  expect(screen.getByLabelText("Relay URL")).toHaveValue(
    "https://primary.example",
  );
});

it("retains pending admission during network failure without redeeming the invite again", async () => {
  journal().begin(community);
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Relay offline"));
  const user = userEvent.setup();
  await open();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Relay offline");
  expect(journal().get(community)).toBeDefined();
  expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(false);
  admitted = true;
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Display name");
});

it("fences a late claim completion after the dialog is replaced", async () => {
  let release!: () => void;
  claim = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const user = userEvent.setup();
  const first = await open();
  await start(user);
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() =>
    expect(calls.some((call) => call.path === "/api/invites/claim")).toBe(true),
  );
  try {
    await first.stop();
    await open();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByLabelText("Display name");
    const queries = calls.filter((call) => call.path === "/query").length;
    await act(async () => release());
    expect(calls.filter((call) => call.path === "/query")).toHaveLength(
      queries,
    );
    expect(first.close).not.toHaveBeenCalled();
    expect(first.communities.snapshot().memberships).toEqual([]);
  } finally {
    release();
  }
});
