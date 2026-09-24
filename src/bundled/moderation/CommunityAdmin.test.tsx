// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { RelayData } from "../../features/relay/service";
import { allowedActions, membersFromSnapshot } from "./api";
import { CommunityAdmin } from "./CommunityAdmin";

const relayKey = "f".repeat(64);
const owner = "0".repeat(64);
const admin = "1".repeat(64);
const member = "2".repeat(64);
const snapshot = (tags: string[][], pubkey = relayKey) => ({
  id: "e".repeat(64),
  kind: 13534,
  pubkey,
  created_at: 1,
  content: "",
  sig: "",
  tags,
});
const roster = [
  ["-"],
  ["member", owner, "owner"],
  ["member", admin, "admin"],
  ["member", member, "member"],
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reads roles only from the relay-signed member list", () => {
  expect(membersFromSnapshot(snapshot(roster), relayKey)).toEqual([
    { pubkey: owner, role: "owner" },
    { pubkey: admin, role: "admin" },
    { pubkey: member, role: "member" },
  ]);
  expect(() =>
    membersFromSnapshot(snapshot(roster, owner), relayKey),
  ).toThrow();
  expect(
    membersFromSnapshot(
      snapshot([
        ["p", admin, "", "owner"],
        ["member", "A".repeat(64), "owner"],
      ]),
      relayKey,
    ),
  ).toEqual([]);
});

it("offers only actions the relay permission matrix allows", () => {
  const m = (role: "owner" | "admin" | "member") => ({ pubkey: member, role });
  expect(allowedActions("owner", m("member"), false)).toEqual([
    "promote",
    "remove",
  ]);
  expect(allowedActions("owner", m("admin"), false)).toEqual([
    "demote",
    "remove",
  ]);
  expect(allowedActions("owner", m("owner"), false)).toEqual([]);
  expect(allowedActions("owner", m("admin"), true)).toEqual([]);
  expect(allowedActions("admin", m("member"), false)).toEqual(["remove"]);
  expect(allowedActions("admin", m("admin"), false)).toEqual([]);
  expect(allowedActions("member", m("member"), false)).toEqual([]);
  expect(allowedActions(undefined, m("member"), false)).toEqual([]);
});

function relay(viewer: string, events = [snapshot(roster)]) {
  const read = vi.fn(async () => events);
  const profiles = new Map();
  const session = {
    read,
    profiles: {
      subscribe: () => () => {},
      snapshot: () => profiles,
      ensure: async () => {},
    },
  };
  const value = {
    status: "ready",
    generation: 1,
    scope: `https://primary.example:${viewer}`,
    viewer,
    session,
  };
  return {
    read,
    relay: {
      snapshot: () => value,
      subscribe: () => () => {},
    } as unknown as RelayData,
  };
}

function broker(routes: Record<string, (body: unknown) => Response>) {
  const calls: { route: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const route = String(url).split("/").at(-1) ?? "";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ route, body });
      if (route === "session") return Response.json({ relayAuthor: relayKey });
      return routes[route]?.(body) ?? Response.json({}, { status: 404 });
    }),
  );
  return calls;
}

it("gates administration to owners and admins by the verified roster", async () => {
  broker({});
  const { relay: data, read } = relay(member);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(
    await screen.findByText(
      "Only community owners and admins can invite people or manage members.",
    ),
  ).toBeVisible();
  expect(read).toHaveBeenCalledWith(
    [{ kinds: [13534], authors: [relayKey], limit: 1 }],
    expect.objectContaining({ fresh: true }),
  );
  expect(
    screen.queryByRole("button", { name: "Invite to community" }),
  ).toBeNull();
});

it("treats a roster signed by anyone else as unavailable", async () => {
  broker({});
  const { relay: data } = relay(owner, [snapshot(roster, owner)]);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load members",
  );
});

