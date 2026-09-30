// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatPublicKey } from "../../shared/identity/public-key";
import { npubEncode } from "nostr-tools/nip19";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../../features/relay/session";
import { keypair, profile, signed } from "../../features/relay/testing";
import { matchesEvent } from "../../features/relay/projection";
import type { RelayEvent } from "../../features/relay/events";
import { PublishRejected } from "../../features/relay/outbox";
import type {
  Presence,
  PresenceStatus,
} from "../../features/presence/presence";
import { ChannelMembersButton } from "./ChannelMembersDialog";
import { ToastProvider } from "../../shared/design-system/ui/Toast";

const stops: (() => void)[] = [];
beforeEach(() => {
  // jsdom has no top layer; browser tests own popup paint and hit testing.
  HTMLElement.prototype.showPopover = function () {
    this.style.display = "block";
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  for (const stop of stops.splice(0)) stop();
});
const id = "11111111-1111-4111-8111-111111111111";
async function setup(
  actor = "owner",
  targetRole = "member",
  supported = true,
  roleRead?: Promise<void>,
  targetAgent = false,
  presence?: Presence,
  messageSupport = false,
  messageNavigation = true,
) {
  const viewer = keypair(),
    relay = keypair(),
    target = keypair(),
    owner = keypair();
  let role: string | undefined = targetRole;
  let tick = 1700000000;
  let lag = false;
  const members = () => [
    [viewer.pubkey, actor],
    [owner.pubkey, "owner"],
    ...(role ? [[target.pubkey, role]] : []),
  ];
  const events = () => [
    signed(relay, {
      kind: 39000,
      created_at: tick,
      content: "",
      tags: [["d", id], ["t", "stream"], ["private"], ["name", "Design"]],
    }),
    signed(relay, {
      kind: 39001,
      created_at: tick,
      content: "",
      tags: [
        ["d", id],
        ...members()
          .filter(([, r]) => r === "owner" || r === "admin")
          .map(([key, r]) => ["p", key ?? "", r ?? ""]),
      ],
    }),
    signed(relay, {
      kind: 39002,
      created_at: tick,
      content: "",
      tags: [
        ["d", id],
        ...members().map(([key, r]) => ["p", key ?? "", "", r ?? ""]),
      ],
    }),
    profile(viewer, { name: "Carl" }),
    profile(target, { name: "Morgan", is_agent: targetAgent }),
    profile(owner, { name: "Owner" }),
  ];
  const publish = vi.fn(async (event: RelayEvent) => {
    if (!lag)
      role =
        event.kind === 9001
          ? undefined
          : event.tags.find(([key]) => key === "role")?.[1];
    tick++;
  });
  const query = vi.fn(async (filters: Parameters<typeof matchesEvent>[1][]) => {
    if (filters.some((filter) => filter.kinds?.includes(39001))) await roleRead;
    return events().filter((event) =>
      filters.some((filter) => matchesEvent(event, filter)),
    );
  });
  const sessionOwner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: relay.pubkey,
    media: () => undefined,
    query,
    ...(supported
      ? {
          memberAdministration: {
            sign: async (template) => signed(viewer, template),
            publish,
          },
        }
      : {}),
    writer: {
      kinds: [9, 9000],
      sign: async (template) => signed(viewer, template),
      publish: vi.fn(),
    },
  });
  stops.push(sessionOwner.dispose);
  const session = sessionOwner.session;
  session.channels.ensureList();
  await vi.waitFor(() => expect(session.channels.list().status).toBe("ready"));
  const onOpenLink = vi.fn(() => true);
  const onOpenConversation = vi.fn(() => true);
  const openMessage = vi.fn(
    async (_keys: readonly string[], _signal: AbortSignal) => "dm-1",
  );
  const presentedSession = {
    ...session,
    ...(presence ? { presence } : {}),
    directMessages: {
      ...session.directMessages,
      available: messageSupport,
      open: openMessage,
    },
  };
  render(
    <ToastProvider>
      <ChannelMembersButton
        session={presentedSession}
        channelId={id}
        canOpenLink={() => true}
        onOpenLink={onOpenLink}
        onOpenConversation={messageNavigation ? onOpenConversation : undefined}
      />
    </ToastProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Channel members" }));
  await screen.findByText("Morgan");
  await vi.waitFor(() =>
    expect(session.memberAdministration.snapshot(id).status).toBe(
      roleRead ? "loading" : "ready",
    ),
  );
  return {
    user,
    session,
    publish,
    query,
    onOpenLink,
    onOpenConversation,
    openMessage,
    target,
    viewer,
    relay,
    lag: () => {
      lag = true;
    },
    confirm: (next: string | undefined) => {
      role = next;
      tick++;
    },
    choose: async (name: string) => {
      await user.click(
        screen.getByRole("button", { name: "Actions for Morgan" }),
      );
      await user.click(await screen.findByRole("menuitem", { name }));
      expect(onOpenLink).not.toHaveBeenCalled();
      return screen.findByRole("dialog", {
        name:
          name === "Remove from channel"
            ? "Remove member?"
            : "Change member role?",
      });
    },
  };
}
it.each([
  ["member", "admin", ["Owner", "Morgan", "Carl"]],
  ["admin", "member", ["Owner", "Carl", "Morgan"]],
  ["owner", "owner", ["Carl", "Morgan", "Owner"]],
  ["admin", "admin", ["Owner", "Carl", "Morgan"]],
  ["member", "bot", ["Owner", "Carl", "Morgan"]],
  ["member", "guest", ["Owner", "Carl", "Morgan"]],
] as const)(
  "orders owners, admins, then everyone else alphabetically (viewer: %s, target: %s)",
  async (actor, target, expected) => {
    const t = await setup(actor, target);
    expect(memberOrder()).toEqual(expected);
    const groupFor = (role: string) =>
      role === "owner" ? "Owners" : role === "admin" ? "Admins" : "Members";
    for (const [name, role] of [
      ["Carl", actor],
      ["Morgan", target],
      ["Owner", "owner"],
    ]) {
      const row = screen.getByRole("button", {
        name: new RegExp(`^Open profile for ${name}`),
      });
      expect(row.closest("section")).toHaveAttribute(
        "aria-label",
        groupFor(required(role)),
      );
      expect(
        within(required(row.closest("li"))).queryByText(required(role)),
      ).not.toBeInTheDocument();
    }
    await t.user.type(screen.getByRole("searchbox"), "o");
    expect(memberOrder()).toEqual(expected.filter((name) => name !== "Carl"));
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("uses alphabetical order until roles load, then reorders on verified role refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = await setup("member", "member", true, gate);
  try {
    expect(memberOrder()).toEqual(["Carl", "Morgan", "Owner"]);
  } finally {
    await act(async () => release());
  }
  const refresh = screen.getByRole("button", { name: "Refresh member data" });
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(memberOrder()).toEqual(["Owner", "Carl", "Morgan"]);
  t.confirm("admin");
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(memberOrder()).toEqual(["Owner", "Morgan", "Carl"]);
  const query = required(t.query.getMockImplementation());
  t.query.mockRejectedValue(new Error("Read failed"));
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(memberOrder()).toEqual(["Owner", "Morgan", "Carl"]);
  t.query.mockImplementation(query);
  t.confirm("member");
  await t.user.click(refresh);
  await vi.waitFor(() => expect(refresh).toHaveAttribute("aria-busy", "false"));
  expect(memberOrder()).toEqual(["Owner", "Carl", "Morgan"]);
  expect(t.publish).not.toHaveBeenCalled();
});

function memberOrder() {
  return within(screen.getByRole("region", { name: "Member list" }))
    .getAllByRole("button", { name: /^Open profile for/ })
    .map((row) =>
      required(row.getAttribute("aria-label"))
        .split(" (")[0]
        ?.replace("Open profile for ", ""),
    );
}

it.each([false, true])(
  "omits unverified roles during the initial read, then shows the result (failure: %s)",
  async (failure) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => {
      if (failure) throw new Error("Roles unavailable");
    });
    try {
      const t = await setup("owner", "member", true, gate);
      await vi.waitFor(() =>
        expect(
          t.query.mock.calls.some(([filters]) =>
            filters.some((filter) => filter.kinds?.includes(39001)),
          ),
        ).toBe(true),
      );
      const row = screen.getByRole("button", {
        name: /Open profile for Morgan/,
      });
      expect(row).toBeVisible();
      expect(screen.queryByText("Role unverified")).not.toBeInTheDocument();
      expect(row).not.toHaveAccessibleName(/Role unverified/);
      expect(
        within(required(row.closest("li"))).queryByText("member"),
      ).not.toBeInTheDocument();
      await act(async () => release());
      await vi.waitFor(() =>
        expect(t.session.memberAdministration.snapshot(id).status).toBe(
          failure ? "error" : "ready",
        ),
      );
      expect(row.closest("li")).not.toHaveTextContent(
        /Role unverified|^member$/,
      );
      expect(row).toHaveAccessibleName(
        failure ? /Role unverified/ : /, member$/,
      );
      expect(t.publish).not.toHaveBeenCalled();
    } finally {
      await act(async () => release());
    }
  },
);