it("mints a bounded invite and surfaces relay refusals", async () => {
  const user = userEvent.setup();
  let refuse = false;
  const calls = broker({
    invite: (body) =>
      refuse
        ? Response.json(
            { error: "only relay owners and admins can create invites" },
            { status: 403 },
          )
        : Response.json({
            code: "abc",
            url: "https://primary.example/invite/abc",
            expires_at: 1700003600,
            max_uses: (body as { max_uses: number | null }).max_uses,
            uses_remaining: (body as { max_uses: number | null }).max_uses,
          }),
  });
  const { relay: data } = relay(admin);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await user.click(
    await screen.findByRole("button", { name: "Invite to community" }),
  );
  // Admins cannot grant admin, so no role choice is offered.
  expect(screen.queryByRole("combobox", { name: "Role" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Create invite link" }));
  expect(
    await screen.findByDisplayValue("https://primary.example/invite/abc"),
  ).toBeVisible();
  expect(calls.find((c) => c.route === "invite")?.body).toEqual({
    ttl_secs: 3 * 24 * 60 * 60,
    max_uses: null,
  });
  expect(screen.getByText(/No use limit/)).toBeVisible();
  refuse = true;
  await user.click(screen.getByRole("button", { name: "Create another link" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "only relay owners and admins can create invites",
    ),
  );
  expect(
    screen.queryByDisplayValue("https://primary.example/invite/abc"),
  ).toBeNull();
});

it("confirms member removal and shows the relay's refusal", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () =>
      Response.json(
        { error: "invalid: cannot remove the relay owner" },
        { status: 400 },
      ),
  });
  const { relay: data } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(
    screen.queryByRole("button", { name: `Actions for ${owner.slice(0, 8)}` }),
  ).toBeNull();
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  expect(menus).toHaveLength(2); // Admin and member; never the viewer/owner.
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  expect(calls.some((c) => c.route === "member")).toBe(false);
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "invalid: cannot remove the relay owner",
    ),
  );
  expect(calls.find((c) => c.route === "member")?.body).toEqual({
    action: "remove",
    pubkey: member,
  });
});

it("keeps an accepted removal when the refresh fails and retries read-only", async () => {
  const user = userEvent.setup();
  const calls = broker({
    member: () => Response.json({ accepted: true, message: "" }),
  });
  const { relay: data, read } = relay(owner);
  render(<CommunityAdmin relay={data} active={() => true} />);
  const menus = await screen.findAllByRole("button", { name: /^Actions for / });
  read.mockRejectedValueOnce(new Error("relay unavailable"));
  await user.click(menus[1] as HTMLElement);
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  await user.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Remove",
    }),
  );
  expect(
    await screen.findByText("Change accepted by the relay."),
  ).toBeVisible();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not load members: relay unavailable The list below may be out of date.",
  );
  // A stale list offers no further destructive commands.
  expect(screen.queryAllByRole("button", { name: /^Actions for / })).toEqual(
    [],
  );
  read.mockResolvedValueOnce([
    snapshot([
      ["member", owner, "owner"],
      ["member", admin, "admin"],
    ]),
  ]);
  await user.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(
    1,
  );
  expect(calls.filter((c) => c.route === "member")).toHaveLength(1);
});

it("picks up a promotion made elsewhere when refreshed", async () => {
  const user = userEvent.setup();
  broker({});
  const { relay: data, read } = relay(member);
  render(<CommunityAdmin relay={data} active={() => true} />);
  await screen.findByText(
    "Only community owners and admins can invite people or manage members.",
  );
  read.mockResolvedValueOnce([
    snapshot([
      ["member", owner, "owner"],
      ["member", member, "admin"],
    ]),
  ]);
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  expect(
    await screen.findByRole("button", { name: "Invite to community" }),
  ).toBeVisible();
});

it("recovers from an initial read failure on retry", async () => {
  const user = userEvent.setup();
  broker({});
  const { relay: data, read } = relay(owner);
  read.mockRejectedValueOnce(new Error("offline"));
  render(<CommunityAdmin relay={data} active={() => true} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Could not load members: offline",
  );
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: "Invite to community" }),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});