it("presents verified roles, protects owners/self, and confirms a separate deliberate role intent", async () => {
  const t = await setup();
  await expectProfileOnly(t.user, "Carl");
  await expectProfileOnly(t.user, "Owner");
  const row = required(screen.getByText("Morgan").closest("li"));
  expect(row.closest("section")).toHaveAttribute("aria-label", "Members");
  let dialog = await t.choose("Make admin");
  await vi.waitFor(() =>
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toHaveFocus(),
  );
  expect(
    within(dialog).getByRole("button", { name: "Cancel" }),
  ).toHaveAttribute("data-variant", "outline");
  expect(
    within(dialog).getByRole("button", { name: "Make admin" }),
  ).toHaveAttribute("data-variant", "prominent");
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(t.publish).not.toHaveBeenCalled();
  dialog = await t.choose("Make admin");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Make admin" }),
  );
  await screen.findByText("Member change confirmed.");
  expect(screen.getByText("Morgan").closest("section")).toHaveAttribute(
    "aria-label",
    "Admins",
  );
  expect(t.publish).toHaveBeenCalledOnce();
});
it("confirms removal and removes only the confirmed roster entry", async () => {
  const t = await setup();
  const dialog = await t.choose("Remove from channel");
  expect(dialog).toHaveTextContent(
    "does not delete their identity or stop their agents",
  );
  expect(
    within(dialog).getByRole("button", { name: "Remove member" }),
  ).toHaveAttribute("data-variant", "destructive");
  expect(screen.getAllByText("Morgan").length).toBeGreaterThan(0);
  await t.user.click(
    within(dialog).getByRole("button", { name: "Remove member" }),
  );
  await screen.findByText("Member change confirmed.");
  expect(screen.queryByText("Morgan")).not.toBeInTheDocument();
  expect(t.session.channels.get?.(id)?.members).not.toContain(t.target.pubkey);
});
it.each(["member", "guest"])(
  "keeps ordinary invitations usable for %s without admin controls",
  async (actor) => {
    const t = await setup(actor);
    await expectProfileOnly(t.user, "Morgan");
    expect(screen.getByRole("searchbox")).toHaveAttribute(
      "placeholder",
      "Add people and agents",
    );
  },
);
it.each([
  ["member", ["Make admin", "Remove from channel"]],
  ["admin", ["Make member", "Remove from channel"]],
  ["guest", ["Make admin", "Make member", "Remove from channel"]],
] as const)(
  "omits Guest assignment while preserving the verified %s role and supported actions",
  async (role, actions) => {
    const t = await setup("owner", role);
    const row = required(screen.getByText("Morgan").closest("li"));
    expect(
      within(row).getByRole("button", { name: /Open profile/ }),
    ).toHaveAccessibleName(new RegExp(`, ${role}$`));
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    await screen.findByRole("menuitem", { name: "Remove from channel" });
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["View profile", "Copy npub", ...actions]);
    await t.user.keyboard("{Escape}");
    expect(
      within(row).getByRole("button", { name: /Open profile/ }),
    ).toHaveAccessibleName(new RegExp(`, ${role}$`));
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it("changes an existing Guest to Member only after explicit confirmation", async () => {
  const t = await setup("owner", "guest");
  const dialog = await t.choose("Make member");
  expect(dialog).toHaveTextContent("from guest to member");
  expect(t.publish).not.toHaveBeenCalled();
  await t.user.click(
    within(dialog).getByRole("button", { name: "Make member" }),
  );
  await screen.findByText("Member change confirmed.");
  expect(screen.getByText("Morgan").closest("section")).toHaveAttribute(
    "aria-label",
    "Members",
  );
  expect(t.publish).toHaveBeenCalledOnce();
});
it.each([false, true])(
  "groups Bot with Members while retaining its accessible role and removal-only policy (Agent: %s)",
  async (agent) => {
    const t = await setup("owner", "bot", true, undefined, agent);
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    if (agent) {
      expect(
        row.closest("li")?.querySelector('[data-avatar-shape="squircle"]'),
      ).toBeInTheDocument();
      expect(row.closest("section")).toHaveAttribute("aria-label", "Members");
      expect(
        within(required(row.closest("li"))).queryByText("bot"),
      ).not.toBeInTheDocument();
      expect(row).toHaveAccessibleName(/, member$/);
      expect(row).not.toHaveAccessibleName(/, bot/);
    } else {
      expect(
        within(required(row.closest("li"))).queryByText("Agent"),
      ).not.toBeInTheDocument();
      expect(row.closest("section")).toHaveAttribute("aria-label", "Members");
      expect(row).toHaveAccessibleName(/, bot/);
    }
    expect(
      t.session.memberAdministration.snapshot(id).authority.roles[
        t.target.pubkey
      ],
    ).toBe("bot");
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Remove from channel" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: /Make / }),
    ).not.toBeInTheDocument();
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it.each(["member", "admin", "owner", "guest"])(
  "groups an Agent by verified %s role without role pills",
  async (role) => {
    const t = await setup("owner", role, true, undefined, true);
    const row = screen.getByRole("button", { name: /Open profile for Morgan/ });
    expect(
      row.closest("li")?.querySelector('[data-avatar-shape="squircle"]'),
    ).toBeInTheDocument();
    expect(
      within(required(row.closest("li"))).queryByText(role),
    ).not.toBeInTheDocument();
    expect(row.closest("section")).toHaveAttribute(
      "aria-label",
      role === "owner" ? "Owners" : role === "admin" ? "Admins" : "Members",
    );
    expect(row).toHaveAccessibleName(new RegExp(`, ${role}$`));
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it("reads roles on hosts without the narrow writer", async () => {
  const t = await setup("owner", "guest", false);
  expect(
    screen.getByRole("button", { name: /Open profile for Morgan/ }),
  ).toHaveAccessibleName(/, guest$/);
  await expectProfileOnly(t.user, "Morgan");
});
it("keeps unconfirmed roles and session recovery across close/reopen without replay", async () => {
  const t = await setup();
  t.lag();
  const dialog = await t.choose("Make admin");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Make admin" }),
  );
  await screen.findByText(/This request may have taken effect/);
  expect(screen.getByText("Morgan").closest("section")).toHaveAttribute(
    "aria-label",
    "Members",
  );
  await expectProfileOnly(t.user, "Morgan");
  await t.user.click(
    screen.getByRole("button", { name: "Close channel members" }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  await t.user.click(screen.getByRole("button", { name: "Channel members" }));
  await screen.findByText(/This request may have taken effect/);
  await vi.waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Refresh member data" }),
    ).not.toHaveAttribute("aria-disabled", "true"),
  );
  t.confirm("admin");
  await t.user.click(
    screen.getByRole("button", { name: "Refresh member data" }),
  );
  await screen.findByText("Member change confirmed.");
  expect(t.publish).toHaveBeenCalledOnce();
});
it("pending operations survive closing while suppressing duplicate actions", async () => {
  const t = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const publish = required(t.publish.getMockImplementation());
  t.publish.mockImplementationOnce(async (event) => {
    await gate;
    await publish(event);
  });
  try {
    const dialog = await t.choose("Make admin");
    await t.user.click(
      within(dialog).getByRole("button", { name: "Make admin" }),
    );
    await vi.waitFor(() => expect(t.publish).toHaveBeenCalledOnce());
    await expectProfileOnly(t.user, "Morgan");
    await t.user.click(
      screen.getByRole("button", { name: "Close channel members" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await t.user.click(screen.getByRole("button", { name: "Channel members" }));
    expect(screen.getByText(/Checking permissions and waiting/)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Refresh member data" }),
    ).toHaveAttribute("aria-disabled", "true");
  } finally {
    await act(async () => release());
  }
  await screen.findByText("Member change confirmed.");
  expect(t.publish).toHaveBeenCalledOnce();
});
it("retains roster and displays rejection with explicit refresh recovery", async () => {
  const t = await setup();
  t.publish.mockRejectedValueOnce(new PublishRejected("Permission changed"));
  const dialog = await t.choose("Remove from channel");
  await t.user.click(
    within(dialog).getByRole("button", { name: "Remove member" }),
  );
  await screen.findByText("Permission changed");
  expect(screen.getByText("Morgan")).toBeVisible();
  await t.user.click(
    screen.getByRole("button", { name: "Refresh member data" }),
  );
  await screen.findByRole("button", { name: "Actions for Morgan" });
  expect(t.publish).toHaveBeenCalledOnce();
});

it.each([true, false])(
  "refreshes roster and roles from the header without writes (writer: %s)",
  async (supported) => {
    const t = await setup("owner", "member", supported);
    const section = screen.getByRole("region", { name: "Members" });
    const dialog = screen.getByRole("dialog", { name: "Channel members" });
    const header = required(dialog.querySelector("header"));
    const refresh = within(header).getByRole("button", {
      name: "Refresh member data",
    });
    const close = within(header).getByRole("button", {
      name: "Close channel members",
    });
    expect(refresh).toHaveAttribute("data-variant", "ghost");
    expect(refresh).toHaveAttribute("data-icon-size", "compact");
    expect(refresh.nextElementSibling).toBe(close);
    await vi.waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    await t.user.type(screen.getByRole("searchbox"), "Morgan");
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    t.confirm("admin");
    await t.user.click(refresh);
    await vi.waitFor(() =>
      expect(screen.getByText("Morgan").closest("section")).toHaveAttribute(
        "aria-label",
        "Admins",
      ),
    );
    await vi.waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    t.confirm(undefined);
    await t.user.click(refresh);
    await vi.waitFor(() =>
      expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
    );
    expect(within(section).getByRole("heading")).toHaveTextContent(
      "Members · 0",
    );
    expect(within(section).queryByText("Morgan")).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("Morgan");
    expect(t.publish).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "recovers visible roles after an unrelated access change (read fails: %s)",
  async (failure) => {
    const t = await setup();
    const other = "22222222-2222-4222-8222-222222222222";
    const query = required(t.query.getMockImplementation());
    let joined = true;
    let failRead = failure;
    t.query.mockImplementation(async (filters) => {
      if (
        !joined &&
        failRead &&
        filters.some((filter) => filter.kinds?.includes(39001))
      )
        throw new Error("Roles unavailable");
      if (filters.some((filter) => filter["#d"]?.includes(other)))
        return [
          signed(t.relay, {
            kind: 39000,
            content: "",
            tags: [
              ["d", other],
              ["t", "stream"],
              ["private"],
              ["name", "Other"],
            ],
          }),
          signed(t.relay, {
            kind: 39002,
            created_at: joined ? 1700000100 : 1700000101,
            content: "",
            tags: [["d", other], ...(joined ? [["p", t.viewer.pubkey]] : [])],
          }),
        ].filter((event) =>
          filters.some((filter) => matchesEvent(event, filter)),
        );
      return query(filters);
    });
    const readOther = () =>
      t.session.read([{ kinds: [39000, 39002], "#d": [other], limit: 2 }], {
        fresh: true,
      });
    await act(async () => {
      await readOther();
    });
    const before = t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39001)),
    ).length;
    joined = false;
    await act(async () => {
      await readOther();
    });
    await vi.waitFor(() =>
      expect(t.session.memberAdministration.snapshot(id).status).toBe(
        failure ? "error" : "ready",
      ),
    );
    const refresh = screen.getByRole("button", { name: "Refresh member data" });
    await vi.waitFor(() =>
      expect(refresh).toHaveAttribute("aria-busy", "false"),
    );
    expect(
      t.query.mock.calls.filter(([filters]) =>
        filters.some((filter) => filter.kinds?.includes(39001)),
      ),
    ).toHaveLength(before + 1);
    // Session revocation also clears optional names; identify the row by its stable key.
    const targetRow = () =>
      required(
        screen
          .getAllByRole("button", { name: /^Open profile for/ })
          .find((button) =>
            button
              .getAttribute("aria-label")
              ?.includes(`(${formatPublicKey(t.target.pubkey)})`),
          )
          ?.closest("li"),
      );
    if (failure) {
      expect(screen.getByText("Roles unavailable")).toBeVisible();
      expect(
        within(targetRow()).getByRole("button", { name: /Open profile/ }),
      ).toHaveAccessibleName(/Role unverified/);
      failRead = false;
      await t.user.click(refresh);
      await vi.waitFor(() =>
        expect(t.session.memberAdministration.snapshot(id).status).toBe(
          "ready",
        ),
      );
    }
    expect(targetRow().closest("section")).toHaveAttribute(
      "aria-label",
      "Members",
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("does not reload roles after this channel's access is revoked", async () => {
  const t = await setup();
  const query = required(t.query.getMockImplementation());
  const before = t.query.mock.calls.filter(([filters]) =>
    filters.some((filter) => filter.kinds?.includes(39001)),
  ).length;
  t.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(39002)))
      return [
        signed(t.relay, {
          kind: 39002,
          created_at: 1700000100,
          content: "",
          tags: [
            ["d", id],
            ["p", t.target.pubkey, "", "member"],
          ],
        }),
      ];
    return query(filters);
  });
  await act(async () => {
    await t.session.read([{ kinds: [39002], "#d": [id], limit: 1 }], {
      fresh: true,
    });
  });
  expect(t.session.memberAdministration.snapshot(id).status).toBe("idle");
  expect(
    t.query.mock.calls.filter(([filters]) =>
      filters.some((filter) => filter.kinds?.includes(39001)),
    ),
  ).toHaveLength(before);
  expect(screen.queryByText("Morgan")).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

it("holds duplicate refreshes, retains the roster on read failure, and recovers explicitly", async () => {
  const t = await setup();
  const refresh = screen.getByRole("button", {
    name: "Refresh member data",
  });
  await vi.waitFor(() =>
    expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
  );
  const query = required(t.query.getMockImplementation());
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  t.query.mockImplementation(async (filters) => {
    if (filters.some((filter) => filter.kinds?.includes(39002))) {
      started++;
      await gate;
      throw new Error("Member reads offline");
    }
    return query(filters);
  });
  try {
    await t.user.click(refresh);
    await vi.waitFor(() => expect(started).toBe(2));
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(refresh).toHaveAttribute("aria-disabled", "true");
    expect(refresh.querySelector("svg")).toHaveClass(
      "motion-safe:animate-spin",
    );
    expect(screen.queryByText("Loading members…")).not.toBeInTheDocument();
    expect(screen.getByText("Morgan")).toBeVisible();
    await t.user.click(refresh);
  } finally {
    await act(async () => release());
  }
  await screen.findByText(/The member list could not load/);
  await vi.waitFor(() =>
    expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
  );
  expect(started).toBe(2);
  expect(screen.getByText("Morgan").closest("section")).toHaveAttribute(
    "aria-label",
    "Members",
  );
  t.query.mockImplementation(query);
  t.confirm("admin");
  await t.user.click(refresh);
  await vi.waitFor(() =>
    expect(screen.getByText("Morgan").closest("section")).toHaveAttribute(
      "aria-label",
      "Admins",
    ),
  );
  await vi.waitFor(() =>
    expect(refresh).not.toHaveAttribute("aria-disabled", "true"),
  );
  expect(
    screen.queryByText(/The member list could not load/),
  ).not.toBeInTheDocument();
  expect(t.publish).not.toHaveBeenCalled();
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Missing fixture value");
  return value;
}

async function expectProfileOnly(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
) {
  await user.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  expect(
    (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
  ).toEqual(["View profile", "Copy npub"]);
  await vi.waitFor(() => expect(screen.getByRole("menu")).toHaveFocus());
  await user.keyboard("{Escape}");
  await vi.waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
}

it.each(["ellipsis", "context", "keyboard", "context-key"])(
  "opens the same profile-first member menu via %s",
  async (entry) => {
    const t = await setup();
    const row = required(screen.getByText("Morgan").closest("li"));
    if (entry === "ellipsis") {
      await t.user.click(
        screen.getByRole("button", { name: "Actions for Morgan" }),
      );
    } else if (entry === "context") {
      fireEvent.contextMenu(row, { clientX: 100, clientY: 100, button: 2 });
    } else {
      fireEvent.keyDown(
        within(required(row.closest("li"))).getByRole("button", {
          name: /^Open profile/,
        }),
        entry === "keyboard"
          ? { key: "F10", shiftKey: true }
          : { key: "ContextMenu" },
      );
    }
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual([
      "View profile",
      "Copy npub",
      "Make admin",
      "Remove from channel",
    ]);
    expect(t.onOpenLink).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
    await t.user.click(screen.getByRole("menuitem", { name: "View profile" }));
    expect(t.onOpenLink).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("keeps Members and restores the menu trigger when profile navigation is declined", async () => {
  const t = await setup();
  t.onOpenLink.mockReturnValue(false);
  const actions = screen.getByRole("button", { name: "Actions for Morgan" });
  await t.user.click(actions);
  await t.user.click(
    await screen.findByRole("menuitem", { name: "View profile" }),
  );
  await vi.waitFor(() =>
    expect(screen.queryByRole("menu")).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("dialog", { name: "Channel members" })).toBeVisible();
  await vi.waitFor(() => expect(actions).toHaveFocus());
  expect(t.onOpenLink).toHaveBeenCalledOnce();
  expect(t.onOpenLink).toHaveBeenCalledWith(
    expect.any(String),
    screen.getByRole("button", { name: "Channel members", hidden: true }),
  );
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([false, true])(
  "reuses mounted presence for human/agent avatars without inventing offline state (agent: %s)",
  async (agent) => {
    let status: PresenceStatus = "unknown";
    const listeners = new Map<string, Set<() => void>>();
    const presence = {
      status: () => status,
      limited: () => false,
      subscribe(key, listener) {
        const current = listeners.get(key) ?? new Set();
        current.add(listener);
        listeners.set(key, current);
        return () => {
          current.delete(listener);
          if (!current.size) listeners.delete(key);
        };
      },
      connected() {},
      clear() {},
      refresh() {},
      dispose() {},
    } satisfies Presence;
    const t = await setup("owner", "member", true, undefined, agent, presence);
    const profile = screen.getByRole("button", {
      name: /Open profile for Morgan/,
    });
    const avatar = required(profile.querySelector(".buzz-avatar-status"));
    expect(avatar).not.toHaveAttribute("data-status");
    expect(profile).not.toHaveAttribute("title");
    expect(profile).not.toHaveAccessibleDescription(/Presence:/);
    expect(avatar).toHaveAttribute("data-shape", agent ? "squircle" : "circle");
    expect(listeners.get(t.target.pubkey)?.size).toBe(1);
    for (const next of ["online", "away", "offline", "unknown"] as const) {
      act(() => {
        status = next;
        for (const callbacks of listeners.values())
          for (const callback of callbacks) callback();
      });
      if (next === "unknown") {
        expect(avatar).not.toHaveAttribute("data-status");
        expect(profile).not.toHaveAccessibleDescription(/Presence:/);
      } else {
        expect(avatar).toHaveAttribute("data-status", next);
        expect(profile).toHaveAccessibleDescription(`Presence: ${next}`);
      }
    }
    await t.user.type(screen.getByRole("searchbox"), "Carl");
    expect(listeners.has(t.target.pubkey)).toBe(false);
    await t.user.click(
      screen.getByRole("button", { name: "Close channel members" }),
    );
    await vi.waitFor(() => expect(listeners.size).toBe(0));
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it.each(["Carl", "Owner", "Morgan"])(
  "copies the full npub for %s without opening a profile or changing membership",
  async (name) => {
    const t = await setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const profile = screen.getByRole("button", {
      name: new RegExp(`^Open profile for ${name} `),
    });
    const row = required(profile.closest("li"));
    const npub =
      name === "Carl"
        ? npubEncode(t.viewer.pubkey)
        : name === "Morgan"
          ? npubEncode(t.target.pubkey)
          : npubEncode(
              required(
                t.session.channels
                  .get?.(id)
                  ?.members?.find(
                    (key) => key !== t.viewer.pubkey && key !== t.target.pubkey,
                  ),
              ),
            );
    await t.user.click(
      within(row).getByRole("button", { name: `Actions for ${name}` }),
    );
    await t.user.click(
      await screen.findByRole("menuitem", { name: "Copy npub" }),
    );
    expect(copy).toHaveBeenCalledExactlyOnceWith(npub);
    expect(await screen.findByText("Copied npub")).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "Channel members" }),
    ).toBeVisible();
    expect(t.onOpenLink).not.toHaveBeenCalled();
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("keeps agent Copy available after clipboard rejection and retries from the menu", async () => {
  const t = await setup("owner", "member", true, undefined, true);
  const copy = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockRejectedValueOnce(new Error("denied"))
    .mockResolvedValue();
  const actions = screen.getByRole("button", { name: "Actions for Morgan" });
  await t.user.click(actions);
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Copy npub" }),
  );
  expect(
    await screen.findByText("Couldn’t copy npub. Try again."),
  ).toBeVisible();
  await t.user.click(actions);
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Copy npub" }),
  );
  expect(await screen.findByText("Copied npub")).toBeVisible();
  expect(copy).toHaveBeenNthCalledWith(2, npubEncode(t.target.pubkey));
  expect(t.publish).not.toHaveBeenCalled();
});

it.each([
  [false, "member", true, true, true],
  [true, "member", true, true, false],
  [false, "bot", true, true, false],
  [false, "member", false, true, false],
  [false, "member", true, false, false],
] as const)(
  "gates Send message by human identity, capability and navigation (%s/%s/%s/%s)",
  async (agent, role, available, navigation, offered) => {
    const t = await setup(
      "member",
      role,
      true,
      undefined,
      agent,
      undefined,
      available,
      navigation,
    );
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Morgan" }),
    );
    expect(
      (await screen.findAllByRole("menuitem")).map((item) => item.textContent),
    ).toEqual(
      offered
        ? ["View profile", "Send message", "Copy npub"]
        : ["View profile", "Copy npub"],
    );
    await t.user.keyboard("{Escape}");
    await t.user.click(
      screen.getByRole("button", { name: "Actions for Carl" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Copy npub" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitem", { name: "Send message" }),
    ).not.toBeInTheDocument();
    expect(t.openMessage).not.toHaveBeenCalled();
  },
);

it("opens a confirmed human DM once, then hands navigation off without a membership write", async () => {
  const t = await setup(
    "member",
    "member",
    true,
    undefined,
    false,
    undefined,
    true,
  );
  let release!: (id: string) => void;
  t.openMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const actions = screen.getByRole("button", { name: "Actions for Morgan" });
  await t.user.click(actions);
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Send message" }),
  );
  expect(t.openMessage).toHaveBeenCalledExactlyOnceWith(
    [t.target.pubkey],
    expect.any(AbortSignal),
  );
  expect(await screen.findByText("Opening conversation…")).toBeVisible();
  await t.user.click(actions);
  expect(
    await screen.findByRole("menuitem", { name: "Send message" }),
  ).toHaveAttribute("aria-disabled", "true");
  await t.user.click(screen.getByRole("menuitem", { name: "Send message" }));
  expect(t.openMessage).toHaveBeenCalledOnce();
  await t.user.keyboard("{Escape}");
  await act(async () => release("dm-1"));
  expect(t.onOpenConversation).toHaveBeenCalledExactlyOnceWith("dm-1");
  await vi.waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(t.onOpenLink).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});

it.each(["read", "navigation"])(
  "retains Members after DM %s failure and allows explicit retry",
  async (failure) => {
    const t = await setup(
      "member",
      "member",
      true,
      undefined,
      false,
      undefined,
      true,
    );
    if (failure === "read")
      t.openMessage.mockRejectedValueOnce(new Error("DM unavailable"));
    else t.onOpenConversation.mockReturnValueOnce(false);
    const actions = screen.getByRole("button", { name: "Actions for Morgan" });
    await t.user.click(actions);
    await t.user.click(
      await screen.findByRole("menuitem", { name: "Send message" }),
    );
    expect(
      await screen.findByText(
        failure === "read"
          ? "DM unavailable"
          : "Could not open the conversation. Try Send message again.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "Channel members" }),
    ).toBeVisible();
    await t.user.click(actions);
    await t.user.click(
      await screen.findByRole("menuitem", { name: "Send message" }),
    );
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(t.openMessage).toHaveBeenCalledTimes(2);
    expect(t.publish).not.toHaveBeenCalled();
  },
);

it("closing Members aborts the DM waiter and prevents late navigation", async () => {
  const t = await setup(
    "member",
    "member",
    true,
    undefined,
    false,
    undefined,
    true,
  );
  let release!: (id: string) => void;
  t.openMessage.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await t.user.click(
    screen.getByRole("button", { name: "Actions for Morgan" }),
  );
  await t.user.click(
    await screen.findByRole("menuitem", { name: "Send message" }),
  );
  const signal = required(t.openMessage.mock.calls[0]?.[1]);
  expect(signal.aborted).toBe(false);
  await t.user.click(
    screen.getByRole("button", { name: "Close channel members" }),
  );
  expect(signal.aborted).toBe(true);
  await act(async () => release("dm-1"));
  expect(t.onOpenConversation).not.toHaveBeenCalled();
  expect(t.publish).not.toHaveBeenCalled();
});
